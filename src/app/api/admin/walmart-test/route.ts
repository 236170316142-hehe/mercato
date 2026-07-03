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

  // Format A: query params in URL (POST with no body)
  try {
    const urlA = `${BASE}/items/catalog/search?query=${encodeURIComponent(upc)}&searchType=PRODUCT_ID&productIdType=UPC&count=5&startIndex=0`;
    const rA = await fetch(urlA, { method: "POST", headers });
    const bA = await rA.text();
    log.fmtA_url = urlA;
    log.fmtA_status = rA.status;
    log.fmtA_body = bA.slice(0, 1000);
  } catch (e) { log.fmtA_error = String(e); }

  // Format B: minimal JSON body — just query
  try {
    const rB = await fetch(`${BASE}/items/catalog/search`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ query: upc }),
    });
    const bB = await rB.text();
    log.fmtB_status = rB.status;
    log.fmtB_body = bB.slice(0, 1000);
  } catch (e) { log.fmtB_error = String(e); }

  // Format C: queryTerm instead of query
  try {
    const rC = await fetch(`${BASE}/items/catalog/search`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ queryTerm: upc, searchType: "PRODUCT_ID", productIdType: "UPC" }),
    });
    const bC = await rC.text();
    log.fmtC_status = rC.status;
    log.fmtC_body = bC.slice(0, 1000);
  } catch (e) { log.fmtC_error = String(e); }

  // Format D: form-encoded body
  try {
    const rD = await fetch(`${BASE}/items/catalog/search`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
      body: `query=${encodeURIComponent(upc)}&searchType=PRODUCT_ID&productIdType=UPC`,
    });
    const bD = await rD.text();
    log.fmtD_status = rD.status;
    log.fmtD_body = bD.slice(0, 1000);
  } catch (e) { log.fmtD_error = String(e); }

  // Format E: keyword search with URL params
  try {
    const urlE = `${BASE}/items/catalog/search?query=${encodeURIComponent("juniper quilt GHF")}&searchType=KEYWORD&count=5`;
    const rE = await fetch(urlE, { method: "POST", headers });
    const bE = await rE.text();
    log.fmtE_status = rE.status;
    log.fmtE_body = bE.slice(0, 1000);
  } catch (e) { log.fmtE_error = String(e); }

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
