export type SkuProductInput = {
  id: string;
  name: string;
  brand: string | null;
  description: string | null;
  vendorCategory?: string | null;
  vendorContext?: string | null;
};

export type SkuEnrichment = {
  productId: string;
  name: string;
  brand: string | null;
  description: string | null;
  searchContext: string;
};

/**
 * True when the "name" is really a vendor code (SKU sheet uploads), not a product title.
 * Examples: TOVF-TOVL54566, ABC-12345, SKU1234
 */
export function looksLikeSkuName(name: string, vendorSku?: string | null): boolean {
  const n = name.trim();
  if (!n) return true;
  if (vendorSku && n.toLowerCase() === vendorSku.trim().toLowerCase()) return true;

  // Alphanumeric code with optional separators, short word count, no spaces (or one hyphenated token)
  const compact = /^[A-Z0-9][A-Z0-9._/-]{2,39}$/i.test(n);
  const words = n.split(/\s+/).filter(Boolean);
  if (compact && words.length <= 2) return true;

  // Mostly digits / codes rather than English words
  const letters = (n.match(/[a-zA-Z]{3,}/g) ?? []).length;
  const hasSpaces = /\s/.test(n);
  if (!hasSpaces && letters <= 1 && /[0-9]{3,}/.test(n)) return true;

  return false;
}

/** Search variants so "TOVF-TOVL54566" also tries "TOV-L54566". */
export function skuSearchVariants(sku: string): string[] {
  const s = sku.trim();
  if (!s) return [];
  const out = new Set<string>([s]);

  const parts = s.split(/[-_/]/).filter(Boolean);
  if (parts.length >= 2) {
    const last = parts[parts.length - 1]!;
    out.add(last);

    // TOVL54566 → TOV-L54566 (letter + L + digits, common furniture MPN style)
    const tovL = last.match(/^([A-Za-z]+?)(L)(\d{4,})$/i);
    if (tovL) out.add(`${tovL[1]}-${tovL[2].toUpperCase()}${tovL[3]}`);

    // ABC12345 → ABC-12345
    const splitDigits = last.match(/^([A-Za-z]{2,})(\d{4,})$/);
    if (splitDigits) out.add(`${splitDigits[1]}-${splitDigits[2]}`);

    // Prefer last segment if first looks like a brand prefix (TOVF, APSA, …)
    if (/^[A-Z]{2,6}F?$/i.test(parts[0]!)) {
      out.add(parts.slice(1).join("-"));
    }
  } else {
    const tovL = s.match(/^([A-Za-z]+?)(L)(\d{4,})$/i);
    if (tovL) out.add(`${tovL[1]}-${tovL[2].toUpperCase()}${tovL[3]}`);
    const splitDigits = s.match(/^([A-Za-z]{2,})(\d{4,})$/);
    if (splitDigits) out.add(`${splitDigits[1]}-${splitDigits[2]}`);
  }

  // Prefer catalog-style codes (contain a hyphen) before raw vendor codes
  return [...out].sort((a, b) => {
    const score = (v: string) => (/-/.test(v) && /\d{4,}/.test(v) ? 0 : v.includes("-") ? 1 : 2);
    return score(a) - score(b) || a.length - b.length;
  });
}

function decodeHtml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

type SearchHit = { title: string; snippet: string };

