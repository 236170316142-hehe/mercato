import JSZip from "jszip";
import ExcelJS from "exceljs";
import type { Product, ExportTemplate } from "@prisma/client";

type Column = { key: string; label: string; required?: boolean };

// Minimal template shape needed by generateCategoryZip — excludes the large fileData BYTEA blob.
// The route can use a `select` query to avoid fetching fileData, which is never used in the
// pure-XML XLSX path.
export type TemplateRow = {
  id: string;
  name: string;
  category?: string | null;
  fileFormat: string;
  columns: unknown;
};

// ── Category-split export (primary mode) ─────────────────────────────────────
// Each category is auto-matched to the closest template by name similarity.
// The defaultTemplateId is used as the fallback when no close match is found.

export async function generateCategoryZip(
  products: Product[],
  templates: TemplateRow[],
  marketplace = "amazon",
  defaultTemplateId?: string,
): Promise<Buffer> {
  const zip = new JSZip();
  const fallback = templates.find((t) => t.id === defaultTemplateId) ?? templates[0];

  const eligible = eligibleProducts(products, marketplace);

  // Group by category; uncategorized products go into "_Uncategorized"
  const groups = new Map<string, Product[]>();
  for (const p of eligible) {
    const cat = p.marketplaceCategory ?? "_Uncategorized";
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat)!.push(p);
  }

  // Process categories sequentially with event-loop yields between each file.
  // ExcelJS template loading (fillTemplateXlsx) is synchronous CPU work that blocks
  // the Node.js event loop for 10–15 s per file, preventing poll requests from being
  // served. We skip template file loading and use column definitions only (createXlsxFromScratch).
  // This is non-blocking and completes in < 1 s total.
  for (const [category, categoryProducts] of groups) {
    await new Promise<void>((r) => setImmediate(r)); // yield so HTTP polls can be served

    const template = findBestTemplate(category, templates, fallback);
    const columns = template.columns as Column[];
    const fileName = sanitize(category);

    if (template.fileFormat === "csv") {
      zip.file(`${fileName}.csv`, generateCsv(categoryProducts, columns));
    } else {
      const buffer = await createXlsxFromScratch(categoryProducts, columns, category);
      zip.file(`${fileName}.xlsx`, buffer);
    }
  }

  return zip.generateAsync({ type: "nodebuffer" }) as unknown as Promise<Buffer>;
}

// Pick the best-matching template for a category using word-overlap scoring.
// Falls back to the provided default when no template scores above zero.
export function findBestTemplate<T extends { id: string; name: string; category?: string | null }>(
  category: string,
  templates: T[],
  fallback: T,
): T {
  if (templates.length <= 1) return fallback;

  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const normCat = norm(category);
  const catWords = normCat.split(" ").filter((w) => w.length > 2);

  let best = fallback;
  let bestScore = 0;

  for (const t of templates) {
    // Score against both the template name and its category field (whichever is set)
    const normName = norm(t.name);
    const normCatField = t.category ? norm(t.category) : normName;
    const target = normCatField || normName;
    const targetWords = target.split(" ").filter((w) => w.length > 2);

    let score = 0;
    for (const word of catWords) if (targetWords.includes(word)) score += 2;
    for (const word of targetWords) if (catWords.includes(word)) score += 1;
    if (target.includes(normCat)) score += 5;
    if (normCat.includes(target)) score += 3;
    // Exact match bonus
    if (target === normCat) score += 10;

    if (score > bestScore) { bestScore = score; best = t; }
  }

  return best;
}

// ── Legacy multi-template export (kept for backward compat) ──────────────────

export async function generateExportZip(
  products: Product[],
  templates: ExportTemplate[],
  marketplace = "amazon",
): Promise<Buffer> {
  const zip = new JSZip();
  const eligible = eligibleProducts(products, marketplace);

  for (const template of templates) {
    const columns = template.columns as Column[];
    const filtered = template.category
      ? eligible.filter((p) => p.marketplaceCategory === template.category)
      : eligible;

    const fileName = sanitize(template.name);
    const fileData = template.fileData ? (template.fileData as Buffer) : null;

    if (template.fileFormat === "csv") {
      zip.file(`${fileName}.csv`, generateCsv(filtered, columns));
    } else {
      const buffer = fileData
        ? await fillTemplateXlsx(filtered, columns, fileData)
        : await createXlsxFromScratch(filtered, columns, template.name);
      zip.file(`${fileName}.xlsx`, buffer);
    }
  }

  return zip.generateAsync({ type: "nodebuffer" }) as unknown as Promise<Buffer>;
}

