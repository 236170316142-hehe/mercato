import { readXlsxGrid } from "./xlsx-lite";

export type VendorRow = {
  name: string;
  sku?: string;
  upc?: string;
  asin?: string;
  brand?: string;
  description?: string;
  dimensions?: string;
  imageUrl?: string;
  price?: number;
  discontinued?: boolean;
  [key: string]: unknown;
};

const MAX_FILE_ROWS = 2000;
const MAX_FILE_COLS = 64;
const HEADER_SCAN_ROWS = 25;

const ASIN_RE = /^B0[A-Z0-9]{8}$/i;
const BARCODE_RE = /^\d{8,14}$/;

function columnShare(rows: string[][], col: number, test: (v: string) => boolean): number {
  let seen = 0;
  let hit = 0;
  for (const r of rows) {
    const v = (r[col] ?? "").trim();
    if (!v) continue;
    seen++;
    if (test(v)) hit++;
  }
  return seen ? hit / seen : 0;
}

function findHeader(headers: string[], re: RegExp, taken: Set<number>): number | null {
  for (let i = 0; i < headers.length; i++) {
    if (!taken.has(i) && re.test(headers[i])) return i;
  }
  return null;
}

function findHeaderLoose(headers: string[], re: RegExp, taken: Set<number>): number | null {
  for (let i = 0; i < headers.length; i++) {
    if (!taken.has(i) && re.test(headers[i].replace(/[_-]/g, " "))) return i;
  }
  return null;
}

type ColMap = {
  asinCol: number | null;
  codeCol: number | null;
  brandCol: number | null;
  productCol: number | null;
  vendorSkuCol: number | null;
  descriptionCol: number | null;
  dimensionsCol: number | null; // explicit combined "Dimensions" column
  lengthCol: number | null;     // first "Length" column (individual item)
  widthCol: number | null;      // first "Width" column (individual item)
  heightCol: number | null;     // first "Height" or "Depth" column (individual item)
  imageCol: number | null;      // image URL column
  priceCol: number | null;
  statusCol: number | null;     // product status / active / discontinued column
};

