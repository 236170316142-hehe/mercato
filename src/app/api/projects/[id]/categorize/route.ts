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

  // Fetch all templates visible to this user and use their names as the allowed category list.
  // Template name is the canonical category — if a category field is set it takes priority,
  // otherwise the name itself is used (since users name templates after the category they represent).
  const userTemplates = await prisma.exportTemplate.findMany({
    where: { OR: [{ userId: user!.id }, { userId: null }] },
    select: { name: true, category: true },
  });
  const availableCategories = [
    ...new Set(userTemplates.map((t) => t.category || t.name).filter(Boolean)),
  ] as string[];

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
