/**
 * How a category path is turned into an output-file group.
 *
 * Mathis assigns products a full taxonomy leaf path:
 *
 *   Rugs > Rug Type > Indoor Rugs
 *   Baby & Kids > Baby & Kids Decor > Baby & Kids Rugs
 *   Baby & Kids > Kids Furniture > Daybeds
 *
 * Mathis ingests one file per DEPARTMENT (the first path segment), so the three
 * paths above belong in two files (Rugs, Baby & Kids) — not three. Grouping on the
 * full leaf path produced a separate file per subcategory, which is wrong for Mathis.
 *
 * Other marketplaces keep the existing behaviour: the full category string is the group.
 *
 * This module is deliberately dependency-free so the export UI and the server-side ZIP
 * builder can share it and always agree on the file count shown vs. produced.
 */

/** Top-level department of a taxonomy path — "Rugs > Rug Type > Indoor Rugs" → "Rugs". */
export function departmentOf(category: string): string {
  return category.split(">")[0]?.trim() || category.trim();
}

/** True when this marketplace groups export files by department instead of by full path. */
export function groupsByDepartment(marketplace: string): boolean {
  return marketplace.toLowerCase() === "mathis";
}

/**
 * The export-file group a category belongs to for the given marketplace.
 * Mathis → department; everything else → the category path unchanged.
 */
export function exportGroupOf(category: string, marketplace: string): string {
  return groupsByDepartment(marketplace) ? departmentOf(category) : category;
}
