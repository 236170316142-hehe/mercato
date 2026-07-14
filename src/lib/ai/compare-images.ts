import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";

const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export type ImageCompareVerdict = "match" | "mismatch" | "unsure";

export type ImageCompareResult = {
  verdict: ImageCompareVerdict;
  reason: string;
};

// ── Image download ────────────────────────────────────────────────────────────
// We fetch the bytes ourselves (rather than passing URLs to the API) so that
// vendor-hosted images behind odd CDNs still work, and so a dead URL degrades
// gracefully to "unsure" instead of failing the whole verify batch.

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // Anthropic vision limit is 5MB per image
const SUPPORTED_MIME = /^image\/(jpeg|png|gif|webp)$/i;

async function fetchImage(url: string): Promise<{ data: Uint8Array; mimeType: string } | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; product-verify/1.0)" },
    });
    if (!res.ok) return null;
    const mimeType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!SUPPORTED_MIME.test(mimeType)) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_IMAGE_BYTES) return null;
    return { data: buf, mimeType };
  } catch {
    return null;
  }
}

// ── Visual comparison ─────────────────────────────────────────────────────────

/**
 * Compare a vendor catalog image against a live marketplace image and decide
 * whether they show the same product.
 *
 * Returns "unsure" (→ manual review) when the API key is missing, an image
 * can't be downloaded, or the model can't tell — never throws.
 */
export async function compareProductImages(
  vendorImageUrl: string,
  liveImageUrl: string,
  productName: string,
): Promise<ImageCompareResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { verdict: "unsure", reason: "ANTHROPIC_API_KEY not configured" };
  }

  const [vendorImg, liveImg] = await Promise.all([fetchImage(vendorImageUrl), fetchImage(liveImageUrl)]);
  if (!vendorImg) return { verdict: "unsure", reason: "Could not download catalog image" };
  if (!liveImg) return { verdict: "unsure", reason: "Could not download marketplace image" };

  const model = process.env.DEFAULT_ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";

  try {
    const { text } = await generateText({
      model: anthropic(model),
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                `Product: "${productName}"\n\n` +
                `Image 1 is from our product catalog. Image 2 is from a marketplace listing ` +
                `we matched to this product. Decide whether both images show the SAME product.\n\n` +
                `Rules:\n` +
                `- Ignore differences in background, angle, lighting, watermarks, cropping, ` +
                `lifestyle staging, and image quality.\n` +
                `- Different color/finish variants of the same model count as MATCH only if the ` +
                `shape/design is clearly identical.\n` +
                `- A clearly different item, design, pattern, or pack quantity (e.g. one item vs ` +
                `a multi-pack shot) is a MISMATCH.\n` +
                `- If either image is too unclear to judge, answer UNSURE.\n\n` +
                `Answer on the first line with exactly one word: MATCH, MISMATCH, or UNSURE. ` +
                `On the second line give a one-sentence reason.`,
            },
            { type: "image", image: vendorImg.data, mediaType: vendorImg.mimeType },
            { type: "image", image: liveImg.data, mediaType: liveImg.mimeType },
          ],
        },
      ],
      maxOutputTokens: 150,
    });

    const lines = text.trim().split("\n").map((l) => l.trim()).filter(Boolean);
    const first = (lines[0] ?? "").toUpperCase();
    const reason = lines.slice(1).join(" ") || "No reason given";
    if (first.startsWith("MATCH")) return { verdict: "match", reason };
    if (first.startsWith("MISMATCH")) return { verdict: "mismatch", reason };
    return { verdict: "unsure", reason };
  } catch {
    return { verdict: "unsure", reason: "Image comparison failed" };
  }
}

/**
 * Run compareProductImages over many pairs with bounded concurrency.
 * Items resolve in input order; individual failures resolve to "unsure".
 */
export async function compareProductImagesBatch(
  items: Array<{ vendorImageUrl: string; liveImageUrl: string; productName: string }>,
  concurrency = 4,
): Promise<ImageCompareResult[]> {
  const results: ImageCompareResult[] = new Array(items.length);
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const settled = await Promise.all(
      batch.map((it) => compareProductImages(it.vendorImageUrl, it.liveImageUrl, it.productName)),
    );
    settled.forEach((r, j) => { results[i + j] = r; });
  }
  return results;
}
