import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { Product } from "@prisma/client";

const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const TITLE_RULES: Record<string, string> = {
  walmart: `Walmart title format rules:
- Structure: [Brand] [Product Type] [Key Attributes], [Color/Size/Pack if applicable]
- Max 75 characters
- Include the most important searchable attributes: material, color, size, pack count
- Highlight the main USP (e.g. "Memory Foam", "Waterproof", "Heavy Duty")
- Use consumer-friendly language — no internal vendor codes or abbreviations
- Do NOT copy the vendor title verbatim; rewrite it clearly and descriptively
- Do NOT use ALL CAPS or excessive punctuation`,

  amazon: `Amazon title format rules:
- Structure: [Brand] [Product] [Key Feature] [Size/Color/Pack]
- Max 200 characters
- Include primary keywords naturally
- No promotional language (Best, #1, Amazing, etc.)`,

  temu: `Temu title format rules:
- Descriptive and feature-rich, max 60 characters
- Include style, material, color, size/count
- Appeal to value-conscious buyers`,
};

export async function generateMarketplaceTitles(
  marketplace: string,
  products: Product[],
): Promise<Map<string, string>> {
  const titleMap = new Map<string, string>();
  if (!products.length) return titleMap;

  const rules = TITLE_RULES[marketplace.toLowerCase()] ?? TITLE_RULES.walmart;
  const BATCH = 20;

  for (let i = 0; i < products.length; i += BATCH) {
    const batch = products.slice(i, i + BATCH);
    const input = batch.map((p) => {
      const vd = (p.vendorData as Record<string, unknown> | null) ?? {};
      const attrs = ["color", "material", "size", "finish", "style", "fabric"]
        .map((k) => { const v = vd[k]; return v ? `${k}:${v}` : null; })
        .filter(Boolean).join(", ");
      return {
        id: p.id,
        name: p.name,
        brand: p.brand ?? "",
        category: p.marketplaceCategory ?? "",
        description: (p.description ?? "").slice(0, 250),
        attributes: attrs,
      };
    });

    try {
      const { text } = await generateText({
        model: anthropic("claude-haiku-4-5-20251001"),
        prompt: `You are an expert e-commerce copywriter specialising in ${marketplace} listings.

${rules}

Generate an optimised product title for each product. Return ONLY a JSON array — no explanation, no markdown.
Format: [{"id":"<id>","title":"<title>"}, ...]

Products:
${JSON.stringify(input, null, 2)}`,
        maxOutputTokens: 1500,
      });

      const match = text.match(/\[[\s\S]*\]/);
      if (match) {
        const parsed = JSON.parse(match[0]) as { id: string; title: string }[];
        for (const item of parsed) {
          if (item.id && typeof item.title === "string" && item.title.trim()) {
            titleMap.set(item.id, item.title.trim());
          }
        }
      }
    } catch (err) {
      console.error(`[generate-title] batch ${i}–${i + BATCH} failed:`, err);
      // Fall through — products that fail will use their original vendor name
    }

    // Yield between batches so the event loop stays responsive
    await new Promise<void>((r) => setTimeout(r, 0));
  }

  return titleMap;
}
