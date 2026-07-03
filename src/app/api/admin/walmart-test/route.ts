import { NextRequest, NextResponse } from "next/server";
import { adminGuard } from "@/lib/auth-helpers";
import { createSign } from "crypto";

const BASE = "https://developer.api.walmart.com/api-proxy/service/affil/product/v2";

function generateAuthHeaders(): Record<string, string> {
  const consumerId = process.env.WALMART_AFFILIATE_CONSUMER_ID;
  const privateKeyRaw = process.env.WALMART_AFFILIATE_PRIVATE_KEY;
  const keyVersion = process.env.WALMART_AFFILIATE_KEY_VERSION ?? "1";

  if (!consumerId || !privateKeyRaw) {
    throw new Error("WALMART_AFFILIATE_CONSUMER_ID / WALMART_AFFILIATE_PRIVATE_KEY not configured");
  }

  const timestamp = String(Date.now());

  const headersToSign: [string, string][] = [
    ["WM_CONSUMER.ID", consumerId],
    ["WM_CONSUMER.INTIMESTAMP", timestamp],
    ["WM_SEC.KEY_VERSION", keyVersion],
  ];
  headersToSign.sort((a, b) => a[0].localeCompare(b[0]));

  const canonicalString = headersToSign.map(([, v]) => v.trim()).join("\n") + "\n";
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

export async function GET(req: NextRequest) {
  const { response } = await adminGuard();
  if (response) return response;

  const upc = req.nextUrl.searchParams.get("upc") ?? "636047400413";
  const log: Record<string, unknown> = {};

  log.env = {
    consumerIdSet: !!process.env.WALMART_AFFILIATE_CONSUMER_ID,
    privateKeySet: !!process.env.WALMART_AFFILIATE_PRIVATE_KEY,
    keyVersion: process.env.WALMART_AFFILIATE_KEY_VERSION ?? "1 (default)",
  };

  // Test 1: UPC lookup
  try {
    const headers = generateAuthHeaders();
    const res = await fetch(`${BASE}/items?upc=${encodeURIComponent(upc)}`, { headers });
    const body = await res.text();
    log.upcLookup = { status: res.status, body: body.slice(0, 2000) };
  } catch (e) {
    log.upcLookupError = String(e);
  }

  // Test 2: Keyword search
  try {
    const headers = generateAuthHeaders();
    const res = await fetch(`${BASE}/searches?query=juniper+quilt&numItems=3`, { headers });
    const body = await res.text();
    log.keywordSearch = { status: res.status, body: body.slice(0, 2000) };
  } catch (e) {
    log.keywordSearchError = String(e);
  }

  return NextResponse.json({ log });
}
