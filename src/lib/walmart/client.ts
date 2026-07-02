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

export async function searchWalmartByUpc(upc: string): Promise<WalmartItem | null> {
  const token = await getToken();
  const res = await fetch(
    `${BASE}/items/walmart/search?query=${encodeURIComponent(upc)}&searchType=TEXT&startIndex=0&count=5`,
    { headers: baseHeaders(token) }
  );
  if (!res.ok) return null;
  const data = await res.json();
  const items: WalmartItem[] = data.items ?? data.itemResponse ?? [];
  return items.find((i) => i.upc === upc) ?? items[0] ?? null;
}

export async function searchWalmartByName(query: string): Promise<WalmartItem | null> {
  const token = await getToken();
  const res = await fetch(
    `${BASE}/items/walmart/search?query=${encodeURIComponent(query)}&searchType=TEXT&startIndex=0&count=10`,
    { headers: baseHeaders(token) }
  );
  if (!res.ok) return null;
  const data = await res.json();
  const items: WalmartItem[] = data.items ?? data.itemResponse ?? [];
  return items[0] ?? null;
}
