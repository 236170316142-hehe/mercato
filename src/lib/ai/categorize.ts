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

// Per-category descriptions for Mathis Brothers home furnishings categories.
// Matched against the template/category name with the first matching pattern.
// CRITICAL: Mathis is a HOME FURNISHINGS & FURNITURE store — NOT a clothing or costume store.
// Every category below is about HOME goods only. Clothing, apparel, costumes, and fashion
// accessories are NEVER a match for any Mathis category → use "Uncategorized".
const CATEGORY_HINTS: Array<[RegExp, string]> = [
  [/living\s*room/i,
    "Living room FURNITURE: sofas, sectionals, loveseats, recliners, accent chairs, chaises, ottomans (as furniture), coffee tables, end tables, side tables, entertainment centers, TV stands, console/sofa tables, media cabinets. NOT clothing, NOT rugs (those go in Rugs), NOT lighting (those go in Lighting)."],
  [/bedroom/i,
    "Adult bedroom FURNITURE: beds, headboards, footboards, bed frames, platform beds, sleigh beds, storage beds, dressers, chest of drawers, nightstands, armoires, vanities, bedroom mirrors, bedroom sets/suites. NOT kids/youth beds (those go in Baby & Kids), NOT mattresses (those go in Mattress), NOT bedding/sheets (those go in Bedding & Bath)."],
  [/dining\s*room|dining/i,
    "Dining room: dining tables, dining chairs, dining benches, bar stools (counter & bar height), china cabinets, buffets, sideboards, hutches, bar carts, bar cabinets, dining/kitchen sets. NOT kitchen appliances or food."],
  [/outdoor|patio/i,
    "Outdoor & patio HOME furniture: outdoor sofas, outdoor sectionals, lounge chairs, chaise lounges, patio dining sets, fire pits, outdoor swings, garden benches, pergolas, umbrellas, outdoor storage boxes, Adirondack chairs. Must be for outdoor use."],
  [/mattress|sleep|foundation/i,
    "Sleep products: mattresses of all types (innerspring, memory foam, hybrid, latex, pillow-top, gel), box springs/foundations, mattress toppers, mattress protectors, adjustable bed bases, bed pillows, mattress pads. NOT bed frames (those go in Bedroom)."],
  [/rug/i,
    "Floor coverings: area rugs, accent rugs, runners, hallway rugs, outdoor rugs, rug pads, all sizes and materials (wool, polypropylene, natural fiber, shag, flatweave). Product must be a rug or floor covering."],
  [/bedding|bath|linen/i,
    "Bed & bath TEXTILES: comforter sets, duvet covers, duvet inserts, quilt sets, sheet sets, pillowcases, shams, bed skirts, blankets, throws, coverlets, towel sets, bath rugs, shower curtains, bath accessories. NOT bedroom furniture."],
  [/baby|kid|youth|child|nursery|toddler/i,
    "HOME FURNISHINGS for children & nursery: cribs, bassinets, toddler beds, bunk beds, loft beds, youth/kids bedroom sets, kids dressers, kids desks, changing tables, nursery furniture sets, kids bedding sets, baby bedding, nursery decor (wall art, mobiles, lamps for nursery), kids area rugs, playroom furniture, kids storage. NOT clothing, NOT costumes, NOT toys (unless furniture/storage for toys like toy chests)."],
  [/decor|accent/i,
    "Home DECORATIVE accessories: wall art, canvas prints, framed art, wall mirrors (decorative), sculptures, figurines, vases, decorative bowls, candles & candleholders, picture frames, decorative trays, faux plants/flowers, clocks, bookends, decorative pillows & throws (as accent decor), table runners. NOT furniture."],
  [/lighting|lamp/i,
    "Light fixtures & lamps: chandeliers, pendant lights, flush mount & semi-flush lights, ceiling fans with lights, table lamps, floor lamps, arc lamps, wall sconces, vanity lights, lamp shades, light kits. Product must be a lighting item or lamp."],
  [/kitchen/i,
    "Kitchen FURNITURE & storage: kitchen islands, kitchen carts, kitchen bar stools, breakfast bars, kitchen cabinets, pantry storage units, butcher block tables. NOT kitchen appliances, NOT cookware."],
  [/office/i,
    "Home office FURNITURE: desks (writing desks, computer desks, executive desks, standing desks), office chairs, task chairs, bookcases, filing cabinets, credenzas, computer armoires, office sets."],
  [/storage|organiz|shelv/i,
    "Storage & organization HOME furniture: bookcase shelving units, storage ottomans, media storage cabinets, hall trees, coat racks, entryway benches with storage, closet organizer systems, decorative baskets & bins used as home storage. NOT standalone baskets sold as decor."],
  [/seasonal|holiday/i,
    "Seasonal HOME DECOR: Christmas trees (artificial), Christmas/holiday ornaments, wreaths, garlands, holiday lights & string lights, Thanksgiving/harvest home decor, Easter/spring home decor, Halloween HOME decorations (pumpkins, skulls, spooky decor for the home — NOT costumes or wearable items), seasonal throw pillows, seasonal table runners, holiday mantel decor, snow globes. IMPORTANT: apparel, costumes, wigs, and anything worn on the body is NOT seasonal home decor — mark those Uncategorized."],
  [/accent|entry|entryway/i,
    "Accent & entryway HOME furniture: accent chairs (decorative chairs), accent/side tables, console tables (entryway tables), hall trees, entryway benches, coat racks, umbrella stands, entryway sets."],
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
    ? "You are a product categorization expert for Mathis Brothers, a large Oklahoma-based home furnishings retailer. Mathis Brothers sells ONLY: furniture, mattresses, rugs, bedding, home decor, and lighting. They do NOT sell clothing, apparel, costumes, wearable items, food, or electronics."
    : "You are a product categorization expert for a major retail marketplace.";

  const mathisUncategorizedExamples = isMathis
    ? "\n   Examples of products that must be Uncategorized at Mathis: Halloween costumes, wigs, hats (worn), clothing of any kind, shoes, food, electronics, appliances, toys (not furniture/storage), perfume, medicine, sporting goods."
    : "";

  const strictRules = availableCategories?.length ? `
STRICT RULES — violations are not acceptable:
1. category = EXACTLY one of the names above (copy character-for-character) OR "Uncategorized" if the product does not fit
2. NEVER output "General", "Other", "Miscellaneous", "Furniture", "Unknown", or any name NOT in the list (except "Uncategorized")
3. Use "Uncategorized" when the product is clearly NOT a home furnishings/decor item — clothing, costumes, wigs, wearables, food, electronics, toys (non-furniture), fragrances.${mathisUncategorizedExamples}
4. For products that ARE home goods: always assign the most specific matching category from the list. Spread products across ALL relevant categories — do NOT funnel everything into 1-2 buckets.
5. [vendor category] hints in the product list are strong clues — use them along with the category guide above
6. Read the category guide descriptions carefully — each category lists EXACTLY what belongs there
7. If a product could fit two categories, pick the one whose guide description is a closer match` : "";

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
