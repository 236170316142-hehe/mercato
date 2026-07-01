/** Friendly arguments for the Keepa Product Finder, mapped to Keepa's `selection` JSON. */
export interface FinderArgs {
  rootCategory?: number | number[];
  categoriesInclude?: number[];
  categoriesExclude?: number[];
  titleKeywords?: string; // space-separated keywords matched in the title
  minRating?: number; // stars, 0–5
  maxRating?: number;
  minReviews?: number;
  maxReviews?: number;
  priceMin?: number; // major currency units (e.g. dollars)
  priceMax?: number;
  salesRankMax?: number; // lower = better seller
  oosMax?: number; // max 90-day out-of-stock % (only when the user asks for availability)
  minMonthlySold?: number;
  brand?: string;
  sort?: [string, "asc" | "desc"]; // e.g. ["current_SALES", "asc"]
  limit?: number; // perPage (1–10000)
  page?: number;
  productType?: number;
}

/**
 * Build the Keepa Product Finder `selection` object.
 * Rating is encoded ×10 (4.0★ → 40); prices are converted to cents.
 */
export function buildSelection(args: FinderArgs): Record<string, unknown> {
  const sel: Record<string, unknown> = {};

  if (args.rootCategory != null) {
    sel.rootCategory = Array.isArray(args.rootCategory) ? args.rootCategory : [args.rootCategory];
  }
  if (args.categoriesInclude?.length) sel.categories_include = args.categoriesInclude;
  if (args.categoriesExclude?.length) sel.categories_exclude = args.categoriesExclude;
  if (args.titleKeywords?.trim()) sel.title = args.titleKeywords.trim();

  if (args.minRating != null) sel.current_RATING_gte = Math.round(clamp(args.minRating, 0, 5) * 10);
  if (args.maxRating != null) sel.current_RATING_lte = Math.round(clamp(args.maxRating, 0, 5) * 10);
  if (args.minReviews != null) sel.current_COUNT_REVIEWS_gte = Math.max(0, Math.round(args.minReviews));
  if (args.maxReviews != null) sel.current_COUNT_REVIEWS_lte = Math.max(0, Math.round(args.maxReviews));

  if (args.priceMin != null) sel.current_NEW_gte = Math.round(args.priceMin * 100);
  if (args.priceMax != null) sel.current_NEW_lte = Math.round(args.priceMax * 100);

  if (args.salesRankMax != null) sel.current_SALES_lte = Math.round(args.salesRankMax);
  // Availability filter — only set when the user explicitly asks about stock.
  if (args.oosMax != null) sel.outOfStockPercentage90_lte = clamp(Math.round(args.oosMax), 0, 100);
  if (args.minMonthlySold != null) sel.monthlySold_gte = Math.round(args.minMonthlySold);
  if (args.brand?.trim()) sel.brand = [args.brand.trim()];
  if (args.productType != null) sel.productType = args.productType;

  sel.sort = [args.sort ?? ["current_SALES", "asc"]];
  sel.page = args.page ?? 0;
  // Keepa Product Finder requires perPage between 50 and 10000.
  // Callers slice the returned ASIN list down to the exact count they want.
  sel.perPage = clamp(Math.round(args.limit ?? 50), 50, 10000);

  return sel;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}
