import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";

const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export type ProductInput = {
  id: string;
  name: string;
  brand: string | null;
  description: string | null;
  vendorCategory?: string | null;
};

export type CategorizeResult = {
  productId: string;
  category: string;
  path: string;
  confidence: number;
};

// ── Web search enrichment ─────────────────────────────────────────────────────
// Uses SerpAPI (if key is set) to look up a product name and return a short
// context snippet. Called for low-confidence or Uncategorized products so the
// AI gets real-world context about what the product actually is.

async function searchProductContext(name: string): Promise<string | null> {
  const key = process.env.SERPAPI_KEY;
  if (!key) return null;
  try {
    const url = `https://serpapi.com/search.json?q=${encodeURIComponent(name)}&engine=google&api_key=${key}&num=3`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const data = await res.json() as { organic_results?: { snippet?: string; title?: string }[] };
    const snippets = (data.organic_results ?? [])
      .slice(0, 3)
      .map((r) => [r.title, r.snippet].filter(Boolean).join(": "))
      .filter(Boolean)
      .join(" | ");
    return snippets || null;
  } catch {
    return null;
  }
}

// ── Category hints ────────────────────────────────────────────────────────────
// Descriptions used to build the category guide in the AI prompt.
// These are informational only — the AI makes its own decision based on
// understanding what the product actually IS.

