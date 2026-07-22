import JSZip from "jszip";
import type { Product, ExportTemplate } from "@prisma/client";
import { loadMathisCategoryPaths } from "../ai/mathis-taxonomy";
import { matchDropdownValues, dropdownKey, type DropdownQuery } from "../ai/match-dropdown";

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

  // Group by category first so we always produce ONE FILE PER CATEGORY.
  // Even when all categories resolve to the same fallback template, each category
  // gets its own named file (e.g. "Baby & Kids.xlsx", "Seasonal.xlsx") instead
  // of everything collapsing into a single template-named file.
  const byCategory = new Map<string, { template: TemplateRow; catLabel: string; products: Product[] }>();
  for (const p of eligible) {
    const cat = p.marketplaceCategory;
    const isUncategorized = !cat || cat === "Uncategorized";
    const catKey = isUncategorized ? `__uncategorized__` : cat;
    const tpl = isUncategorized ? fallback : findBestTemplate(cat!, templates, fallback);
    if (!byCategory.has(catKey)) byCategory.set(catKey, { template: tpl, catLabel: isUncategorized ? "" : cat!, products: [] });
    byCategory.get(catKey)!.products.push(p);
  }

  for (const [catKey, { template, catLabel, products: catProducts }] of byCategory.entries()) {
    await new Promise<void>((r) => setImmediate(r)); // yield so HTTP polls can be served

    const columns = template.columns as Column[];
    // Name the file after the category (e.g. "Baby & Kids.xlsx"), falling back to
    // the template name for uncategorized products.
    const fileName = catKey === "__uncategorized__" ? sanitize(template.name) : sanitize(catLabel);

    if (template.fileFormat === "csv") {
      zip.file(`${fileName}.csv`, generateCsv(catProducts, columns));
    } else if (template.fileData) {
      const buffer = await fillTemplateXlsx(catProducts, columns, template.fileData as Buffer, marketplace);
      zip.file(`${fileName}.xlsx`, buffer);
    } else {
      const buffer = await createXlsxFromScratch(catProducts, columns, catLabel || template.name);
      zip.file(`${fileName}.xlsx`, buffer);
    }
  }

  return zip.generateAsync({ type: "nodebuffer" }) as unknown as Promise<Buffer>;
}

