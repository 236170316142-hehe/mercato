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
  const model = process.env.DEFAULT_ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";

  const BATCH = 20;
  const PARALLEL = 5; // run 5 AI calls concurrently

  const batches: ProductInput[][] = [];
  for (let i = 0; i < products.length; i += BATCH) batches.push(products.slice(i, i + BATCH));

  const results: CategorizeResult[] = new Array(batches.length * BATCH);

  for (let i = 0; i < batches.length; i += PARALLEL) {
    const group = batches.slice(i, i + PARALLEL);
    const settled = await Promise.allSettled(group.map((b) => categorizeBatch(b, taxonomy, model)));
    settled.forEach((s, gi) => {
      const batchResults = s.status === "fulfilled" ? s.value : group[gi].map((p) => ({
        productId: p.id, category: "General", path: "General", confidence: 0.1,
      }));
      results.splice((i + gi) * BATCH, BATCH, ...batchResults);
    });
  }

  return results.filter((r) => r?.productId);
}

async function categorizeBatch(
  products: ProductInput[],
  taxonomy: string,
  model: string,
): Promise<CategorizeResult[]> {
  const list = products
    .map((p, idx) => `${idx + 1}. "${p.name}"${p.brand ? ` by ${p.brand}` : ""}${p.description ? ` — ${p.description.slice(0, 80)}` : ""}`)
    .join("\n");

  const prompt = `You are a product categorization expert. Categorize each product into ${taxonomy}.

Products to categorize:
${list}

Respond with a JSON array only (no markdown, no explanation):
[
  { "index": 1, "category": "Category Name", "path": "Top Level > Sub Category > Leaf Category", "confidence": 0.95 },
  ...
]

Rules:
- category: must be EXACTLY one of the allowed category names (copy verbatim, no paraphrasing)
- path: full breadcrumb path with " > " separators (use the category as the leaf)
- confidence: 0.0 to 1.0 based on how certain you are
- Return exactly ${products.length} items in the same order`;

  const { text } = await generateText({
    model: anthropic(model),
    prompt,
    maxOutputTokens: 2000,
  });

  try {
    const parsed = JSON.parse(text.trim()) as { index: number; category: string; path: string; confidence: number }[];
    return parsed.map((r) => ({
      productId: products[r.index - 1]?.id ?? "",
      category: r.category,
      path: r.path,
      confidence: r.confidence,
    })).filter((r) => r.productId);
  } catch {
    // Fallback: assign generic category if AI response can't be parsed
    return products.map((p) => ({
      productId: p.id,
      category: "General",
      path: "General",
      confidence: 0.1,
    }));
  }
}
