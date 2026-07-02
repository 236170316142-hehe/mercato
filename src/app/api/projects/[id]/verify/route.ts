import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 300;
import { authGuard } from "@/lib/auth-helpers";
import { prisma } from "@/lib/db";
import { verifyProducts } from "@/lib/marketplaces/verify";

const BATCH_SIZE = 50;

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

  await prisma.project.update({ where: { id }, data: { status: "verifying" } });

  let totalProcessed = 0;
  let totalSkipped = 0;

  try {
    const allProducts = project.products;

    for (let i = 0; i < allProducts.length; i += BATCH_SIZE) {
      const batch = allProducts.slice(i, i + BATCH_SIZE);
      const results = await verifyProducts(project.marketplace, batch as Parameters<typeof verifyProducts>[1]);

      const processed = results.filter((r) => r.status !== "skipped");
      totalSkipped += results.length - processed.length;

      // Save results in small sub-batches to avoid overwhelming the DB
      for (let j = 0; j < processed.length; j += 10) {
        const sub = processed.slice(j, j + 10);
        await Promise.all(
          sub.map((r) =>
            prisma.product.update({
              where: { id: r.productId },
              data: {
                verifyStatus: r.status,
                verifyFields: r.fields as object[],
                liveData: r.liveData as object,
                verifiedAt: new Date(),
              },
            })
          )
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
