const BASE = "https://marketplace.walmartapis.com/v3";

function correlationId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function baseHeaders(token: string) {
  return {
    "Authorization": `Bearer ${token}`,
    "WM_SEC.ACCESS_TOKEN": token,
    "WM_QOS.CORRELATION_ID": correlationId(),
    "WM_SVC.NAME": "Mercato",
    "Accept": "application/json",
  };
}

async function getToken(): Promise<string> {
  const id = process.env.WALMART_CLIENT_ID;
  const secret = process.env.WALMART_CLIENT_SECRET;
  if (!id || !secret) throw new Error("WALMART_CLIENT_ID / WALMART_CLIENT_SECRET not configured");

  const creds = Buffer.from(`${id}:${secret}`).toString("base64");
  const res = await fetch(`${BASE}/token`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${creds}`,
      "WM_QOS.CORRELATION_ID": correlationId(),
      "WM_SVC.NAME": "Mercato",
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => res.status.toString());
    throw new Error(`Walmart token error ${res.status}: ${txt}`);
  }
  const data = await res.json();
  return data.access_token as string;
}

export type WalmartItem = {
  itemId?: string;
  upc?: string;
  sku?: string;
  productName?: string;
  price?: number;
  imageUrl?: string;
  shortDescription?: string;
  brand?: string;
};

function extractItems(data: Record<string, unknown>): WalmartItem[] {
  // Handle multiple response shapes from the Walmart Marketplace API
  const candidates = [
    data.items,
    data.itemResponse,
    data.data,
    (data.list as Record<string, unknown> | null)?.items,
    (data.list as Record<string, unknown> | null)?.ItemResponse,
  ];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length > 0) return c as WalmartItem[];
  }
  return [];
}

export async function searchWalmartByUpc(upc: string): Promise<WalmartItem | null> {
  const token = await getToken();

  // Strategy 1: catalog search with PRODUCT_ID searchType (UPC lookup)
  const r1 = await fetch(
    `${BASE}/items/catalog/search?query=${encodeURIComponent(upc)}&searchType=PRODUCT_ID&productIdType=UPC&startIndex=0&count=5`,
    { headers: baseHeaders(token) }
  );
  if (r1.ok) {
    const d = await r1.json() as Record<string, unknown>;
    const items = extractItems(d);
    const match = items.find((i) => i.upc === upc) ?? items[0] ?? null;
    if (match) return match;
  }

  // Strategy 2: text search with the UPC string
  const r2 = await fetch(
    `${BASE}/items/walmart/search?query=${encodeURIComponent(upc)}&searchType=TEXT&startIndex=0&count=5`,
    { headers: baseHeaders(token) }
  );
  if (r2.ok) {
    const d = await r2.json() as Record<string, unknown>;
    const items = extractItems(d);
    // Only accept if the UPC actually matches — prevents wrong product returns
    return items.find((i) => i.upc === upc) ?? null;
  }

  return null;
}

export async function searchWalmartByName(query: string): Promise<WalmartItem | null> {
  const token = await getToken();

  // catalog/search endpoint first
  const r1 = await fetch(
    `${BASE}/items/catalog/search?query=${encodeURIComponent(query)}&searchType=TEXT&startIndex=0&count=10`,
    { headers: baseHeaders(token) }
  );
  if (r1.ok) {
    const d = await r1.json() as Record<string, unknown>;
    const items = extractItems(d);
    if (items.length > 0) return items[0];
  }

  // Fallback to items/walmart/search
  const r2 = await fetch(
    `${BASE}/items/walmart/search?query=${encodeURIComponent(query)}&searchType=TEXT&startIndex=0&count=10`,
    { headers: baseHeaders(token) }
  );
  if (!r2.ok) return null;
  const d = await r2.json() as Record<string, unknown>;
  const items = extractItems(d);
  return items[0] ?? null;
}