async function searchSerpApi(query: string): Promise<SearchHit[]> {
  const key = process.env.SERPAPI_KEY;
  if (!key) return [];
  try {
    const url = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&engine=google&api_key=${key}&num=5`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const data = (await res.json()) as { organic_results?: { title?: string; snippet?: string }[] };
    return (data.organic_results ?? [])
      .slice(0, 5)
      .map((r) => ({ title: (r.title ?? "").trim(), snippet: (r.snippet ?? "").trim() }))
      .filter((h) => h.title);
  } catch {
    return [];
  }
}

const BROWSER_UA = "Mozilla/5.0";

async function searchDuckDuckGo(query: string): Promise<SearchHit[]> {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "text/html",
      },
      signal: AbortSignal.timeout(10000),
    });
    // 202 = bot challenge page (no results)
    if (!res.ok || res.status === 202) return [];
    const html = await res.text();
    if (!html.includes("result__a")) return [];
    const titles = [...html.matchAll(/class="result__a"[^>]*>([^<]+)</g)].map((m) => decodeHtml(m[1] ?? ""));
    const snippets = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)].map((m) =>
      decodeHtml((m[1] ?? "").replace(/<[^>]+>/g, "")),
    );
    const hits: SearchHit[] = [];
    for (let i = 0; i < Math.min(titles.length, 5); i++) {
      hits.push({ title: titles[i]!, snippet: snippets[i] ?? "" });
    }
    return hits.filter((h) => h.title);
  } catch {
    return [];
  }
}

/** TOV Furniture vendor codes (TOVF-TOVL##### / TOV-L#####) → tovfurniture.com search. */
function isTovLikeSku(sku: string): boolean {
  return /\btov/i.test(sku);
}

async function searchTovFurniture(query: string): Promise<SearchHit[]> {
  try {
    const url = `https://tovfurniture.com/search?q=${encodeURIComponent(query)}&type=product`;
    const res = await fetch(url, {
      headers: { "User-Agent": BROWSER_UA, Accept: "text/html" },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return [];
    const html = await res.text();

    // Product handles ranked by Shopify search (_pos=)
    const handles = [...html.matchAll(/\/products\/([a-z0-9-]+)\?[^"]*_pos=(\d+)/gi)]
      .map((m) => ({ handle: m[1]!, pos: Number(m[2]) }))
      .filter((h) => h.handle && !/gift-card|baseball-cap/i.test(h.handle))
      .sort((a, b) => a.pos - b.pos);

    const uniqueHandles = [...new Set(handles.map((h) => h.handle))].slice(0, 3);
    const hits: SearchHit[] = [];

    for (const handle of uniqueHandles) {
      try {
        const pRes = await fetch(`https://tovfurniture.com/products/${handle}.json`, {
          headers: { "User-Agent": BROWSER_UA, Accept: "application/json" },
          signal: AbortSignal.timeout(8000),
        });
        if (!pRes.ok) continue;
        const data = (await pRes.json()) as {
          product?: { title?: string; vendor?: string; body_html?: string; variants?: { sku?: string }[] };
        };
        const product = data.product;
        if (!product?.title) continue;
        const skus = (product.variants ?? []).map((v) => v.sku).filter(Boolean).join(", ");
        const desc = decodeHtml((product.body_html ?? "").replace(/<[^>]+>/g, " ")).slice(0, 220);
        hits.push({
          title: `${product.title} | TOV Furniture`,
          snippet: [product.vendor ? `Brand: ${product.vendor}` : null, skus ? `SKU: ${skus}` : null, desc]
            .filter(Boolean)
            .join(". "),
        });
      } catch {
        /* try next handle */
      }
    }

    if (hits.length) return hits;

    // Fallback: card heading text on the search page
    const cardTitles = [...html.matchAll(/class="[^"]*(?:card__heading|full-unstyled-link)[^"]*"[^>]*>([\s\S]*?)<\//gi)]
      .map((m) => decodeHtml((m[1] ?? "").replace(/<[^>]+>/g, "")))
      .filter((t) => t.length > 4 && !/gift card|baseball/i.test(t));
    return [...new Set(cardTitles)].slice(0, 3).map((title) => ({
      title: `${title} | TOV Furniture`,
      snippet: `SKU search: ${query}`,
    }));
  } catch {
    return [];
  }
}

async function searchWeb(query: string, originalSku: string): Promise<SearchHit[]> {
  // Vendor-specific catalog first for TOV codes (most reliable for Mathis furniture sheets)
  if (isTovLikeSku(originalSku) || isTovLikeSku(query)) {
    const tov = await searchTovFurniture(query);
    if (tov.length) return tov;
  }
  const serp = await searchSerpApi(query);
  if (serp.length) return serp;
  return searchDuckDuckGo(query);
}

function pickProductName(hits: SearchHit[], sku: string): string | null {
  const skuNorm = sku.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const hit of hits) {
    // Prefer titles that look like real product names (have spaces / words)
    const title = hit.title.split("|")[0]?.trim() ?? hit.title;
    if (!title || title.length < 8) continue;
    const words = title.split(/\s+/).filter((w) => /[a-zA-Z]{3,}/.test(w));
    if (words.length < 2) continue;
    // Skip pure navigational / brand-home pages
    if (/^(home|shop|cart|login|instagram)\b/i.test(title)) continue;
    // Prefer hits that mention the SKU (or a close variant) in title/snippet
    const blob = `${hit.title} ${hit.snippet}`.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (skuNorm.length >= 6 && blob.includes(skuNorm.slice(-6))) return title;
    if (words.length >= 2) return title;
  }
  return hits[0]?.title.split("|")[0]?.trim() || null;
}

function guessBrand(hits: SearchHit[], name: string | null): string | null {
  const blob = `${name ?? ""} ${hits.map((h) => h.title).join(" ")}`;
  if (/\bTOV\b/i.test(blob) || /tovfurniture/i.test(blob)) return "TOV Furniture";
  const m = blob.match(/\bby\s+([A-Z][A-Za-z0-9&' ]{1,40})\b/);
  return m?.[1]?.trim() || null;
}

/**
 * Resolve SKU-only product rows to real titles/descriptions via web search
 * so Mathis (and other) categorization has something to match against.
 */
export async function enrichSkuOnlyProducts(
  products: SkuProductInput[],
): Promise<{ products: SkuProductInput[]; enrichments: SkuEnrichment[] }> {
  const enrichments: SkuEnrichment[] = [];
  const out: SkuProductInput[] = [];

  const PARALLEL = 3;
  const queue = products.map((p, idx) => ({ p, idx }));
  const results = new Array<SkuProductInput>(products.length);

  for (let i = 0; i < queue.length; i += PARALLEL) {
    const slice = queue.slice(i, i + PARALLEL);
    await Promise.all(
      slice.map(async ({ p, idx }) => {
        if (!looksLikeSkuName(p.name)) {
          results[idx] = p;
          return;
        }

        const variants = skuSearchVariants(p.name);
        let hits: SearchHit[] = [];
        let usedQuery = variants[0] ?? p.name;

        for (const v of variants) {
          hits = await searchWeb(v, p.name);
          usedQuery = v;
          if (hits.length > 0) {
            const digits = (v.match(/\d{4,}/) ?? [])[0];
            if (!digits || hits.some((h) => `${h.title} ${h.snippet}`.includes(digits))) break;
          }
        }

        if (!hits.length) {
          results[idx] = p;
          return;
        }

        const resolvedName = pickProductName(hits, usedQuery);
        if (!resolvedName) {
          results[idx] = p;
          return;
        }

        const brand = p.brand || guessBrand(hits, resolvedName);
        const searchContext = hits
          .slice(0, 3)
          .map((h) => [h.title, h.snippet].filter(Boolean).join(": "))
          .join(" | ");
        const description =
          p.description ||
          hits.find((h) => h.snippet.length > 40)?.snippet.slice(0, 200) ||
          null;

        const enrichment: SkuEnrichment = {
          productId: p.id,
          name: resolvedName,
          brand,
          description,
          searchContext,
        };
        enrichments.push(enrichment);

        results[idx] = {
          ...p,
          name: resolvedName,
          brand,
          description,
          vendorContext: [p.vendorContext, `resolved_from_sku: ${p.name}`, `web: ${searchContext.slice(0, 280)}`]
            .filter(Boolean)
            .join("; "),
        };
      }),
    );
  }

  for (let i = 0; i < results.length; i++) out.push(results[i] ?? products[i]!);
  return { products: out, enrichments };
}
