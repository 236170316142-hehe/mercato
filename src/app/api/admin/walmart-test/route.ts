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

  const channelType = process.env.WALMART_CHANNEL_TYPE_ID ?? "9ebb75c2-1baf-4238-89f7-59a6c37bc347";
  const headers = {
    "Authorization": `Bearer ${token}`,
    "WM_SEC.ACCESS_TOKEN": token,
    "WM_QOS.CORRELATION_ID": correlationId(),
    "WM_SVC.NAME": "Mercato",
    "WM_CONSUMER.CHANNEL.TYPE": channelType,
    "Accept": "application/json",
  };

  const jsonHeaders = { ...headers, "Content-Type": "application/json" };

  // All errors said "field":"payload" — try wrapping body in payload key
  // Format A: payload wrapper + queryTerm
  try {
    const rA = await fetch(`${BASE}/items/catalog/search`, {
      method: "POST", headers: jsonHeaders,
      body: JSON.stringify({ payload: { queryTerm: upc } }),
    });
    log.fmtA_status = rA.status;
    log.fmtA_body = (await rA.text()).slice(0, 1000);
  } catch (e) { log.fmtA_error = String(e); }

  // Format B: payload wrapper + queryTerm + filters
  try {
    const rB = await fetch(`${BASE}/items/catalog/search`, {
      method: "POST", headers: jsonHeaders,
      body: JSON.stringify({ payload: { queryTerm: upc, filters: [{ name: "upc", values: [upc] }] } }),
    });
    log.fmtB_status = rB.status;
    log.fmtB_body = (await rB.text()).slice(0, 1000);
  } catch (e) { log.fmtB_error = String(e); }

  // Format C: payload wrapper + keyword
  try {
    const rC = await fetch(`${BASE}/items/catalog/search`, {
      method: "POST", headers: jsonHeaders,
      body: JSON.stringify({ payload: { queryTerm: "juniper quilt" } }),
    });
    log.fmtC_status = rC.status;
    log.fmtC_body = (await rC.text()).slice(0, 1000);
  } catch (e) { log.fmtC_error = String(e); }

  // Try GET /v3/items filtered by UPC — searches seller's listed items
  try {
    const rD = await fetch(`${BASE}/items?upc=${encodeURIComponent(upc)}&limit=5`, { headers });
    log.fmtD_getByUpc_status = rD.status;
    log.fmtD_getByUpc_body = (await rD.text()).slice(0, 1000);
  } catch (e) { log.fmtD_error = String(e); }

  // Try GET /v3/items filtered by SKU/productId
  try {
    const rE = await fetch(`${BASE}/items?productId=${encodeURIComponent(upc)}&productIdType=UPC&limit=5`, { headers });
    log.fmtE_getByProductId_status = rE.status;
    log.fmtE_getByProductId_body = (await rE.text()).slice(0, 1000);
  } catch (e) { log.fmtE_error = String(e); }

  // Try GET /v3/items/{upc} — direct lookup
  try {
    const rF = await fetch(`${BASE}/items/${encodeURIComponent(upc)}`, { headers });
    log.fmtF_directLookup_status = rF.status;
    log.fmtF_directLookup_body = (await rF.text()).slice(0, 1000);
  } catch (e) { log.fmtF_error = String(e); }

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
