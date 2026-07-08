import type { Product } from "@prisma/client";

export type VerifyResult = {
  productId: string;
  status: "ok" | "warning" | "mismatch" | "not_found" | "skipped" | "discontinued";
  fields: FieldResult[];
  liveData: Record<string, unknown>;
  resolvedUpc?: string; // normalized UPC extracted from vendorData when p.upc was null
};

// Check raw vendorData for a status column indicating discontinued.
// Works for both: parsed `discontinued: true` flag (new imports) and
// raw status column values (existing imported products).
function isDiscontinuedInVendorData(vendorData: unknown): boolean {
  if (!vendorData || typeof vendorData !== "object") return false;
  const data = vendorData as Record<string, unknown>;
  if (data.discontinued === true) return true;
  const statusKeyRe = /\b(status|active|availability)\b/i;
  const discValueRe = /^(d|dc|disc|discontinued|inactive|obsolete|delisted|n|no)$/i;
  for (const [key, val] of Object.entries(data)) {
    if (!statusKeyRe.test(key)) continue;
    if (discValueRe.test(String(val ?? "").trim())) return true;
  }
  return false;
}

type FieldResult = {
  field: string;
  label: string;
  stored: string;
  live: string;
  match: boolean;
  severity: "ok" | "warning" | "mismatch";
};

export async function verifyProducts(
  marketplace: string,
  products: Product[],
): Promise<VerifyResult[]> {
  switch (marketplace) {
    case "amazon_us":
    case "amazon":
      return verifyAmazon(products);
    case "walmart":
      return verifyWalmart(products);
    default:
      // Only Amazon and Walmart are verified; all others pass through as ok.
      return products.map((p) => ({
        productId: p.id,
        status: "ok",
        fields: [],
        liveData: {},
      }));
  }
}

// ── Amazon (Keepa) ────────────────────────────────────────────────────────────

