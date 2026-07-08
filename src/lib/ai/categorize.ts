import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";

const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export type ProductInput = {
  id: string;
  name: string;
  brand: string | null;
  description: string | null;
  vendorCategory?: string | null; // original vendor/spreadsheet category — used as a classification hint
};

export type CategorizeResult = {
  productId: string;
  category: string;
  path: string;
  confidence: number;
};

// Per-category descriptions for Mathis Brothers.
// Mathis Brothers is a large Oklahoma home furnishings retailer that also sells
// seasonal costumes, holiday decor, and baby/kids items in its seasonal department.
const CATEGORY_HINTS: Array<[RegExp, string]> = [
  [/seasonal|holiday/i,
    "Seasonal & holiday items for TEENS AND ADULTS: Halloween costumes for teens/adults (sizes S, M, L, XL, XXL, 12-14, 14-16, 16-18, M/L, adult, one-size-fits-most), adult costume accessories (wigs, hats, masks, capes, props, adult socks/tights), Christmas decorations, holiday lights, ornaments, wreaths, garlands, Thanksgiving decor, Easter decor, seasonal throw pillows, holiday mantel decor. KEY SIZE RULE: sizes L/XL/XXL/adult/12+ → Seasonal. NOT for infants or small children — those go in Baby & Kids."],
  [/baby|kid|youth|child|nursery|toddler/i,
    "Items for INFANTS, BABIES, TODDLERS, and YOUNG CHILDREN: baby/toddler/kids Halloween costumes and dress-up (sizes NB, 0-3M, 3-6M, 6-12M, 12-18M, 18-24M, T1, T2, T3, T4, 2T, 3T, 4T, S/4-6, M/7-8, M/8-10), kids clothing, baby accessories (bibs, booties, socks for babies), kids toys, stuffed animals, dolls, baby gear, cribs, toddler beds, bunk beds, youth bedroom sets, nursery furniture, kids bedding, baby monitors, changing tables, kids decor. KEY RULE: any product with a baby/toddler/kids size designation → Baby & Kids."],
  [/living\s*room/i,
    "Living room FURNITURE: sofas, sectionals, loveseats, recliners, accent chairs, ottomans, coffee tables, end tables, entertainment centers, TV stands, console tables."],
  [/bedroom/i,
    "Adult bedroom FURNITURE: beds, headboards, bed frames, dressers, nightstands, armoires, bedroom sets. NOT mattresses (→ Mattress), NOT kids beds (→ Baby & Kids)."],
  [/dining/i,
    "Dining room: dining tables, dining chairs, bar stools, china cabinets, buffets, sideboards, dining sets."],
  [/outdoor|patio/i,
    "Outdoor & patio furniture: outdoor sofas, lounge chairs, patio dining sets, fire pits, umbrellas, garden benches, outdoor storage."],
  [/mattress|sleep|foundation/i,
    "Sleep products: mattresses (all types), box springs, mattress toppers/protectors, adjustable bases, bed pillows, mattress pads."],
  [/rug/i,
    "Floor coverings: area rugs, runners, accent rugs, outdoor rugs, rug pads — all sizes and styles."],
  [/bedding|bath|linen/i,
    "Bed & bath textiles: comforter sets, duvet covers, sheet sets, pillowcases, blankets, throws, towels, bath accessories."],
  [/decor|accent/i,
    "Decorative home accessories: wall art, mirrors, sculptures, vases, candles, picture frames, throw pillows (home decor), clocks, faux plants."],
  [/lighting|lamp/i,
    "Light fixtures & lamps: chandeliers, pendant lights, ceiling fans, table lamps, floor lamps, wall sconces, lamp shades."],
  [/kitchen/i,
    "Kitchen furniture & storage: kitchen islands, bar stools, kitchen carts, kitchen cabinets, pantry storage."],
  [/office/i,
    "Home office furniture: desks, office chairs, bookcases, filing cabinets."],
  [/storage|organiz|shelv/i,
    "Storage & organization: shelving units, storage ottomans, bookcases, hall trees, coat racks, closet organizers."],
  [/accent|entry|entryway/i,
    "Entryway furniture: accent chairs, console tables, hall trees, entryway benches, coat racks."],
];

function buildCategoryGuide(categories: string[]): string {
  const lines: string[] = [];
  for (const cat of categories) {
    const hint = CATEGORY_HINTS.find(([pattern]) => pattern.test(cat));
    lines.push(hint ? `  • "${cat}" → ${hint[1]}` : `  • "${cat}"`);
  }
  return lines.join("\n");
}

