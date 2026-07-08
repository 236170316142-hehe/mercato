import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";

const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

type ProductInput = {
  id: string;
  name: string;
  brand: string | null;
  description: string | null;
};

export type CategorizeResult = {
  productId: string;
  category: string;
  path: string;
  confidence: number;
};

const MARKETPLACE_TAXONOMIES: Record<string, string> = {
  amazon: "Amazon product categories (e.g. Electronics > Cameras, Home & Kitchen > Cookware, Clothing > Men's Shoes)",
  bestbuy: "Best Buy categories (e.g. TV & Home Theater, Computers & Tablets, Cell Phones, Appliances, Gaming)",
  walmart: "Walmart categories (e.g. Electronics, Home, Clothing, Baby, Sports & Outdoors, Food)",
  temu: "Temu categories (e.g. Women's Clothing, Home & Garden, Beauty & Health, Electronics, Sports)",
  mathis: "Mathis Brothers categories (e.g. Living Room, Bedroom, Dining Room, Outdoor, Mattresses)",
  sears: "Sears categories (e.g. Appliances, Tools, Clothing, Shoes, Electronics, Lawn & Garden)",
};

export async function categorizeProducts(
  marketplace: string,
  products: ProductInput[],
  availableCategories?: string[],
): Promise<CategorizeResult[]> {
  const taxonomy = availableCategories?.length
    ? `exactly one of these categories (use the name verbatim):\n${availableCategories.map((c) => `- ${c}`).join("\n")}`
    : (MARKETPLACE_TAXONOMIES[marketplace] ?? `${marketplace} product categories`);

  // When categorizing against exact template names, always use Sonnet for accuracy.
  const model = availableCategories?.length
    ? (process.env.CATEGORIZE_ANTHROPIC_MODEL ?? "claude-sonnet-5")
    : (process.env.DEFAULT_ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001");

  const BATCH = 20;
  const PARALLEL = 5;

  const batches: ProductInput[][] = [];
  for (let i = 0; i < products.length; i += BATCH) batches.push(products.slice(i, i + BATCH));

  const allResults: CategorizeResult[] = [];

  for (let i = 0; i < batches.length; i += PARALLEL) {
    const group = batches.slice(i, i + PARALLEL);
    const settled = await Promise.allSettled(group.map((b) => categorizeBatch(b, taxonomy, model, availableCategories)));
    settled.forEach((s, gi) => {
      const fallbackCat = availableCategories?.[0] ?? "General";
      const batchResults = s.status === "fulfilled" ? s.value : group[gi].map((p) => ({
        productId: p.id, category: fallbackCat, path: fallbackCat, confidence: 0.1,
      }));
      allResults.push(...batchResults);
    });
  }

  // ── Validation pass ────────────────────────────────────────────────────────
  // If the AI returned a category not in the allowed list (e.g. "General",
  // "Other", "Miscellaneous"), retry those products with an ultra-strict prompt.
  // If the retry still produces an off-list result, assign the closest category
  // by word-overlap against the product name.
  if (availableCategories?.length) {
    const allowed = new Set(availableCategories);
    const offListIds = new Set(allResults.filter((r) => !allowed.has(r.category)).map((r) => r.productId));

    if (offListIds.size > 0) {
      const retryInputs = products.filter((p) => offListIds.has(p.id));
      const strictTaxonomy = `EXACTLY one of these categories — no exceptions, no alternatives:\n${availableCategories.map((c) => `- ${c}`).join("\n")}`;

      const retryBatches: ProductInput[][] = [];
      for (let i = 0; i < retryInputs.length; i += BATCH) retryBatches.push(retryInputs.slice(i, i + BATCH));

      const retryMap = new Map<string, CategorizeResult>();
      for (const batch of retryBatches) {
        try {
          const batchResults = await categorizeBatch(batch, strictTaxonomy, model, availableCategories);
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

      // Merge retry results; fix any still-off-list with word-overlap fallback
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

// Word-overlap: pick the allowed category whose name shares the most words with the product name.
// Used as last-resort fallback when AI keeps returning off-list results.
function pickClosest(productName: string, allowed: string[]): string {
  if (!allowed.length) return "General";
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter((w) => w.length > 2);
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
  taxonomy: string,
  model: string,
  availableCategories?: string[],
): Promise<CategorizeResult[]> {
  const list = products
    .map((p, idx) => `${idx + 1}. "${p.name}"${p.brand ? ` by ${p.brand}` : ""}${p.description ? ` — ${p.description.slice(0, 80)}` : ""}`)
    .join("\n");

  const strictCategoryRule = availableCategories?.length
    ? `- category MUST be EXACTLY one of the names listed above — copy character-for-character
- NEVER output "General", "Other", "Misc", "Miscellaneous", "Unknown", or ANY word/phrase not in the list
- If you are uncertain, pick the SINGLE most plausible category from the list — never invent a new one`
    : `- category must be a valid ${taxonomy} category name`;

  const prompt = `You are a product categorization expert for a retail store. Categorize each product into ${taxonomy}.

Products to categorize:
${list}

Respond with a JSON array only (no markdown, no explanation):
[
  { "index": 1, "category": "Category Name", "path": "Top Level > Sub Category > Leaf Category", "confidence": 0.95 },
  ...
]

Critical rules:
${strictCategoryRule}
- Spread products across ALL matching categories — never pile everything into one bucket
- Use the MOST SPECIFIC category that fits — generic or seasonal categories are absolute last resorts
- "Seasonal" means holiday or season-specific decor ONLY — not a catch-all for uncertain products
- "Decor" means decorative accessories, art, accent pieces ONLY
- If a product clearly belongs to Rugs, Bedding & Bath, Mattress, Kitchen, Outdoor, Organization, Baby & Kids, or Home Improvement — always use that specific category, never Decor or Seasonal
- path: breadcrumb with " > " separators, category name as the leaf node
- confidence: 0.0–1.0
- Return exactly ${products.length} items in the same order as the input`;

  const { text } = await generateText({
    model: anthropic(model),
    prompt,
    maxOutputTokens: 2000,
  });

  try {
    const parsed = JSON.parse(text.trim()) as { index: number; category: string; path: string; confidence: number }[];
    const fallbackCat = availableCategories?.[0] ?? "General";
    const allowedSet = availableCategories ? new Set(availableCategories) : null;
    return parsed.map((r) => {
      const cat = allowedSet && !allowedSet.has(r.category)
        ? fallbackCat  // will be fixed by validation pass
        : r.category;
      return {
        productId: products[r.index - 1]?.id ?? "",
        category: cat,
        path: r.path,
        confidence: r.confidence,
      };
    }).filter((r) => r.productId);
  } catch {
    const fallbackCat = availableCategories?.[0] ?? "General";
    return products.map((p) => ({
      productId: p.id,
      category: fallbackCat,
      path: fallbackCat,
      confidence: 0.1,
    }));
  }
}
