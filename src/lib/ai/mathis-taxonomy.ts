import { readFileSync } from "fs";
import { join } from "path";

/**
 * Full Mathis path: "Category > Subcategory" or "Category > Subcategory > Product Type".
 * Unlike Temu, some Mathis branches are naturally 2 levels deep (e.g. "Living Room > Sofas"),
 * so the third column is optional in mathis_categories.csv.
 */
export type MathisCategoryPath = string;

let cachedPaths: MathisCategoryPath[] | null = null;
let cachedPromptBlock: string | null = null;

function csvPath(): string {
  return join(process.cwd(), "src/lib/ai/data/mathis_categories.csv");
}

/** Load and cache every leaf path from mathis_categories.csv. */
export function loadMathisCategoryPaths(): MathisCategoryPath[] {
  if (cachedPaths) return cachedPaths;

  const raw = readFileSync(csvPath(), "utf8");
  const paths: MathisCategoryPath[] = [];

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.toLowerCase().startsWith("category,")) continue;

    // Simple CSV split — fields have no embedded commas in this file
    const cols = trimmed.split(",").map((c) => c.trim());
    const [category, subcategory, productType] = cols;
    if (!category || !subcategory) continue;
    paths.push(
      productType
        ? `${category} > ${subcategory} > ${productType}`
        : `${category} > ${subcategory}`,
    );
  }

  if (paths.length === 0) {
    throw new Error("mathis_categories.csv is empty or could not be parsed");
  }

  cachedPaths = paths;
  return cachedPaths;
}

/**
 * Format the taxonomy for the Claude prompt, grouped by top-level category
 * so the model can scan it efficiently (~420 leaf paths).
 */
export function formatMathisTaxonomyForPrompt(): string {
  if (cachedPromptBlock) return cachedPromptBlock;

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
