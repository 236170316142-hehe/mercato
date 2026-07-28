import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";

// Walmart categorization has two category layers:
//
//   1. The RICH taxonomy (walmart_categories.csv) — Walmart's full multi-level
//      Marketplace taxonomy. Optional; supply it to categorize into detailed
//      paths. When absent, the template list below is used directly.
//
//   2. The TEMPLATE list (walmart_template_categories.csv) — the 75 flat values
//      the "MP Item Setup by Match" template's Product Category dropdown
//      actually accepts. This is the authoritative EXPORT target: any value not
//      in this list is rejected on import, so a rich category is always mapped
//      down to one of these before it reaches the sheet.
//
// Modelled on temu-taxonomy.ts (mtime-cached, disk-reload) so a CSV swap needs
// no server restart.

const DATA_DIR = "src/lib/ai/data";
const RICH_CSV = "walmart_categories.csv";
const TEMPLATE_CSV = "walmart_template_categories.csv";

function dataPath(file: string): string {
  return join(process.cwd(), DATA_DIR, file);
}

/** Proper quoted-CSV line parser — handles fields that contain commas
 *  ("Baby Diapering, Care, & Other"). */
function parseCsvLine(line: string): string[] {
  const cols: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === "," && !inQuotes) { cols.push(current.trim()); current = ""; continue; }
    current += ch;
  }
  cols.push(current.trim());
  return cols;
}

// ── Template category list (the export target) ────────────────────────────────

let cachedTemplate: string[] | null = null;
let cachedTemplateMtime = 0;

/** The 75 category values the Walmart template's dropdown accepts. Always present. */
export function loadWalmartTemplateCategories(): string[] {
  const path = dataPath(TEMPLATE_CSV);
  const mtime = statSync(path).mtimeMs;
  if (cachedTemplate && mtime === cachedTemplateMtime) return cachedTemplate;
  cachedTemplateMtime = mtime;

  const raw = readFileSync(path, "utf8");
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.toLowerCase() === "category") continue;
    // This file is ONE category per line by definition. Several values contain
    // commas ("Home Decor, Kitchen, & Other"), so it must NOT be comma-split —
    // read each line verbatim, only stripping an accidental wrapping quote.
    out.push(t.replace(/^"(.*)"$/, "$1"));
  }
  if (!out.length) throw new Error(`${TEMPLATE_CSV} is empty or could not be parsed`);
  cachedTemplate = out;
  return out;
}

// ── Rich taxonomy (optional) ──────────────────────────────────────────────────

let cachedRich: string[] | null = null;
let cachedRichMtime = 0;

/** True when the optional rich taxonomy file exists on disk. */
export function hasWalmartRichTaxonomy(): boolean {
  return existsSync(dataPath(RICH_CSV));
}

/**
 * The rich taxonomy paths, or null when the file is not present.
 *
 * Accepts either a single "path" column already formatted as "A > B > C", or
 * up to three separate columns that are joined with " > ". Rows with fewer than
 * one usable segment are skipped.
 */
export function loadWalmartRichTaxonomy(): string[] | null {
  const path = dataPath(RICH_CSV);
  if (!existsSync(path)) return null;
  const mtime = statSync(path).mtimeMs;
  if (cachedRich && mtime === cachedRichMtime) return cachedRich;
  cachedRichMtime = mtime;

  const raw = readFileSync(path, "utf8");
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const cols = parseCsvLine(t);
    if (cols[0]?.toLowerCase() === "category" || cols[0]?.toLowerCase() === "path") continue;
    // Already-joined path, or separate level columns.
    const segments = cols.length === 1
      ? cols[0].split(">").map((s) => s.trim())
      : cols.map((c) => c.trim());
    const usable = segments.filter(Boolean);
    if (usable.length) out.push(usable.join(" > "));
  }
  cachedRich = out.length ? out : null;
  return cachedRich;
}

/**
 * The category list the AI categorizes into.
 *
 * Rich taxonomy when supplied (detailed paths), otherwise the 75 template
 * values so categorization is fully functional with no external file. Either
 * way the result is mapped down to a template value at export time via
 * mapToTemplateCategory.
 */
