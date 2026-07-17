import JSZip from "jszip";
import ExcelJS from "exceljs";
import type { Product, ExportTemplate } from "@prisma/client";

type Column = { key: string; label: string; required?: boolean };

export type TemplateRow = {
  id: string;
  name: string;
  category?: string | null;
  fileFormat: string;
  columns: unknown;
  fileData?: Buffer | null; // included when caller wants formatting/dropdowns preserved
};

// ── Flat export (non-Mathis marketplaces, no templates required) ─────────────
// Exports all products as a single Excel file with standard enriched columns.
// Used for Amazon, Walmart, Best Buy, Temu, Sears — where templates are optional.

const FLAT_COLUMNS: Column[] = [
  { key: "item_sku",             label: "Item SKU" },
  { key: "upc",                  label: "UPC" },
  { key: "asin",                 label: "ASIN" },
  { key: "name",                 label: "Product Name" },
  { key: "brand",                label: "Brand" },
  { key: "price",                label: "Price" },
  { key: "standard_price",       label: "Standard Price" },
  { key: "quantity",             label: "Quantity" },
  { key: "condition",            label: "Condition" },
  { key: "description",          label: "Description" },
  { key: "main_image_url",       label: "Main Image URL" },
  { key: "product_image_2_url",  label: "Image 2 URL" },
  { key: "product_image_3_url",  label: "Image 3 URL" },
  { key: "category",             label: "Category" },
  { key: "category_path",        label: "Category Path" },
  { key: "country_of_origin",    label: "Country of Origin" },
  { key: "item_weight",          label: "Item Weight" },
  { key: "item_length",          label: "Item Length" },
  { key: "item_width",           label: "Item Width" },
  { key: "item_height",          label: "Item Height" },
  { key: "color",                label: "Color" },
  { key: "size",                 label: "Size" },
  { key: "material",             label: "Material" },
  { key: "keywords",             label: "Keywords" },
];

export async function generateFlatExport(
  products: Product[],
  marketplace: string,
): Promise<Buffer> {
  const eligible = eligibleProducts(products, marketplace);
  const zip = new JSZip();
  const safeName = sanitize(marketplace || "export");
  const buffer = await createXlsxFromScratch(eligible, FLAT_COLUMNS, "Products");
  zip.file(`${safeName}_export.xlsx`, buffer);
  return zip.generateAsync({ type: "nodebuffer" }) as unknown as Promise<Buffer>;
}

// ── Category-split export without templates (Temu) ───────────────────────────
// Groups products by their AI-assigned marketplaceCategory and creates one
// Excel file per category using standard flat columns. No templates needed.

export async function generateFlatCategoryZip(
  products: Product[],
  marketplace: string,
): Promise<Buffer> {
  const zip = new JSZip();
  const eligible = eligibleProducts(products, marketplace);

  const groups = new Map<string, Product[]>();
  for (const p of eligible) {
    const cat = p.marketplaceCategory;
    if (!cat || cat === "Uncategorized") continue;
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat)!.push(p);
  }

  // Fall back to single flat file if nothing was categorized
  if (groups.size === 0) {
    const buffer = await createXlsxFromScratch(eligible, FLAT_COLUMNS, "Products");
    zip.file(`${sanitize(marketplace)}_export.xlsx`, buffer);
    return zip.generateAsync({ type: "nodebuffer" }) as unknown as Promise<Buffer>;
  }

  for (const [category, categoryProducts] of groups) {
    await new Promise<void>((r) => setImmediate(r));
    const fileName = sanitize(category);
    const buffer = await createXlsxFromScratch(categoryProducts, FLAT_COLUMNS, category);
    zip.file(`${fileName}.xlsx`, buffer);
  }

  return zip.generateAsync({ type: "nodebuffer" }) as unknown as Promise<Buffer>;
}

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

  // Group by category; skip products with no category or AI-flagged "Uncategorized"
  const groups = new Map<string, Product[]>();
  for (const p of eligible) {
    const cat = p.marketplaceCategory;
    if (!cat || cat === "Uncategorized") continue;
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat)!.push(p);
  }

  // Process categories sequentially with event-loop yields between each file.
  // Always use createXlsxFromScratch (JSZip, ~1MB RAM) — never fillTemplateXlsx (ExcelJS,
  // 50–200MB RAM per file). On Render's 512MB free tier, ExcelJS across multiple category
  // files causes SIGABRT OOM crashes. Column definitions still come from the matched
  // template so the correct columns are written; only visual styling is skipped.
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