export async function categorizeProducts(
  marketplace: string,
  products: ProductInput[],
  availableCategories?: string[],
): Promise<CategorizeResult[]> {
  // Always use Sonnet when constrained to a specific template list — accuracy matters more than speed.
  const model = availableCategories?.length
    ? (process.env.CATEGORIZE_ANTHROPIC_MODEL ?? "claude-sonnet-5")
    : (process.env.DEFAULT_ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001");

  const BATCH = 20;
  const PARALLEL = 3; // reduced to avoid rate limits with Sonnet

  const batches: ProductInput[][] = [];
  for (let i = 0; i < products.length; i += BATCH) batches.push(products.slice(i, i + BATCH));

  const allResults: CategorizeResult[] = [];

  for (let i = 0; i < batches.length; i += PARALLEL) {
    const group = batches.slice(i, i + PARALLEL);
    const settled = await Promise.allSettled(group.map((b) => categorizeBatch(b, marketplace, model, availableCategories)));
    settled.forEach((s, gi) => {
      const fallbackCat = availableCategories?.[0] ?? "General";
      const batchResults = s.status === "fulfilled" ? s.value : group[gi].map((p) => ({
        productId: p.id, category: fallbackCat, path: fallbackCat, confidence: 0.1,
      }));
      allResults.push(...batchResults);
    });
  }

  // ── Validation pass ────────────────────────────────────────────────────────
  // "Uncategorized" is always valid — skip it from retry.
  // Retry products whose category is genuinely off-list (not Uncategorized).
  if (availableCategories?.length) {
    const allowed = new Set([...availableCategories, "Uncategorized"]);
    const offListIds = new Set(allResults.filter((r) => !allowed.has(r.category)).map((r) => r.productId));

    if (offListIds.size > 0) {
      const retryInputs = products.filter((p) => offListIds.has(p.id));
      const retryBatches: ProductInput[][] = [];
      for (let i = 0; i < retryInputs.length; i += BATCH) retryBatches.push(retryInputs.slice(i, i + BATCH));

      const retryMap = new Map<string, CategorizeResult>();
      for (const batch of retryBatches) {
        try {
          const batchResults = await categorizeBatch(batch, marketplace, model, availableCategories, true);
          for (const r of batchResults) retryMap.set(r.productId, r);
        } catch {
          // On error, mark as Uncategorized rather than forcing wrong category
          for (const p of batch) {
            retryMap.set(p.id, {
              productId: p.id,
              category: "Uncategorized",
              path: "Uncategorized",
              confidence: 0.1,
            });
          }
        }
      }

      for (let i = 0; i < allResults.length; i++) {
        const r = allResults[i];
        if (!r?.productId || !offListIds.has(r.productId)) continue;
        const retry = retryMap.get(r.productId);
        if (!retry) continue;
        // If still off-list after retry, mark Uncategorized (never silently force wrong category)
        if (!allowed.has(retry.category)) {
          retry.category = "Uncategorized";
          retry.path = "Uncategorized";
          retry.confidence = 0.1;
        }
        allResults[i] = retry;
      }
    }
  }

  return allResults;
}

function pickClosest(productName: string, allowed: string[]): string {
  if (!allowed.length) return "General";
  const norm = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter((w) => w.length > 2);
  const nameWords = new Set(norm(productName));
  let best = allowed[0];
  let bestScore = -1;
  for (const cat of allowed) {
    const catWords = norm(cat);
    let score = 0;
    for (const w of catWords) if (nameWords.has(w)) score += 2;
    for (const w of nameWords) if (new Set(catWords).has(w)) score += 1;
    if (score > bestScore) { bestScore = score; best = cat; }
  }
  return best;
}

async function categorizeBatch(
  products: ProductInput[],
  marketplace: string,
  model: string,
  availableCategories?: string[],
  strictMode = false,
): Promise<CategorizeResult[]> {
  const isMathis = marketplace === "mathis";

  // Build per-product lines including vendor category hint
  const list = products.map((p, idx) => {
    let line = `${idx + 1}. "${p.name}"`;
    if (p.brand) line += ` by ${p.brand}`;
    if (p.description) line += ` — ${p.description.slice(0, 120)}`;
    if (p.vendorCategory) line += ` [vendor category: ${p.vendorCategory}]`;
    return line;
  }).join("\n");

  // Build the category section of the prompt
  let categorySection: string;
  if (availableCategories?.length) {
    const guide = buildCategoryGuide(availableCategories);
    categorySection = strictMode
      ? `EXACTLY one of these categories (copy character-for-character — no variations allowed):
${availableCategories.map((c) => `- ${c}`).join("\n")}`
      : `exactly one of these categories:
${availableCategories.map((c) => `- ${c}`).join("\n")}

Category guide — what belongs in each:
${guide}`;
  } else {
    const taxonomies: Record<string, string> = {
      amazon: "Amazon product categories (Electronics > Cameras, Home & Kitchen > Cookware, Clothing > Men's Shoes, etc.)",
      bestbuy: "Best Buy categories (TV & Home Theater, Computers & Tablets, Cell Phones, Appliances, Gaming, etc.)",
      walmart: "Walmart categories (Electronics, Home, Clothing, Baby, Sports & Outdoors, Food, etc.)",
      temu: "Temu categories (Women's Clothing, Home & Garden, Beauty & Health, Electronics, Sports, etc.)",
      mathis: "Mathis Brothers home furnishings categories (Living Room, Bedroom, Dining Room, Outdoor, Mattress, Rugs, Bedding & Bath, Baby & Kids, Decor, Lighting, Kitchen, Home Office, Storage, Seasonal, etc.)",
      sears: "Sears categories (Appliances, Tools, Clothing, Shoes, Electronics, Lawn & Garden, etc.)",
    };
    categorySection = taxonomies[marketplace] ?? `${marketplace} product categories`;
  }

  const storeContext = isMathis
    ? "You are a product categorization expert for Mathis Brothers, a large Oklahoma-based retailer selling furniture, mattresses, rugs, home decor, lighting, AND seasonal items including Halloween costumes and holiday decor."
    : "You are a product categorization expert for a major retail marketplace.";

  const strictRules = availableCategories?.length ? `
STRICT RULES — violations are not acceptable:
1. category = EXACTLY one of the names above (copy character-for-character) OR "Uncategorized" if the product genuinely does not fit any category
2. NEVER output "General", "Other", "Miscellaneous", "Furniture", "Unknown", or any name NOT in the list (except "Uncategorized")
3. Use "Uncategorized" ONLY for products that clearly don't fit any category (e.g. electronics, food, medicine, automotive parts, perfume/fragrance). If any reasonable fit exists, assign it.
4. SIZE-BASED ROUTING for seasonal/kids items — most important rule:
   - Baby/infant size (NB, 0-3M, 3-6M, 6-12M, 12-18M, 18-24M) → Baby & Kids
   - Toddler size (T1, T2, T3, T4, 2T, 3T, 4T) → Baby & Kids
   - Young children's size (S/4-6, M/7-8, M/8-10, size ≤10) → Baby & Kids
   - Teen/adult size (L, XL, XXL, 12-14, 14-16, 16-18, M/L, Adult, One Size) → Seasonal
5. [vendor category] hints in the product list are strong clues — use them with the category guide
6. Spread products across ALL relevant categories — do NOT force everything into 1-2 buckets
7. If unsure between two categories, pick the one whose guide description best matches the product` : "";

  const prompt = `${storeContext} Categorize each product into ${categorySection}.

Products:
${list}

Respond with a JSON array only (no markdown, no explanation):
[{"index":1,"category":"Category Name","path":"Category Name","confidence":0.95},...]
${strictRules}
- path: use "Category Name" as the leaf (e.g. "Mathis Brothers > Bedroom")
- confidence: 0.0–1.0
- Return exactly ${products.length} items in the same order`;

  const { text } = await generateText({
    model: anthropic(model),
    prompt,
    maxOutputTokens: 2000,
  });

  const fallbackCat = availableCategories?.[0] ?? "General";
  // "Uncategorized" is always a valid output — it means the product doesn't fit any template
  const allowedSet = availableCategories ? new Set([...availableCategories, "Uncategorized"]) : null;

  const mapResult = (r: { index: number; category: string; path: string; confidence: number }) => {
    let cat = r.category?.trim() ?? "";
    if (allowedSet && !allowedSet.has(cat)) {
      // AI returned something off-list — don't silently force to first template,
      // try word-overlap first; if score is 0 (no overlap at all), mark Uncategorized
      const closest = availableCategories ? pickClosest(cat, availableCategories) : fallbackCat;
      const normCat = cat.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const normClosest = closest.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const hasOverlap = normClosest.split(" ").some(w => w.length > 2 && normCat.includes(w)) ||
                         normCat.split(" ").some(w => w.length > 2 && normClosest.includes(w));
      cat = hasOverlap ? closest : "Uncategorized";
    }
    return {
      productId: products[r.index - 1]?.id ?? "",
      category: cat,
      path: r.path?.trim() || cat,
      confidence: r.confidence ?? 0.5,
    };
  };

  try {
    const parsed = JSON.parse(text.trim()) as { index: number; category: string; path: string; confidence: number }[];
    return parsed.map(mapResult).filter((r) => r.productId);
  } catch {
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]) as { index: number; category: string; path: string; confidence: number }[];
        return parsed.map(mapResult).filter((r) => r.productId);
      } catch { /* fall through */ }
    }
    return products.map((p) => ({
      productId: p.id,
      category: fallbackCat,
      path: fallbackCat,
      confidence: 0.1,
    }));
  }
}