function eligibleProducts(products: Product[], marketplace: string): Product[] {
  const anyVerified = products.some((p) => p.verifyStatus != null);
  if (!anyVerified) return products;
  return marketplace === "amazon_us"
    ? products.filter((p) => p.verifyStatus === "ok")
    : products.filter((p) => ["ok", "warning", "not_found"].includes(p.verifyStatus ?? ""));
}

// ── Fill existing template file with product rows ─────────────────────────────

async function fillTemplateXlsx(
  products: Product[],
  columns: Column[],
  fileData: Buffer,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  // ExcelJS type expects bare Buffer; Prisma Bytes resolves to Buffer<ArrayBuffer> in TS5
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await wb.xlsx.load(fileData as any);

  // Prefer a sheet literally named "Template" (Temu / multi-tab workbooks).
  // Fall back to the sheet with the most rows, then worksheets[0].
  const ws =
    wb.worksheets.find((s) => /^template$/i.test(s.name)) ??
    wb.worksheets.reduce(
      (best, s) => ((s.rowCount ?? 0) > (best.rowCount ?? 0) ? s : best),
      wb.worksheets[0],
    );
  if (!ws) return createXlsxFromScratch(products, columns, "Sheet1");

  // Find the header row: row with the most *literal* (non-formula) non-empty cells.
  // Formula-heavy data rows would otherwise score higher than the real header.
  let headerRowNum = 1;
  let maxLiteralCells = 0;
  ws.eachRow((row, rowNumber) => {
    let count = 0;
    row.eachCell((cell) => {
      const v = cell.value;
      const isFormula = v !== null && typeof v === "object" && "formula" in (v as object);
      if (!isFormula && v !== null && v !== undefined && v !== "") count++;
    });
    if (count > maxLiteralCells) { maxLiteralCells = count; headerRowNum = rowNumber; }
  });

  // Build a map: normalised header text → 1-based column index
  const headerToCol = new Map<string, number>();
  const headerRow = ws.getRow(headerRowNum);
  headerRow.eachCell((cell, colNumber) => {
    const text = normalizeKey(String(cell.value ?? ""));
    if (text) headerToCol.set(text, colNumber);
  });

  // Map each column definition to a column index in the template
  const colIndexMap: [Column, number][] = [];
  for (const col of columns) {
    const byLabel = headerToCol.get(normalizeKey(col.label));
    const byKey   = headerToCol.get(normalizeKey(col.key));
    const idx = byLabel ?? byKey;
    if (idx !== undefined) colIndexMap.push([col, idx]);
  }

  // If no columns matched the template headers, fall back to a fresh workbook
  // so the file is never silently empty.
  if (colIndexMap.length === 0) {
    return createXlsxFromScratch(products, columns, ws.name);
  }

  // Determine the first data row.
  // Some templates (e.g. Temu) have hidden instruction rows between the header and the
  // first data row. Scan forward up to 10 rows to find the first row that either has
  // formula cells (pre-built Temu VLOOKUP rows) or is entirely empty.
  let firstDataRow = headerRowNum + 1;
  for (let r = headerRowNum + 1; r <= headerRowNum + 10; r++) {
    const row = ws.getRow(r);
    let hasFormula = false;
    let hasLiteralText = false;
    row.eachCell((cell) => {
      const v = cell.value;
      if (v !== null && typeof v === "object" && "formula" in (v as object)) hasFormula = true;
      else if (v !== null && v !== undefined && v !== "") hasLiteralText = true;
    });
    if (hasFormula || !hasLiteralText) { firstDataRow = r; break; }
  }

  // Remove all existing data rows in ONE splice — avoids the slow per-row loop.
  // Guard against edge cases: spliceRows(n, 0) is a no-op; negative count must not happen.
  const lastRow = ws.lastRow?.number ?? headerRowNum;
  const existingDataRows = Math.max(0, lastRow - headerRowNum);
  if (existingDataRows > 0) {
    try {
      ws.spliceRows(headerRowNum + 1, existingDataRows);
    } catch {
      // Some complex templates (merged cells, named ranges) reject spliceRows — ignore and overwrite in place
    }
  }

  // Append product rows after the header
  for (const p of products) {
    const newRow = ws.addRow([]);
    for (const [col, colIdx] of colIndexMap) {
      newRow.getCell(colIdx).value = (getProductField(p, col.key) ?? "") as ExcelJS.CellValue;
    }
    newRow.commit();
  }

  return wb.xlsx.writeBuffer() as unknown as Promise<Buffer>;
}

