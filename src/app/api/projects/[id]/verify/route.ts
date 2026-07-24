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

// Stop starting new batches once we're this close to the `maxDuration` ceiling.
// A run that is cut off mid-batch loses that batch's work and strands the
// project; stopping cleanly lets the caller resume from where we left off.
const TIME_BUDGET_MS = (maxDuration - 45) * 1000;

function isAmazonMarketplace(marketplace: string): boolean {
  return marketplace === "amazon" || marketplace === "amazon_us";
}

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const startedAt = Date.now();
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

  // Resume by default: only products that were never verified are processed, so
  // a run cut short by the duration ceiling can be continued by calling again.
  // `?force=1` re-checks everything (the explicit "Re-verify" action).
  const force = _req.nextUrl.searchParams.get("force") === "1";
  const allProducts = force
    ? project.products
    : project.products.filter((p) => p.verifyStatus == null);

  // Nothing left to do — the project is already fully verified.
  if (allProducts.length === 0) {
    await prisma.project.update({ where: { id }, data: { status: "verified" } });
    return NextResponse.json({
      verified: 0,
      skipped: 0,
      remaining: 0,
      complete: true,
      totalProducts: project.products.length,
    });
  }

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
  let attempted = 0;
  let ranOutOfTime = false;

  const { withImageCache } = await import("@/lib/ai/compare-images");

  try {
    // One download cache for the whole run: vendor images are compared against
    // several marketplace angles, and marketplace CDN URLs recur across
    // products, so this removes most of the repeated image-fetch I/O. The cache
    // is discarded when the run returns rather than living on the module.
    await withImageCache(async () => {
      for (let i = 0; i < allProducts.length; i += BATCH_SIZE) {
        // Stop before the platform kills us mid-batch. Work already committed is
        // kept, and the response tells the caller how much is left to resume.
        if (Date.now() - startedAt > TIME_BUDGET_MS) {
          ranOutOfTime = true;
          break;
        }
        const batch = allProducts.slice(i, i + BATCH_SIZE);
        attempted += batch.length;
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
    });

    const remaining = allProducts.length - attempted;
    const complete = remaining === 0;

    // Only claim "verified" once every product has actually been checked;
    // otherwise leave the project resumable rather than falsely complete.
    await prisma.project.update({
      where: { id },
      data: { status: complete ? "verified" : "uploaded" },
    });

    return NextResponse.json({
      verified: totalProcessed,
      skipped: totalSkipped,
      remaining,
      complete,
      partial: ranOutOfTime,
      totalProducts: project.products.length,
    });
  } catch (err) {
    // Work already committed to the DB is preserved; the project drops back to
    // "uploaded" so the next call resumes with whatever is still unverified.
    await prisma.project.update({ where: { id }, data: { status: "uploaded" } });
    const msg = err instanceof Error ? err.message : "Verification failed";
    return NextResponse.json(
      { error: msg, verified: totalProcessed, resumable: true },
      { status: 500 },
    );
  }
}
