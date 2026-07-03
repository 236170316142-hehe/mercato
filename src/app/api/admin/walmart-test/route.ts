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

  const jsonHeaders = { ...headers, "Content-Type": "application/json" };

  // Format A: queryTerm + filters array with upc
  try {
    const rA = await fetch(`${BASE}/items/catalog/search`, {
      method: "POST", headers: jsonHeaders,
      body: JSON.stringify({ queryTerm: upc, filters: [{ name: "upc", values: [upc] }] }),
    });
    log.fmtA_status = rA.status;
    log.fmtA_body = (await rA.text()).slice(0, 1000);
  } catch (e) { log.fmtA_error = String(e); }

  // Format B: queryTerm + filters with productIdType
  try {
    const rB = await fetch(`${BASE}/items/catalog/search`, {
      method: "POST", headers: jsonHeaders,
      body: JSON.stringify({ queryTerm: upc, filters: [{ name: "productIdType", values: ["UPC"] }, { name: "productId", values: [upc] }] }),
    });
    log.fmtB_status = rB.status;
    log.fmtB_body = (await rB.text()).slice(0, 1000);
  } catch (e) { log.fmtB_error = String(e); }

  // Format C: just queryTerm, no other fields
  try {
    const rC = await fetch(`${BASE}/items/catalog/search`, {
      method: "POST", headers: jsonHeaders,
      body: JSON.stringify({ queryTerm: upc }),
    });
    log.fmtC_status = rC.status;
    log.fmtC_body = (await rC.text()).slice(0, 1000);
  } catch (e) { log.fmtC_error = String(e); }

  // Format D: queryTerm keyword search (product name)
  try {
    const rD = await fetch(`${BASE}/items/catalog/search`, {
      method: "POST", headers: jsonHeaders,
      body: JSON.stringify({ queryTerm: "juniper quilt GHF" }),
    });
    log.fmtD_status = rD.status;
    log.fmtD_body = (await rD.text()).slice(0, 1000);
  } catch (e) { log.fmtD_error = String(e); }

  // Format E: nested query object
  try {
    const rE = await fetch(`${BASE}/items/catalog/search`, {
      method: "POST", headers: jsonHeaders,
      body: JSON.stringify({ query: { queryTerm: upc, type: "PRODUCT_ID" }, filters: { productIdType: "UPC" } }),
    });
    log.fmtE_status = rE.status;
    log.fmtE_body = (await rE.text()).slice(0, 1000);
  } catch (e) { log.fmtE_error = String(e); }

  // Format F: idType filter
  try {
    const rF = await fetch(`${BASE}/items/catalog/search`, {
      method: "POST", headers: jsonHeaders,
      body: JSON.stringify({ queryTerm: upc, idType: "UPC" }),
    });
    log.fmtF_status = rF.status;
    log.fmtF_body = (await rF.text()).slice(0, 1000);
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