// ── Create a fresh workbook — pure XML + JSZip, no ExcelJS ───────────────────
// ExcelJS.writeBuffer() is CPU-bound and blocks the Node.js event loop for
// several seconds per file. JSZip.generateAsync() uses native zlib (truly
// async) so it never blocks the event loop, keeping GET polls responsive.

async function createXlsxFromScratch(
  products: Product[],
  columns: Column[],
  sheetName: string,
): Promise<Buffer> {
  // Build all rows: header first, then one row per product.
  // Yield every 100 rows so the event loop stays free to serve GET poll requests
  // while generating large files (185+ products).
  const allRows: string[][] = [columns.map((c) => c.label)];
  for (let i = 0; i < products.length; i++) {
    if (i > 0 && i % 100 === 0) await new Promise<void>((r) => setImmediate(r));
    allRows.push(columns.map((c) => String(getProductField(products[i], c.key) ?? "")));
  }

  // Shared-string table (XLSX stores text by index to deduplicate)
  const ssArr: string[] = [];
  const ssMap = new Map<string, number>();
  const ssIdx = (s: string): number => {
    let i = ssMap.get(s);
    if (i === undefined) { i = ssArr.length; ssMap.set(s, i); ssArr.push(s); }
    return i;
  };
  for (const row of allRows) for (const cell of row) ssIdx(cell);

  // Column-letter helper: 1→A, 27→AA …
  const colLetter = (n: number): string => {
    let s = "";
    while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
    return s;
  };

  // Sheet XML — numbers written inline, strings reference shared-string index
  const rowXml = allRows.map((row, ri) => {
    const cells = row.map((val, ci) => {
      const ref = `${colLetter(ci + 1)}${ri + 1}`;
      const isNum = val !== "" && !Number.isNaN(Number(val));
      return isNum
        ? `<c r="${ref}"><v>${x(val)}</v></c>`
        : `<c r="${ref}" t="s"><v>${ssIdx(val)}</v></c>`;
    }).join("");
    return `<row r="${ri + 1}">${cells}</row>`;
  }).join("");

  const safeSheet = sheetName.slice(0, 31).replace(/[\\/*?[\]:]/g, "_");

  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>${rowXml}</sheetData></worksheet>`;

  const ssXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${ssArr.length}" uniqueCount="${ssArr.length}">
${ssArr.map((s) => `<si><t xml:space="preserve">${x(s)}</t></si>`).join("")}
</sst>`;

  const wbXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${x(safeSheet)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

  const xlsxZip = new JSZip();
  xlsxZip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`);
  xlsxZip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`);
  xlsxZip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`);
  xlsxZip.file("xl/workbook.xml", wbXml);
  xlsxZip.file("xl/worksheets/sheet1.xml", sheetXml);
  xlsxZip.file("xl/sharedStrings.xml", ssXml);
  xlsxZip.file("xl/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts><font><sz val="11"/><name val="Calibri"/></font></fonts>
<fills><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>
</styleSheet>`);

  return xlsxZip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }) as unknown as Promise<Buffer>;
}

// ── CSV ───────────────────────────────────────────────────────────────────────

function generateCsv(products: Product[], columns: Column[]): string {
  const header = columns.map((c) => `"${c.label}"`).join(",");
  const rows = products.map((p) =>
    columns.map((c) => {
      const val = getProductField(p, c.key);
      return `"${String(val ?? "").replace(/"/g, '""')}"`;
    }).join(",")
  );
  return [header, ...rows].join("\n");
}

// ── Field resolver ────────────────────────────────────────────────────────────

// Cache the normalized-key → value map for vendorData objects.
// Without this, getProductField rebuilds the map on every cell (once per product × column),
// which for 370 products × 45 columns = 16,650 linear scans over vendorData keys.
// With the cache, the map is built ONCE per product and all subsequent lookups are O(1).
const _vdNormCache = new WeakMap<object, Map<string, unknown>>();

function getVdNorm(vd: Record<string, unknown>): Map<string, unknown> {
  const cached = _vdNormCache.get(vd);
  if (cached) return cached;
  const norm = new Map<string, unknown>();
  for (const [k, v] of Object.entries(vd)) {
    if (v !== "" && v != null) norm.set(normalizeKey(k), v);
  }
  _vdNormCache.set(vd, norm);
  return norm;
}

function getProductField(p: Product, key: string): unknown {
  const nk = normalizeKey(key);
  const vd = p.vendorData as Record<string, unknown> | null;
  const ld = p.liveData as Record<string, unknown> | null;

  // O(1) vendorData lookup using the per-product normalized key map
  const vdNorm: Map<string, unknown> | null = vd ? getVdNorm(vd) : null;

  const fromVendor = (...aliases: string[]): unknown => {
    if (!vd || !vdNorm) return undefined;
    for (const alias of aliases) {
      // Exact original-key match (covers keys that are already lowercase / no spaces)
      if (alias in vd) { const v = vd[alias]; if (v !== "" && v != null) return v; }
      // O(1) normalized match via cached map
      const v = vdNorm.get(normalizeKey(alias));
      if (v !== undefined) return v;
    }
    return undefined;
  };

  const fromLive = (field: string): unknown => ld?.[field] ?? undefined;

  const livePrice = typeof ld?.price === "number" && ld.price > 0 ? ld.price / 100 : null;
  const verifiedAsin = typeof ld?.asin === "string" ? ld.asin : null;

  const price = p.price != null
    ? p.price
    : (fromVendor("price", "retail_price", "unit_price", "cost", "msrp", "list_price", "wholesale") ?? livePrice ?? "");

  // ── Broad ID search across vendor data ──────────────────────────────────────
  // Covers any column a vendor might use for item/style/model/catalog numbers
  const anyVendorId = fromVendor(
    "item", "item_no", "item_number", "item_id", "item_#",
    "sku", "sku_id", "sku_no",
    "style", "style_no", "style_number", "style_id", "style_#",
    "model", "model_no", "model_number", "model_id",
    "part_no", "part_number", "part_id",
    "product_no", "product_number", "product_code",
    "article_no", "article_number", "article_id", "article",
    "catalog_no", "catalog_number", "cat_no",
    "design_no", "design_number", "design_id",
    "reference", "ref", "ref_no",
    "stock_no", "stock_number",
    "collection_code", "collection_id",
  );

  // Guaranteed unique ID: prefer meaningful identifiers, fall back to DB id (always non-empty)
  const goodsId   = p.upc ?? p.vendorSku ?? anyVendorId ?? p.id;
  const skuId     = p.vendorSku ?? p.upc ?? anyVendorId ?? p.id;
  const productId = p.upc ?? p.vendorSku ?? anyVendorId ?? p.asin ?? verifiedAsin ?? p.id;

  // ── Description / details — prefer vendor text, fall back to product name ──
  const descriptionText =
    p.description ||
    (fromVendor("description", "long_description", "details", "notes", "specs", "specifications") as string | undefined) ||
    p.name ||
    (fromLive("description") as string | undefined) ||
    "";

  const coreMap: Record<string, unknown> = {
    // Name / Title
    name: p.name || fromLive("title") || "",
    title: p.name || fromLive("title") || "",
    product_name: p.name || fromLive("title") || "",
    item_name: p.name || fromLive("title") || "",

    // SKU fields — guaranteed non-empty
    sku: skuId, vendor_sku: skuId, seller_sku: skuId, merchant_sku: skuId, sku_id: skuId,
    shop_sku: skuId, shopsku: skuId, item_sku: skuId,

    // Variant grouping — UPC or vendor SKU used as the group identifier
    variant_group_code: p.upc ?? fromVendor("variant_group_code", "group_code", "style_no", "style_number", "style") ?? p.vendorSku ?? anyVendorId ?? "",
    variant_code: p.upc ?? p.vendorSku ?? anyVendorId ?? "",
    group_code: p.upc ?? p.vendorSku ?? anyVendorId ?? "",

    // Barcode IDs
    upc: p.upc ?? fromVendor("upc", "ean", "barcode", "gtin") ?? "",
    ean: p.upc ?? fromVendor("ean", "upc", "barcode", "gtin") ?? "",
    barcode: p.upc ?? fromVendor("barcode", "upc", "ean") ?? "",
    gtin: p.upc ?? fromVendor("gtin", "upc", "ean") ?? "",
    asin: p.asin ?? verifiedAsin ?? "",
    merchant_suggested_asin: p.asin ?? verifiedAsin ?? "",

    // Temu / marketplace generic IDs — guaranteed non-empty
    goods_id: goodsId,
    product_id: productId,

    // Amazon flat-file external ID
    external_product_id: p.upc ?? fromVendor("upc", "ean", "barcode") ?? p.asin ?? verifiedAsin ?? "",
    external_product_id_type: (p.upc || fromVendor("upc", "ean", "barcode")) ? "UPC" : (p.asin || verifiedAsin) ? "ASIN" : "",
    product_id_type: (p.upc || fromVendor("upc", "ean", "barcode")) ? "UPC" : (p.asin || verifiedAsin) ? "ASIN" : "",

    // Listing actions
    listing_action: "Add",
    add_delete: "a",
    update_delete: "PartialUpdate",
    operation_type: "Update",

    // Status
    status: fromVendor("status", "item_status", "product_status", "active") ?? "on_sale",
    active: "Y",

    // Brand / Manufacturer
    brand: p.brand || (fromVendor("brand", "brand_name", "manufacturer", "maker") as string) || fromLive("brand") || "",
    brand_name: p.brand || (fromVendor("brand", "brand_name", "manufacturer") as string) || fromLive("brand") || "",
    manufacturer: p.brand || (fromVendor("manufacturer", "brand", "maker") as string) || fromLive("brand") || "",

    // Description / Details — never empty (falls back to product name)
    description: descriptionText,
    product_description: descriptionText,
    details: descriptionText,
    long_description: descriptionText,
    bullet_point1: fromVendor("bullet_point1", "bullet1", "feature1", "key_feature_1") ?? p.name ?? "",
    bullet_point2: fromVendor("bullet_point2", "bullet2", "feature2", "key_feature_2") ?? "",
    bullet_point3: fromVendor("bullet_point3", "bullet3", "feature3", "key_feature_3") ?? "",
    bullet_point4: fromVendor("bullet_point4", "bullet4", "feature4") ?? "",
    bullet_point5: fromVendor("bullet_point5", "bullet5", "feature5") ?? "",

    // Price
    price,
    standard_price: price,
    msrp: fromVendor("msrp", "list_price", "retail_price") ?? price,
    sale_price: fromVendor("sale_price", "promo_price") ?? price,
    minimum_seller_allowed_price: fromVendor("min_price", "minimum_price", "map_price") ?? price,
    maximum_seller_allowed_price: fromVendor("max_price", "maximum_price") ?? "",

    // Condition & quantity
    item_condition: "New",
    condition: "New",
    condition_type: "New",
    condition_note: "",
    quantity: fromVendor("quantity", "qty", "stock", "inventory", "available_qty", "on_hand") ?? "1",
    fulfillment_latency: fromVendor("lead_time", "fulfillment_latency", "handling_time") ?? "",

    // Dimensions
    dimensions: fromVendor("dimensions", "dims", "size", "product_size") ?? "",
    length: fromVendor("length", "item_length") ?? "",
    width: fromVendor("width", "item_width") ?? "",
    height: fromVendor("height", "item_height", "depth") ?? "",
    weight: fromVendor("weight", "item_weight", "unit_weight") ?? "",

    // Image — covers generic keys and Mathis-specific names
    image_url: p.imageUrl || fromLive("image") || "",
    imageurl: p.imageUrl || fromLive("image") || "",
    main_image_url: p.imageUrl || fromLive("image") || "",
    silo_image: p.imageUrl || fromVendor("silo_image", "image_url", "main_image", "hero_image", "primary_image") || fromLive("image") || "",
    other_image_url1: fromVendor("image_url2", "other_image_url1", "alternate_image1") ?? "",
    product_image_2_url: fromVendor("product_image_2_url", "image_url2", "image_url_2", "image2", "alternate_image1", "secondary_image") ?? "",
    product_image_3_url: fromVendor("product_image_3_url", "image_url3", "image_url_3", "image3", "alternate_image2") ?? "",
    product_image_4_url: fromVendor("product_image_4_url", "image_url4", "image_url_4", "image4", "alternate_image3") ?? "",
    product_image_5_url: fromVendor("product_image_5_url", "image_url5", "image_url_5", "image5", "alternate_image4") ?? "",
    product_image_6_url: fromVendor("product_image_6_url", "image_url6", "image_url_6", "image6", "alternate_image5") ?? "",
    product_image_7_url: fromVendor("product_image_7_url", "image_url7", "image_url_7", "image7", "alternate_image6") ?? "",
    product_image_8_url: fromVendor("product_image_8_url", "image_url8", "image_url_8", "image8", "alternate_image7") ?? "",
    product_image_9_url: fromVendor("product_image_9_url", "image_url9", "image_url_9", "image9", "alternate_image8") ?? "",
    product_image_10_url: fromVendor("product_image_10_url", "image_url10", "image_url_10", "image10", "alternate_image9") ?? "",

    // Category — always filled from AI categorisation
    category: p.marketplaceCategory ?? "",
    category_name: p.marketplaceCategory ?? "",
    feed_product_type: p.marketplaceCategory ?? "",
    item_type: p.marketplaceCategory ?? "",
    item_type_name: p.categoryPath ?? p.marketplaceCategory ?? "",
    category_path: p.categoryPath ?? p.marketplaceCategory ?? "",
    browse_node: p.categoryPath ?? "",
    product_type: p.marketplaceCategory ?? "",

    // Temu-specific technique fields — pass through vendor data if present
    customization_processing_technique: fromVendor("customization_processing_technique", "processing_technique", "technique") ?? "",
    primary_technique: fromVendor("primary_technique", "technique", "process") ?? "",
    secondary_technique: fromVendor("secondary_technique", "secondary_process") ?? "",
    customization_option: fromVendor("customization_option", "customization") ?? "",

    // More name/title aliases
    product_title: p.name || fromLive("title") || "",
    display_name: p.name || fromLive("title") || "",
    short_name: p.name || "",

    // Short / long description aliases
    short_description: (descriptionText || "").slice(0, 200),
    short_desc: (descriptionText || "").slice(0, 200),
    full_description: descriptionText,
    product_features: fromVendor("features", "product_features", "key_features", "highlights") ?? descriptionText,
    features: fromVendor("features", "product_features", "key_features", "highlights") ?? descriptionText,
    key_features: fromVendor("key_features", "features", "highlights") ?? descriptionText,
    shelf_description: descriptionText,
    site_description: descriptionText,

    // Search / keywords
    keywords: fromVendor("keywords", "tags", "search_terms", "meta_keywords") ?? "",
    tags: fromVendor("tags", "keywords", "search_terms") ?? "",
    search_terms: fromVendor("search_terms", "keywords", "tags") ?? "",

    // Price / cost aliases
    retail_price: fromVendor("retail_price", "msrp", "list_price", "rrp", "suggested_retail_price") ?? price,
    map_price: fromVendor("map_price", "minimum_advertised_price", "min_price", "map") ?? price,
    cost: fromVendor("cost", "cost_price", "wholesale_price", "vendor_price", "net_price") ?? "",
    wholesale: fromVendor("wholesale", "wholesale_price", "cost_price", "net_price") ?? "",

    // Dimension aliases (many retailer templates use "Item Width" etc.)
    item_length: fromVendor("length", "item_length", "product_length") ?? "",
    item_width: fromVendor("width", "item_width", "product_width") ?? "",
    item_height: fromVendor("height", "item_height", "product_height", "depth") ?? "",
    item_depth: fromVendor("depth", "item_depth", "height") ?? "",
    item_weight: fromVendor("weight", "item_weight", "product_weight", "unit_weight") ?? "",
    product_length: fromVendor("length", "item_length", "product_length") ?? "",
    product_width: fromVendor("width", "item_width", "product_width") ?? "",
    product_height: fromVendor("height", "item_height", "product_height") ?? "",
    product_weight: fromVendor("weight", "item_weight", "product_weight") ?? "",
    package_weight: fromVendor("package_weight", "shipping_weight", "gross_weight") ?? "",
    shipping_weight: fromVendor("shipping_weight", "package_weight", "gross_weight") ?? "",
    depth: fromVendor("depth", "item_depth", "height") ?? "",

    // Color / finish / attribute aliases
    primary_color: fromVendor("color", "colour", "primary_color", "color_name", "finish") ?? "",
    colour: fromVendor("colour", "color", "color_name") ?? "",
    color_name: fromVendor("color", "colour", "color_name") ?? "",
    finish: fromVendor("finish", "color", "colour", "surface_finish") ?? "",
    material_type: fromVendor("material", "materials", "material_type", "fabric", "fabric_type") ?? "",
    fabric: fromVendor("fabric", "material", "materials", "fabric_type") ?? "",
    product_type_keyword: p.marketplaceCategory ?? fromVendor("product_type", "item_type") ?? "",
    item_type_keyword: p.marketplaceCategory ?? fromVendor("item_type", "product_type") ?? "",

    // Misc
    merchant_catalog_number: skuId,
    unspsc_code: fromVendor("unspsc_code", "unspsc") ?? "",
    national_stock_number: fromVendor("national_stock_number", "nsn") ?? "",
    country_of_origin: fromVendor("country_of_origin", "country", "made_in", "origin") ?? "",
    material: fromVendor("material", "materials", "fabric", "composition") ?? "",
    color: fromVendor("color", "colour", "color_name") ?? "",
    size: fromVendor("size", "item_size", "dimensions") ?? "",
    age_group: fromVendor("age_group", "age", "age_range") ?? "",
    gender: fromVendor("gender", "target_gender") ?? "",
    pack_size: fromVendor("pack_size", "pack", "pieces_per_pack", "units_per_pack", "qty_per_pack") ?? "",

    // Furniture / lifestyle (Mathis Brothers and similar)
    assembly_required: fromVendor("assembly_required", "assembly", "requires_assembly", "self_assembly") ?? "",
    warranty: fromVendor("warranty", "warranty_description", "warranty_period", "warranty_info") ?? "",
    warranty_description: fromVendor("warranty_description", "warranty", "warranty_info") ?? "",
    collection: fromVendor("collection", "collection_name", "product_collection", "series") ?? "",
    style: fromVendor("style", "design_style", "furniture_style") ?? "",
    number_of_pieces: fromVendor("pieces", "number_of_pieces", "set_pieces", "quantity_per_set") ?? "",
    pieces: fromVendor("pieces", "number_of_pieces") ?? "",
  };

  if (nk in coreMap) return coreMap[nk];

  if (vd) {
    // Exact key match
    if (key in vd) { const v = vd[key]; if (v !== "" && v != null) return v; }
    // Normalized key match
    const normHit = Object.keys(vd).find((k) => normalizeKey(k) === nk);
    if (normHit) { const v = vd[normHit]; if (v !== "" && v != null) return v; }

    // Numbered image/photo field: collect ALL image-URL-like keys from vendorData sorted,
    // then return the nth one. e.g. "product_image_3_url" → n=3 → 3rd image key.
    if (nk.includes("image") || nk.includes("photo") || nk.includes("img")) {
      const imgNum = nk.match(/(\d+)/)?.[1];
      if (imgNum) {
        const n = parseInt(imgNum, 10);
        const imgKeys = Object.keys(vd)
          .filter((k) => { const nv = normalizeKey(k); return nv.includes("image") || nv.includes("photo") || nv.includes("img"); })
          .sort();
        const pick = imgKeys[n - 1];
        if (pick) { const v = vd[pick]; if (v !== "" && v != null) return v; }
      }
    }

    // Word-overlap fuzzy match — score ≥ 3 avoids false positives.
    // +2 for each template word found in vendorData key, +1 for the reverse direction.
    const nkWords = nk.split("_").filter((w) => w.length > 2);
    if (nkWords.length >= 2) {
      let fuzzyKey: string | undefined;
      let bestScore = 0;
      for (const vdKey of Object.keys(vd)) {
        const vdWords = normalizeKey(vdKey).split("_").filter((w) => w.length > 2);
        let score = 0;
        for (const w of nkWords) if (vdWords.includes(w)) score += 2;
        for (const w of vdWords) if (nkWords.includes(w)) score += 1;
        if (score > bestScore) { bestScore = score; fuzzyKey = vdKey; }
      }
      if (fuzzyKey && bestScore >= 3) { const v = vd[fuzzyKey]; if (v !== "" && v != null) return v; }
    }
  }

  // Last resort: normalized key match against liveData
  if (ld) {
    const ldHit = Object.keys(ld).find((k) => normalizeKey(k) === nk);
    if (ldHit) { const v = ld[ldHit]; if (v !== "" && v != null) return v; }
  }

  return "";
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeKey(s: string): string {
  return s.toLowerCase().replace(/[\s_\-]+/g, "_").trim();
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\- ]/g, "").trim().replace(/\s+/g, "_");
}

function x(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