async function verifyAmazon(products: Product[]): Promise<VerifyResult[]> {
  const { getProducts, getProductsByCode, keywordSearch, getLastTokenInfo, normalizeMany } = await import("@/lib/keepa");

  // Products the vendor file explicitly marks as discontinued — skip Keepa entirely.
  const discontinuedResults: VerifyResult[] = products
    .filter((p) => isDiscontinuedInVendorData(p.vendorData))
    .map((p) => ({ productId: p.id, status: "discontinued" as const, fields: [], liveData: {} }));
  const activeProducts = products.filter((p) => !isDiscontinuedInVendorData(p.vendorData));

  // Only trust ASINs that look like real Amazon ASINs (B + 9 alphanumeric chars).
  // Numeric-looking values like "43664.043078" are product codes, not ASINs — treat
  // them as having no ASIN so they fall through to UPC / keyword search.
  const ASIN_RE = /^B[0-9A-Z]{9}$/i;

  // Normalize UPC from any vendor format:
  //  • Scientific notation from Excel: "8.19E+11" → "819000000000"
  //  • Floats with decimals: "819000000000.0" → "819000000000"
  //  • Short UPCs: pad to 12 digits (UPC-A standard)
  //  • Returns null if the result isn't 8–14 digits
  const normalizeUpc = (raw: string | null | undefined): string | null => {
    if (!raw) return null;
    let s = String(raw).trim();
    if (/^\d[\d.]*[eE][+\-]?\d+$/.test(s)) {
      const n = Number(s);
      if (!isNaN(n) && n > 0) s = Math.round(n).toString();
    }
    s = s.replace(/[^0-9]/g, "");
    if (!s) return null;
    if (s.length < 8) return null; // too short to be a real barcode
    if (s.length < 12) s = s.padStart(12, "0"); // pad UPC-A
    if (s.length > 14) s = s.slice(-14);
    return s;
  };

  // Derive all barcode variants to try: UPC-12 + EAN-13 (prepend "0")
  const upcVariants = (raw: string | null | undefined): string[] => {
    const n = normalizeUpc(raw);
    if (!n) return [];
    if (n.length === 12) return [n, "0" + n]; // UPC-A + EAN-13
    return [n];
  };

  // Extract a barcode from vendorData when p.upc is null or invalid.
  // Vendor files often have UPC/EAN/barcode in columns with non-standard headers
  // that the importer didn't map to the upc field.
  const extractVendorUpc = (p: Product): string | null => {
    const vd = p.vendorData as Record<string, unknown> | null;
    if (!vd) return null;
    // Priority 1: known barcode column names
    const barcodeKeys = /\b(upc|ean|gtin|barcode|isbn|item[\s_-]*code|product[\s_-]*code)\b/i;
    for (const [k, v] of Object.entries(vd)) {
      if (!barcodeKeys.test(k)) continue;
      const norm = normalizeUpc(String(v ?? ""));
      if (norm) return norm;
    }
    // Priority 2: any column whose value looks like a barcode (8-14 digits after normalization)
    for (const v of Object.values(vd)) {
      const norm = normalizeUpc(String(v ?? ""));
      if (norm && norm.length >= 12) return norm;
    }
    return null;
  };

  // Resolve the best UPC for each product: stored p.upc → normalize → fallback vendorData scan
  const resolvedUpc = (p: Product): string | null =>
    normalizeUpc(p.upc) ?? extractVendorUpc(p);

  const withAsin     = activeProducts.filter((p) => p.asin && ASIN_RE.test(p.asin));
  const asinInvalid  = activeProducts.filter((p) => p.asin && !ASIN_RE.test(p.asin));
  // A product "has UPC" if p.upc normalizes OR vendorData contains a barcode
  const withUpcOnly  = activeProducts.filter((p) => (!p.asin || !ASIN_RE.test(p.asin ?? "")) && !!resolvedUpc(p));
  const withNameOnly = activeProducts.filter((p) => (!p.asin || !ASIN_RE.test(p.asin ?? "")) && !resolvedUpc(p));

  // Fetch by ASIN
  const asinResults = new Map<string, VerifyResult>();
  if (withAsin.length) {
    const asins = withAsin.map((p) => p.asin) as string[];
    const raw = await getProducts(1, asins, { stats: 1, rating: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const live = normalizeMany(raw, 1) as any[];
    // Don't throw on empty — Keepa may simply not carry these ASINs. Mark as not_found and continue.
    const liveMap = new Map(live.map((l) => [l.asin as string, l]));
    for (const p of withAsin) {
      const lp = liveMap.get(p.asin!);
      if (!lp) { asinResults.set(p.id, notFound(p.id)); continue; }
      const nameSim = titleSim(p.name, lp.title as string);
      if (nameSim < 0.25) {
        asinResults.set(p.id, notFound(p.id));
      } else {
        asinResults.set(p.id, compareToLive(p, lp.title as string, lp.brand as string ?? null, null, lp as Record<string, unknown>));
      }
    }
  }
  void asinInvalid; // they flow into withUpcOnly / withNameOnly above

  // Fetch by UPC/EAN barcode
  // Build a map: every normalized code variant → product, so Keepa response codes
  // (which may be stored as EAN-13) can be matched back to the originating product.
  const upcResults = new Map<string, VerifyResult>();
  const upcNotFound: Product[] = [];
  if (withUpcOnly.length) {
    const codeToProduct = new Map<string, Product>();
    for (const p of withUpcOnly) {
      for (const v of upcVariants(resolvedUpc(p))) codeToProduct.set(v, p);
    }
    const allCodes = [...new Set(codeToProduct.keys())];

    const rawProducts = await getProductsByCode(1, allCodes, { stats: 1 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const liveNorm = normalizeMany(rawProducts, 1) as any[];

    // Map every barcode Keepa returns → list of normalized live products
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const codeToLiveList = new Map<string, (typeof liveNorm[number])[]>();
    rawProducts.forEach((raw, idx) => {
      const norm = liveNorm[idx];
      if (!norm) return;
      const codes = [...(raw.eanList ?? []), ...(raw.upcList ?? [])].filter((c): c is string => typeof c === "string");
      for (const code of codes) {
        if (!codeToLiveList.has(code)) codeToLiveList.set(code, []);
        codeToLiveList.get(code)!.push(norm);
      }
    });

    for (const p of withUpcOnly) {
      // Collect candidates across all variants (UPC-12 + EAN-13)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const candidates: (typeof liveNorm[number])[] = [];
      for (const v of upcVariants(resolvedUpc(p))) {
        for (const c of (codeToLiveList.get(v) ?? [])) candidates.push(c);
      }

      if (!candidates.length) {
        upcNotFound.push(p);
        continue;
      }

      // Pick the ASIN whose title is most similar to the vendor's product name.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let best: any = candidates[0];
      let bestSim = titleSim(p.name, best.title as string);
      for (const candidate of candidates.slice(1)) {
        const sim = titleSim(p.name, candidate.title as string);
        if (sim > bestSim) { best = candidate; bestSim = sim; }
      }

      // A barcode IS the product identity — trust UPC match even with low title similarity.
      // Only fall through if title is completely unrelated (< 0.1) which likely means a
      // catalog error (wrong product merged onto the same barcode by a third-party seller).
      if (bestSim < 0.1) {
        upcNotFound.push(p);
      } else {
        const resolved = resolvedUpc(p);
        const result = compareToLive(p, best.title as string, (best.brand as string) ?? null, null, best as Record<string, unknown>);
        if (resolved && !p.upc) result.resolvedUpc = resolved;
        upcResults.set(p.id, result);
      }
    }
  }

  // ── Brand expansion: vendor acronym → ALL known Amazon brand names ───────────
  // Use products already found via ASIN/UPC to resolve acronyms.
  // "GHF" → ["Greenland Home Fashions", "Barefoot Bungalow"] (both are GHF sub-brands).
  // We try EACH of these when keyword-searching for unresolved products.
  const brandAllOptions = new Map<string, Set<string>>();
  const trackBrand = (vendorBrand: string | null, result: VerifyResult | undefined) => {
    if (!vendorBrand || !result || result.status === "not_found") return;
    const amazonBrand = result.liveData?.brand as string | undefined;
    if (!amazonBrand) return;
    const vb = vendorBrand.toLowerCase();
    if (!brandAllOptions.has(vb)) brandAllOptions.set(vb, new Set());
    brandAllOptions.get(vb)!.add(amazonBrand);
  };
  for (const p of withAsin)    trackBrand(p.brand, asinResults.get(p.id));
  for (const p of withUpcOnly) trackBrand(p.brand, upcResults.get(p.id));

  // Keyword search for:
  //  (a) products with no ASIN or UPC at all
  //  (b) products whose UPC Keepa couldn't match (upcNotFound fallback)
  const nameResults = new Map<string, VerifyResult>();
  const keywordPool = [...withNameOnly, ...upcNotFound];
  if (keywordPool.length) {
    const { refreshKeepaTokens } = await import("@/lib/keepa/client");
    const tokenInfo = await refreshKeepaTokens();
    if (tokenInfo != null && tokenInfo.tokensLeft < 200) {
      // Tokens too low — skip keyword searches rather than crashing the whole batch
      for (const p of keywordPool) nameResults.set(p.id, { productId: p.id, status: "skipped", fields: [], liveData: {} });
      return [...discontinuedResults, ...activeProducts.map((p) =>
        asinResults.get(p.id) ?? upcResults.get(p.id) ?? nameResults.get(p.id)
        ?? { productId: p.id, status: "skipped" as const, fields: [] as FieldResult[], liveData: {} }
      )];
    }

    // Deduplicate by brand+name so identical products share one search pass
    const byTerm = new Map<string, Product[]>();
    for (const p of keywordPool) {
      const term = [p.brand, p.name].filter(Boolean).join(" ").trim();
      if (!byTerm.has(term)) byTerm.set(term, []);
      byTerm.get(term)!.push(p);
    }

    const CONCURRENCY = 1;
    const entries = [...byTerm.entries()];
    for (let i = 0; i < entries.length; i += CONCURRENCY) {
      const left = getLastTokenInfo()?.tokensLeft;
      if (left != null && left < 200) break;

      await Promise.all(entries.slice(i, i + CONCURRENCY).map(async ([_term, group]) => {
        try {
          const productName = group[0].name || _term;
          const vendorBrand = group[0].brand ?? null;

          // All Amazon brand names we've seen for this vendor brand (e.g. "GHF" →
          // ["Greenland Home Fashions", "Barefoot Bungalow"]). Fall back to raw vendor
          // brand string if we haven't seen this brand in any successful lookup yet.
          const knownBrands: string[] = vendorBrand
            ? [...(brandAllOptions.get(vendorBrand.toLowerCase()) ?? []), vendorBrand]
                .filter((b, i, a) => a.indexOf(b) === i) // deduplicate
            : [];

          // Cache Keepa results by search term so Strategy 5 (same terms, lower threshold)
          // doesn't repeat API calls already made by Strategies 1/2.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const apiCache = new Map<string, any[]>();

          const searchAndPick = async (searchTerm: string, minSim = 0.4) => {
            const cacheKey = searchTerm.toLowerCase().trim();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            let normed: any[];
            if (apiCache.has(cacheKey)) {
              normed = apiCache.get(cacheKey)!;
            } else {
              const { asinList } = await keywordSearch(1, searchTerm);
              if (!asinList.length) { apiCache.set(cacheKey, []); return null; }
              const rawFound = await getProducts(1, asinList.slice(0, 20), { stats: 1 });
              normed = normalizeMany(rawFound, 1);
              apiCache.set(cacheKey, normed);
            }
            if (!normed.length) return null;
            let best = normed[0];
            let bestSim = titleSim(productName, best.title);
            for (const n of normed.slice(1)) {
              const s = titleSim(productName, n.title);
              if (s > bestSim) { best = n; bestSim = s; }
            }
            return bestSim >= minSim ? { best, bestSim } : null;
          };

          // Need at least one searchable word
          const nameWords = productName.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(w => w.length > 2);
          if (!nameWords.length) {
            for (const p of group) nameResults.set(p.id, notFound(p.id));
            return;
          }

          // Extract vendor SKU — present on most products (model/part numbers appear
          // in Amazon listing titles and are very precise identifiers).
          const vendorSku = group[0].vendorSku?.trim() || null;
          // A useful SKU is alphanumeric, ≥ 4 chars, not a pure integer (pure integers are often internal IDs)
          const isUsefulSku = vendorSku && /^[A-Z0-9][A-Z0-9\-_]{3,}$/i.test(vendorSku) && !/^\d+$/.test(vendorSku);

          let match = null;

          // ── Strategy 0: vendor SKU / model number ────────────────────────────────
          // SKUs are the most precise identifier after ASINs and UPCs. Many Amazon
          // listings include the manufacturer model number in the title.
          if (!match && isUsefulSku) {
            match = await searchAndPick(vendorSku!, 0.15);
            if (!match && vendorBrand) match = await searchAndPick(`${vendorBrand} ${vendorSku}`.trim(), 0.15);
          }

          // ── Strategy 1: each known full Amazon brand + product name ────────────
          // "Greenland Home Fashions Mermaid", then "Barefoot Bungalow Mermaid", etc.
          for (const brand of knownBrands) {
            if (brand.toLowerCase() === vendorBrand?.toLowerCase()) continue; // skip acronym, try last
            match = await searchAndPick(`${brand} ${productName}`.trim());
            if (match) break;
          }

          // ── Strategy 1.5: shortened brand names (first 2 words) ──────────────
          // e.g. "Greenland Home" from "Greenland Home Fashions" — many Amazon
          // listings use the short form and keyword search misses the full-name version.
          if (!match) {
            const shortBrands = [...new Set(
              knownBrands
                .filter(b => b.split(/\s+/).length > 2)
                .map(b => b.split(/\s+/).slice(0, 2).join(" "))
            )];
            for (const brand of shortBrands) {
              match = await searchAndPick(`${brand} ${productName}`.trim());
              if (match) break;
            }
          }

          // ── Strategy 2: product name only ─────────────────────────────────────
          if (!match) match = await searchAndPick(productName);

          // ── Strategy 3: vendor brand acronym + name (original term) ───────────
          if (!match && vendorBrand && vendorBrand !== productName) {
            match = await searchAndPick(`${vendorBrand} ${productName}`.trim());
          }

          // ── Strategy 4: UPC as keyword (for UPC-fallback products) ────────────
          // Amazon indexes barcodes — searching the UPC often surfaces the exact listing.
          if (!match) {
            const upc = group.find(p => p.upc)?.upc;
            if (upc) match = await searchAndPick(upc, 0.25);
          }

          // ── Strategy 5: relax threshold to 0.3 and try all brands again ───────
          // Last-ditch effort: something is better than "not found".
          if (!match) {
            for (const brand of knownBrands) {
              match = await searchAndPick(`${brand} ${productName}`.trim(), 0.3);
              if (match) break;
            }
          }
          if (!match) match = await searchAndPick(productName, 0.3);

          if (!match) {
            for (const p of group) nameResults.set(p.id, notFound(p.id));
            return;
          }

          const { best } = match;
          for (const p of group) {
            nameResults.set(p.id, compareToLive(
              p, best.title, best.brand ?? null, null,
              best as unknown as Record<string, unknown>,
            ));
          }
        } catch {
          for (const p of group) nameResults.set(p.id, notFound(p.id));
        }
      }));
    }
  }

  // Assemble results in original order.
  // Products with no entry in any map were in the keyword-search queue but the loop broke
  // before processing them (token exhaustion). Mark as "skipped" so the route preserves
  // their previous DB state rather than overwriting with not_found.
  const activeResults = activeProducts.map((p) =>
    asinResults.get(p.id) ?? upcResults.get(p.id) ?? nameResults.get(p.id)
    ?? { productId: p.id, status: "skipped" as const, fields: [] as FieldResult[], liveData: {} }
  );
  return [...discontinuedResults, ...activeResults];
}

// ── Walmart (Marketplace API) ─────────────────────────────────────────────────

async function verifyWalmart(products: Product[]): Promise<VerifyResult[]> {
  const { searchWalmartByUpc, searchWalmartByName } = await import("@/lib/walmart/client");
  const CONCURRENCY = 3;

  // Mark discontinued products immediately
  const discontinuedResults: VerifyResult[] = products
    .filter((p) => isDiscontinuedInVendorData(p.vendorData))
    .map((p) => ({ productId: p.id, status: "discontinued" as const, fields: [], liveData: {} }));
  const activeProducts = products.filter((p) => !isDiscontinuedInVendorData(p.vendorData));

  const results: VerifyResult[] = [];

  for (let i = 0; i < activeProducts.length; i += CONCURRENCY) {
    const batch = activeProducts.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(batch.map(async (p) => {
      let item = null;

      if (p.upc) {
        // Has a UPC — do UPC-based lookup only. If Walmart doesn't carry it by UPC,
        // a keyword search would match random products with the same name (e.g. "Juniper" plant
        // instead of "Juniper" quilt set). Better to return not_found than a wrong match.
        item = await searchWalmartByUpc(p.upc).catch(() => null);
      } else {
        // No UPC — try brand + name, then name alone
        const query = [p.brand, p.name].filter(Boolean).join(" ").trim();
        item = await searchWalmartByName(query).catch(() => null);
        if (!item && p.name) {
          item = await searchWalmartByName(p.name).catch(() => null);
        }
      }

      if (!item) return notFound(p.id);

      const priceInCents = item.salePrice != null ? Math.round(item.salePrice * 100) : null;
      // Map Affiliate API fields to what compareToLive expects
      const liveDataForCompare = {
        ...item,
        images: [item.largeImage, item.thumbnailImage].filter(Boolean),
        description: item.shortDescription ?? item.longDescription ?? "",
      };
      return compareToLive(
        p,
        item.name ?? "",
        item.brandName ?? null,
        priceInCents,
        liveDataForCompare as unknown as Record<string, unknown>,
      );
    }));

    for (let j = 0; j < settled.length; j++) {
      const s = settled[j];
      results.push(s.status === "fulfilled" ? s.value : notFound(batch[j].id));
    }
  }

  return [...discontinuedResults, ...results];
}

// ── BestBuy ───────────────────────────────────────────────────────────────────

async function verifyBestBuy(products: Product[]): Promise<VerifyResult[]> {
  const apiKey = process.env.BESTBUY_API_KEY;
  if (!apiKey) throw new Error("BESTBUY_API_KEY not configured. Add BESTBUY_API_KEY to .env");

  const results: VerifyResult[] = [];
  const CONCURRENCY = 10;

  for (let i = 0; i < products.length; i += CONCURRENCY) {
    const batch = products.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(batch.map(async (p) => {
      const query = encodeURIComponent(p.upc ? `upc=${p.upc}` : `name=${p.name}`);
      const url = `https://api.bestbuy.com/v1/products(${query})?apiKey=${apiKey}&show=name,brand,salePrice,upc&format=json&pageSize=1`;
      const res = await fetch(url).catch(() => null);
      if (!res?.ok) return notFound(p.id);
      const data = await res.json();
      const item = data.products?.[0];
      if (!item) return notFound(p.id);
      return compareToLive(p, item.name, item.brand, item.salePrice ? Math.round(item.salePrice * 100) : null, item);
    }));
    for (const s of settled) results.push(s.status === "fulfilled" ? s.value : notFound(batch[results.length % CONCURRENCY]?.id ?? ""));
  }

  return results;
}

// ── SerpAPI (Temu / Walmart / Mathis / Sears) ─────────────────────────────────

async function verifySerpApi(marketplace: string, products: Product[]): Promise<VerifyResult[]> {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) throw new Error("SERPAPI_KEY not configured. Add it to .env to verify non-Amazon marketplaces.");

  return Promise.all(
    products.map(async (p) => {
      const query = encodeURIComponent(`${p.name} ${p.brand ?? ""} site:${marketplace}.com`);
      const url = `https://serpapi.com/search.json?q=${query}&engine=google_shopping&api_key=${apiKey}`;
      const res = await fetch(url).catch(() => null);
      if (!res?.ok) return notFound(p.id);
      const data = await res.json();
      const item = data.shopping_results?.[0];
      if (!item) return notFound(p.id);
      const priceNum = typeof item.price === "string"
        ? Math.round(parseFloat(item.price.replace(/[^0-9.]/g, "")) * 100)
        : null;
      return compareToLive(p, item.title, item.source ?? null, priceNum, item);
    })
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function notFound(productId: string): VerifyResult {
  return {
    productId,
    status: "not_found",
    fields: [{ field: "availability", label: "Availability", stored: "In Stock", live: "Not found on marketplace", match: false, severity: "mismatch" }],
    liveData: {},
  };
}

function compareToLive(
  p: Product,
  liveTitle: string,
  liveBrand: string | null,
  _livePriceCents: number | null,
  liveData: Record<string, unknown>,
): VerifyResult {
  const fields: FieldResult[] = [];

  // Title
  const sim = titleSim(p.name, liveTitle);
  fields.push({ field: "title", label: "Title", stored: p.name, live: liveTitle, match: sim >= 0.4, severity: sim >= 0.4 ? "ok" : sim >= 0.2 ? "warning" : "mismatch" });

  // Brand
  const brandMatch = !p.brand || !liveBrand || brandsMatch(p.brand, liveBrand);
  fields.push({ field: "brand", label: "Brand", stored: p.brand ?? "N/A", live: liveBrand ?? "N/A", match: brandMatch, severity: brandMatch ? "ok" : "warning" });

  // Images — check vendor has image and marketplace listing has images
  const liveImages = Array.isArray(liveData.images) ? liveData.images as string[] : [];
  const hasLiveImages = liveImages.length > 0;
  // Vendor image: stored imageUrl field OR any image-like URL in vendorData
  const vdRaw = (p.vendorData as Record<string, unknown> | null) ?? {};
  const vendorImgUrl = p.imageUrl || (() => {
    for (const [k, v] of Object.entries(vdRaw)) {
      if (/image|img|photo|picture|thumbnail/i.test(k) && typeof v === "string" && v.startsWith("http")) return v;
    }
    return null;
  })();
  const hasVendorImage = !!vendorImgUrl;
  const imgMatch = !hasVendorImage || hasLiveImages;
  fields.push({
    field: "images", label: "Images",
    stored: vendorImgUrl ? "Vendor image provided" : "N/A",
    live: hasLiveImages ? `${liveImages.length} image${liveImages.length === 1 ? "" : "s"} on marketplace` : "No images on marketplace listing",
    match: imgMatch,
    severity: !hasVendorImage ? "ok" : hasLiveImages ? "ok" : "warning",
  });

  // Description — compare vendor description with Amazon description/features
  const liveDesc = [
    typeof liveData.description === "string" ? liveData.description : "",
    ...(Array.isArray(liveData.features) ? liveData.features as string[] : []),
  ].filter(Boolean).join(" ");
  const vendorDesc = p.description ?? "";
  const descSim = vendorDesc && liveDesc ? wordOverlap(vendorDesc, liveDesc) : null;
  fields.push({
    field: "description", label: "Description",
    stored: vendorDesc || "N/A",
    live: liveDesc ? liveDesc.slice(0, 200) + (liveDesc.length > 200 ? "…" : "") : "N/A",
    match: descSim == null || descSim >= 0.1,
    severity: descSim == null ? "ok" : descSim >= 0.1 ? "ok" : "warning",
  });

  // Dimensions — try two sources; pick the one closer to the marketplace package dims.
  // Source 1: stored dimensions string (may be product size like "90x90" for quilts)
  // Source 2: L/W/H columns from vendorData (individual item package dims)
  // IMPORTANT: dimension differences are NEVER a hard mismatch — max severity is "warning"
  // because vendor product dims and marketplace package dims use different measurement conventions.
  const vendorDimStr = (vdRaw.dimensions as string | null) ?? null;
  const dims1 = vendorDimStr ? parseDims(vendorDimStr) : null;

  const getVdNum = (...names: string[]): number | null => {
    for (const [k, v] of Object.entries(vdRaw)) {
      if (names.some(n => k.toLowerCase() === n.toLowerCase())) {
        const num = parseFloat(String(v).replace(/[^0-9.]/g, ""));
        if (!isNaN(num) && num > 0) return num;
      }
    }
    return null;
  };
  const vL = getVdNum("Length", "Len");
  const vW = getVdNum("Width", "Wid", "Wide");
  const vH = getVdNum("Height", "Hgt", "Ht", "Depth", "Dep");
  const dims2: [number, number, number] | null = vL && vW && vH ? [vL, vW, vH] : null;

  const liveL = typeof liveData.lengthMm === "number" && liveData.lengthMm > 0 ? liveData.lengthMm / 25.4 : null;
  const liveW = typeof liveData.widthMm === "number" && liveData.widthMm > 0 ? liveData.widthMm / 25.4 : null;
  const liveH = typeof liveData.heightMm === "number" && liveData.heightMm > 0 ? liveData.heightMm / 25.4 : null;
  const liveDims = liveL && liveW && liveH ? [liveL, liveW, liveH].sort((a, b) => b - a) as [number, number, number] : null;

  const calcDiff = (vendor: [number, number, number], live: [number, number, number]): number => {
    const vs = [...vendor].sort((a, b) => b - a) as [number, number, number];
    return Math.max(...vs.map((v, i) => Math.abs(v - live[i]) / Math.max(v, 1)));
  };

  // Filter out product-sized dims (e.g. 90×90 quilt) — only compare package-sized dims (all values ≤ 60")
  const isPackageSized = (d: [number, number, number]) => Math.max(...d) <= 60;
  const usableDims1 = dims1 && isPackageSized(dims1) ? dims1 : null;
  const usableDims2 = dims2 && isPackageSized(dims2) ? dims2 : null;

  let bestDims = usableDims1 ?? usableDims2;
  let bestDimDisplay = vendorDimStr || (dims2 ? `${vL} × ${vW} × ${vH}` : null);
  if (liveDims && usableDims1 && usableDims2) {
    if (calcDiff(usableDims2, liveDims) < calcDiff(usableDims1, liveDims)) {
      bestDims = usableDims2;
      bestDimDisplay = `${vL} × ${vW} × ${vH}`;
    }
  } else if (!usableDims1 && usableDims2) {
    bestDimDisplay = `${vL} × ${vW} × ${vH}`;
  }

  // Dimensions are max "warning" — they never cause "mismatch" status on their own
  let dimSeverity: "ok" | "warning" = "ok";
  let dimMatch = true;
  if (bestDims && liveDims) {
    const maxDiff = calcDiff(bestDims, liveDims);
    dimMatch = maxDiff <= 0.25;
    dimSeverity = maxDiff <= 0.25 ? "ok" : "warning";
  }
  fields.push({
    field: "dimensions", label: "Dimensions",
    stored: bestDimDisplay || "N/A",
    live: liveDims ? `${liveDims[0].toFixed(1)}" × ${liveDims[1].toFixed(1)}" × ${liveDims[2].toFixed(1)}" (L×W×H)` : "N/A",
    match: dimMatch,
    severity: dimSeverity,
  });

  const hasMismatch = fields.some((f) => f.severity === "mismatch");
  const hasWarning = fields.some((f) => f.severity === "warning");

  return {
    productId: p.id,
    status: hasMismatch ? "mismatch" : hasWarning ? "warning" : "ok",
    fields,
    liveData,
  };
}

/**
 * Returns true if two brand strings refer to the same brand.
 * Handles: string containment, shared keyword (>3 chars), and acronym matching.
 * "BB" ↔ "Barefoot Bungalow", "GHF" ↔ "Greenland Home Fashions", "Ashley" ↔ "Signature Design by Ashley"
 */
function brandsMatch(a: string, b: string): boolean {
  const al = a.toLowerCase().trim();
  const bl = b.toLowerCase().trim();
  if (!al || !bl) return true;
  if (bl.includes(al) || al.includes(bl)) return true;

  // Shared keyword (>3 chars): "Ashley Furniture" ↔ "Signature Design by Ashley"
  const words = (s: string) => s.replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(w => w.length > 3);
  const wb = new Set(words(bl));
  if (words(al).some(w => wb.has(w))) return true;

  // Acronym: "BB" ↔ "Barefoot Bungalow", "GHF" ↔ "Greenland Home Fashions"
  const acronymOf = (short: string, full: string): boolean => {
    const s = short.replace(/[^a-zA-Z]/g, "").toUpperCase();
    if (s.length < 2 || s.length > 8) return false;
    const initials = full.split(/\s+/).filter(w => w.length > 1).map(w => w[0].toUpperCase()).join("");
    return initials === s;
  };
  return acronymOf(al, bl) || acronymOf(bl, al);
}

/** Word overlap fraction for description comparison (uses the smaller set as denominator). */
function wordOverlap(a: string, b: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(w => w.length > 3);
  const wa = new Set(norm(a));
  const wb = new Set(norm(b));
  if (!wa.size || !wb.size) return 0;
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  return common / Math.min(wa.size, wb.size);
}

/** Parse a vendor dimension string into [W, D, H] in inches. Handles "72W x 38D x 32H", "72 x 38 x 32", etc. */
function parseDims(s: string): [number, number, number] | null {
  const nums = [...s.matchAll(/(\d+(?:\.\d+)?)/g)].map(m => parseFloat(m[1])).filter(n => n > 0);
  if (nums.length < 3) return null;
  return [nums[0], nums[1], nums[2]];
}

function titleSim(a: string, b: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2);
  const wa = new Set(norm(a));
  const wb = new Set(norm(b));
  if (!wa.size) return !wb.size ? 1 : 0;
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  return common / wa.size;
}
