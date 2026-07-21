import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 300;
import { authGuard } from "@/lib/auth-helpers";
import { prisma } from "@/lib/db";
import { categorizeProducts, type ProductInput } from "@/lib/ai/categorize";
import { enrichSkuOnlyProducts, looksLikeSkuName } from "@/lib/ai/resolve-sku";
import { hasCatalogVendor } from "@/lib/ai/vendor-catalog";

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

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { user, response } = await authGuard();
  if (response) return response;
  const { id } = await params;

  // `force: true` re-categorizes every product from scratch. Default (false) reuses
  // each product's existing category and only (re)processes ones that are still
  // Uncategorized / never categorized — so repeat runs give stable, repeatable results.
  const body = await req.json().catch(() => ({}));
  const force: boolean = body?.force === true;

  const project = await prisma.project.findUnique({
    where: { id },
    include: {
      products: {
        select: {
          id: true,
          name: true,
          brand: true,
          description: true,
          vendorSku: true,
          marketplaceCategory: true,
          vendorData: true,
        },
      },
    },
  });

  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (project.userId !== user!.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // Temu & Best Buy share temu_categories.csv; Mathis uses mathis_categories.csv.
  // These CSV taxonomy sheets drive categorization inside categorizeProducts (not template names).
  // The top level of each assigned path still fuzzy-matches export templates at export time.
  const mpLower = project.marketplace.toLowerCase();

  await prisma.project.update({ where: { id }, data: { status: "categorizing" } });

  try {
    // Build ProductInput with vendor category hint + supplemental context fields
    let productInputs: ProductInput[] = project.products.map((p) => ({
      id: p.id,
      name: p.name,
      brand: p.brand,
      description: p.description,
      sku: p.vendorSku,
      vendorCategory: extractVendorCategory(p.vendorData),
      vendorContext: extractVendorContext(p.vendorData),
    }));

    // Reuse existing categories for repeatable re-runs: unless `force`, only send
    // products that don't yet have a confident category (null or "Uncategorized").
    // Already-categorized products are left untouched, so their result never changes.
    const existingCatById = new Map(project.products.map((p) => [p.id, p.marketplaceCategory]));
    const needsCategorization = (id: string) => {
      if (force) return true;
      const cat = existingCatById.get(id);
      return !cat || cat === "Uncategorized";
    };
    productInputs = productInputs.filter((p) => needsCategorization(p.id));

    let enrichedCount = 0;

    if (productInputs.length > 0) {
      // SKU-only sheets (common for Mathis): resolve codes like TOVF-TOVL54566 → real
      // product titles (vendor catalog first, then web search) before asking Claude to
      // categorize. Trigger when the name still looks like a code OR the vendor SKU maps to
      // a known catalog vendor — the latter lets re-runs correct a previously bad resolution.
      const skuOnly = productInputs.filter(
        (p) => looksLikeSkuName(p.name, p.sku) || (p.sku ? hasCatalogVendor(p.sku) : false),
      );
      if (skuOnly.length > 0) {
        const { products: enriched, enrichments } = await enrichSkuOnlyProducts(productInputs);
        productInputs = enriched;
        enrichedCount = enrichments.length;
        if (enrichments.length > 0) {
          await Promise.all(
            enrichments.map((e) =>
              prisma.product.update({
                where: { id: e.productId },
                data: {
                  name: e.name,
                  brand: e.brand,
                  description: e.description,
                },
              }),
            ),
          );
        }
      }

      const results = await categorizeProducts(project.marketplace, productInputs);

      // ── Bulletproofing: route uncertain products to review instead of guessing ──
      // Correctness-first policy — it is always safer to mark a product "Uncategorized"
      // (excluded from export, surfaced for manual review) than to assign a wrong category.
      // Two gates:
      //   1. Unresolved SKU — the name is still a raw vendor code (catalog + web both failed),
      //      so the AI had nothing real to categorize. Never trust that guess.
      //   2. Low confidence — the AI itself signalled uncertainty below the threshold.
      const MIN_CONFIDENCE = Number(process.env.CATEGORIZE_MIN_CONFIDENCE ?? 0.6);
      const inputById = new Map(productInputs.map((p) => [p.id, p]));

      for (const r of results) {
        const input = inputById.get(r.productId);
        const stillRawSku = input ? looksLikeSkuName(input.name, input.sku) : false;
        if (r.category !== "Uncategorized" && (stillRawSku || r.confidence < MIN_CONFIDENCE)) {
          r.category = "Uncategorized";
          r.path = "Uncategorized";
        }
      }

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

      // Fold new results into the existing-category map so the response counts
      // reflect the full project (kept + newly categorized).
      for (const r of results) existingCatById.set(r.productId, r.category);
    }

    await prisma.project.update({ where: { id }, data: { status: "categorized" } });

    const allCats = [...existingCatById.values()];
    const matched = allCats.filter((c) => c && c !== "Uncategorized").length;
    const unmatched = allCats.length - matched;

    return NextResponse.json({
      categorized: allCats.length,
      matched,
      unmatched,
      reprocessed: productInputs.length,
      enrichedFromSku: enrichedCount,
      categories:
        mpLower === "temu" || mpLower === "bestbuy"
          ? ["(temu_categories.csv taxonomy)"]
          : mpLower === "mathis"
            ? ["(mathis_categories.csv taxonomy)"]
            : [],
    });
  } catch (err) {
    await prisma.project.update({ where: { id }, data: { status: "verified" } });
    const msg = err instanceof Error ? err.message : "Categorization failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
