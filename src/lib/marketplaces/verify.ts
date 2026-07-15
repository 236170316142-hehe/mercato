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
  note?: string; // extra context shown in the UI (e.g. AI image-comparison reasoning)
};

export async function verifyProducts(
  marketplace: string,
  products: Product[],
): Promise<VerifyResult[]> {
  let results: VerifyResult[];
  switch (marketplace) {
    case "amazon_us":
    case "amazon":
      results = await verifyAmazon(products);
      break;
    case "walmart":
      results = await verifyWalmart(products);
      break;
    default:
      // Only Amazon and Walmart are verified; all others pass through as ok.
      return products.map((p) => ({
        productId: p.id,
        status: "ok",
        fields: [],
        liveData: {},
      }));
  }

  // Post-pass: AI visual comparison of catalog vs marketplace images.
  await applyImageComparison(results, products);
  return results;
}

// ── AI image comparison post-pass ─────────────────────────────────────────────
// For every result where both a catalog image and a marketplace image exist,
// ask a vision model whether they show the same product, then upgrade the
// "images" field from the default "warning" to "ok" (visual match) or
// "mismatch" (visibly different product). "unsure" keeps the manual-review
// warning. Degrades gracefully: without an API key nothing changes.

async function applyImageComparison(results: VerifyResult[], products: Product[]): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) return;

  const isUrl = (v: string | undefined): v is string => !!v && v.startsWith("http");
  const nameById = new Map(products.map((p) => [p.id, p.name]));

  const targets: { result: VerifyResult; field: FieldResult }[] = [];
  for (const r of results) {
    const field = r.fields.find((f) => f.field === "images");
    if (!field || !isUrl(field.stored) || !isUrl(field.live)) continue;
    targets.push({ result: r, field });
  }
  if (!targets.length) return;

  const { compareProductImagesBatch } = await import("@/lib/ai/compare-images");
  const verdicts = await compareProductImagesBatch(
    targets.map((t) => ({
      vendorImageUrl: t.field.stored,
      liveImageUrl: t.field.live,
      productName: nameById.get(t.result.productId) ?? "",
    })),
  );

  targets.forEach((t, i) => {
    const v = verdicts[i];
    if (v.verdict === "match") {
      t.field.severity = "ok";
      t.field.match = true;
    } else if (v.verdict === "mismatch") {
      t.field.severity = "mismatch";
      t.field.match = false;
    }
    // "unsure" → keep the existing "warning" (manual review)
    t.field.note = v.verdict === "match"
      ? `AI visual check: images match — ${v.reason}`
      : v.verdict === "mismatch"
        ? `AI visual check: images differ — ${v.reason}`
        : `Needs manual review — ${v.reason}`;

    // Recompute the overall status from the updated field severities.
    const hasMismatch = t.result.fields.some((f) => f.severity === "mismatch");
    const hasWarning = t.result.fields.some((f) => f.severity === "warning");
    t.result.status = hasMismatch ? "mismatch" : hasWarning ? "warning" : "ok";
  });
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
      // ASIN is the most definitive product identity — always trust it.
      // Don't reject based on title similarity: vendor files often use abbreviations.
      const result = compareToLive(p, lp.title as string, lp.brand as string ?? null, null, lp as Record<string, unknown>);
      // Downgrade mismatch → warning for ASIN-confirmed products (title abbreviation ≠ wrong product)
      if (result.status === "mismatch") {
        result.status = "warning";
        result.fields = result.fields.map((f) =>
          f.severity === "mismatch" ? { ...f, severity: "warning" as const } : f
        );
      }
      asinResults.set(p.id, result);
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

    // Map every barcode Keepa returns → list of normalized live products.
    // Coerce codes to string: some Keepa responses return numeric EANs.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const codeToLiveList = new Map<string, (typeof liveNorm[number])[]>();
    rawProducts.forEach((raw, idx) => {
      const norm = liveNorm[idx];
      if (!norm) return;
      const codes = [...(raw.eanList ?? []), ...(raw.upcList ?? [])]
        .map((c) => String(c).trim())
        .filter((c) => c.length >= 8);
      for (const code of codes) {
        if (!codeToLiveList.has(code)) codeToLiveList.set(code, []);
        codeToLiveList.get(code)!.push(norm);
      }
    });

    for (const p of withUpcOnly) {
      // Collect candidates across all variants (UPC-12 + EAN-13)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let candidates: (typeof liveNorm[number])[] = [];
      for (const v of upcVariants(resolvedUpc(p))) {
        for (const c of (codeToLiveList.get(v) ?? [])) candidates.push(c);
      }

      // Code map miss — Keepa may have returned the product but not populated
      // eanList/upcList (common for some catalog entries), or the batch lookup
      // silently failed for this code. Do a targeted single-product rescue lookup.
      if (!candidates.length) {
        const rescueCodes = upcVariants(resolvedUpc(p));
        if (rescueCodes.length) {
          try {
            const rescueRaw = await getProductsByCode(1, rescueCodes, { stats: 1 });
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const rescueNorm = normalizeMany(rescueRaw, 1) as any[];
            candidates = rescueNorm.filter(Boolean);
          } catch { /* fall through to upcNotFound */ }
        }
      }

      if (!candidates.length) {
        upcNotFound.push(p);
        continue;
      }

      // Pick the best ASIN using multi-signal scoring (not just title).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const best: any = pickBestCandidate(p, candidates);

      // A UPC barcode IS the product identity — do NOT reject based on title similarity.
      // Vendor files often use heavy abbreviations ("PWR STRP 360PRO") that share zero words
      // with the full Amazon title ("360 Electrical Pro Heavy Duty Hexacore"). The UPC match
      // is definitive — trust it unconditionally and let compareToLive report the title diff
      // as a warning rather than silently returning not_found.
      const resolved = resolvedUpc(p);
      const result = compareToLive(p, best.title as string, (best.brand as string) ?? null, null, best as Record<string, unknown>);
      if (resolved && !p.upc) result.resolvedUpc = resolved;
      // UPC-confirmed product: downgrade any mismatch → warning so vendor abbreviation
      // differences don't block the export. The UPC is the authoritative identity check.
      if (result.status === "mismatch") {
        result.status = "warning";
        result.fields = result.fields.map((f) =>
          f.severity === "mismatch" ? { ...f, severity: "warning" as const } : f
        );
      }
      upcResults.set(p.id, result);
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

          // Vendor model/part number — exact match against a candidate's model/MPN
          // is a definitive identity signal that overrides title similarity.
          const vendorModel = extractModelNumber(group[0].vendorData);

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
            // Exact model/MPN match wins outright, regardless of title similarity
            if (vendorModel) {
              const vm = modelNorm(vendorModel);
              for (const n of normed) {
                const candModels = [n.model, n.partNumber]
                  .filter((m: unknown): m is string => typeof m === "string" && !!m.trim())
                  .map(modelNorm);
                if (candModels.includes(vm)) return { best: n, bestSim: 1 };
              }
            }
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

          // ── Strategy 0: vendor model number / SKU ────────────────────────────────
          // Model numbers and SKUs are the most precise identifiers after ASINs and
          // UPCs. Many Amazon listings include the manufacturer model number in the
          // title, and Keepa indexes model/MPN for keyword search.
          if (!match && vendorModel && vendorModel !== vendorSku) {
            match = await searchAndPick(vendorModel, 0.15);
            if (!match && vendorBrand) match = await searchAndPick(`${vendorBrand} ${vendorModel}`.trim(), 0.15);
          }
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
      // Build Walmart product page URL from itemId (not the image URL)
      const slug = (item.name ?? "product")
        .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
      const walmartProductUrl = item.itemId
        ? `https://www.walmart.com/ip/${slug}/${item.itemId}`
        : "";
      const liveDataForCompare = {
        ...item,
        images: [item.largeImage, item.thumbnailImage].filter(Boolean),
        description: item.shortDescription ?? item.longDescription ?? "",
        productUrl: walmartProductUrl,
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

  // Title — semantic similarity + recall signal + pack-quantity mismatch check
  const sim = titleSim(p.name, liveTitle);
  // Recall: what fraction of vendor title words are found in the live title?
  // Walmart/Walmart titles are often much longer and more verbose. A short vendor
  // title like "iStep 6 Inch Running Board" is fully contained within a longer
  // Walmart title like "APS iStep 6 Inch Black Running Board Nerf Bars for Jeep…"
  // The Jaccard score drops because of the many extra Walmart words, but recall
  // tells us the vendor's key terms are all there.
  const wv = normalizeTitle(p.name);
  const wl = normalizeTitle(liveTitle);
  let recallHits = 0;
  for (const w of wv) if (wl.has(w)) recallHits++;
  const recall = wv.size > 0 ? recallHits / wv.size : 0;

  let titleSeverity: "ok" | "warning" | "mismatch" =
    sim >= 0.4 || recall >= 0.6 ? "ok"     // Jaccard ok OR 60%+ vendor words found in live title
    : sim >= 0.2 || recall >= 0.4 ? "warning"
    : "mismatch";
  // Pack-quantity check: if vendor title has no quantity (= 1) and live title says "Pack of N"
  // (N > 1), or vice-versa, that is a definitive mismatch regardless of word similarity.
  const vendorQty = extractPackQty(p.name);
  const liveQty = extractPackQty(liveTitle);
  if (vendorQty !== liveQty) titleSeverity = "mismatch";
  fields.push({
    field: "title", label: "Title",
    stored: p.name, live: liveTitle,
    match: titleSeverity === "ok",
    severity: titleSeverity,
  });

  // Brand — standard matching + cross-check with product titles.
  // Vendors often store the parent-company name ("APS") while the marketplace
  // shows the product-line brand ("iStep"). If the live brand appears in the
  // vendor's product title, or the vendor brand appears in the live title,
  // we know it's the same product family.
  const liveBrandInVendorTitle = !!(liveBrand && p.name.toLowerCase().includes(liveBrand.toLowerCase()));
  const vendorBrandInLiveTitle = !!(p.brand && liveTitle.toLowerCase().includes(p.brand.toLowerCase()));
  const brandMatch = !p.brand || !liveBrand
    || brandsMatch(p.brand, liveBrand)
    || liveBrandInVendorTitle
    || vendorBrandInLiveTitle;
  fields.push({ field: "brand", label: "Brand", stored: p.brand ?? "N/A", live: liveBrand ?? "N/A", match: brandMatch, severity: brandMatch ? "ok" : "warning" });

  // Model number — compare vendor's model/part number against live listing's model/MPN
  const vdRaw = (p.vendorData as Record<string, unknown> | null) ?? {};
  const vendorModel = extractModelNumber(p.vendorData);
  const liveModel =
    (typeof liveData.model === "string" && liveData.model.trim() ? liveData.model.trim() : null) ||
    (typeof liveData.partNumber === "string" && liveData.partNumber.trim() ? liveData.partNumber.trim() : null);
  const modelMatch = !vendorModel || !liveModel || modelNorm(vendorModel) === modelNorm(liveModel);
  fields.push({
    field: "model", label: "Model Number",
    stored: vendorModel ?? "N/A",
    live: liveModel ?? "N/A",
    match: modelMatch,
    severity: !vendorModel || !liveModel ? "ok" : modelMatch ? "ok" : "warning",
  });

  // Images — start as "warning" whenever a vendor image exists; the AI visual
  // comparison post-pass (applyImageComparison) upgrades this to "ok" or
  // "mismatch" after actually looking at both images. If the AI is unavailable
  // or unsure, the "warning" stands and signals manual review.
  const liveImages = Array.isArray(liveData.images) ? liveData.images as string[] : [];
  const hasLiveImages = liveImages.length > 0;
  const vendorImgUrl = p.imageUrl || (() => {
    for (const [k, v] of Object.entries(vdRaw)) {
      if (/image|img|photo|picture|thumbnail/i.test(k) && typeof v === "string" && v.startsWith("http")) return v;
    }
    return null;
  })();
  const hasVendorImage = !!vendorImgUrl;
  // "ok" only when no vendor image (nothing to compare); "warning" when both exist (needs visual review);
  // "warning" when vendor has image but live has none.
  const imgSeverity: "ok" | "warning" = !hasVendorImage ? "ok" : "warning";
  // For live value: prefer a product page URL (Walmart) over raw image URL — more useful in the report
  const liveImgOrUrl = (liveData.productUrl as string | undefined) || liveImages[0] || "N/A";
  fields.push({
    field: "images", label: "Images",
    stored: vendorImgUrl ?? "N/A",
    live: liveImgOrUrl,
    match: hasVendorImage ? hasLiveImages : true,
    severity: imgSeverity,
  });

  // Description — compare vendor description with live description/features.
  // Skip comparison when the vendor description is too short or looks like
  // placeholder/restricted text — these produce false warnings because they
  // have near-zero word overlap with any real marketplace description.
  const liveDesc = [
    typeof liveData.description === "string" ? liveData.description : "",
    ...(Array.isArray(liveData.features) ? liveData.features as string[] : []),
  ].filter(Boolean).join(" ");
  const vendorDesc = p.description ?? "";
  const vendorDescWords = vendorDesc.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(w => w.length > 3);
  // Placeholder detection: too short (<8 meaningful words) OR common filler phrases
  const isPlaceholderDesc = vendorDescWords.length < 8
    || /\b(restricted|confidential|proprietary|call for|n\/a|see image|coming soon|tbd|contact us)\b/i.test(vendorDesc);
  const descSim = !isPlaceholderDesc && vendorDesc && liveDesc ? wordOverlap(vendorDesc, liveDesc) : null;
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

  // Status rollup — distinguish hard fields (identity-critical) from soft fields
  // (informational). A warning on a soft field alone is surfaced in the report
  // for manual review but does NOT change the overall status to "warning".
  // Hard: title, brand, model  →  any warning/mismatch here = escalates status
  // Soft: images, description, dimensions  →  shown in report, but won't alone
  //       cause "warning" overall (too many false positives from short vendor
  //       descriptions and visual-only image checks)
  const HARD_FIELDS = new Set(["title", "brand", "model"]);
  const hasMismatch = fields.some((f) => f.severity === "mismatch");
  const hasHardWarning = fields.some((f) => f.severity === "warning" && HARD_FIELDS.has(f.field));

  return {
    productId: p.id,
    status: hasMismatch ? "mismatch" : hasHardWarning ? "warning" : "ok",
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

// ── Multi-signal ASIN candidate picker ───────────────────────────────────────
// When Keepa returns multiple ASINs for a single UPC, score each candidate
// across 7 signals and return the highest-scoring one.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function pickBestCandidate(p: Product, candidates: any[]): any {
  if (candidates.length === 1) return candidates[0];

  // Extract vendor price for price-range comparison
  const vdRaw = (p.vendorData as Record<string, unknown> | null) ?? {};

  // Vendor model / part number — the strongest identity signal after the barcode itself
  const vendorModel = extractModelNumber(p.vendorData);
  const vendorPrice = (() => {
    if (p.price != null) return Number(p.price);
    for (const key of ["price", "retail_price", "unit_price", "cost", "msrp", "list_price", "wholesale"]) {
      const v = vdRaw[key];
      if (v != null && !isNaN(Number(v))) return Number(v);
    }
    return null;
  })();

  // Extract vendor category for category-match signal
  const vendorCategory = (() => {
    for (const key of ["category", "Category", "product_category", "item_category", "department", "product_type"]) {
      const v = vdRaw[key];
      if (v && typeof v === "string") return v.toLowerCase();
    }
    return null;
  })();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const score = (c: any): number => {
    let s = 0;

    // 0. Model number match — weight 50
    // A matching model/MPN is nearly a guaranteed correct listing, so it outweighs
    // every other single signal. Match against the candidate's model AND partNumber
    // fields; fall back to checking whether the model appears verbatim in the title.
    if (vendorModel) {
      const vm = modelNorm(vendorModel);
      const candModels = [c.model, c.partNumber]
        .filter((m): m is string => typeof m === "string" && !!m.trim())
        .map(modelNorm);
      if (candModels.includes(vm)) s += 50;
      else if (vm.length >= 4 && modelNorm(c.title as string ?? "").includes(vm)) s += 30;
    }

    // 1. Title similarity — weight 35
    const ts = titleSim(p.name, c.title as string ?? "");
    s += ts * 35;

    // 2. Brand match — weight 25
    // Exact brand match scores full; partial (one contains other) scores half
    const vendorBrand = (p.brand ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const liveBrand = (c.brand as string ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (vendorBrand && liveBrand) {
      if (vendorBrand === liveBrand) s += 25;
      else if (vendorBrand.includes(liveBrand) || liveBrand.includes(vendorBrand)) s += 12;
    }

    // 3. Price proximity — weight 20
    // Score based on how close the live price is to the vendor price.
    // A price within 20% = full score; >100% off = 0.
    if (vendorPrice != null && vendorPrice > 0 && c.price != null) {
      const livePrice = (c.price as number) / 100; // Keepa stores cents
      if (livePrice > 0) {
        const ratio = Math.min(vendorPrice, livePrice) / Math.max(vendorPrice, livePrice);
        s += ratio * 20; // 1.0 if identical, 0.5 if one is 2x the other
      }
    }

    // 4. Category match — weight 15
    // Compare vendor category hint against Amazon category tree or title
    if (vendorCategory) {
      const catWords = vendorCategory.split(/[\s,>/]+/).filter((w) => w.length > 3);
      const liveContext = [
        c.title as string ?? "",
        c.categoryTree as string ?? "",
        c.rootCategory as string ?? "",
      ].join(" ").toLowerCase();
      const catHits = catWords.filter((w) => liveContext.includes(w)).length;
      if (catWords.length > 0) s += (catHits / catWords.length) * 15;
    }

    // 5. Pack / quantity match — weight 20
    // Same rule as verification: a title with no pack mention = single unit (qty 1).
    // Prefer ASINs whose Amazon title implies the same quantity as the vendor title;
    // penalize candidates with a different pack size (vendor qty 1 vs "Pack of 6").
    const vendorQty = extractPackQty(p.name);
    const liveQty   = extractPackQty(c.title as string ?? "");
    if (vendorQty === liveQty) {
      if (vendorQty > 1) s += 20; // explicit pack match — big bonus
      // both single-unit: no bonus (that's the default, not a signal)
    } else {
      s -= 15; // different pack size — penalty
    }

    // 6. Availability / sales rank — weight 5
    const rank = c.salesRank as number ?? -1;
    if (rank > 0 && rank < 1_000_000) s += 5;
    else if (rank > 0 && rank < 5_000_000) s += 2;

    return s;
  };

  let best = candidates[0];
  let bestScore = score(candidates[0]);
  for (const c of candidates.slice(1)) {
    const cs = score(c);
    if (cs > bestScore) { bestScore = cs; best = c; }
  }
  return best;
}

// ── Pack-quantity helpers ─────────────────────────────────────────────────────
// Extracts the item-count / pack size from a product title.
// No mention → treated as 1 (single unit). Used to flag qty mismatches between
// the vendor title and the live marketplace title (Pack of 6 ≠ Pack of 1).

export function extractPackQty(title: string): number {
  const t = title.toLowerCase();
  const patterns: RegExp[] = [
    /pack[- ]of[- ](\d+)/,               // "pack of 6", "pack-of-6"
    /(\d+)[- ]?pack\b/,                  // "6-pack", "6 pack", "6pack"
    /set[- ]of[- ](\d+)/,                // "set of 3"
    /(\d+)[- ]?(?:pieces?|pcs?)\b/,      // "6 pieces", "6 pcs", "6pc"
    /(\d+)[- ]?(?:count|ct)\b/,          // "6 count", "6ct"
    /(\d+)[- ]?pk\b/,                    // "6pk", "6-pk"
    /box[- ]of[- ](\d+)/,                // "box of 12"
    /bundle[- ]of[- ](\d+)/,             // "bundle of 4"
    /(\d+)[- ]units?\b/,                 // "6 units"
    /qty[: ]+(\d+)/,                     // "qty: 6"
    /\((\d+)\s*(?:pack|count|ct|pk|pcs?|pieces?)\)/, // "(6 pack)", "(12 ct)"
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) {
      const qty = parseInt(m[1], 10);
      if (qty > 0 && qty <= 500) return qty;
    }
  }
  return 1; // default: single unit
}

// ── Model-number helpers ──────────────────────────────────────────────────────
// Extracts a model / part number from raw vendor spreadsheet data.

/** Normalize a model/part number for comparison: lowercase, strip separators. */
function modelNorm(s: string): string {
  return s.toLowerCase().replace(/[\s\-_\/.]+/g, "");
}

const MODEL_NUMBER_KEYS = [
  "model", "modelnumber", "modelno", "modelnum",
  "mpn", "manufacturerpartnumber", "mfrpartno",
  "partnumber", "partno", "partnum",
  "itemmodelnumber",
];

export function extractModelNumber(vendorData: unknown): string | null {
  if (!vendorData || typeof vendorData !== "object") return null;
  const vd = vendorData as Record<string, unknown>;
  const norm = (s: string) => s.toLowerCase().replace(/[\s_\-#.]+/g, "");
  for (const [k, v] of Object.entries(vd)) {
    if (MODEL_NUMBER_KEYS.includes(norm(k))) {
      if (v && typeof v === "string") {
        const val = v.trim();
        if (val && !val.startsWith("http")) return val;
      }
    }
  }
  return null;
}

// Common retail abbreviation synonyms — both directions are registered
const SYNONYMS: Record<string, string> = {
  tv: "television", television: "tv",
  pc: "computer", computer: "pc",
  ac: "airconditioner", airconditioner: "ac",
  wifi: "wireless", wireless: "wifi",
  bt: "bluetooth", bluetooth: "bt",
  usb: "universal", pkg: "package",
  qty: "quantity", pcs: "pieces", pieces: "pcs",
  sz: "size", xl: "extralarge", lg: "large", sm: "small", md: "medium",
  blk: "black", wht: "white", gry: "gray", grey: "gray",
  pwr: "power", strp: "strip", ext: "extension",
  hdmi: "highdefinition", led: "light", lcd: "display",
  fridge: "refrigerator", refrigerator: "fridge",
  sofa: "couch", couch: "sofa",
  stool: "chair", barstool: "stool",
  // Automotive running boards / steps
  sidestep: "runningboard", runningboard: "sidestep",
  nerfbar: "runningboard", stepbar: "runningboard",
  sideboard: "runningboard", stepboard: "runningboard",
  // Home / furniture
  comforter: "bedding", quilt: "bedding", duvet: "bedding",
  loveseat: "sofa", sectional: "sofa",
  dresser: "chest", armoire: "wardrobe", wardrobe: "armoire",
  rug: "carpet", carpet: "rug",
};

function normalizeTitle(s: string): Set<string> {
  const STOP = new Set(["the", "and", "for", "with", "from", "this", "that", "are", "was", "has"]);
  const tokens = s.toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
  const result = new Set<string>();
  for (const t of tokens) {
    result.add(t);
    if (SYNONYMS[t]) result.add(SYNONYMS[t]);
  }
  return result;
}

function titleSim(a: string, b: string): number {
  const wa = normalizeTitle(a);
  const wb = normalizeTitle(b);
  if (!wa.size) return !wb.size ? 1 : 0;
  // Jaccard similarity: |intersection| / |union| — symmetric, works both ways
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  const union = wa.size + wb.size - common;
  const jaccard = union > 0 ? common / union : 0;
  // Also compute recall (how much of 'a' is in 'b') as secondary signal
  const recall = common / wa.size;
  // Weighted blend: 60% Jaccard + 40% recall
  return jaccard * 0.6 + recall * 0.4;
}
