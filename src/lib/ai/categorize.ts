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

// Per-category descriptions so the AI knows exactly what belongs in each bucket.
// Matched against the template/category name with the first matching pattern.
const CATEGORY_HINTS: Array<[RegExp, string]> = [
  [/seasonal|holiday/i, "Teen & adult Halloween/holiday items: costumes for teens/adults (sizes L, XL, XXL, M/L, adult, 12/14 and up), adult costume props (wigs, hats, canes, adult socks), Christmas decorations, holiday lights/ornaments/wreaths. NOT for infants, babies, or small children (those go in Baby & Kids)."],
  [/baby|kid|youth|child|nursery|toddler/i, "Everything for infants, babies, toddlers, and young children: baby clothing/costumes (sizes NB, 0-3M, 3-6M, 6-12M, 12-18M, 18-24M), toddler items (T1/T2/T3/T4, 2T/3T/4T), young children's costumes and clothing in kids sizes (S/4-6, M/7-8, M/8-10), baby toys, toddler toys, doll sets, stuffed animals, kids accessories (socks size 6 or smaller), cribs, toddler beds, nursery furniture, youth bedroom sets. KEY RULE: if the product name includes a baby/infant size or toddler designation, assign to this category."],
  [/mattress|sleep|foundation/i, "Sleep products: mattresses (innerspring, memory foam, hybrid, latex, pillow-top), box springs, mattress toppers/protectors, adjustable bases, bed pillows, mattress pads."],
  [/kitchen/i, "Kitchen furniture & storage: kitchen islands, bar stools, kitchen carts, breakfast bars, kitchen cabinets, pantry storage."],
  [/rug/i, "Floor coverings: area rugs, runners, accent rugs, outdoor rugs, rug pads — all sizes and styles."],
  [/bedding|bath|linen/i, "Bed & bath textiles: comforter sets, duvet covers, sheet sets, pillowcases, bed skirts, blankets, throws, towels, bath accessories."],
  [/outdoor|patio/i, "Outdoor/patio living: outdoor sofas, sectionals, lounge chairs, patio dining sets, fire pits, umbrellas, porch swings, garden benches, outdoor storage."],
  [/living/i, "Living room furniture: sofas, sectionals, loveseats, recliners, accent chairs, ottomans, coffee tables, end tables, entertainment centers, TV stands, console tables, sofa tables."],
  [/bedroom/i, "Adult bedroom furniture: beds, headboards, bed frames, platform beds, dressers, chests, nightstands, armoires, vanities, mirrors, bedroom sets."],
  [/dining/i, "Dining room: dining tables, dining chairs, barstools, china cabinets, buffets, sideboards, bar carts, dining sets, kitchen tables."],
  [/decor|accent/i, "Decorative accessories: wall art, wall decor, mirrors, sculptures, vases, candles, picture frames, decorative trays, throw pillows, accent lamps, artificial plants/flowers, clocks."],
  [/lighting|lamp/i, "Light fixtures & lamps: chandeliers, pendant lights, ceiling fans, table lamps, floor lamps, wall sconces, lamp shades."],
  [/office/i, "Home office: desks, writing tables, office chairs, task chairs, bookcases, filing cabinets, computer armoires, office sets."],
  [/storage|organiz|shelv/i, "Storage & organization: shelving units, storage ottomans, bookcases, cabinets, media storage, baskets/bins, closet organizers, hall trees, coatracks."],
  [/home\s*improv/i, "Home improvement: tools, hardware, flooring, fixtures, paint, repair/installation items."],
  [/accent|entry|entryway/i, "Accent & entryway furniture: accent chairs, accent tables, console tables, hall trees, benches, entryway sets."],
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
  // Retry any products whose category is not in the allowed list.
  // Final fallback: word-overlap between product name and category name.
  if (availableCategories?.length) {
    const allowed = new Set(availableCategories);
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
          for (const p of batch) {
            retryMap.set(p.id, {
              productId: p.id,
              category: pickClosest(p.name, availableCategories),
              path: pickClosest(p.name, availableCategories),
              confidence: 0.2,
            });
          }
        }
      }

      for (let i = 0; i < allResults.length; i++) {
        const r = allResults[i];
        if (!r?.productId || !offListIds.has(r.productId)) continue;
        const retry = retryMap.get(r.productId);
        if (!retry) continue;
        if (!allowed.has(retry.category)) {
          const p = products.find((p) => p.id === r.productId);
          retry.category = pickClosest(p?.name ?? "", availableCategories);
          retry.path = retry.category;
          retry.confidence = 0.2;
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
    ? "You are a product categorization expert for Mathis Brothers, a large Oklahoma-based home furnishings retailer selling furniture, mattresses, rugs, and home decor."
    : "You are a product categorization expert for a major retail marketplace.";

  const strictRules = availableCategories?.length ? `
STRICT RULES — violations are not acceptable:
1. category = one of the names above, copied exactly character-for-character (no abbreviations, no variations)
2. NEVER output "General", "Other", "Miscellaneous", "Unknown", or any name NOT in the category list
3. AGE/SIZE ROUTING (most important rule for costumes, clothing, toys):
   - Product has infant/baby size (NB, 0-3M, 3-6M, 6-12M, 12-18M, 18-24M) → Baby & Kids
   - Product has toddler size (T1, T2, T3, T4, 2T, 3T, 4T, "Toddler") → Baby & Kids
   - Product has small children's size (S/4-6, M/7-8, M/8-10, size 6 or smaller) → Baby & Kids
   - Product says "Adults", "Adult", teen sizes (L, XL, 12-14, 14-16, 16-18, M/L) → Seasonal (if costume/holiday item)
4. [vendor category] hints in the product list are clues — use them along with the category guide above
5. Spread products across the full range of categories based on what the product actually IS
6. If unsure between two categories, pick the one whose category guide description best matches` : "";

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
  const allowedSet = availableCategories ? new Set(availableCategories) : null;

  try {
    const parsed = JSON.parse(text.trim()) as { index: number; category: string; path: string; confidence: number }[];
    return parsed.map((r) => {
      const cat = allowedSet && !allowedSet.has(r.category) ? fallbackCat : r.category;
      return {
        productId: products[r.index - 1]?.id ?? "",
        category: cat,
        path: r.path ?? cat,
        confidence: r.confidence ?? 0.5,
      };
    }).filter((r) => r.productId);
  } catch {
    // JSON parse failed — try extracting JSON from the response
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]) as { index: number; category: string; path: string; confidence: number }[];
        return parsed.map((r) => {
          const cat = allowedSet && !allowedSet.has(r.category) ? fallbackCat : r.category;
          return {
            productId: products[r.index - 1]?.id ?? "",
            category: cat,
            path: r.path ?? cat,
            confidence: r.confidence ?? 0.5,
          };
        }).filter((r) => r.productId);
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