// ── Single-template export (non-Mathis marketplaces with user-selected template) ─
// Exports ALL products into one file using the chosen template's column definitions.
// Uses TemplateRow (no fileData blob) so it never calls fillTemplateXlsx or blocks the event loop.

export async function generateSingleTemplateExport(
  products: Product[],
  template: TemplateRow,
  marketplace: string,
  fileData?: Buffer | null,
): Promise<Buffer> {
  const zip = new JSZip();
  const eligible = eligibleProducts(products, marketplace);
  const columns = template.columns as Column[];
  const fileName = sanitize(template.name);

  if (template.fileFormat === "csv") {
    zip.file(`${fileName}.csv`, generateCsv(eligible, columns));
  } else if (fileData) {
    // Preserve original template formatting, dropdowns, validations
    const buffer = await fillTemplateXlsx(eligible, columns, fileData);
    zip.file(`${fileName}.xlsx`, buffer);
  } else {
    const buffer = await createXlsxFromScratch(eligible, columns, template.name);
    zip.file(`${fileName}.xlsx`, buffer);
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
      const buffer = await createXlsxFromScratch(filtered, columns, template.name);
      zip.file(`${fileName}.xlsx`, buffer);
    }
  }

  return zip.generateAsync({ type: "nodebuffer" }) as unknown as Promise<Buffer>;
}

