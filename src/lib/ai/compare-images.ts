import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";

const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export type ImageCompareVerdict = "match" | "mismatch" | "unsure";

export type ImageCompareResult = {
  verdict: ImageCompareVerdict;
  reason: string;
};

// ── Image download ────────────────────────────────────────────────────────────

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
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

// ── Single pair comparison ─────────────────────────────────────────────────────

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
            { type: "image", image: vendorImg.data, mediaType: vendorImg.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp" },
            { type: "image", image: liveImg.data, mediaType: liveImg.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp" },
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
 * Compare vendor image against ALL available marketplace images (up to maxAngles).
 * Returns "match" as soon as any angle matches — improves accuracy when the primary
 * marketplace image shows a different variant/angle than the vendor image.
 */
export async function compareVendorAgainstAllImages(
  vendorImageUrl: string,
  liveImageUrls: string[],
  productName: string,
  maxAngles = 5,
): Promise<ImageCompareResult> {
  const urls = liveImageUrls.filter((u) => u && u.startsWith("http")).slice(0, maxAngles);
  if (!urls.length) return { verdict: "unsure", reason: "No marketplace images available" };

  let lastResult: ImageCompareResult = { verdict: "unsure", reason: "No images could be compared" };
  for (const liveUrl of urls) {
    const result = await compareProductImages(vendorImageUrl, liveUrl, productName);
    lastResult = result;
    if (result.verdict === "match") return result; // stop at first match
  }
  // All angles checked — return the last result (mismatch or unsure)
  return lastResult;
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

/**
 * Batch version of compareVendorAgainstAllImages.
 */
export async function compareVendorAgainstAllImagesBatch(
  items: Array<{ vendorImageUrl: string; liveImageUrls: string[]; productName: string }>,
  concurrency = 3,
): Promise<ImageCompareResult[]> {
  const results: ImageCompareResult[] = new Array(items.length);
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const settled = await Promise.all(
      batch.map((it) => compareVendorAgainstAllImages(it.vendorImageUrl, it.liveImageUrls, it.productName)),
    );
    settled.forEach((r, j) => { results[i + j] = r; });
  }
  return results;
}
