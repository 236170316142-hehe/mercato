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
    "WM_CONSUMER.CHANNEL.TYPE": process.env.WALMART_CHANNEL_TYPE_ID ?? "9ebb75c2-1baf-4238-89f7-59a6c37bc347",
    "Accept": "application/json",
    "Content-Type": "application/json",
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
  wpid?: string;
  upc?: string;
  gtin?: string;
  sku?: string;
  productName?: string;
  price?: number;
  imageUrl?: string;
  shortDescription?: string;
  brand?: string;
};

function normalizeItem(raw: Record<string, unknown>): WalmartItem {
  // Price can be a number or { amount, currency }
  let price: number | undefined;
  if (typeof raw.price === "number") price = raw.price;
  else if (raw.price && typeof (raw.price as Record<string,unknown>).amount === "number") {
    price = (raw.price as Record<string, number>).amount;
  }
  return {
    itemId: raw.itemId as string | undefined ?? raw.wpid as string | undefined,
    wpid: raw.wpid as string | undefined,
    upc: raw.upc as string | undefined,
    gtin: raw.gtin as string | undefined,
    sku: raw.sku as string | undefined,
    productName: raw.productName as string | undefined ?? raw.name as string | undefined,
    price,
    imageUrl: raw.imageUrl as string | undefined,
    shortDescription: raw.shortDescription as string | undefined,
    brand: raw.brand as string | undefined,
  };
}

function extractItems(data: Record<string, unknown>): WalmartItem[] {
  const candidates = [
    data.items,
    data.ItemResponse,
    data.itemResponse,
    data.data,
    (data.list as Record<string, unknown> | null)?.items,
    (data.list as Record<string, unknown> | null)?.ItemResponse,
    (data.payload as Record<string, unknown> | null)?.items,
  ];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length > 0) {
      return c.map((i) => normalizeItem(i as Record<string, unknown>));
    }
  }
  return [];
}

export async function searchWalmartByUpc(upc: string): Promise<WalmartItem | null> {
  const token = await getToken();
  const h = baseHeaders(token);

  // Strategy 1: POST catalog search by UPC (correct method per API spec)
  try {
    const r1 = await fetch(`${BASE}/items/catalog/search`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({
        query: upc,
        searchType: "PRODUCT_ID",
        productIdType: "UPC",
        count: 5,
        startIndex: 0,
      }),
    });
    if (r1.ok) {
      const d = await r1.json() as Record<string, unknown>;
      const items = extractItems(d);
      const match = items.find((i) => i.upc === upc || i.gtin?.endsWith(upc)) ?? items[0] ?? null;
      if (match) return match;
    } else {
      console.error(`[walmart] POST catalog/search status ${r1.status}:`, await r1.text().catch(() => ""));
    }
  } catch (e) {
    console.error("[walmart] POST catalog/search error:", e);
  }

  // Strategy 2: Search seller's own items by UPC (GET /v3/items with upc filter)
  try {
    const r2 = await fetch(`${BASE}/items?limit=10`, { headers: h });
    if (r2.ok) {
      const d = await r2.json() as Record<string, unknown>;
      const items = extractItems(d);
      const match = items.find((i) => i.upc === upc || i.gtin?.endsWith(upc));
      if (match) return match;
    }
  } catch (e) {
    console.error("[walmart] GET /items error:", e);
  }

  return null;
}

export async function searchWalmartByName(query: string): Promise<WalmartItem | null> {
  const token = await getToken();
  const h = baseHeaders(token);

  // POST catalog search by keyword
  try {
    const r1 = await fetch(`${BASE}/items/catalog/search`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({
        query,
        searchType: "KEYWORD",
        count: 10,
        startIndex: 0,
      }),
    });
    if (r1.ok) {
      const d = await r1.json() as Record<string, unknown>;
      const items = extractItems(d);
      if (items.length > 0) return items[0];
    } else {
      console.error(`[walmart] POST catalog/search (name) status ${r1.status}:`, await r1.text().catch(() => ""));
    }
  } catch (e) {
    console.error("[walmart] POST catalog/search (name) error:", e);
  }

  return null;
}
