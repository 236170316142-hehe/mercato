import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 300;
import { authGuard } from "@/lib/auth-helpers";
import { prisma } from "@/lib/db";
import { categorizeProducts } from "@/lib/ai/categorize";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { user, response } = await authGuard();
  if (response) return response;
  const { id } = await params;

  const project = await prisma.project.findUnique({
    where: { id },
    include: { products: { select: { id: true, name: true, brand: true, description: true, marketplaceCategory: true } } },
  });

  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (project.userId !== user!.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // Fetch template categories visible to this user to constrain AI to exact names
  const marketplaceTemplates = await prisma.exportTemplate.findMany({
    where: {
      marketplace: project.marketplace,
      OR: [{ userId: user!.id }, { userId: null }],
    },
    select: { category: true },
  });
  const availableCategories = [
    ...new Set(marketplaceTemplates.map((t) => t.category).filter((c): c is string => !!c)),
  ];

  await prisma.project.update({ where: { id }, data: { status: "categorizing" } });

  try {
    const results = await categorizeProducts(
      project.marketplace,
      project.products,
      availableCategories.length ? availableCategories : undefined,
    );

    await Promise.all(
      results.map((r) =>
        prisma.product.update({
          where: { id: r.productId },
          data: {
            marketplaceCategory: r.category,
            categoryPath: r.path,
            categoryConfidence: r.confidence,
            categorizedAt: new Date(),
          },
        })
      )
    );

    await prisma.project.update({ where: { id }, data: { status: "categorized" } });

    return NextResponse.json({ categorized: results.length, categories: availableCategories });
  } catch (err) {
    await prisma.project.update({ where: { id }, data: { status: "verified" } });
    const msg = err instanceof Error ? err.message : "Categorization failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
