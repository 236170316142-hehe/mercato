import { NextRequest, NextResponse } from "next/server";
import { adminGuard } from "@/lib/auth-helpers";

const BASE = "https://marketplace.walmartapis.com/v3";

function correlationId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export async function GET(req: NextRequest) {
  const { response } = await adminGuard();
  if (response) return response;

  const upc = req.nextUrl.searchParams.get("upc") ?? "636047400413";
  const log: Record<string, unknown> = {};

  // Step 1: Get token
  const id = process.env.WALMART_CLIENT_ID;
  const secret = process.env.WALMART_CLIENT_SECRET;
  log.credentials = { clientIdSet: !!id, secretSet: !!secret };

  if (!id || !secret) {
    return NextResponse.json({ error: "Credentials not configured", log });
  }

  let token: string | null = null;
  try {
    const creds = Buffer.from(`${id}:${secret}`).toString("base64");
    const tokenRes = await fetch(`${BASE}/token`, {
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
    const tokenBody = await tokenRes.text();
    log.tokenStatus = tokenRes.status;
    log.tokenHeaders = Object.fromEntries(tokenRes.headers.entries());
    log.tokenBody = tokenBody;

    if (!tokenRes.ok) {
      return NextResponse.json({ error: "Token request failed", log });
    }
    const tokenData = JSON.parse(tokenBody);
    token = tokenData.access_token as string;
    log.tokenOk = true;
    log.tokenType = tokenData.token_type;
  } catch (e) {
    log.tokenError = String(e);
    return NextResponse.json({ error: "Token fetch threw", log });
  }

  const headers = {
    "Authorization": `Bearer ${token}`,
    "WM_SEC.ACCESS_TOKEN": token,
    "WM_QOS.CORRELATION_ID": correlationId(),
    "WM_SVC.NAME": "Mercato",
    "Accept": "application/json",
  };

  // Step 2: Catalog search by UPC (PRODUCT_ID)
  try {
    const url1 = `${BASE}/items/catalog/search?query=${encodeURIComponent(upc)}&searchType=PRODUCT_ID&productIdType=UPC&startIndex=0&count=5`;
    log.catalogSearchUrl = url1;
    const r1 = await fetch(url1, { headers });
    const b1 = await r1.text();
    log.catalogSearchStatus = r1.status;
    log.catalogSearchBody = b1.slice(0, 2000);
  } catch (e) {
    log.catalogSearchError = String(e);
  }

  // Step 3: Walmart item search by UPC (TEXT)
  try {
    const url2 = `${BASE}/items/walmart/search?query=${encodeURIComponent(upc)}&searchType=TEXT&startIndex=0&count=5`;
    log.walmartSearchUrl = url2;
    const r2 = await fetch(url2, { headers });
    const b2 = await r2.text();
    log.walmartSearchStatus = r2.status;
    log.walmartSearchBody = b2.slice(0, 2000);
  } catch (e) {
    log.walmartSearchError = String(e);
  }

  // Step 4: Try GET /v3/items (list seller's own items)
  try {
    const url3 = `${BASE}/items?limit=5`;
    const r3 = await fetch(url3, { headers });
    const b3 = await r3.text();
    log.listItemsStatus = r3.status;
    log.listItemsBody = b3.slice(0, 1000);
  } catch (e) {
    log.listItemsError = String(e);
  }

  return NextResponse.json({ log });
}
