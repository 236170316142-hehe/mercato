import JSZip from "jszip";
import ExcelJS from "exceljs";
import type { Product, ExportTemplate } from "@prisma/client";

type Column = { key: string; label: string; required?: boolean };

// ── Category-split export (primary mode) ─────────────────────────────────────
// One template format → one file per product category, all bundled in a ZIP.

export async function generateCategoryZip(
  products: Product[],
  template: ExportTemplate,
  marketplace = "amazon",
): Promise<Buffer> {
  const zip = new JSZip();
  const columns = template.columns as Column[];

  const eligible = eligibleProducts(products, marketplace);

  // Group by category; uncategorized products go into "_Uncategorized"
  const groups = new Map<string, Product[]>();
  for (const p of eligible) {
    const cat = p.marketplaceCategory ?? "_Uncategorized";
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat)!.push(p);
  }

  const fileData = template.fileData ? (template.fileData as Buffer) : null;

  for (const [category, categoryProducts] of groups) {
    const fileName = sanitize(category);
    if (template.fileFormat === "csv") {
      zip.file(`${fileName}.csv`, generateCsv(categoryProducts, columns));
    } else {
      const buffer = fileData
        ? await fillTemplateXlsx(categoryProducts, columns, fileData)
        : await createXlsxFromScratch(categoryProducts, columns, category);
      zip.file(`${fileName}.xlsx`, buffer);
    }
  }

  return zip.generateAsync({ type: "nodebuffer" }) as unknown as Promise<Buffer>;
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
    // Formula rows or empty rows are data-area rows; stop at first non-literal row
    if (hasFormula || !hasLiteralText) { firstDataRow = r; break; }
  }

  // Write product rows directly into the data area, overwriting any existing
  // cell values or formula cells. This works for both plain and formula-based templates.
  for (let i = 0; i < products.length; i++) {
    const row = ws.getRow(firstDataRow + i);
    row.eachCell((cell) => { cell.value = null; });
    for (const [col, colIdx] of colIndexMap) {
      row.getCell(colIdx).value = (getProductField(products[i], col.key) ?? "") as ExcelJS.CellValue;
    }
    row.commit();
  }

  // Clear any remaining template rows beyond the products we wrote
  const lastRow = ws.lastRow?.number ?? firstDataRow;
  for (let r = firstDataRow + products.length; r <= lastRow; r++) {
    const row = ws.getRow(r);
    row.eachCell((cell) => { cell.value = null; });
    row.commit();
  }

  return wb.xlsx.writeBuffer() as unknown as Promise<Buffer>;
}

// ── Create a fresh workbook when no template file is stored ───────────────────

async function createXlsxFromScratch(
  products: Product[],
  columns: Column[],
  sheetName: string,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName.slice(0, 31));

  ws.columns = columns.map((c) => ({
    header: c.label,
    key: c.key,
    width: Math.max(c.label.length + 4, 20),
  }));

  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2E8F0" } };

  for (const p of products) {
    const row: Record<string, unknown> = {};
    for (const col of columns) {
      row[col.key] = getProductField(p, col.key) ?? "";
    }
    ws.addRow(row);
  }

  return wb.xlsx.writeBuffer() as unknown as Promise<Buffer>;
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

function getProductField(p: Product, key: string): unknown {
  const nk = normalizeKey(key);
  const vd = p.vendorData as Record<string, unknown> | null;
  const ld = p.liveData as Record<string, unknown> | null;

  // Look up from vendorData — exact match first, then normalised key
  const fromVendor = (...aliases: string[]): unknown => {
    if (!vd) return undefined;
    for (const alias of aliases) {
      const na = normalizeKey(alias);
      if (alias in vd) { const v = vd[alias]; if (v !== "" && v != null) return v; }
      const hit = Object.keys(vd).find((k) => normalizeKey(k) === na);
      if (hit !== undefined) { const v = vd[hit]; if (v !== "" && v != null) return v; }
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

    // Image
    image_url: p.imageUrl || fromLive("image") || "",
    imageurl: p.imageUrl || fromLive("image") || "",
    main_image_url: p.imageUrl || fromLive("image") || "",
    other_image_url1: fromVendor("image_url2", "other_image_url1", "alternate_image1") ?? "",

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
  };

  if (nk in coreMap) return coreMap[nk];

  // Fall back to vendorData — exact match first, then normalised key
  if (vd) {
    if (key in vd) { const v = vd[key]; if (v !== "" && v != null) return v; }
    const match = Object.keys(vd).find((k) => normalizeKey(k) === nk);
    if (match) { const v = vd[match]; if (v !== "" && v != null) return v; }
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