function eligibleProducts(products: Product[], _marketplace: string): Product[] {
  const anyVerified = products.some((p) => p.verifyStatus != null);
  if (!anyVerified) return products;
  // Only exclude hard API errors — ok, warning, not_found, and un-verified (null) all export.
  return products.filter((p) => p.verifyStatus !== "error");
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
  // Some templates (e.g. Temu) place hidden INSTRUCTION rows between the header and
  // the first real data row. We only want to skip past genuine instruction rows —
  // NOT a stale sample/example data row, which must be overwritten so it doesn't
  // survive in the output. Heuristic: a row is an "instruction" row (skip it) only
  // if it looks like guidance — a single populated cell, or text containing typical
  // instruction words. A row that fills most columns is stale DATA → overwrite it.
  const instructionRe = /example|required|optional|instruction|do not|enter |select |format|max |min /i;
  let firstDataRow = headerRowNum + 1;
  for (let r = headerRowNum + 1; r <= headerRowNum + 10; r++) {
    const row = ws.getRow(r);
    let hasFormula = false;
    let populated = 0;
    let looksLikeInstruction = false;
    row.eachCell((cell) => {
      const v = cell.value;
      if (v !== null && typeof v === "object" && "formula" in (v as object)) { hasFormula = true; return; }
      if (v !== null && v !== undefined && v !== "") {
        populated++;
        if (instructionRe.test(String(v))) looksLikeInstruction = true;
      }
    });
    // Formula row (Temu VLOOKUP) or empty row → data starts here, stop scanning.
    if (hasFormula || populated === 0) { firstDataRow = r; break; }
    // A sparse/instruction-looking row is guidance → skip past it.
    // A densely-filled row is stale sample data → overwrite from here.
    if (looksLikeInstruction || populated <= Math.max(1, Math.floor(colIndexMap.length / 3))) {
      firstDataRow = r + 1;
      continue;
    }
    firstDataRow = r;
    break;
  }

  // Extract dropdown validation options per 1-based column index BEFORE we clear
  // rows — resolving a range-reference dropdown (=Lists!$A$1:$A$3) reads cells
  // from the workbook, which must still be intact.
  //
  // ExcelJS stores dataValidations keyed either as a range ("D3:D10000") or, more
  // commonly, per-cell ("D10", "D11", …). Either way the leading letters give the
  // column. A list formula is one of two forms:
  //   • inline  — '"New,Used,Refurbished"'  → split on commas
  //   • range   — '=Lists!$A$1:$A$3' or 'Sheet2!$A:$A' → read the referenced cells
  const dropdownOptions = new Map<number, string[]>();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dvModel = (ws as any).dataValidations?.model ?? {};
    for (const [rangeKey, dv] of Object.entries(dvModel)) {
      const dvTyped = dv as { type?: string; formulae?: string[] };
      if (dvTyped.type !== "list" || !dvTyped.formulae?.[0]) continue;
      const colLetters = /^([A-Z]+)/i.exec(rangeKey.split(":")[0])?.[1];
      if (!colLetters) continue;
      let ci = 0;
      for (const ch of colLetters.toUpperCase()) ci = ci * 26 + (ch.charCodeAt(0) - 64);
      // First per-column formula wins (they're identical across a column's cells)
      if (dropdownOptions.has(ci)) continue;
      const opts = resolveDropdownOptions(wb, dvTyped.formulae[0]);
      if (opts.length) dropdownOptions.set(ci, opts);
    }
  } catch { /* dataValidations not accessible — skip silently */ }

  // Clear existing sample/data rows, then write products into FIXED row positions
  // starting at firstDataRow. We do NOT use ws.addRow(): data-validations extend the
  // worksheet's used range far below the real data (e.g. to row 100), so addRow would
  // append after that phantom range and leave a stale sample row plus a block of blanks.
  const lastRow = ws.lastRow?.number ?? headerRowNum;
  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    const row = ws.getRow(firstDataRow + i);
    for (const [col, colIdx] of colIndexMap) {
      const rawValue = String(getProductField(p, col.key) ?? "");
      const opts = dropdownOptions.get(colIdx);
      const cellValue = opts?.length ? pickDropdownValue(rawValue, opts) : rawValue;
      row.getCell(colIdx).value = cellValue as ExcelJS.CellValue;
    }
    row.commit();
  }

  // Blank out any leftover template rows below the data we just wrote (the old
  // sample row and any rows the previous content occupied).
  for (let r = firstDataRow + products.length; r <= lastRow; r++) {
    const row = ws.getRow(r);
    for (const [, colIdx] of colIndexMap) row.getCell(colIdx).value = null;
    row.commit();
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

  // Sheet XML — numbers written inline, strings reference shared-string index.
  // Exception: numeric strings with 10+ digits (UPCs, EANs, GTINs, numeric ASINs)
  // must be forced to shared-string cells so Excel doesn't render them as 6.36E+11.
  const rowXml = allRows.map((row, ri) => {
    const cells = row.map((val, ci) => {
      const ref = `${colLetter(ci + 1)}${ri + 1}`;
      const isLargeId = /^\d{10,}$/.test(val);
      const isNum = val !== "" && !isLargeId && !Number.isNaN(Number(val));
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
  // Marketplace product-page URL (e.g. Walmart https://www.walmart.com/ip/...),
  // built during verification and stored in liveData.productUrl. This is the
  // product listing link — NOT the image URL.
  const productPageUrl =
    (typeof ld?.productUrl === "string" && ld.productUrl) ||
    (fromVendor("product_url", "product_page_url", "listing_url", "item_url", "url") as string | undefined) ||
    "";

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

    // Amazon flat-file external ID — detect type from digit count (UPC-12, EAN-13, GTIN-14, ASIN)
    external_product_id: p.upc ?? fromVendor("upc", "ean", "barcode") ?? p.asin ?? verifiedAsin ?? "",
    external_product_id_type: (() => {
      const barcodeVal = String(p.upc ?? fromVendor("upc", "ean", "barcode") ?? "");
      if (barcodeVal) return detectUpcType(barcodeVal);
      if (p.asin || verifiedAsin) return "ASIN";
      return "";
    })(),
    product_id_type: (() => {
      const barcodeVal = String(p.upc ?? fromVendor("upc", "ean", "barcode") ?? "");
      if (barcodeVal) return detectUpcType(barcodeVal);
      if (p.asin || verifiedAsin) return "ASIN";
      return "";
    })(),

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

    // Product-page URL — Walmart "product link"/URL columns must be the listing
    // page (https://www.walmart.com/ip/...), NOT the image URL.
    product_url: productPageUrl,
    product_page_url: productPageUrl,
    product_link: productPageUrl,
    listing_url: productPageUrl,
    item_url: productPageUrl,
    item_page_url: productPageUrl,
    buy_url: productPageUrl,
    site_product_link: productPageUrl,
    url: productPageUrl,

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

    // "# of Pieces" → normalizes to "of_pieces" after stripping "#"
    of_pieces: fromVendor("pieces", "number_of_pieces", "set_pieces", "quantity_per_set") ?? "",

    // "Item #" and "Item Number" → normalizes to "item" / "item_number" → map to SKU
    item: skuId,
    item_number: skuId,

    // Retail-specific price labels
    net_price: fromVendor("net_price", "cost", "cost_price", "wholesale_price", "vendor_price") ?? "",
    list_price: fromVendor("list_price", "msrp", "retail_price", "rrp") ?? price,
    map: fromVendor("map", "map_price", "minimum_advertised_price", "min_price") ?? "",

    // Image aliases used in furniture/lifestyle templates
    lifestyle_image: fromVendor("lifestyle_image", "lifestyle_image_url", "room_scene", "room_image") || fromLive("image") || "",
    room_scene: fromVendor("room_scene", "room_scene_url", "lifestyle_image", "room_image") || fromLive("image") || "",
    hero_image: p.imageUrl || fromVendor("hero_image", "hero_image_url", "main_image", "silo_image", "image_url") || fromLive("image") || "",
    additional_image_1: fromVendor("additional_image_1", "alternate_image_1", "image_url2", "image2", "other_image1") ?? "",
    additional_image_2: fromVendor("additional_image_2", "alternate_image_2", "image_url3", "image3", "other_image2") ?? "",
    additional_image_3: fromVendor("additional_image_3", "alternate_image_3", "image_url4", "image4", "other_image3") ?? "",

    // Fabric / upholstery specific
    seat_material: fromVendor("seat_material", "seat_fabric", "upholstery_material", "fabric", "material") ?? "",
    frame_material: fromVendor("frame_material", "frame", "frame_type") ?? "",
    leg_material: fromVendor("leg_material", "legs", "leg_type") ?? "",
    fill_material: fromVendor("fill_material", "fill", "cushion_fill") ?? "",

    // Shipping / packaging
    package_length: fromVendor("package_length", "carton_length", "box_length") ?? "",
    package_width: fromVendor("package_width", "carton_width", "box_width") ?? "",
    package_height: fromVendor("package_height", "carton_height", "box_height") ?? "",

    // Misc Mathis fields
    finish_color: fromVendor("finish_color", "finish", "color", "colour") ?? "",
    seat_height: fromVendor("seat_height", "seat_h") ?? "",
    arm_height: fromVendor("arm_height", "arm_h") ?? "",
    seat_depth: fromVendor("seat_depth", "seat_d") ?? "",
    seat_width: fromVendor("seat_width", "seat_w") ?? "",
    min_height: fromVendor("min_height", "minimum_height", "collapsed_height") ?? "",
    max_height: fromVendor("max_height", "maximum_height", "extended_height") ?? "",
    number_of_drawers: fromVendor("number_of_drawers", "drawers", "num_drawers", "drawer_count") ?? "",
    number_of_shelves: fromVendor("number_of_shelves", "shelves", "num_shelves", "shelf_count") ?? "",
    number_of_doors: fromVendor("number_of_doors", "doors", "num_doors", "door_count") ?? "",
  };

  if (nk in coreMap) return coreMap[nk];

  if (vd && vdNorm) {
    // Exact key match
    if (key in vd) { const v = vd[key]; if (v !== "" && v != null) return v; }
    // O(1) normalized key match via cache
    const normV = vdNorm.get(nk);
    if (normV !== undefined) return normV;

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

/**
 * Detect whether a barcode string is UPC-A (12 digits), EAN-8/13, GTIN-14, or ASIN.
 * Returns the correct identifier type string for use in marketplace templates.
 */
function detectUpcType(raw: string): "UPC" | "EAN" | "GTIN" | "ASIN" | "" {
  if (!raw) return "";
  const s = String(raw).trim();
  if (/^B[0-9A-Z]{9}$/i.test(s)) return "ASIN";
  const digits = s.replace(/\D/g, "");
  if (digits.length === 8)  return "EAN";
  if (digits.length === 12) return "UPC";
  if (digits.length === 13) return "EAN";
  if (digits.length === 14) return "GTIN";
  return "UPC";
}

/**
 * Resolve a data-validation list formula into its option strings.
 * Handles both inline lists ('"A,B,C"') and range references
 * ('=Lists!$A$1:$A$3', 'Sheet2!$A:$A', or a same-sheet '$A$1:$A$10') by reading
 * the referenced cells from the workbook.
 */
function resolveDropdownOptions(wb: ExcelJS.Workbook, formula: string): string[] {
  const f = formula.trim().replace(/^=/, "");
  // Inline list: "New,Used,Refurbished"
  if (f.startsWith('"') && f.endsWith('"')) {
    return f.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
  }
  // Range reference, optionally sheet-qualified: [Sheet!]A1:A10 (with optional $)
  const m = /^(?:'?([^'!]+)'?!)?\$?([A-Z]+)\$?(\d+)?(?::\$?([A-Z]+)\$?(\d+)?)?$/i.exec(f);
  if (!m) return [];
  const [, sheetName, c1, r1, c2, r2] = m;
  const ws = sheetName ? wb.getWorksheet(sheetName) : wb.worksheets[0];
  if (!ws) return [];
  const colNum = (letters: string) => {
    let n = 0;
    for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n;
  };
  const startCol = colNum(c1);
  const endCol = c2 ? colNum(c2) : startCol;
  const startRow = r1 ? parseInt(r1, 10) : 1;
  // Whole-column ref (A:A) has no row bound — cap the scan at the sheet's used rows.
  const endRow = r2 ? parseInt(r2, 10) : (r1 ? startRow : (ws.lastRow?.number ?? 1));
  const opts: string[] = [];
  for (let r = Math.min(startRow, endRow); r <= Math.max(startRow, endRow); r++) {
    for (let c = Math.min(startCol, endCol); c <= Math.max(startCol, endCol); c++) {
      const v = ws.getRow(r).getCell(c).value;
      const text = v == null ? "" : typeof v === "object" && "result" in v ? String((v as { result?: unknown }).result ?? "") : String(v);
      if (text.trim()) opts.push(text.trim());
    }
  }
  return opts;
}

/**
 * Pick the best matching value from an Excel dropdown option list.
 * Preference order:
 *   1. exact (case-insensitive, punctuation-insensitive)
 *   2. whole-WORD overlap — the raw value contains the option as a distinct word
 *      (or vice-versa). This is word-boundary aware, so "used - like new" matches
 *      "Used" (a whole word) and does NOT falsely match "New" via the trailing
 *      "...new". Ties are broken by longer option, then earlier word position.
 *   3. collapsed substring — last-resort loose containment
 * Falls back to the original value (Excel flags it invalid) when nothing matches.
 */
function pickDropdownValue(raw: string, options: string[]): string {
  if (!raw || !options.length) return raw;
  const collapse = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

  const collapsedRaw = collapse(raw);
  // 1. Exact (punctuation-insensitive)
  const exact = options.find((o) => collapse(o) === collapsedRaw);
  if (exact) return exact;

  // 2. Whole-word overlap, scored
  const rawWords = words(raw);
  const rawWordSet = new Set(rawWords);
  let best: string | null = null;
  let bestScore = -1;
  for (const o of options) {
    const optWords = words(o);
    if (!optWords.length) continue;
    // How many of the option's words appear as whole words in the raw value…
    const optInRaw = optWords.filter((w) => rawWordSet.has(w)).length;
    // …and vice-versa (raw words appearing in the option)
    const optWordSet = new Set(optWords);
    const rawInOpt = rawWords.filter((w) => optWordSet.has(w)).length;
    const overlap = optInRaw + rawInOpt;
    if (overlap === 0) continue;
    // Earliest matching word position in the raw string (lower = better)
    const pos = optWords.reduce((min, w) => {
      const i = rawWords.indexOf(w);
      return i >= 0 && i < min ? i : min;
    }, Number.MAX_SAFE_INTEGER);
    // Score: overlap dominates, then earlier position, then longer option
    const score = overlap * 1000 - pos * 10 + collapse(o).length;
    if (score > bestScore) { bestScore = score; best = o; }
  }
  if (best) return best;

  // 3. Collapsed substring (loose) — either direction
  const sub = options.find((o) => {
    const c = collapse(o);
    return c && (c.includes(collapsedRaw) || collapsedRaw.includes(c));
  });
  if (sub) return sub;

  return raw; // no match — keep original; Excel will flag it as invalid
}

function normalizeKey(s: string): string {
  return s.toLowerCase()
    .replace(/\s*\([^)]*\)\s*/g, " ")   // strip parenthetical annotations: (in), (Y/N), (lbs), etc.
    .replace(/#/g, "")                   // strip "#" — "Style #" → "style ", "Item #" → "item "
    .replace(/[\s_\-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .trim();
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\- ]/g, "").trim().replace(/\s+/g, "_");
}

function x(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