const CATEGORY_HINTS: Array<[RegExp, string]> = [
  [/seasonal|holiday/i,
    "Halloween/holiday items for teens & adults: adult/teen costumes (ANY character or theme), adult costume accessories (wigs, hats, masks, props), holiday home decorations, Christmas trees, ornaments, wreaths, holiday lights. For wearable costumes: use size in the name as a guide (adult/teen/XL/L/12-14/14-16/16-18 → here; toddler/infant/baby/2T/4T/0-3M → Baby & Kids)."],
  [/baby|kid|youth|child|nursery|toddler/i,
    "Everything for infants, babies, toddlers, and young children: costumes and dress-up for babies/toddlers/young kids (NB/0-3M/2T/T4/S/4-6/M/7-8 sizes), children's clothing & accessories, stuffed animals, kids toys, baby gear, nursery & kids bedroom furniture (cribs, toddler beds, bunk beds, youth sets), kids bedding, nursery decor."],
  [/living\s*room/i,
    "Living room furniture: sofas, sectionals, loveseats, recliners, accent chairs, ottomans, coffee tables, end tables, entertainment centers, TV stands, console tables."],
  [/bedroom/i,
    "Adult bedroom furniture: beds, headboards, bed frames, dressers, nightstands, armoires, bedroom sets/suites."],
  [/dining/i,
    "Dining room: dining tables, dining chairs, bar stools, china cabinets, buffets, sideboards, dining sets."],
  [/outdoor|patio/i,
    "Outdoor & patio furniture: outdoor sofas, lounge chairs, patio dining sets, fire pits, umbrellas, garden benches, outdoor storage."],
  [/mattress|sleep|foundation/i,
    "Sleep products: mattresses (all types), box springs, mattress toppers/protectors, adjustable bases, bed pillows, mattress pads."],
  [/rug/i,
    "Floor coverings: area rugs, runners, accent rugs, outdoor rugs, rug pads."],
  [/bedding|bath|linen/i,
    "Bed & bath textiles: comforter sets, duvet covers, sheet sets, pillowcases, blankets, throws, towels, bath accessories."],
  [/decor|accent/i,
    "Decorative home accessories: wall art, mirrors, sculptures, vases, candles, picture frames, decorative pillows, clocks, faux plants."],
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
    lines.push(hint ? `  • "${cat}" — ${hint[1]}` : `  • "${cat}"`);
  }
  return lines.join("\n");
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function categorizeProducts(
  marketplace: string,
  products: ProductInput[],
  availableCategories?: string[],
): Promise<CategorizeResult[]> {
  const mpLower = marketplace.toLowerCase();
  const isMathis = mpLower === "mathis";
  const isTemu = mpLower === "temu";
  const isConstrained = (isMathis || isTemu) && !!availableCategories?.length;

  // Smaller batches for Mathis/Temu (constrained categories) so the AI can reason
  // more carefully about each product. Other marketplaces use larger batches.
  const BATCH = isConstrained ? 8 : 20;
  const PARALLEL = isConstrained ? 2 : 3;

  const model = availableCategories?.length
    ? (process.env.CATEGORIZE_ANTHROPIC_MODEL ?? "claude-sonnet-5")
    : (process.env.DEFAULT_ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001");

  const batches: ProductInput[][] = [];
  for (let i = 0; i < products.length; i += BATCH) batches.push(products.slice(i, i + BATCH));

  const allResults: CategorizeResult[] = [];

  for (let i = 0; i < batches.length; i += PARALLEL) {
    const group = batches.slice(i, i + PARALLEL);
    const settled = await Promise.allSettled(
      group.map((b) => categorizeBatch(b, marketplace, model, availableCategories))
    );
    settled.forEach((s, gi) => {
      const fallback = availableCategories?.[0] ?? "General";
      allResults.push(...(s.status === "fulfilled"
        ? s.value
        : group[gi].map((p) => ({ productId: p.id, category: fallback, path: fallback, confidence: 0.1 }))));
    });
  }

  // ── Validation pass ────────────────────────────────────────────────────────
  if (availableCategories?.length) {
    const allowed = new Set([...availableCategories, "Uncategorized"]);

    // Retry products that landed off-list (AI hallucinated a category name)
    const offListIds = new Set(allResults.filter((r) => !allowed.has(r.category)).map((r) => r.productId));
    if (offListIds.size > 0) {
      const retryInputs = products.filter((p) => offListIds.has(p.id));
      for (let i = 0; i < retryInputs.length; i += BATCH) {
        const batch = retryInputs.slice(i, i + BATCH);
        try {
          const retryResults = await categorizeBatch(batch, marketplace, model, availableCategories, true);
          for (const r of retryResults) {
            if (!allowed.has(r.category)) { r.category = "Uncategorized"; r.path = "Uncategorized"; r.confidence = 0.1; }
            const idx = allResults.findIndex((a) => a.productId === r.productId);
            if (idx !== -1) allResults[idx] = r;
          }
        } catch {
          for (const p of batch) {
            const idx = allResults.findIndex((a) => a.productId === p.id);
            if (idx !== -1) { allResults[idx].category = "Uncategorized"; allResults[idx].path = "Uncategorized"; }
          }
        }
      }
    }

    // ── Web search rescue for Uncategorized products ───────────────────────
    // If SerpAPI is configured, search for each Uncategorized product to get
    // real-world context, then try to re-categorize with that context.
    const uncategorizedIds = new Set(allResults.filter((r) => r.category === "Uncategorized").map((r) => r.productId));
    if (uncategorizedIds.size > 0 && process.env.SERPAPI_KEY) {
      const rescueProducts = products.filter((p) => uncategorizedIds.has(p.id));

      // Search in parallel (max 5 at once to respect rate limits)
      const SEARCH_PARALLEL = 5;
      const enriched: Array<ProductInput & { searchContext?: string }> = [];
      for (let i = 0; i < rescueProducts.length; i += SEARCH_PARALLEL) {
        const slice = rescueProducts.slice(i, i + SEARCH_PARALLEL);
        const contexts = await Promise.all(slice.map((p) => searchProductContext(p.name)));
        slice.forEach((p, j) => enriched.push({ ...p, searchContext: contexts[j] ?? undefined }));
      }

      // Re-categorize with search context in small batches
      for (let i = 0; i < enriched.length; i += 5) {
        const batch = enriched.slice(i, i + 5);
        try {
          const rescueResults = await categorizeBatchWithContext(batch, marketplace, model, availableCategories);
          for (const r of rescueResults) {
            if (!allowed.has(r.category)) { r.category = "Uncategorized"; r.path = "Uncategorized"; }
            const idx = allResults.findIndex((a) => a.productId === r.productId);
            if (idx !== -1) allResults[idx] = r;
          }
        } catch { /* keep Uncategorized */ }
      }
    }
  }

  return allResults;
}

// ── Batch categorization (reasoning-first) ────────────────────────────────────
// Uses a chain-of-thought approach: asks the AI to first identify what each
// product IS before assigning a category. More accurate than direct assignment.

async function categorizeBatch(
  products: ProductInput[],
  marketplace: string,
  model: string,
  availableCategories?: string[],
  strictMode = false,
): Promise<CategorizeResult[]> {
  return categorizeBatchWithContext(
    products.map((p) => ({ ...p, searchContext: undefined })),
    marketplace,
    model,
    availableCategories,
    strictMode,
  );
}

async function categorizeBatchWithContext(
  products: Array<ProductInput & { searchContext?: string }>,
  marketplace: string,
  model: string,
  availableCategories?: string[],
  strictMode = false,
): Promise<CategorizeResult[]> {
  const mpLower = marketplace.toLowerCase();
  const isMathis = mpLower === "mathis";
  const isTemu = mpLower === "temu";

  const list = products.map((p, idx) => {
    let line = `${idx + 1}. "${p.name}"`;
    if (p.brand) line += ` by ${p.brand}`;
    if (p.description) line += ` — ${p.description.slice(0, 150)}`;
    if (p.vendorCategory) line += ` [vendor category: ${p.vendorCategory}]`;
    if (p.searchContext) line += `\n   [web search context: ${p.searchContext.slice(0, 300)}]`;
    return line;
  }).join("\n");

  let categorySection: string;
  if (availableCategories?.length) {
    const guide = buildCategoryGuide(availableCategories);
    categorySection = strictMode
      ? `EXACTLY one of these categories (copy the name character-for-character):\n${availableCategories.map((c) => `- ${c}`).join("\n")}`
      : `exactly one of these categories:\n${availableCategories.map((c) => `- ${c}`).join("\n")}\n\nCategory guide:\n${guide}`;
  } else {
    const taxonomies: Record<string, string> = {
      amazon: "Amazon product categories (Electronics > Cameras, Home & Kitchen > Cookware, Clothing > Men's Shoes, etc.)",
      bestbuy: "Best Buy categories (TV & Home Theater, Computers & Tablets, Cell Phones, Appliances, Gaming, etc.)",
      walmart: "Walmart categories (Electronics, Home, Clothing, Baby, Sports & Outdoors, Food, etc.)",
      temu: "Temu categories (Women's Clothing, Home & Garden, Beauty & Health, Electronics, Sports, etc.)",
      mathis: "Mathis Brothers categories (Living Room, Bedroom, Dining Room, Outdoor, Mattress, Rugs, Bedding & Bath, Baby & Kids, Decor, Lighting, Kitchen, Home Office, Storage, Seasonal)",
      sears: "Sears categories (Appliances, Tools, Clothing, Shoes, Electronics, Lawn & Garden, etc.)",
    };
    categorySection = taxonomies[marketplace] ?? `${marketplace} product categories`;
  }

  const storeContext = isMathis
    ? "You are a product categorization expert for Mathis Brothers, a large Oklahoma-based retailer that sells furniture, mattresses, rugs, bedding, home decor, lighting, AND seasonal/holiday items including Halloween costumes for all ages."
    : isTemu
    ? "You are a product categorization expert for Temu, a global e-commerce marketplace. Temu organizes products by Category > Subcategory > Product Type. Match each product to the most specific product type available in the provided list."
    : "You are a product categorization expert for a major retail marketplace.";

  const reasoningInstruction = `For each product, first think: "What is this product? What does it do / who uses it?" — then pick the best category. Use your knowledge of real-world products.`;

  const rules = availableCategories?.length ? `
RULES:
1. Output EXACTLY one category name from the list above (copy it character-for-character) OR "Uncategorized" if truly no fit exists
2. Never invent category names. Never output "General", "Other", "Furniture", "Unknown", etc.
3. "Uncategorized" is only for products that genuinely don't belong in ANY listed category
4. Use all available information: product name, brand, description, vendor category, web context
5. If the product name includes a size, use it as a strong signal for age/audience` : "";

  const prompt = `${storeContext}

${reasoningInstruction}

Categorize each product into ${categorySection}.

Products:
${list}

Respond ONLY with a JSON array — no markdown, no explanation:
[{"index":1,"category":"Category Name","path":"Category Name","confidence":0.95},...]
${rules}
- path: full path e.g. "Mathis Brothers > Seasonal"
- confidence: 0.0–1.0 (how certain you are)
- Return exactly ${products.length} items in the same order as the product list`;

  const { text } = await generateText({
    model: anthropic(model),
    prompt,
    maxOutputTokens: 2000,
  });

  const fallbackCat = availableCategories?.[0] ?? "General";
  const allowedSet = availableCategories ? new Set([...availableCategories, "Uncategorized"]) : null;

  const mapResult = (r: { index: number; category: string; path: string; confidence: number }) => {
    let cat = r.category?.trim() ?? "";
    if (allowedSet && !allowedSet.has(cat)) {
      // AI returned something slightly off — try word-overlap mapping before giving up
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const normCat = norm(cat);
      let best: string | null = null;
      let bestScore = 0;
      for (const allowed of availableCategories ?? []) {
        const normAllowed = norm(allowed);
        const score = normAllowed.split(" ").filter(w => w.length > 2 && normCat.includes(w)).length
                    + normCat.split(" ").filter(w => w.length > 2 && normAllowed.includes(w)).length;
        if (score > bestScore) { bestScore = score; best = allowed; }
      }
      cat = bestScore >= 2 ? best! : "Uncategorized";
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
    return products.map((p) => ({ productId: p.id, category: fallbackCat, path: fallbackCat, confidence: 0.1 }));
  }
}
