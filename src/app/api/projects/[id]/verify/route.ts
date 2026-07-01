import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 300;
import { authGuard } from "@/lib/auth-helpers";
import { prisma } from "@/lib/db";
import { verifyProducts } from "@/lib/marketplaces/verify";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { user, response } = await authGuard();
  if (response) return response;
  const { id } = await params;

  const project = await prisma.project.findUnique({
    where: { id },
    include: { products: true },
  });

  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (project.userId !== user!.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  await prisma.project.update({ where: { id }, data: { status: "verifying" } });

  try {
    const results = await verifyProducts(project.marketplace, project.products);

    // "skipped" means the token loop broke before reaching that product — preserve its
    // existing DB result instead of overwriting with a false not_found.
    const processed = results.filter((r) => r.status !== "skipped");
    const skippedCount = results.length - processed.length;

    if (processed.length > 0) {
      await Promise.all(
        processed.map((r) =>
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

    await prisma.project.update({ where: { id }, data: { status: "verified" } });

    return NextResponse.json({ verified: processed.length, skipped: skippedCount });
  } catch (err) {
    await prisma.project.update({ where: { id }, data: { status: "uploaded" } });
    const msg = err instanceof Error ? err.message : "Verification failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
