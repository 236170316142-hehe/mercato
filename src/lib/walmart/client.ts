import { createSign } from "crypto";

const BASE = "https://developer.api.walmart.com/api-proxy/service/affil/product/v2";

export type WalmartItem = {
  itemId?: string;
  upc?: string;
  name?: string;
  brandName?: string;
  salePrice?: number;
  msrp?: number;
  thumbnailImage?: string;
  largeImage?: string;
  shortDescription?: string;
  longDescription?: string;
  categoryPath?: string;
};

function generateAuthHeaders(): Record<string, string> {
  const consumerId = process.env.WALMART_AFFILIATE_CONSUMER_ID;
  const privateKeyRaw = process.env.WALMART_AFFILIATE_PRIVATE_KEY;
  const keyVersion = process.env.WALMART_AFFILIATE_KEY_VERSION ?? "1";

  if (!consumerId || !privateKeyRaw) {
    throw new Error("WALMART_AFFILIATE_CONSUMER_ID / WALMART_AFFILIATE_PRIVATE_KEY not configured");
  }

  const timestamp = String(Date.now());

  // Sort headers alphabetically by key name (required by Walmart)
  const headersToSign: [string, string][] = [
    ["WM_CONSUMER.ID", consumerId],
    ["WM_CONSUMER.INTIMESTAMP", timestamp],
    ["WM_SEC.KEY_VERSION", keyVersion],
  ];
  headersToSign.sort((a, b) => a[0].localeCompare(b[0]));

  // Canonical string: sorted values joined by "\n" + trailing "\n"
  const canonicalString = headersToSign.map(([, v]) => v.trim()).join("\n") + "\n";

  // Handle env vars where newlines may be stored as literal \n
  const pemKey = privateKeyRaw.replace(/\\n/g, "\n");

  const signer = createSign("SHA256");
  signer.update(canonicalString);
  const signature = signer.sign(pemKey, "base64");

  const result: Record<string, string> = {};
  for (const [k, v] of headersToSign) result[k] = v;
  result["WM_SEC.AUTH_SIGNATURE"] = signature;
  result["Accept"] = "application/json";
  return result;
}

function normalizeUpc(upc: string): string {
  const digits = upc.replace(/\D/g, "");
  // UPC-A is 12 digits; many vendor files drop the leading zero — restore it
  if (digits.length === 11) return "0" + digits;
  return digits;
}

export async function searchWalmartByUpc(upc: string): Promise<WalmartItem | null> {
  const normalized = normalizeUpc(upc);
  try {
    const headers = generateAuthHeaders();
    const res = await fetch(`${BASE}/items?upc=${encodeURIComponent(normalized)}`, { headers });
    if (!res.ok) {
      console.error(`[walmart] UPC search ${res.status}:`, await res.text().catch(() => ""));
      return null;
    }
    const data = await res.json() as Record<string, unknown>;
    const items = (data.items as WalmartItem[] | undefined) ?? [];
    return items.find((i) => normalizeUpc(i.upc ?? "") === normalized) ?? items[0] ?? null;
  } catch (e) {
    console.error("[walmart] UPC search error:", e);
    return null;
  }
}

export async function searchWalmartByName(query: string): Promise<WalmartItem | null> {
  try {
    const headers = generateAuthHeaders();
    const res = await fetch(`${BASE}/search?query=${encodeURIComponent(query)}&numItems=5`, { headers });
    if (!res.ok) {
      console.error(`[walmart] Name search ${res.status}:`, await res.text().catch(() => ""));
      return null;
    }
    const data = await res.json() as Record<string, unknown>;
    const search = data.search as Record<string, unknown> | undefined;
    const items =
      (search?.items as WalmartItem[] | undefined) ??
      (data.items as WalmartItem[] | undefined) ??
      [];
    return items[0] ?? null;
  } catch (e) {
    console.error("[walmart] Name search error:", e);
    return null;
  }
}