export function loadWalmartCategoryPaths(): string[] {
  return loadWalmartRichTaxonomy() ?? loadWalmartTemplateCategories();
}

/** Format the category list for the Claude prompt, grouped by top-level. */
export function formatWalmartTaxonomyForPrompt(): string {
  const paths = loadWalmartCategoryPaths();
  // Flat list (template mode) — one bullet per value.
  if (paths.every((p) => !p.includes(" > "))) {
    return paths.map((c) => `  - ${c}`).join("\n");
  }
  // Path mode — group by top-level department.
  const byTop = new Map<string, string[]>();
  for (const path of paths) {
    const top = path.split(" > ")[0] ?? path;
    if (!byTop.has(top)) byTop.set(top, []);
    byTop.get(top)!.push(path);
  }
  const lines: string[] = [];
  for (const [top, leaves] of byTop) {
    lines.push(`${top}:`);
    lines.push(leaves.map((l) => `  - ${l}`).join("\n"));
    lines.push("");
  }
  return lines.join("\n").trim();
}

// ── Rich path → template value mapping ────────────────────────────────────────

function norm(s: string): string {
  return s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();
}

// Deterministic hints for template values whose name doesn't lexically overlap
// the words a rich path would use. Kept small and obvious; the word-overlap
// scorer handles the rest.
const TEMPLATE_ALIASES: Array<[RegExp, string]> = [
  [/\b(sofa|couch|table|chair|dresser|bed|desk|bookcase|furniture|nightstand|ottoman)\b/, "Furniture"],
  [/\b(rug|carpet|decor|vase|candle|mirror|wall art|pillow|throw|curtain)\b/, "Home Decor, Kitchen, & Other"],
  [/\b(cookware|bakeware|kitchen|dinnerware|utensil|flatware)\b/, "Home Decor, Kitchen, & Other"],
  [/\b(sheet|comforter|duvet|quilt|bedding|pillowcase)\b/, "Bedding"],
  [/\b(tv|television|monitor|display)\b/, "TVs & Video Displays"],
  [/\b(phone|tablet|laptop|computer)\b/, "Computers"],
  [/\b(toy|toys|play ?set|doll|action figure)\b/, "Toys"],
  [/\b(shirt|pants|dress|apparel|clothing|jacket)\b/, "Clothing"],
  [/\b(shoe|footwear|sneaker|boot|sandal)\b/, "Footwear"],
  [/\b(tool|drill|wrench|hammer|hardware)\b/, "Tools"],
  [/\b(patio|garden|outdoor|planter)\b/, "Garden & Patio"],
];

/**
 * Map an assigned category (rich path OR already a template value) to one of the
 * 75 template dropdown values. Returns null when nothing matches confidently, so
 * the caller can leave the cell blank rather than write an invalid value.
 */
export function mapToTemplateCategory(assigned: string): string | null {
  if (!assigned) return null;
  const templates = loadWalmartTemplateCategories();

  // Exact match (already a template value, e.g. template-mode categorization).
  const exact = templates.find((t) => norm(t) === norm(assigned));
  if (exact) return exact;

  // Compare against the most specific segment of a rich path first, then the
  // whole thing, so "Home > Furniture > Sofas" keys off "Sofas"/"Furniture".
  const segments = assigned.split(">").map((s) => s.trim()).filter(Boolean);
  const haystacks = [...segments.reverse(), assigned].map(norm);

  // Deterministic aliases.
  for (const h of haystacks) {
    for (const [re, target] of TEMPLATE_ALIASES) {
      if (re.test(h)) return templates.find((t) => t === target) ?? null;
    }
  }

  // Word-overlap scoring against each template value.
  let best: string | null = null;
  let bestScore = 0;
  for (const t of templates) {
    const tWords = norm(t).split(" ").filter((w) => w.length > 2);
    for (const h of haystacks) {
      const hWords = new Set(h.split(" ").filter((w) => w.length > 2));
      let score = 0;
      for (const w of tWords) if (hWords.has(w)) score += 1;
      if (score > bestScore) { bestScore = score; best = t; }
    }
  }
  // Require at least one shared meaningful word; otherwise leave it to the
  // export's own dropdown matcher / blank rule.
  return bestScore >= 1 ? best : null;
}
