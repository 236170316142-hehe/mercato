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

// Additional vendor fields that provide strong categorization signals.
// These are extracted and included as supplemental context in the AI prompt.
const VENDOR_CONTEXT_KEYS = [
  // Product type / classification
  "item_type", "product_type", "type", "style", "product_style",
  // Age / audience
  "age_group", "age", "target_age", "age_range", "audience",
  // Gender
  "gender", "target_gender", "sex",
  // Size signals
  "size", "size_range", "sizes", "available_sizes",
  // Season / occasion
  "season", "occasion", "holiday", "theme",
  // Material / fabric (useful for furniture vs soft goods)
  "material", "fabric", "composition",
  // Color (helps distinguish furniture line vs costume)
  "color", "colour",
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

// Build a short "key: value" context string from vendor data fields that help
// the AI distinguish between categories (e.g. age_group=Toddler, season=Halloween).
// Skips URLs, empty values, and very long strings to keep the prompt tight.
function extractVendorContext(vendorData: unknown): string | null {
  if (!vendorData || typeof vendorData !== "object") return null;
  const vd = vendorData as Record<string, unknown>;
  const nk = (s: string) => s.toLowerCase().replace(/[\s_\-]+/g, "_");
  const parts: string[] = [];

  for (const key of VENDOR_CONTEXT_KEYS) {
    // Try exact key and case-insensitive normalized match
    let val: unknown = vd[key];
    if (val === undefined || val === null || val === "") {
      const found = Object.entries(vd).find(([k]) => nk(k) === nk(key));
      val = found?.[1];
    }
    if (!val || typeof val !== "string") continue;
    const v = val.trim();
    if (!v || v.length > 80 || v.startsWith("http")) continue;
    parts.push(`${key}: ${v}`);
    if (parts.length >= 6) break; // cap to keep prompt size reasonable
  }

  return parts.length ? parts.join(", ") : null;
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

  // Mathis, Best Buy, and Temu: constrain AI to uploaded template names so each product lands in
  // a category that has a matching export template. All other marketplaces use their standard
  // taxonomy freely — templates are chosen by the user at export time, not categorization time.
  const mpLower = project.marketplace.toLowerCase();
  const isMathis = mpLower === "mathis";
  const isBestBuy = mpLower === "bestbuy";
  const isTemu = mpLower === "temu";
  let availableCategories: string[] = [];
  if (isMathis || isBestBuy || isTemu) {
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
    // Build ProductInput with vendor category hint + supplemental context fields
    const productInputs: ProductInput[] = project.products.map((p) => ({
      id: p.id,
      name: p.name,
      brand: p.brand,
      description: p.description,
      vendorCategory: extractVendorCategory(p.vendorData),
      vendorContext: extractVendorContext(p.vendorData),
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
