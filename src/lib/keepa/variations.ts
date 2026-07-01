// Variation-family expansion. When a buyer adds a product that belongs to an
// Amazon parent/child variation family (e.g. a t-shirt that comes in several
// colours/sizes), the storefront wants the WHOLE family so it can render a single
// product with a colour/size selector. Search collapses variants to one-per-parent,
// so an added child usually arrives alone — this module fetches the parent's full
// child table and hydrates the missing, priced siblings, tagged with the family's
// theme + each child's dimension values. Off the hot search path; bounded + best-effort.

import { getProducts } from "./client";
import { normalizeMany } from "./product";
import type { KeepaProduct, NormalizedProduct } from "./types";

const MAX_FAMILIES = 40; // distinct parents expanded per request
const MAX_CHILDREN = 300; // total sibling rows hydrated per request

export interface FamilyExpansion {
  /** Extra priced sibling products to add, each tagged with parent/theme/attributes. */
  extras: NormalizedProduct[];
  /** parentAsin → variation theme ("Color, Size"), so originals can be enriched too. */
  themeByParent: Map<string, string | null>;
  /** asin → its dimension values ({Color:"Red"}), covering originals and extras. */
  attributesByAsin: Map<string, Record<string, string>>;
}

/** The varying dimension names of a family: Keepa's frozenAttributes, else the union seen in the child table. */
function familyTheme(parent: KeepaProduct): string | null {
  let dims = Array.isArray(parent.frozenAttributes)
    ? parent.frozenAttributes.filter((d): d is string => typeof d === "string" && d.trim().length > 0)
    : [];
  if (!dims.length && Array.isArray(parent.variations)) {
    const seen = new Set<string>();
    for (const v of parent.variations) for (const a of v.attributes ?? []) if (a?.dimension) seen.add(a.dimension);
    dims = [...seen];
  }
  return dims.length ? dims.join(", ") : null;
}

/**
 * Given the products a user is adding, fetch the full variation family for each
 * distinct parent and return the priced siblings that aren't already in the batch.
 * Never throws — on any Keepa hiccup it returns whatever was gathered so far.
 */
export async function expandVariationFamilies(
  domain: number,
  incoming: { asin: string; parentAsin?: string | null }[],
): Promise<FamilyExpansion> {
  const themeByParent = new Map<string, string | null>();
  const attributesByAsin = new Map<string, Record<string, string>>();
  const empty: FamilyExpansion = { extras: [], themeByParent, attributesByAsin };

  const parents = [
    ...new Set(incoming.map((p) => p.parentAsin).filter((a): a is string => typeof a === "string" && a.length > 0)),
  ].slice(0, MAX_FAMILIES);
  if (!parents.length) return empty;

  try {
    // Hydrate the parents to read each family's full child table + theme.
    const parentProducts = await getProducts(domain, parents);
    const incomingAsins = new Set(incoming.map((p) => p.asin));
    const childAsins: string[] = [];

    for (const parent of parentProducts) {
      themeByParent.set(parent.asin, familyTheme(parent));
      for (const v of parent.variations ?? []) {
        if (!v?.asin) continue;
        if (v.attributes?.length) {
          const m: Record<string, string> = {};
          for (const a of v.attributes) {
            const d = a?.dimension?.trim();
            const val = a?.value?.trim();
            if (d && val) m[d] = val;
          }
          if (Object.keys(m).length) attributesByAsin.set(v.asin, m);
        }
        if (!incomingAsins.has(v.asin)) childAsins.push(v.asin);
      }
    }

    const toFetch = [...new Set(childAsins)].slice(0, MAX_CHILDREN);
    if (!toFetch.length) return { extras: [], themeByParent, attributesByAsin };

    // Hydrate the missing siblings → priced products, tagged with their family.
    const extras = normalizeMany(await getProducts(domain, toFetch, { stats: 180, rating: true }), domain)
      .filter((p) => p.price != null)
      .map((p) => {
        const theme = (p.parentAsin && themeByParent.get(p.parentAsin)) || p.variationTheme || null;
        const attrs = attributesByAsin.get(p.asin) ?? p.variationAttributes ?? null;
        return { ...p, variationTheme: theme, variationAttributes: attrs };
      });
    return { extras, themeByParent, attributesByAsin };
  } catch {
    // Keepa unreachable / out of credits — the original add still succeeds.
    return { extras: [], themeByParent, attributesByAsin };
  }
}
