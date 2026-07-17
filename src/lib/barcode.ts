/**
 * Canonical barcode + ASIN identity handling.
 *
 * Vendor files carry barcodes in every imaginable shape: Excel scientific
 * notation, floats, short UPC-E codes, EAN-13 with a leading zero, GTIN-14
 * case codes. The same physical product routinely appears as "012345678905"
 * in one file and "0012345678905" in the next.
 *
 * `toGtin14` collapses all of those to one canonical form so a barcode can be
 * used as a stable identity — a cache key, a map key, a dedupe key.
 */

/**
 * Amazon ASIN shape: "B" + 9 alphanumerics.
 *
 * Deliberately looser than /^B0[A-Z0-9]{8}$/ — legacy ASINs exist that don't
 * start with "B0". A false positive is cheap (the lookup misses and the product
 * falls through to the barcode path, which self-corrects); a false negative is
 * expensive (a valid ASIN rejected here costs a full keyword-search cascade).
 */
export const ASIN_RE = /^B[0-9A-Z]{9}$/i;

export function isAsin(v: string | null | undefined): boolean {
  return !!v && ASIN_RE.test(v.trim());
}

/** Digits only, with Excel scientific-notation recovery. Returns "" if unusable. */
function toDigits(raw: string | null | undefined): string {
  if (raw == null) return "";
  let s = String(raw).trim();
  // Excel silently mangles long barcodes into scientific notation: 8.19E+11.
  if (/^\d[\d.]*[eE][+-]?\d+$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n) && n > 0) s = Math.round(n).toString();
  }
  return s.replace(/[^0-9]/g, "");
}

/**
 * Canonical GTIN-14 form of any barcode, or null if it can't be one.
 *
 * All GTIN flavours (UPC-A 12, EAN-13, ITF-14) are the same number space —
 * left-padding to 14 makes them directly comparable. This is the cache key.
 *
 * Codes shorter than 8 digits are rejected as too short to be a real barcode;
 * longer than 14 keeps the trailing 14 (vendor prefixes/padding sit in front).
 */
export function toGtin14(raw: string | null | undefined): string | null {
  const d = toDigits(raw);
  if (d.length < 8) return null;
  const trimmed = d.length > 14 ? d.slice(-14) : d;
  return trimmed.padStart(14, "0");
}

/**
 * Barcode variants to send to an external API for a given code.
 *
 * Keepa indexes products under whichever form the catalog happens to carry, so
 * querying both UPC-A and EAN-13 for the same product is deliberate and finds
 * matches a single form misses. Caching is keyed on `toGtin14` instead, so all
 * variants of one code collapse to a single cache entry.
 *
 * Returns longest-first (most specific), deduped.
 */
export function barcodeVariants(raw: string | null | undefined): string[] {
  const g = toGtin14(raw);
  if (!g) return [];
  const out = new Set<string>();

  // The code as the vendor actually wrote it (normalized): the form their
  // catalog uses is the likeliest to be indexed.
  const asGiven = toDisplayBarcode(raw);
  if (asGiven) out.add(asGiven);

  // Plus the EAN-13 form of a UPC-A, since catalogs carry either.
  const stripped = g.replace(/^0+/, "");
  if (stripped.length <= 13) out.add(stripped.padStart(13, "0"));

  // Every variant is another code in the API query, so stop here — no
  // speculative 14-digit padding for codes that never needed it.
  return [...out].sort((a, b) => b.length - a.length);
}

/**
 * Legacy display form: digits, padded to at least 12, capped at 14.
 *
 * Preserves the pre-GTIN-14 normalization exactly — for user-facing output and
 * the `Product.upc` column, where changing stored values would be a migration.
 * For identity/comparison use `toGtin14`.
 */
export function toDisplayBarcode(raw: string | null | undefined): string | null {
  const d = toDigits(raw);
  if (d.length < 8) return null;
  if (d.length > 14) return d.slice(-14);
  return d.length < 12 ? d.padStart(12, "0") : d;
}
