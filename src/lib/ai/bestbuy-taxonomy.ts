import { readFileSync, statSync } from "fs";
import { join } from "path";

/** Full Best Buy path: "Category > Subcategory > Sub-Subcategory" */
export type BestBuyCategoryPath = string;

let cachedPaths: BestBuyCategoryPath[] | null = null;
let cachedPromptBlock: string | null = null;
let cachedMtime = 0;

function csvPath(): string {
  return join(process.cwd(), "src/lib/ai/data/bestbuy_categories.csv");
}

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

/** Load and cache every leaf path from bestbuy_categories.csv.
 *  Automatically reloads if the CSV file has been modified. */
export function loadBestBuyCategoryPaths(): BestBuyCategoryPath[] {
  const mtime = statSync(csvPath()).mtimeMs;
  if (cachedPaths && mtime === cachedMtime) return cachedPaths;

  cachedPaths = null;
  cachedPromptBlock = null;
  cachedMtime = mtime;

  const raw = readFileSync(csvPath(), "utf8");
  const paths: BestBuyCategoryPath[] = [];

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.toLowerCase().startsWith("category,")) continue;
    const cols = parseCsvLine(trimmed);
    const [category, subcategory, subSub] = cols;
    if (!category || !subcategory || !subSub) continue;
    paths.push(`${category} > ${subcategory} > ${subSub}`);
  }

  if (paths.length === 0) {
    throw new Error("bestbuy_categories.csv is empty or could not be parsed");
  }

  cachedPaths = paths;
  return cachedPaths;
}

export function clearBestBuyCache(): void {
  cachedPaths = null;
  cachedPromptBlock = null;
}

export function formatBestBuyTaxonomyForPrompt(): string {
  if (cachedPromptBlock) return cachedPromptBlock;

  const paths = loadBestBuyCategoryPaths();
  const byTop = new Map<string, string[]>();

  for (const path of paths) {
    const top = path.split(" > ")[0] ?? path;
    const rest = path.slice(top.length + 3);
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
