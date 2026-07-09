import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 300;
import { authGuard } from "@/lib/auth-helpers";
import { prisma } from "@/lib/db";
import { categorizeProducts, type ProductInput } from "@/lib/ai/categorize";

// Keys we try (in order) when extracting the vendor's own category from raw spreadsheet data.
const VENDOR_CATEGORY_KEYS = [
  "category", "Category", "CATEGORY",
  "product_category", "item_category", "item_type", "product_type",
  "department", "Department", "sub_category", "subcategory",
  "product_class", "product_group", "item_group",
];

function extractVendorCategory(vendorData: unknown): string | null {
  if (!vendorData || typeof vendorData !== "object") return null;
  const vd = vendorData as Record<string, unknown>;
  for (const key of VENDOR_CATEGORY_KEYS) {
    const val = vd[key];
    if (val && typeof val === "string" && val.trim()) return val.trim();
  }
  return null;
}

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { user, response } = await authGuard();
  if (response) return response;
  const { id } = await params;

  const project = await prisma.project.findUnique({
    where: { id },
    include: {
      products: {
        select: {
          id: true,
          name: true,
          brand: true,
          description: true,
          marketplaceCategory: true,
          vendorData: true,
        },
      },
    },
  });

  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (project.userId !== user!.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // For Mathis and Temu: constrain AI to the uploaded template names so each product lands
  // in a category that has a matching export template.
  // For all other marketplaces: let the AI use the standard marketplace taxonomy freely —
  // templates are chosen by the user at export time, not at categorization time.
  const mpLower = project.marketplace.toLowerCase();
  const isMathis = mpLower === "mathis";
  const isTemu = mpLower === "temu";
  let availableCategories: string[] = [];
  if (isMathis || isTemu) {
    const marketplaceTemplates = await prisma.exportTemplate.findMany({
      where: {
        marketplace: { equals: project.marketplace, mode: "insensitive" },
        OR: [{ userId: user!.id }, { userId: null }],
      },
      select: { name: true, category: true },
    });
    availableCategories = [
      ...new Set(marketplaceTemplates.map((t) => t.category || t.name).filter(Boolean)),
    ] as string[];
  }

  await prisma.project.update({ where: { id }, data: { status: "categorizing" } });

  try {
    // Build ProductInput with vendor category hint extracted from raw spreadsheet data
    const productInputs: ProductInput[] = project.products.map((p) => ({
      id: p.id,
      name: p.name,
      brand: p.brand,
      description: p.description,
      vendorCategory: extractVendorCategory(p.vendorData),
    }));

    const results = await categorizeProducts(
      project.marketplace,
      productInputs,
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
