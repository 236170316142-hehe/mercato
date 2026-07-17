import { readFileSync } from "fs";
import { join } from "path";

/**
 * Full Mathis category path from the official Mirakl export templates (fwd sheets), up to 4 levels:
 *   Department > Category > Subcategory > Product Type
 * e.g. "Furniture > Living Room > Sofas"
 *      "Furniture > Living Room > Cabinets & Chests > Cabinets"
 *      "Décor > Lighting > Ceiling Fans > Indoor Fans"
 *      "Seasonal > Christmas > Christmas Trees"
 *
 * These are the ONLY valid categories for Mathis product assignments.
 * Department (level 1) corresponds to the Mathis export template file names.
 */
export type MathisCategoryPath = string;

let cachedPaths: MathisCategoryPath[] | null = null;
let cachedPromptBlock: string | null = null;

function csvPath(): string {
  return join(process.cwd(), "src/lib/ai/data/mathis_categories.csv");
}

function isHeader(line: string): boolean {
  const lower = line.toLowerCase();
  return lower.startsWith("department,") || lower.startsWith("category,");
}

/** Minimal CSV line parser that respects double-quoted fields. */
function parseCsvLine(line: string): string[] {
  const cols: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      cols.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  cols.push(cur);
  return cols;
}

/** Load and cache every leaf path from mathis_categories.csv. */
export function loadMathisCategoryPaths(): MathisCategoryPath[] {
  // In dev, always re-read so CSV edits apply without a server restart.
  if (cachedPaths && process.env.NODE_ENV === "production") return cachedPaths;

  const raw = readFileSync(csvPath(), "utf8");
  const paths: MathisCategoryPath[] = [];

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || isHeader(trimmed)) continue;

    const cols = parseCsvLine(trimmed);
    const parts = cols.map((c) => c.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    paths.push(parts.join(" > "));
  }

  if (paths.length === 0) {
    throw new Error("mathis_categories.csv is empty or could not be parsed");
  }

  cachedPaths = paths;
  cachedPromptBlock = null; // rebuild prompt if CSV changed
  return cachedPaths;
}

/**
 * Format the taxonomy for the Claude prompt, grouped by department (level 1)
 * so the model can scan it efficiently (~480 leaf paths, up to 4 levels).
 */
export function formatMathisTaxonomyForPrompt(): string {
  if (cachedPromptBlock && process.env.NODE_ENV === "production") return cachedPromptBlock;

  const paths = loadMathisCategoryPaths();
  const byTop = new Map<string, string[]>();

  for (const path of paths) {
    const top = path.split(" > ")[0] ?? path;
    const rest = path.slice(top.length + 3); // after "Top > "
    if (!byTop.has(top)) byTop.set(top, []);
    byTop.get(top)!.push(rest);
  }

  const lines: string[] = [];
  for (const [top, leaves] of byTop) {
    lines.push(`${top}:`);
    lines.push(leaves.map((l) => `  - ${top} > ${l}`).join("\n"));
    lines.push("");
  }

  cachedPromptBlock = lines.join("\n").trim();
  return cachedPromptBlock;
}