// Pick the best-matching template for a category using word-overlap scoring.
// Falls back to the provided default when no template scores above zero.
//
// For taxonomy paths like "Furniture > Living Room > Sofas", the department
// (first segment) is the primary signal — matching export templates by leaf
// words (e.g. "Kitchen" inside "Organization > Kitchen > …") caused wrong files.
export function findBestTemplate<T extends { id: string; name: string; category?: string | null }>(
  category: string,
  templates: T[],
  fallback: T,
): T {
  if (templates.length <= 1) return fallback;

  // Fold accents so "Décor" ↔ "Decor", then strip to alphanumerics.
  const fold = (s: string) =>
    s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const norm = (s: string) => fold(s).replace(/[^a-z0-9]+/g, " ").trim();

  // Prefer matching on the department (level-1) of a "A > B > C" path.
  const department = category.split(/\s*>\s*/)[0]?.trim() || category;
  const normDept = norm(department);
  const normCat = norm(category);
  const catWords = normCat.split(" ").filter((w) => w.length > 2);

  let best = fallback;
  let bestScore = 0;

  for (const t of templates) {
    const normName = norm(t.name);
    const normCatField = t.category ? norm(t.category) : normName;
    // Strip trailing digits from template names like "Decor 1" / "Decor 2"
    const bareName = normName.replace(/\s+\d+$/, "").trim();
    const target = normCatField || bareName || normName;
    const targetWords = target.split(" ").filter((w) => w.length > 2);

    let score = 0;

    // Strong department match (most important for Mathis/Temu taxonomy paths)
    if (target === normDept || bareName === normDept) score += 20;
    else if (normDept.startsWith(target) || target.startsWith(normDept)) score += 12;
    // "Mattress" ↔ "Mattresses", "Decor" ↔ "Decorative" stem-ish: shared prefix ≥5 chars
    else if (
      (target.length >= 5 && normDept.startsWith(target.slice(0, 5))) ||
      (normDept.length >= 5 && target.startsWith(normDept.slice(0, 5)))
    ) {
      score += 10;
    }

    for (const word of catWords) if (targetWords.includes(word)) score += 2;
    for (const word of targetWords) if (catWords.includes(word)) score += 1;
    if (target.includes(normCat)) score += 5;
    if (normCat.includes(target)) score += 3;
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
    const buffer = await fillTemplateXlsx(eligible, columns, fileData, marketplace);
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
    } else if (fileData) {
      const buffer = await fillTemplateXlsx(filtered, columns, fileData, marketplace);
      zip.file(`${fileName}.xlsx`, buffer);
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

// Fallback when the uploaded template can't be parsed. Produces a bare workbook
// with none of the template's styling, structure, or dropdown validations — so
// it always logs WHY, otherwise the degradation is invisible and surfaces later
// as "the downloaded file doesn't match the template I uploaded".
function bailToScratch(
  products: Product[],
  columns: Column[],
  marketplace: string,
  reason: string,
): Promise<Buffer> {
  console.warn(
    `[export] Template preservation failed${marketplace ? ` (${marketplace})` : ""}: ${reason}. ` +
    `Falling back to a generated workbook — original formatting and dropdowns will be lost.`,
  );
  return createXlsxFromScratch(products, columns, "Sheet1");
}

// ── Fill existing template file with product rows ─────────────────────────────
// Uses pure JSZip + XML string manipulation — no ExcelJS.
// Memory cost: ~3–5× template file size (vs ExcelJS at 50–200×, which OOMs on
// Render's 512MB free tier). All original formatting is preserved verbatim:
// styles, column widths, frozen panes, merged cells, dropdown validations,
// conditional formatting — nothing in the XML is touched except <sheetData> rows.

async function fillTemplateXlsx(
  products: Product[],
  columns: Column[],
  fileData: Buffer,
  marketplace = "",
): Promise<Buffer> {
  const tplZip = await JSZip.loadAsync(fileData);

  // ── Locate target worksheet ────────────────────────────────────────────────
  const relsXml = await tplZip.file("xl/_rels/workbook.xml.rels")?.async("string") ?? "";
  const rIdToTarget = new Map<string, string>();
  // Order-independent: extract Id= and Target= from each <Relationship> regardless of attribute order
  for (const m of relsXml.matchAll(/<Relationship\b([^>]+)/gi)) {
    const attrStr = m[1];
    const idM = attrStr.match(/\bId="([^"]+)"/i);
    const tgtM = attrStr.match(/\bTarget="([^"]+)"/i);
    if (idM && tgtM) {
      const t = tgtM[1];
      rIdToTarget.set(idM[1], t.startsWith("xl/") ? t : `xl/${t}`);
    }
  }
  const wbXml = await tplZip.file("xl/workbook.xml")?.async("string") ?? "";
  // Order-independent: extract name= and r:id= from each <sheet> regardless of attribute order
  const sheetDefs = [...wbXml.matchAll(/<sheet\b([^>]+)/gi)].map(m => ({
    name: m[1].match(/\bname="([^"]*)"/i)?.[1] ?? "",
    rId:  m[1].match(/\br:id="([^"]*)"/i)?.[1] ?? "",
  })).filter(sd => sd.name && sd.rId);

  // name→path map for resolving dropdown range references (=Lists!$A$1:$A$10)
  const sheetNameToPath = new Map<string, string>();
  for (const sd of sheetDefs) {
    const p = rIdToTarget.get(sd.rId);
    if (p) sheetNameToPath.set(sd.name.toLowerCase(), p);
  }

  const targetDef = sheetDefs.find(s => /^template$/i.test(s.name)) ?? sheetDefs[0];
  const sheetPath = targetDef ? rIdToTarget.get(targetDef.rId) : null;
  if (!sheetPath || !tplZip.file(sheetPath)) {
    return bailToScratch(
      products, columns, marketplace,
      `no usable worksheet found (sheets: ${sheetDefs.map(s => s.name).join(", ") || "none"})`,
    );
  }
  let sheetXml = await tplZip.file(sheetPath)!.async("string");

  // ── Shared strings ─────────────────────────────────────────────────────────
  // Keep original <si> XML elements verbatim so rich-text formatting (bold,
  // colored text, fonts) in template header cells is fully preserved.
  // New plain-text entries for product data are appended after the originals.
  const ssPath = "xl/sharedStrings.xml";
  const existingSsXml = await tplZip.file(ssPath)?.async("string") ?? "";
  const originalSiXmls: string[] = [];   // raw inner XML of each <si>, kept as-is
  const ssArr: string[] = [];            // plain-text equivalent (for header parsing & dropdown resolution)
  for (const m of existingSsXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    originalSiXmls.push(m[1]);
    ssArr.push(extractSsText(m[1]));
  }
  const ssMap = new Map<string, number>(ssArr.map((s, i) => [s, i]));
  const newSiTexts: string[] = [];       // product-data values appended as plain text
  const ssIdx = (s: string): number => {
    let i = ssMap.get(s);
    if (i !== undefined) return i;
    i = originalSiXmls.length + newSiTexts.length;
    ssMap.set(s, i);
    newSiTexts.push(s);
    return i;
  };

  // ── Parse header row ───────────────────────────────────────────────────────
  const sdMatch = sheetXml.match(/<sheetData>([\s\S]*?)<\/sheetData>/);
  if (!sdMatch) return bailToScratch(products, columns, marketplace, "template sheet has no <sheetData> block");
  const rowMatches = [...sdMatch[1].matchAll(/<row\b[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)];

  // Header = row with the most literal (non-formula) cells
  let headerRowNum = 1;
  let headerRowXml = "";
  let maxLiteral = 0;
  for (const rm of rowMatches) {
    const count = (rm[0].match(/<c\b/g)?.length ?? 0) - (rm[0].match(/<f>/g)?.length ?? 0);
    if (count > maxLiteral) { maxLiteral = count; headerRowNum = parseInt(rm[1]); headerRowXml = rm[0]; }
  }
  if (!headerRowXml) return bailToScratch(products, columns, marketplace, "could not identify a header row in the template");

  // Map column letter → header label (resolve shared-string refs)
  const colLetterToHeader = new Map<string, string>();
  for (const cm of headerRowXml.matchAll(/<c\b[^>]*\br="([A-Z]+)\d+"([^>]*)>([\s\S]*?)<\/c>/g)) {
    const [, letter, attrs, content] = cm;
    const vVal = content.match(/<v>(\d+)<\/v>/)?.[1] ?? "";
    const tVal = content.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? "";
    const label = /\bt="s"/.test(attrs) && vVal ? (ssArr[parseInt(vVal)] ?? "") : xmlUnescape(tVal || vVal);
    if (label) colLetterToHeader.set(letter, label);
  }

  // ── Map template columns to our column definitions ─────────────────────────
  type ColEntry = { col: Column; letter: string };
  const colEntries: ColEntry[] = [];
  for (const col of columns) {
    for (const [letter, header] of colLetterToHeader) {
      if (normalizeKey(header) === normalizeKey(col.label) || normalizeKey(header) === normalizeKey(col.key)) {
        colEntries.push({ col, letter });
        break;
      }
    }
  }
  if (colEntries.length === 0) {
    // The most common cause of a "downloaded file doesn't match my template" report:
    // the template's header labels don't normalize-match the stored column
    // definitions, so the original workbook (styles, dropdowns, structure) is
    // discarded. Log both sides so the mismatch is diagnosable from the template.
    return bailToScratch(
      products, columns, marketplace,
      `no template header matched the stored column definitions — ` +
      `template headers: [${[...colLetterToHeader.values()].join(" | ")}] ; ` +
      `expected columns: [${columns.map(c => c.label ?? c.key).join(" | ")}]`,
    );
  }

  // OOXML requires cells within a row to appear in left-to-right column order
  colEntries.sort((a, b) => {
    if (a.letter.length !== b.letter.length) return a.letter.length - b.letter.length;
    return a.letter.localeCompare(b.letter);
  });

  // ── Dropdown options from dataValidations ──────────────────────────────────
  // Parse ALL dataValidation blocks first, then filter to type="list".
  // The old regex required type= to precede sqref= in the attribute list —
  // OOXML doesn't guarantee attribute order so some templates were missed.
  const dropdowns = new Map<string, string[]>(); // column letter → options
  for (const dv of sheetXml.matchAll(/<dataValidation\b([^>]*?)>([\s\S]*?)<\/dataValidation>/g)) {
    const attrs = dv[1];
    const body  = dv[2];
    if (!/\btype="list"/i.test(attrs)) continue;
    const sqrefVal = attrs.match(/\bsqref="([^"]+)"/i)?.[1];
    if (!sqrefVal) continue;
    // sqref can be a space-separated list of ranges; extract every unique column letter
    const letters = [...new Set([...sqrefVal.matchAll(/([A-Z]+)\d*/gi)].map(m => m[1].toUpperCase()))];
    if (!letters.length) continue;
    // XML-unescape formula1 (some exporters write &quot; instead of ")
    const rawFormula = body.match(/<formula1[^>]*>([\s\S]*?)<\/formula1>/i)?.[1]?.trim() ?? "";
    const formula = xmlUnescape(rawFormula);
    let opts: string[] = [];
    if (formula.startsWith('"') && formula.endsWith('"')) {
      // Inline list: "Yes,No" or "New,Used,Refurbished"
      opts = formula.slice(1, -1).split(",").map(s => s.trim()).filter(Boolean);
    } else if (formula) {
      // Range reference: Lists!$A$1:$A$10 or =Sheet2!$B:$B
      opts = await resolveXmlRangeDropdown(tplZip, formula.replace(/^=/, ""), sheetNameToPath, ssArr);
    }
    if (opts.length) {
      for (const letter of letters) {
        if (!dropdowns.has(letter)) dropdowns.set(letter, opts);
      }
    }
  }

  // ── Category-column fallback (Mathis only) ────────────────────────────────
  // When the template's range-based category dropdown can't be resolved (sheet
  // name mismatch, encoding issue, etc.) seed it from the Mathis taxonomy CSV.
  // Only applies to Mathis exports — other marketplaces write category as plain
  // text and don't need a forced dropdown option list.
  const isMathis = marketplace.toLowerCase() === "mathis";
  if (isMathis) {
    const catEntry = colEntries.find(({ col }) =>
      normalizeKey(col.key) === "category" || normalizeKey(col.label) === "category"
    );
    if (catEntry && !dropdowns.has(catEntry.letter)) {
      try {
        const paths = loadMathisCategoryPaths();
        const mathisPaths = paths.map(p => "Mathis Home/" + p.split(" > ").map(s => s.trim()).join("/"));
        if (mathisPaths.length) dropdowns.set(catEntry.letter, mathisPaths);
      } catch { /* CSV unavailable — leave column without forced dropdown */ }
    }
  }

  // ── Find first actual data row (skip multi-row headers) ───────────────────
  // Mathis templates have two green header rows:
  //   Row 1 = human-readable labels  (Category, Shop SKU, …)
  //   Row 2 = internal field codes   (category, shopSKU, DIMH, …)  ← MUST be preserved
  //   Row 3+ = pink data-entry rows  ← where product data goes
  // Detect all consecutive "header-styled" rows after headerRowNum and skip them.
  const headerStyles = new Set<string>();
  for (const cm of headerRowXml.matchAll(/\bs="(\d+)"/g)) headerStyles.add(cm[1]);

  let firstDataRowNum = headerRowNum + 1;
  for (const rm of rowMatches) {
    const rn = parseInt(rm[1]);
    if (rn <= headerRowNum) continue;
    // Count how many cells in this row carry a header-type style vs. a different style
    const cellStylesInRow = [...rm[0].matchAll(/\bs="(\d+)"/g)].map(m => m[1]);
    const nonHeaderCells = cellStylesInRow.filter(s => !headerStyles.has(s)).length;
    if (cellStylesInRow.length > 0 && nonHeaderCells === 0) {
      // Every cell has a header style → this is a subheader / field-code row, keep it
      firstDataRowNum = rn + 1;
    } else {
      // First row with different (data) styling — this is where products go
      firstDataRowNum = rn;
      break;
    }
  }

  // ── Build output rows using the template's own pre-formatted rows ──────────
  // Index all rows starting from firstDataRowNum; these carry the pink cell styles.
  const allDataRows = new Map<number, string>();
  for (const rm of rowMatches) {
    const rn = parseInt(rm[1]);
    if (rn >= firstDataRowNum) allDataRows.set(rn, rm[0]);
  }

  // Borrow pink style from the first actual data row for rows beyond the template.
  const borrowedStyle = new Map<string, string>(); // letter → s-index
  for (const cm of (allDataRows.get(firstDataRowNum) ?? "").matchAll(/<c\b[^>]*\br="([A-Z]+)\d+"([^>]*)/g)) {
    const s = cm[2].match(/\bs="(\d+)"/)?.[1];
    if (s) borrowedStyle.set(cm[1], s);
  }

  const outputRows: string[] = [];

  // ── Dropdown-constrained values ────────────────────────────────────────────
  // Every column carrying a dataValidation list MUST receive one of its own options
  // verbatim, otherwise the marketplace rejects the row on import. Resolution order:
  //   1. pickDropdownValue — deterministic (exact → word overlap → substring)
  //   2. AI nearest-compatible match, for values with no lexical overlap
  //      ("Charcoal" → "Grey", "Boucle" → "Fabric")
  //   3. Blank — better an empty optional cell than an invalid value
  // The raw value is never written through to a dropdown column.

  // Normalize a path-style value ("A > B") to the slash form Mathis dropdowns use.
  const toDropdownRaw = (raw: string): string =>
    (raw.includes(" > ") && !raw.includes("/"))
      ? (isMathis
          ? "Mathis Home/" + raw.split(" > ").map(s => s.trim()).join("/")
          : raw.split(" > ").map(s => s.trim()).join("/"))
      : raw;

  // Pass 1 — collect values the deterministic matcher could not place.
  const aiQueries: DropdownQuery[] = [];
  for (const p of products) {
    for (const { col, letter } of colEntries) {
      const options = dropdowns.get(letter);
      if (!options) continue;
      const raw = String(getProductField(p, col.key) ?? "");
      if (!raw.trim()) continue;
      const candidate = toDropdownRaw(raw);
      if (pickDropdownValue(candidate, options) === null) {
        aiQueries.push({ column: colLetterToHeader.get(letter) ?? col.label ?? col.key, value: candidate, options });
      }
    }
  }
  const aiMatches = aiQueries.length ? await matchDropdownValues(aiQueries) : new Map<string, string>();

  // Compute the final value for a column (dropdown-safe)
  const colVal = (p: Product, col: Column, letter: string): string => {
    const raw = String(getProductField(p, col.key) ?? "");
    const options = dropdowns.get(letter);
    if (!options) return raw;
    if (!raw.trim()) return "";
    const candidate = toDropdownRaw(raw);
    const picked = pickDropdownValue(candidate, options);
    if (picked !== null) return picked;
    // Deterministic matching failed — use the AI match, else blank the cell.
    const header = colLetterToHeader.get(letter) ?? col.label ?? col.key;
    return aiMatches.get(dropdownKey(header, candidate)) ?? "";
  };

  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    const rn = firstDataRowNum + i;
    const tplRow = allDataRows.get(rn);

    if (tplRow) {
      // ── In-place modification: keep ALL original cells (preserves every s="N" style,
      // border, background colour, merge, etc.) then patch only our data columns. ──
      // Step 1: clear all cell values (same logic as the "clear excess rows" below)
      let rowXml = tplRow
        .replace(/<v>[\s\S]*?<\/v>/g, "")
        .replace(/<f>[\s\S]*?<\/f>/g, "")
        .replace(/<is>[\s\S]*?<\/is>/g, "")
        .replace(/\s*\bt="[^"]*"/g, "")
        .replace(/<c\b([^>]*)><\/c>/g, "<c$1/>");

      // Step 2: write product values into the relevant cells
      for (const { col, letter } of colEntries) {
        const val = colVal(p, col, letter);
        const ref = `${letter}${rn}`;
        const isLargeId = /^\d{10,}$/.test(val);
        const isNum = val !== "" && !isLargeId && !Number.isNaN(Number(val));

        // Match either self-closing <c r="X1" s="N"/> or paired <c r="X1" s="N">…</c>
        const cellPat = new RegExp(`<c\\b([^>]*\\br="${ref}"[^>]*)(?:/>|>[\\s\\S]*?<\\/c>)`);
        const cm = rowXml.match(cellPat);

        let newCell: string;
        if (val === "") {
          newCell = cm ? `<c${cm[1]}/>` : "";
        } else if (isNum) {
          newCell = cm ? `<c${cm[1]}><v>${x(val)}</v></c>` : `<c r="${ref}"><v>${x(val)}</v></c>`;
        } else {
          newCell = cm ? `<c${cm[1]} t="s"><v>${ssIdx(val)}</v></c>` : `<c r="${ref}" t="s"><v>${ssIdx(val)}</v></c>`;
        }

        if (cm) {
          rowXml = rowXml.replace(cm[0], newCell);
        } else if (newCell) {
          // Cell not in template — append before </row> (rare; Excel will auto-sort on open)
          rowXml = rowXml.replace("</row>", `${newCell}</row>`);
        }
      }
      outputRows.push(rowXml);
    } else {
      // No template row at this position — build a new row with borrowed styles
      const getStyle = (letter: string) => {
        const s = borrowedStyle.get(letter);
        return s ? ` s="${s}"` : "";
      };
      const cells = colEntries.map(({ col, letter }) => {
        const val = colVal(p, col, letter);
        const ref = `${letter}${rn}`;
        const isLargeId = /^\d{10,}$/.test(val);
        const sAttr = getStyle(letter);
        if (val !== "" && !isLargeId && !Number.isNaN(Number(val))) {
          return `<c r="${ref}"${sAttr}><v>${x(val)}</v></c>`;
        }
        return `<c r="${ref}"${sAttr} t="s"><v>${ssIdx(val)}</v></c>`;
      }).join("");
      outputRows.push(`<row r="${rn}">${cells}</row>`);
    }
  }

  // Remaining pre-formatted rows beyond the product count — clear values but
  // keep row structure and pink cell styles (empty input area stays styled).
  const maxTplRow = allDataRows.size > 0 ? Math.max(...allDataRows.keys()) : firstDataRowNum;
  for (let rn = firstDataRowNum + products.length; rn <= maxTplRow; rn++) {
    const tplRow = allDataRows.get(rn);
    if (!tplRow) continue;
    const cleared = tplRow
      .replace(/<v>[\s\S]*?<\/v>/g, "")
      .replace(/<f>[\s\S]*?<\/f>/g, "")
      .replace(/<is>[\s\S]*?<\/is>/g, "")
      .replace(/\s*\bt="[^"]*"/g, "")
      .replace(/<c\b([^>]*)><\/c>/g, "<c$1/>");
    outputRows.push(cleared);
  }

  // Assemble sheetData: ALL rows before firstDataRowNum (both header rows) + output rows
  const keptRows = rowMatches.filter(rm => parseInt(rm[1]) < firstDataRowNum).map(rm => rm[0]).join("");
  sheetXml = sheetXml.replace(/<sheetData>[\s\S]*?<\/sheetData>/, `<sheetData>${keptRows}${outputRows.join("")}</sheetData>`);

  // ── Expand TABLE and autoFilter refs to cover all exported data rows ────────
  // Template colours usually come from the TABLE style (not per-cell s="N").
  // If the table's ref ends before our last data row those rows appear plain white.
  // Parse the table ref, keep the column span, extend the end row.
  const lastDataRow = firstDataRowNum - 1 + products.length;

  // Helper: given a ref like "A1:AA10", extend the end-row to lastDataRow → "A1:AA5"
  const extendRef = (ref: string): string => {
    const m = ref.match(/^([A-Z]+)(\d+):([A-Z]+)\d+$/i);
    if (!m) return ref;
    return `${m[1]}${m[2]}:${m[3]}${lastDataRow}`;
  };

  // Update xl/tables/*.xml — table ref + its nested autoFilter ref
  for (const [fpath, fobj] of Object.entries(tplZip.files)) {
    if (!/^xl\/tables\/[^/]+\.xml$/i.test(fpath)) continue;
    let tblXml = await fobj.async("string");
    tblXml = tblXml.replace(/(<table\b[^>]*\bref=")([^"]+)(")/i, (_, pre, ref, post) => `${pre}${extendRef(ref)}${post}`);
    tblXml = tblXml.replace(/(<autoFilter\b[^>]*\bref=")([^"]+)(")/i, (_, pre, ref, post) => `${pre}${extendRef(ref)}${post}`);
    tplZip.file(fpath, tblXml);
  }

  // Also update the sheet-level <autoFilter> (some templates skip xl/tables/ entirely)
  sheetXml = sheetXml.replace(/(<autoFilter\b[^>]*\bref=")([^"]+)(")/i, (_, pre, ref, post) => `${pre}${extendRef(ref)}${post}`);

  // ── Write modified files back into the ZIP ─────────────────────────────────
  tplZip.file(sheetPath, sheetXml);

  // Write back: original <si> elements preserved verbatim (rich text intact),
  // followed by new plain-text entries for product data values.
  const totalSs = originalSiXmls.length + newSiTexts.length;
  const newSsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${totalSs}" uniqueCount="${totalSs}">
${originalSiXmls.map(si => `<si>${si}</si>`).join("")}${newSiTexts.map(s => `<si><t xml:space="preserve">${x(s)}</t></si>`).join("")}</sst>`;
  tplZip.file(ssPath, newSsXml);

  // Register sharedStrings in [Content_Types].xml if the template omitted it
  const ctXml = await tplZip.file("[Content_Types].xml")?.async("string") ?? "";
  if (ctXml && !ctXml.includes("sharedStrings")) {
    tplZip.file("[Content_Types].xml", ctXml.replace(
      "</Types>",
      `<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`,
    ));
  }

  return tplZip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }) as unknown as Promise<Buffer>;
}

/** Resolve a dataValidation range reference (e.g. =Lists!$A$1:$A$10) by reading
 *  cells from the referenced sheet in the template ZIP. */
async function resolveXmlRangeDropdown(
  tplZip: JSZip,
  formula: string,
  sheetNameToPath: Map<string, string>,
  ssArr: string[],
): Promise<string[]> {
  const m = /^(?:'?([^'!]+)'?!)?\$?([A-Z]+)\$?(\d+)?(?::\$?[A-Z]+\$?(\d+)?)?$/i.exec(formula);
  if (!m) return [];
  const [, sheetName, colLetter, r1, r2] = m;
  const path = sheetName ? sheetNameToPath.get(sheetName.toLowerCase()) : null;
  if (!path) return [];
  const xml = await tplZip.file(path)?.async("string") ?? "";
  if (!xml) return [];
  const startRow = r1 ? parseInt(r1) : 1;
  const endRow = r2 ? parseInt(r2) : 9999;
  const targetCol = colLetter.toUpperCase();
  const opts: string[] = [];
  for (const rm of xml.matchAll(/<row\b[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const rn = parseInt(rm[1]);
    if (rn < startRow || rn > endRow) continue;
    for (const cm of rm[2].matchAll(/<c\b[^>]*\br="([A-Z]+)\d+"([^>]*)>([\s\S]*?)<\/c>/g)) {
      if (cm[1].toUpperCase() !== targetCol) continue;
      const isShared = /\bt="s"/.test(cm[2]);
      const vVal = cm[3].match(/<v>(\d+)<\/v>/)?.[1] ?? "";
      const tVal = cm[3].match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? "";
      const val = isShared && vVal ? (ssArr[parseInt(vVal)] ?? "") : xmlUnescape(tVal || vVal);
      if (val.trim()) opts.push(val.trim());
    }
  }
  return opts;
}

/** Extract plain text from a shared-string <si> element (handles simple + rich text). */
function extractSsText(siXml: string): string {
  const runs = [...siXml.matchAll(/<r>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>[\s\S]*?<\/r>/g)];
  if (runs.length) return runs.map(m => xmlUnescape(m[1])).join("");
  const tMatch = siXml.match(/<t[^>]*>([\s\S]*?)<\/t>/);
  return tMatch ? xmlUnescape(tMatch[1]) : "";
}

function xmlUnescape(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
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
  const productId = p.upc ?? p.vendorSku ?? anyVendorId ?? p.asin ?? verifiedAsin ?? p.id;

  // SKU columns must carry the SELLER'S OWN item code — never a barcode. A UPC/EAN/GTIN
  // is a global product identifier and belongs only in the UPC column; writing it into
  // SKU produced Mathis files where the SKU column was full of barcodes. So the SKU
  // fallback chain deliberately excludes p.upc, and any purely-numeric 8–14 digit
  // candidate (i.e. a barcode that leaked into a vendor "item no" column) is rejected.
  const looksLikeBarcode = (v: unknown): boolean => /^\d{8,14}$/.test(String(v ?? "").trim());
  const skuId = [p.vendorSku, anyVendorId].find((v) => v != null && String(v).trim() !== "" && !looksLikeBarcode(v))
    ?? p.id;

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

    // Brand / Manufacturer / Trademark
    // Live data is authoritative: marketplace brand ("iStep") beats vendor company code ("APS").
    // Walmart uses brandName, Amazon/Keepa uses brand — check both.
    brand: (fromLive("brand") as string) || (fromLive("brandName") as string) || p.brand || (fromVendor("brand", "brand_name", "manufacturer", "maker", "trademark") as string) || "",
    brand_name: (fromLive("brand") as string) || (fromLive("brandName") as string) || p.brand || (fromVendor("brand", "brand_name", "manufacturer") as string) || "",
    manufacturer: (fromLive("brand") as string) || (fromLive("brandName") as string) || p.brand || (fromVendor("manufacturer", "brand", "maker") as string) || "",
    // Temu uses "Trademark" for the brand column
    trademark: (fromLive("brand") as string) || (fromLive("brandName") as string) || p.brand || (fromVendor("trademark", "brand", "brand_name", "manufacturer") as string) || "",

    // Description / Details — never empty (falls back to product name)
    description: descriptionText,
    product_description: descriptionText,
    details: descriptionText,
    long_description: descriptionText,
    // Bullet points — cover numbered ("Bullet Point 1") and unnumbered ("Bullet Points") variants
    bullet_point1: fromVendor("bullet_point1", "bullet_point_1", "bullet1", "feature1", "key_feature_1") ?? p.name ?? "",
    bullet_point2: fromVendor("bullet_point2", "bullet_point_2", "bullet2", "feature2", "key_feature_2") ?? "",
    bullet_point3: fromVendor("bullet_point3", "bullet_point_3", "bullet3", "feature3", "key_feature_3") ?? "",
    bullet_point4: fromVendor("bullet_point4", "bullet_point_4", "bullet4", "feature4") ?? "",
    bullet_point5: fromVendor("bullet_point5", "bullet_point_5", "bullet5", "feature5") ?? "",
    bullet_points: fromVendor("bullet_points", "bullet_point1", "bullet1", "feature1") ?? p.name ?? "",

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

    // Category — filled from AI categorisation; blank for "Uncategorized" so no junk text in the cell
    category: (p.marketplaceCategory && p.marketplaceCategory !== "Uncategorized") ? p.marketplaceCategory : "",
    category_name: (p.marketplaceCategory && p.marketplaceCategory !== "Uncategorized") ? p.marketplaceCategory : "",
    feed_product_type: (p.marketplaceCategory && p.marketplaceCategory !== "Uncategorized") ? p.marketplaceCategory : "",
    item_type: (p.marketplaceCategory && p.marketplaceCategory !== "Uncategorized") ? p.marketplaceCategory : "",
    item_type_name: p.categoryPath ?? ((p.marketplaceCategory && p.marketplaceCategory !== "Uncategorized") ? p.marketplaceCategory : ""),
    category_path: p.categoryPath ?? ((p.marketplaceCategory && p.marketplaceCategory !== "Uncategorized") ? p.marketplaceCategory : ""),
    browse_node: p.categoryPath ?? "",
    product_type: (p.marketplaceCategory && p.marketplaceCategory !== "Uncategorized") ? p.marketplaceCategory : "",

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
    product_image_1_url: p.imageUrl || fromVendor("silo_image", "silo image", "main_image_url", "image_url", "image") || fromLive("image") || "",

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

    // ── Walmart / Best Buy / multi-marketplace fields ────────────────────────
    // Manufacturer Part Number — universal across Walmart, Best Buy, Amazon
    mpn: fromVendor("mpn", "mfr_part_number", "manufacturer_part_number", "model_number", "model_no", "part_number") ?? "",
    manufacturer_part_number: fromVendor("manufacturer_part_number", "mpn", "mfr_part_number", "part_number", "model_number") ?? "",
    mfr_part_number: fromVendor("mpn", "mfr_part_number", "manufacturer_part_number", "model_number") ?? "",
    model_number: fromVendor("model_number", "model_no", "mpn", "model", "part_number") ?? "",
    model_name: fromVendor("model_name", "model", "model_number") ?? "",

    // Walmart-specific operational fields (safe defaults for new listings)
    fulfillment_type: fromVendor("fulfillment_type", "fulfillment", "shipping_type") ?? "3P",
    is_bundle: fromVendor("is_bundle", "bundle", "is_set") ?? "No",
    is_adult_product: fromVendor("is_adult", "is_adult_product", "adult") ?? "No",
    is_gift_wrap_available: fromVendor("gift_wrap", "is_gift_wrap_available") ?? "No",
    is_gift_message_available: fromVendor("gift_message", "is_gift_message_available") ?? "No",
    tax_code: fromVendor("tax_code", "tax_category", "tax_class") ?? "",
    site_start_date: fromVendor("site_start_date", "start_date", "launch_date") ?? "",
    site_end_date: fromVendor("site_end_date", "end_date") ?? "",
    ship_node: fromVendor("ship_node", "warehouse", "location") ?? "",
    multi_pack_quantity: fromVendor("multi_pack_quantity", "pack_size", "pack", "pieces_per_pack") ?? "1",
    minimum_order_quantity: fromVendor("minimum_order_quantity", "min_order_qty", "min_qty", "moq") ?? "1",

    // Compliance / regulatory (Mathis Prop-65, general marketplace compliance)
    prop_65: fromVendor("prop_65", "prop65", "california_prop_65", "proposition_65") ?? "",
    prop_65_chemical: fromVendor("prop_65_chemical", "chemical_name", "prop65_chemical") ?? "",
    made_in_usa: fromVendor("made_in_usa", "made_in_u_s_a", "us_made", "domestic") ?? "",
    flammability: fromVendor("flammability", "flammability_standard", "fire_rating") ?? "",
    certifications: fromVendor("certifications", "certification", "safety_certification") ?? "",

    // Best Buy / electronics-specific
    wireless: fromVendor("wireless", "is_wireless", "wifi", "bluetooth") ?? "",
    battery_life: fromVendor("battery_life", "battery_hours", "runtime") ?? "",
    connectivity: fromVendor("connectivity", "connection_type", "interface") ?? "",
    resolution: fromVendor("resolution", "display_resolution", "screen_resolution") ?? "",
    screen_size: fromVendor("screen_size", "display_size", "screen_diagonal") ?? "",
    storage_capacity: fromVendor("storage_capacity", "storage", "hard_drive", "memory") ?? "",
    processor: fromVendor("processor", "cpu", "processor_type", "chip") ?? "",
    operating_system: fromVendor("operating_system", "os") ?? "",

    // Temu / apparel / lifestyle
    pattern: fromVendor("pattern", "pattern_type", "print") ?? "",
    occasion: fromVendor("occasion", "use_occasion", "application") ?? "",
    season: fromVendor("season", "seasons") ?? "",
    room_type: fromVendor("room_type", "room", "room_style") ?? "",
    shape: fromVendor("shape", "product_shape") ?? "",
    closure_type: fromVendor("closure_type", "closure", "fastening") ?? "",
    care_instructions: fromVendor("care_instructions", "care", "washing_instructions", "cleaning") ?? "",
    number_of_items: fromVendor("number_of_items", "items_per_set", "pieces", "number_of_pieces") ?? "",
    voltage: fromVendor("voltage", "operating_voltage", "power_supply") ?? "",
    wattage: fromVendor("wattage", "power_watts", "watts") ?? "",

    // ── Walmart template column aliases ─────────────────────────────────────
    // "ProductId1" / "Product Id 1" → external product ID value (UPC/GTIN)
    product_id_1: p.upc ?? fromVendor("upc", "ean", "gtin", "barcode") ?? "",
    product_id_type_1: (() => {
      const b = String(p.upc ?? fromVendor("upc", "ean", "barcode") ?? "");
      return b ? detectUpcType(b) : "UPC";
    })(),
    // "ProductCategory" / "Product Category" → AI-assigned category
    product_category: (p.marketplaceCategory && p.marketplaceCategory !== "Uncategorized") ? p.marketplaceCategory : "",
    // "Short Title" — Walmart limits item titles to 75 chars in some feeds
    short_title: (p.name || (fromLive("title") as string) || "").slice(0, 75),
    // Compliance / geo restrictions — usually empty for standard listings
    state_restrictions: fromVendor("state_restrictions", "staterestrictions") ?? "",
    states: fromVendor("states", "restricted_states", "state_list") ?? "",
    zip_codes: fromVendor("zip_codes", "zipcodes", "zip_code_list") ?? "",
    // Product attribute pairs (Walmart uses these for spec bullets)
    product_attribute_1_name: fromVendor("product_attribute_1_name", "attribute_1_name", "attr1_name", "attribute_name_1") ?? "",
    product_attribute_1_value: fromVendor("product_attribute_1_value", "attribute_1_value", "attr1_value", "attribute_value_1") ?? "",
    product_attribute_2_name: fromVendor("product_attribute_2_name", "attribute_2_name", "attr2_name", "attribute_name_2") ?? "",
    product_attribute_2_value: fromVendor("product_attribute_2_value", "attribute_2_value", "attr2_value", "attribute_value_2") ?? "",
    product_attribute_3_name: fromVendor("product_attribute_3_name", "attribute_3_name", "attr3_name") ?? "",
    product_attribute_3_value: fromVendor("product_attribute_3_value", "attribute_3_value", "attr3_value") ?? "",
    // Additional / offer attributes
    additional_attribute_1_name: fromVendor("additional_attribute_1_name", "additional_1_name", "add_attr_1_name") ?? "",
    additional_attribute_1_value: fromVendor("additional_attribute_1_value", "additional_1_value", "add_attr_1_value") ?? "",
    additional_attribute_2_name: fromVendor("additional_attribute_2_name", "additional_2_name") ?? "",
    additional_attribute_2_value: fromVendor("additional_attribute_2_value", "additional_2_value") ?? "",
    offer_attribute_name: fromVendor("offer_attribute_name", "offer_attr_name") ?? "",
    offer_attribute_value: fromVendor("offer_attribute_value", "offer_attr_value") ?? "",
    // Generic "Value" column that appears in some Walmart offer sheets
    value: fromVendor("value", "offer_attribute_value", "attribute_value") ?? "",
  };

  // Build normalized lookup (coreMap keys use underscores; column labels may not)
  // e.g. "shipping_weight" → "shippingweight" so "ShippingWeight" column finds it.
  const coreNorm = new Map<string, unknown>();
  for (const [k, v] of Object.entries(coreMap)) coreNorm.set(normalizeKey(k), v);
  if (coreNorm.has(nk)) return coreNorm.get(nk);

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
/**
 * Deterministically map a value onto one of a dropdown's allowed options.
 * Returns null when no option is a defensible match, so the caller can hand the
 * value to the AI matcher instead of writing a value the marketplace will reject.
 */
function pickDropdownValue(raw: string, options: string[]): string | null {
  if (!raw || !options.length) return raw;
  const collapse = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
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

  // No defensible match. Returning the raw value here would write a value that is not
  // in the list, which the marketplace rejects — signal failure so the AI matcher runs.
  return null;
}

function normalizeKey(s: string): string {
  return s.toLowerCase()
    .replace(/\s*\([^)]*\)\s*/g, "")    // strip parenthetical annotations: (in), (Y/N), (lbs), etc.
    .replace(/#/g, "")                   // strip "#" — "Style #" → "style", "Item #" → "item"
    .replace(/[^a-z0-9]+/g, "");        // strip ALL non-alphanumeric — makes "product_id_1" == "ProductId1" == "product id 1"
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\- ]/g, "").trim().replace(/\s+/g, "_");
}

function x(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
