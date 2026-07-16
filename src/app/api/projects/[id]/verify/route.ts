import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 300;
import { authGuard } from "@/lib/auth-helpers";
import { prisma } from "@/lib/db";
import { verifyProducts } from "@/lib/marketplaces/verify";
import {
  estimateAmazonVerifyTokens,
  refreshKeepaTokens,
} from "@/lib/keepa/client";

const BATCH_SIZE = 50;

function isAmazonMarketplace(marketplace: string): boolean {
  return marketplace === "amazon" || marketplace === "amazon_us";
}

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { user, response } = await authGuard();
  if (response) return response;
  const { id } = await params;

  const project = await prisma.project.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true,
      marketplace: true,
      products: {
        select: {
          id: true,
          name: true,
          vendorSku: true,
          upc: true,
          asin: true,
          brand: true,
          price: true,
          description: true,
          imageUrl: true,
          verifyStatus: true,
          verifyFields: true,
          vendorData: true,
        },
      },
    },
  });

  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (project.userId !== user!.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const allProducts = project.products;

  // Preflight: Amazon verify needs Keepa tokens (estimate + 100 buffer) before starting.
  if (isAmazonMarketplace(project.marketplace) && allProducts.length > 0) {
    const { estimated, required } = estimateAmazonVerifyTokens(allProducts.length);
    const tokenInfo = await refreshKeepaTokens();
    const tokensLeft = tokenInfo?.tokensLeft ?? 0;

    if (tokensLeft < required) {
      const refillRate = tokenInfo?.refillRate ?? 0;
      const shortfall = required - tokensLeft;
      const waitMins = refillRate > 0 ? Math.ceil(shortfall / refillRate) : null;
      const waitHint = waitMins != null
        ? ` Tokens refill at ${refillRate}/min — try again in about ${waitMins} minute${waitMins === 1 ? "" : "s"}.`
        : "";

      return NextResponse.json(
        {
          error: `Not enough Keepa tokens available to verify. Need ${required.toLocaleString()} tokens (${estimated.toLocaleString()} estimated + 100 buffer), but only ${tokensLeft.toLocaleString()} available.${waitHint}`,
          code: "INSUFFICIENT_KEEPA_TOKENS",
          tokensLeft,
          estimated,
          required,
          refillRate,
        },
        { status: 429 },
      );
    }
  }

  await prisma.project.update({ where: { id }, data: { status: "verifying" } });

  let totalProcessed = 0;
  let totalSkipped = 0;

  try {
    for (let i = 0; i < allProducts.length; i += BATCH_SIZE) {
      const batch = allProducts.slice(i, i + BATCH_SIZE);
      const results = await verifyProducts(project.marketplace, batch as Parameters<typeof verifyProducts>[1]);

      const processed = results.filter((r) => r.status !== "skipped");
      totalSkipped += results.length - processed.length;

      // Save results in small sub-batches to avoid overwhelming the DB
      for (let j = 0; j < processed.length; j += 10) {
        const sub = processed.slice(j, j + 10);
        await Promise.all(
          sub.map((r) => {
            const ld = r.liveData as Record<string, unknown> | null;
            const verifiedAsin = typeof ld?.asin === "string" ? ld.asin : null;
            // Keepa prices are in cents (e.g. 1999 = $19.99)
            const verifiedPrice = typeof ld?.price === "number" && ld.price > 0
              ? ld.price / 100 : null;
            // Save UPC resolved from vendorData scan when p.upc was missing
            const resolvedUpc = r.resolvedUpc ?? null;
            return prisma.product.update({
              where: { id: r.productId },
              data: {
                verifyStatus: r.status,
                verifyFields: r.fields as object[],
                liveData: r.liveData as object,
                verifiedAt: new Date(),
                ...(verifiedAsin ? { asin: verifiedAsin } : {}),
                ...(verifiedPrice ? { price: verifiedPrice } : {}),
                ...(resolvedUpc ? { upc: resolvedUpc } : {}),
              },
            });
          })
        );
      }

      totalProcessed += processed.length;
    }

    await prisma.project.update({ where: { id }, data: { status: "verified" } });

    return NextResponse.json({ verified: totalProcessed, skipped: totalSkipped });
  } catch (err) {
    await prisma.project.update({ where: { id }, data: { status: "uploaded" } });
    const msg = err instanceof Error ? err.message : "Verification failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