function detectColumns(headers: string[], sample: string[][]): ColMap {
  const taken = new Set<number>();
  const claim = (i: number | null) => { if (i != null) taken.add(i); return i; };

  // ASIN — "asin", "child_asin", "asins" but NOT "parent_asin"
  let asinCol = claim(findHeaderLoose(headers, /^asins?$|\bchild\s+asin\b/i, taken));
  if (asinCol == null) asinCol = claim(findHeaderLoose(headers, /(?<!parent\s)\basin\b/i, taken));

  // UPC / EAN / barcode
  let codeCol = claim(findHeader(headers, /\b(upc|ean|gtin|barcode|isbn)\b/i, taken));

  // Vendor SKU — covers: SKU, Item No., Style #, Product Code, Stock No., Catalog #, Collection Code, etc.
  const vendorSkuCol = claim(findHeader(
    headers,
    /\b(?:factory|vendor|supplier|seller|internal|our|your)[\s_-]*sku\b|\bsku[s#]?\b|\b(?:item|article|style|model|part|ref(?:erence)?|product|stock|catalog|cat|collection|design|pattern)[\s_-]*(?:no\.?|num(?:ber)?|code|id)\b|\b(?:item|article|style|model|part|ref(?:erence)?|product|stock|catalog|cat|collection|design|pattern)\s*#/i,
    taken,
  ));

  // Brand / manufacturer
  const brandCol = claim(findHeader(headers, /\b(brand|manufacturer|maker)\b/i, taken));

  // Product name (title/name/product wins; description only if nothing better)
  const productCol = claim(findHeaderLoose(
    headers,
    /\b(?:product|item|title)\b|\bname\b|\bdescription\b/i,
    taken,
  ));

  // Long description — claimed AFTER productCol
  const descriptionCol = claim(findHeaderLoose(
    headers,
    /\b(?:description|desc|details?|notes?|specifications?|specs?|long)\b/i,
    taken,
  ));

  // Dimensions — explicit combined column only (NOT length/width/height — those are separate)
  const dimensionsCol = claim(findHeaderLoose(
    headers,
    /\b(?:dimensions?|dims?|package[\s_-]*(?:size|dims?)|product[\s_-]*size)\b/i,
    taken,
  ));
  // First occurrence of individual L/W/H columns (before master-package columns overwrite them)
  const lengthCol = claim(findHeader(headers, /\blength\b/i, taken));
  const widthCol  = claim(findHeader(headers, /\bwidth\b|\bwide\b/i, taken));
  const heightCol = claim(findHeader(headers, /\bheight\b|\bdepth\b/i, taken));

  // Image URL
  const imageCol = claim(findHeaderLoose(
    headers,
    /\b(?:image[\s_-]*(?:url|link|src|path)?|img[\s_-]*(?:url|link)?|photo[\s_-]*(?:url|link)?|picture[\s_-]*(?:url|link)?|thumbnail[\s_-]*(?:url|link)?)\b/i,
    taken,
  ));

  // Price
  const priceCol = claim(findHeader(
    headers,
    /\b(price|unit[\s_-]*price|wholesale|cost|msrp|list[\s_-]*price)\b/i,
    taken,
  ));

  // Product status / active / discontinued indicator column
  const statusCol = claim(findHeader(
    headers,
    /\b(status|item[\s_-]*status|product[\s_-]*status|active|availability|available|disc(?:ontinued)?)\b/i,
    taken,
  ));

  // Cell-shape sniffing for ASIN / UPC when headers didn't match
  if (asinCol == null) {
    for (let i = 0; i < headers.length; i++) {
      if (!taken.has(i) && columnShare(sample, i, (v) => ASIN_RE.test(v)) >= 0.6) {
        asinCol = i; taken.add(i); break;
      }
    }
  }
  if (codeCol == null) {
    for (let i = 0; i < headers.length; i++) {
      if (!taken.has(i) && columnShare(sample, i, (v) => BARCODE_RE.test(v)) >= 0.6) {
        codeCol = i; taken.add(i); break;
      }
    }
  }

  return { asinCol, codeCol, brandCol, productCol, vendorSkuCol, descriptionCol, dimensionsCol, lengthCol, widthCol, heightCol, imageCol, priceCol, statusCol };
}

function pickHeaderRow(grid: string[][]): number {
  let best = 0;
  let bestCount = -1;
  const scan = Math.min(grid.length, HEADER_SCAN_ROWS);
  for (let i = 0; i < scan; i++) {
    const count = grid[i].filter((c) => String(c ?? "").trim() !== "").length;
    if (count >= 2 && count > bestCount) {
      bestCount = count;
      best = i;
    }
  }
  return best;
}

function toNumber(v: string): number | undefined {
  if (!v) return undefined;
  const n = Number(v.replace(/[$,\s]/g, ""));
  return isNaN(n) ? undefined : n;
}

function gridToRows(grid: string[][]): VendorRow[] {
  const headerIdx = pickHeaderRow(grid);
  const rawHeaders = (grid[headerIdx] ?? []).slice(0, MAX_FILE_COLS);
  let width = rawHeaders.length;
  while (width > 0 && String(rawHeaders[width - 1] ?? "").trim() === "") width--;
  width = Math.max(width, 1);

  // ── Multi-row header detection ──────────────────────────────────────────────
  // Some vendor files have a GROUP LABEL row ("INDIVIDUAL ITEM APPROX. DIMs & WEIGHTS")
  // above a SUB-LABEL row ("Length", "Width", "Height").
  // Detect this and merge both rows into one effective header so L/W/H are recognized.
  const subRow = (grid[headerIdx + 1] ?? []).slice(0, MAX_FILE_COLS).map(c => String(c ?? "").trim());
  // Sub-header row is confirmed when it contains ≥2 pure dimension/quantity column names
  const SUB_LABEL_RE = /^(length|width|height|depth|weight|qty|quantity|uom|unit)$/i;
  const GROUP_LABEL_RE = /\b(approx|master|package|individual|item|dims?|weights?|lbs?|inches|carton)\b/i;
  const hasSubHeader = subRow.filter(v => SUB_LABEL_RE.test(v)).length >= 2;

  const headers: string[] = rawHeaders.slice(0, width).map((h, i) => {
    const main = String(h ?? "").trim();
    if (hasSubHeader) {
      const sub = subRow[i] ?? "";
      // Replace blank or group-label cells with the sub-label (e.g. blank → "Length")
      if (sub && (!main || GROUP_LABEL_RE.test(main))) return sub;
    }
    return main;
  });

  // Data rows start after header (and sub-header row if one was consumed)
  const dataStartIdx = hasSubHeader ? headerIdx + 2 : headerIdx + 1;

  // Build data rows (rows below header, non-blank)
  const dataRows: string[][] = [];
  for (let i = dataStartIdx; i < grid.length; i++) {
    const row = (grid[i] ?? []).slice(0, width).map((c) => String(c ?? "").trim());
    if (row.every((c) => c === "")) continue;
    while (row.length < width) row.push("");
    dataRows.push(row);
    if (dataRows.length >= MAX_FILE_ROWS) break;
  }

  if (!dataRows.length) return [];

  const cols = detectColumns(headers, dataRows.slice(0, 10));

  return dataRows.map((row) => {
    const get = (idx: number | null): string => (idx != null ? row[idx] ?? "" : "").trim();

    // Build raw vendorData — FIRST-WINS for duplicate column names so individual item dims
    // (which appear before master-package dims in the spreadsheet) always take priority.
    // e.g. two "Length" columns → raw["Length"] = individual item length, master is ignored.
    const raw: Record<string, unknown> = {};
    const seenCols = new Set<string>();
    headers.forEach((h, i) => {
      if (!h || seenCols.has(h)) return;
      seenCols.add(h);
      raw[h] = row[i] ?? "";
    });

    const name = get(cols.productCol)
      || get(cols.descriptionCol)
      || headers.map((_, i) => row[i]).find((v) => v && v.trim().length > 2)
      || "";

    if (!name) return null;

    // Filter out footer/legal text rows (T&C lines, policy disclaimers, etc.)
    const nonBlankCells = row.filter(c => c && c.trim()).length;
    const wordCount = name.split(/\s+/).filter(w => w.length > 2).length;
    const looksLikeSentence =
      (name.trimEnd().endsWith(".") && name.split(/\s+/).length > 5) ||
      wordCount > 7;
    // Keywords that appear in policy/terms text but never in product names
    const hasPolicyWords = /\b(must\s+be|require[sd]?\s+(auth|writ)|claims?\s+for\s+(defective|missing)|shipment\s+fee|drop\s+ship|\bfob\b|subject\s+to\s+change|without\s+notice|\d+\s+days?\s+of\s+(receipt|delivery)|minimum\s+(initial\s+)?order|net\s+(price|fob)|accessories\s+excluded|dealer\s+to\s+qual)\b/i.test(name);
    if (hasPolicyWords || (looksLikeSentence && (nonBlankCells <= 2 || wordCount > 12))) return null;

    return {
      ...raw,
      name,
      sku: get(cols.vendorSkuCol) || undefined,
      upc: get(cols.codeCol) || undefined,
      asin: get(cols.asinCol) || undefined,
      brand: get(cols.brandCol) || undefined,
      description: get(cols.descriptionCol) || get(cols.productCol) || undefined,
      dimensions: (() => {
        // Prefer an explicit combined "Dimensions" column if it contains multiple numbers (e.g. "18 x 14 x 6")
        const explicit = get(cols.dimensionsCol);
        if (explicit && (explicit.match(/\d/g) ?? []).length >= 2) return explicit;
        // Fall back to combining the first L/W/H columns (individual item package dims)
        const l = get(cols.lengthCol);
        const w = get(cols.widthCol);
        const h = get(cols.heightCol);
        const parts = [l, w, h].filter(v => v && !isNaN(parseFloat(v)) && parseFloat(v) > 0);
        if (parts.length >= 2) return parts.join(" x ");
        return explicit || undefined;
      })(),
      imageUrl: get(cols.imageCol) || undefined,
      price: toNumber(get(cols.priceCol)),
      discontinued: (() => {
        if (cols.statusCol == null) return undefined;
        const v = get(cols.statusCol).toLowerCase();
        if (!v) return undefined;
        // Explicit discontinued values
        if (/^(d|dc|disc|discontinued|inactive|obsolete|delisted|n|no|false|0)$/.test(v)) return true;
        // Explicit active values → not discontinued
        if (/^(a|active|y|yes|true|1|available|in[\s_-]*stock)$/.test(v)) return false;
        return undefined;
      })(),
    } as VendorRow;
  }).filter((r): r is VendorRow => r !== null && r.name.length > 0);
}

// ── CSV ────────────────────────────────────────────────────────────────────────

function parseCsvLine(line: string, delimiter = ","): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (c === delimiter && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += c;
    }
  }
  result.push(current.trim());
  return result;
}

function detectDelimiter(line: string): string {
  const counts = { ",": 0, "\t": 0, ";": 0, "|": 0 };
  for (const ch of line) if (ch in counts) counts[ch as keyof typeof counts]++;
  return (Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0]) ?? ",";
}

function parseCsv(buffer: Buffer): VendorRow[] {
  const text = buffer.toString("utf-8").replace(/^﻿/, "");
  const lines = text.split(/\r?\n/);
  const delim = detectDelimiter(lines[0] ?? "");
  const grid = lines
    .slice(0, MAX_FILE_ROWS + HEADER_SCAN_ROWS)
    .map((l) => parseCsvLine(l, delim));
  return gridToRows(grid);
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function parseVendorFile(buffer: Buffer, filename: string): Promise<VendorRow[]> {
  const ext = filename.split(".").pop()?.toLowerCase();

  if (ext === "csv" || ext === "tsv" || ext === "txt") {
    return parseCsv(buffer);
  }

  try {
    const { grid } = await readXlsxGrid(buffer, MAX_FILE_ROWS + HEADER_SCAN_ROWS);
    return gridToRows(grid);
  } catch {
    throw new Error(
      `Couldn't read "${filename}" — please save it as .xlsx or .csv and upload again.`,
    );
  }
}
