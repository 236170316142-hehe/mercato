export interface Marketplace {
  id: number; // Keepa domain id
  code: string;
  label: string;
  flag: string;
  host: string;
  currency: string;
}

/**
 * Keepa marketplace domains (verified against Keepa's AmazonLocale enum).
 * Each wishlist is locked to exactly one of these.
 */
export const MARKETPLACES: Marketplace[] = [
  { id: 1, code: "US", label: "United States", flag: "🇺🇸", host: "www.amazon.com", currency: "USD" },
  { id: 2, code: "UK", label: "United Kingdom", flag: "🇬🇧", host: "www.amazon.co.uk", currency: "GBP" },
  { id: 3, code: "DE", label: "Germany", flag: "🇩🇪", host: "www.amazon.de", currency: "EUR" },
  { id: 4, code: "FR", label: "France", flag: "🇫🇷", host: "www.amazon.fr", currency: "EUR" },
  { id: 5, code: "JP", label: "Japan", flag: "🇯🇵", host: "www.amazon.co.jp", currency: "JPY" },
  { id: 6, code: "CA", label: "Canada", flag: "🇨🇦", host: "www.amazon.ca", currency: "CAD" },
  { id: 8, code: "IT", label: "Italy", flag: "🇮🇹", host: "www.amazon.it", currency: "EUR" },
  { id: 9, code: "ES", label: "Spain", flag: "🇪🇸", host: "www.amazon.es", currency: "EUR" },
  { id: 10, code: "IN", label: "India", flag: "🇮🇳", host: "www.amazon.in", currency: "INR" },
  { id: 11, code: "MX", label: "Mexico", flag: "🇲🇽", host: "www.amazon.com.mx", currency: "MXN" },
  { id: 12, code: "BR", label: "Brazil", flag: "🇧🇷", host: "www.amazon.com.br", currency: "BRL" },
];

/** Sentinel id meaning "search across all marketplaces". */
export const ALL_MARKETPLACES = 0;

export function getAllDomains(): number[] {
  return MARKETPLACES.map((m) => m.id);
}

export function getMarketplace(id: number): Marketplace | undefined {
  return MARKETPLACES.find((m) => m.id === id);
}

export function isValidMarketplace(id: number): boolean {
  return MARKETPLACES.some((m) => m.id === id);
}

export function marketplaceLabel(id: number): string {
  const m = getMarketplace(id);
  return m ? `${m.flag} ${m.label}` : `Domain ${id}`;
}

// Name/alias → domain id, for detecting which marketplaces a prompt refers to.
// (Bare "us"/"in" are intentionally NOT matched — too ambiguous in free text.)
const NAME_ALIASES: { id: number; re: RegExp; cs?: boolean }[] = [
  { id: 1, re: /\b(usa|u\.s\.a?\.?|america|american|united states)\b/i },
  { id: 1, re: /\bUS\b/, cs: true },
  { id: 2, re: /\b(uk|u\.k\.?|britain|british|england|united kingdom)\b/i },
  { id: 3, re: /\b(germany|german|deutschland)\b/i },
  { id: 4, re: /\b(france|french)\b/i },
  { id: 5, re: /\b(japan|japanese|jp)\b/i },
  { id: 6, re: /\b(canada|canadian)\b/i },
  { id: 8, re: /\b(italy|italian)\b/i },
  { id: 9, re: /\b(spain|spanish)\b/i },
  { id: 10, re: /\b(india|indian|bharat)\b/i },
  { id: 11, re: /\b(mexico|mexican)\b/i },
  { id: 12, re: /\b(brazil|brazilian|brasil)\b/i },
];

/** Distinct marketplace domain ids explicitly named in the text (order: as listed). */
export function detectMarketplaces(text: string): number[] {
  const out: number[] = [];
  for (const a of NAME_ALIASES) {
    if (a.re.test(text) && !out.includes(a.id)) out.push(a.id);
  }
  return out;
}

/** Resolve a marketplace name/code/label to a domain id, with fallbacks. */
export function resolveMarketplaceName(arg: string, fallback?: number): number {
  const byName = detectMarketplaces(arg);
  if (byName.length) return byName[0];
  const t = arg.trim().toLowerCase();
  const m = MARKETPLACES.find((x) => x.code.toLowerCase() === t || x.label.toLowerCase() === t);
  return m?.id ?? fallback ?? 1;
}
