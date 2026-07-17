import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { formatTemuTaxonomyForPrompt, loadTemuCategoryPaths } from "@/lib/ai/temu-taxonomy";
import { formatMathisTaxonomyForPrompt, loadMathisCategoryPaths } from "@/lib/ai/mathis-taxonomy";

const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export type ProductInput = {
  id: string;
  name: string;
  brand: string | null;
  description: string | null;
  vendorCategory?: string | null;
  vendorContext?: string | null;  // additional vendor fields: age_group, gender, season, etc.
};

export type CategorizeResult = {
  productId: string;
  category: string;
  path: string;
  confidence: number;
};

// ── Web search enrichment ─────────────────────────────────────────────────────
// Uses SerpAPI (if key is set) to look up a product name and return a short
// context snippet. Called for low-confidence or Uncategorized products so the
// AI gets real-world context about what the product actually is.

async function searchProductContext(name: string): Promise<string | null> {
  const key = process.env.SERPAPI_KEY;
  if (!key) return null;
  try {
    const url = `https://serpapi.com/search.json?q=${encodeURIComponent(name)}&engine=google&api_key=${key}&num=3`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const data = await res.json() as { organic_results?: { snippet?: string; title?: string }[] };
    const snippets = (data.organic_results ?? [])
      .slice(0, 3)
      .map((r) => [r.title, r.snippet].filter(Boolean).join(": "))
      .filter(Boolean)
      .join(" | ");
    return snippets || null;
  } catch {
    return null;
  }
}

// ── Category hints ────────────────────────────────────────────────────────────
// Descriptions used to build the category guide in the AI prompt.
// These are informational only — the AI makes its own decision based on
// understanding what the product actually IS.

const CATEGORY_HINTS: Array<[RegExp, string]> = [
  [/seasonal|holiday|christmas|halloween|easter|thanksgiving/i,
    "Seasonal/holiday home decor & entertaining: Christmas trees, decorations, lights, wreaths, garlands, seasonal tableware & linens, holiday blankets & throws. Subcategories by holiday: Christmas, Easter, Halloween, Thanksgiving, Hanukkah, Fourth of July, Valentines Day, Seasons."],
  [/baby|kid|youth|child|nursery|toddler/i,
    "Baby & kids home products: nursery furniture (cribs, changing tables, bassinets), kids bedroom furniture, kids playroom items (toys, play tables, stuffed animals), baby & kids decor, kids bedding, lunchtime essentials."],
  [/living\s*room|sofa|sectional|recliner|loveseat/i,
    "Living room furniture: sofas, sectionals, loveseats, recliners, accent chairs, ottomans & poufs, coffee tables, end & side tables, TV stands, fireplaces, futons, sleeper sofas."],
  [/bedroom|bed|headboard|dresser|nightstand/i,
    "Bedroom furniture: beds, headboards, dressers & chests, nightstands, armoires & wardrobes, bedroom sets, vanities, Murphy beds, benches."],
  [/dining|bar\s*stool|buffet|sideboard/i,
    "Dining room furniture: dining tables, dining chairs, dining sets, bar stools, bar & pub tables, sideboards & buffets, display & china cabinets, kitchen islands & carts."],
  [/outdoor|patio|garden/i,
    "Outdoor furniture & accessories: outdoor seating (sofas, chairs, sectionals, benches), outdoor dining, outdoor tables, fire pits, gardening (planters, garden beds, tools), outdoor accessories (rugs, cushions, lighting, grills)."],
  [/mattress|sleep|foundation|pillow/i,
    "Mattress & sleep accessories: bed in a box, mattress accessories (bed frames, bed pillows, boxsprings & foundations, duvet inserts, sheets & pillowcases)."],
  [/rug|doormat/i,
    "Rugs & floor coverings: indoor rugs, outdoor rugs, doormats, rug pads, stair treads."],
  [/bedding|bath|towel|sheet|comforter|duvet/i,
    "Bedding & bath: bed linens (comforters, duvet covers, sheets, quilts, blankets & throws), bath linens (towels, robes, bath rugs), bath accessories (mirrors, shower curtains, storage), bath furniture, bath hardware."],
  [/decor|accent|sculpture|vase|candle|mirror|frame/i,
    "Decor: accents (sculptures, vases, mirrors, picture frames, clocks, candles & holders), flowers & plants (faux/live), lighting (ceiling fans, chandeliers, lamps, sconces, pendants), wall art & decor, pillows & throws, pets, window treatments, fragrances & diffusers."],
  [/light|lamp|chandelier|sconce|fan/i,
    "Lighting (under Decor department): ceiling fans, chandeliers, desk/floor/table lamps, flush mount, pendants, sconces, vanity lights, outdoor lights, novelty lights, wall lights."],
  [/kitchen|cookware|bakeware|tabletop/i,
    "Kitchen: cookware & bakeware (pots, pans, bakeware sets), electrics (blenders, coffee makers, air fryers, mixers), kitchen furniture (bakers racks, islands & carts), kitchen tools, tabletop & bar (dinnerware, drinkware, flatware, serveware)."],
  [/office|desk|bookcase/i,
    "Office furniture (under Furniture): bookcases, desks, file cabinets, office chairs, laptop carts & stands, gaming, office sets."],
  [/storage|organiz|closet|laundry|pantry/i,
    "Organization: bathroom, closet, kitchen, garage, laundry & cleaning, office, baby & kids, outdoor, and specialty organization products."],
  [/entry|hall\s*tree|coat\s*rack|console/i,
    "Entryway furniture (under Furniture): benches, coat racks, console & sofa tables, hall trees, storage."],
  [/home\s*improvement|faucet|toilet|sink|door/i,
    "Home Improvement: bathroom (hardware, plumbing, showers & bathtubs, sinks, toilets), doors & hardware, home gym equipment, kitchen (cabinets, faucets, sinks), outdoor (fencing, porch & deck, shutters)."],
];

function buildCategoryGuide(categories: string[]): string {
  const lines: string[] = [];
  for (const cat of categories) {
    const hint = CATEGORY_HINTS.find(([pattern]) => pattern.test(cat));
    lines.push(hint ? `  • "${cat}" — ${hint[1]}` : `  • "${cat}"`);
  }
  return lines.join("\n");
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function categorizeProducts(
  marketplace: string,
  products: ProductInput[],
  availableCategories?: string[],
): Promise<CategorizeResult[]> {
  const mpLower = marketplace.toLowerCase();
  const isMathis = mpLower === "mathis";
  const isBestBuyTop = mpLower === "bestbuy";
  const isTemuTop = mpLower === "temu";

  // Temu always uses the official taxonomy from temu_categories.csv (not export template names).
  // Claude is given the full sheet + product details and must pick an exact leaf path.
  if (isTemuTop) {
    availableCategories = loadTemuCategoryPaths();
  }

  // Mathis works the same way: the full taxonomy sheet (mathis_categories.csv, built from
  // the official Mirakl export templates / fwd sheets) drives categorization instead of template names.
  // Top level of each path still matches the Mathis export templates, so export matching works.
  if (isMathis) {
    availableCategories = loadMathisCategoryPaths();
  }

  // Constrained mode = AI must pick from a fixed list (Best Buy templates; Temu/Mathis CSV taxonomy)
  const isConstrained = (isMathis || isBestBuyTop || isTemuTop) && !!availableCategories?.length;

  // Smaller batches for constrained-category marketplaces so the AI reasons carefully per product.
  // Temu/Mathis have ~420 leaf paths — keep batches small so the taxonomy fits with product context.
  const BATCH = (isTemuTop || isMathis) ? 5 : isConstrained ? 8 : 20;
  const PARALLEL = isConstrained ? 2 : 3;

  const model = availableCategories?.length
    ? (process.env.CATEGORIZE_ANTHROPIC_MODEL ?? "claude-sonnet-5")
    : (process.env.DEFAULT_ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001");

  const batches: ProductInput[][] = [];
  for (let i = 0; i < products.length; i += BATCH) batches.push(products.slice(i, i + BATCH));

  const allResults: CategorizeResult[] = [];

  for (let i = 0; i < batches.length; i += PARALLEL) {
    const group = batches.slice(i, i + PARALLEL);
    const settled = await Promise.allSettled(
      group.map((b) => categorizeBatch(b, marketplace, model, availableCategories))
    );
    settled.forEach((s, gi) => {
      const fallback = availableCategories?.[0] ?? "General";
      allResults.push(...(s.status === "fulfilled"
        ? s.value
        : group[gi].map((p) => ({ productId: p.id, category: fallback, path: fallback, confidence: 0.1 }))));
    });
  }

  // ── Validation pass ────────────────────────────────────────────────────────
  if (availableCategories?.length) {
    const allowed = new Set([...availableCategories, "Uncategorized"]);

    // Retry products that landed off-list (AI hallucinated a category name)
    const offListIds = new Set(allResults.filter((r) => !allowed.has(r.category)).map((r) => r.productId));
    if (offListIds.size > 0) {
      const retryInputs = products.filter((p) => offListIds.has(p.id));
      for (let i = 0; i < retryInputs.length; i += BATCH) {
        const batch = retryInputs.slice(i, i + BATCH);
        try {
          const retryResults = await categorizeBatch(batch, marketplace, model, availableCategories, true);
          for (const r of retryResults) {
            if (!allowed.has(r.category)) { r.category = "Uncategorized"; r.path = "Uncategorized"; r.confidence = 0.1; }
            const idx = allResults.findIndex((a) => a.productId === r.productId);
            if (idx !== -1) allResults[idx] = r;
          }
        } catch {
          for (const p of batch) {
            const idx = allResults.findIndex((a) => a.productId === p.id);
            if (idx !== -1) { allResults[idx].category = "Uncategorized"; allResults[idx].path = "Uncategorized"; }
          }
        }
      }
    }

    // ── Web search rescue for Uncategorized products ───────────────────────
    // If SerpAPI is configured, search for each Uncategorized product to get
    // real-world context, then try to re-categorize with that context.
    const uncategorizedIds = new Set(allResults.filter((r) => r.category === "Uncategorized").map((r) => r.productId));
    if (uncategorizedIds.size > 0 && process.env.SERPAPI_KEY) {
      const rescueProducts = products.filter((p) => uncategorizedIds.has(p.id));

      // Search in parallel (max 5 at once to respect rate limits)
      const SEARCH_PARALLEL = 5;
      const enriched: Array<ProductInput & { searchContext?: string }> = [];
      for (let i = 0; i < rescueProducts.length; i += SEARCH_PARALLEL) {
        const slice = rescueProducts.slice(i, i + SEARCH_PARALLEL);
        const contexts = await Promise.all(slice.map((p) => searchProductContext(p.name)));
        slice.forEach((p, j) => enriched.push({ ...p, searchContext: contexts[j] ?? undefined }));
      }

      // Re-categorize with search context in small batches
      for (let i = 0; i < enriched.length; i += 5) {
        const batch = enriched.slice(i, i + 5);
        try {
          const rescueResults = await categorizeBatchWithContext(batch, marketplace, model, availableCategories);
          for (const r of rescueResults) {
            if (!allowed.has(r.category)) { r.category = "Uncategorized"; r.path = "Uncategorized"; }
            const idx = allResults.findIndex((a) => a.productId === r.productId);
            if (idx !== -1) allResults[idx] = r;
          }
        } catch { /* keep Uncategorized */ }
      }
    }
  }

  return allResults;
}

// ── Batch categorization (reasoning-first) ────────────────────────────────────
// Uses a chain-of-thought approach: asks the AI to first identify what each
// product IS before assigning a category. More accurate than direct assignment.

async function categorizeBatch(
  products: ProductInput[],
  marketplace: string,
  model: string,
  availableCategories?: string[],
  strictMode = false,
): Promise<CategorizeResult[]> {
  return categorizeBatchWithContext(
    products.map((p) => ({ ...p, searchContext: undefined })),
    marketplace,
    model,
    availableCategories,
    strictMode,
  );
}

async function categorizeBatchWithContext(
  products: Array<ProductInput & { searchContext?: string }>,
  marketplace: string,
  model: string,
  availableCategories?: string[],
  strictMode = false,
): Promise<CategorizeResult[]> {
  const mpLower = marketplace.toLowerCase();
  const isMathis = mpLower === "mathis";
  const isTemu = mpLower === "temu";
  const isBestBuy = mpLower === "bestbuy";

  const list = products.map((p, idx) => {
    let line = `${idx + 1}. "${p.name}"`;
    if (p.brand) line += ` by ${p.brand}`;
    if (p.description) line += ` — ${p.description.slice(0, 150)}`;
    if (p.vendorCategory) line += ` [vendor category: ${p.vendorCategory}]`;
    if (p.vendorContext) line += ` [vendor info: ${p.vendorContext}]`;
    if (p.searchContext) line += `\n   [web search context: ${p.searchContext.slice(0, 300)}]`;
    return line;
  }).join("\n");

  let categorySection: string;
  if (isTemu && availableCategories?.length) {
    // Full taxonomy from temu_categories.csv — Claude must copy an exact leaf path
    const taxonomy = formatTemuTaxonomyForPrompt();
    categorySection = strictMode
      ? `EXACTLY one leaf path from this Temu taxonomy (copy character-for-character as "Category > Subcategory > Sub-Subcategory"):

${taxonomy}

If nothing fits, use "Uncategorized".`
      : `exactly one leaf path from this Temu taxonomy (copy character-for-character as "Category > Subcategory > Sub-Subcategory", e.g. "Women's Clothing > Tops > T-Shirts"):

${taxonomy}

If nothing fits, use "Uncategorized".`;
  } else if (isMathis && availableCategories?.length) {
    // Full taxonomy from mathis_categories.csv (sourced from the official Mirakl fwd sheets).
    // Paths are 2–4 levels: Department > Category > Subcategory > Product Type
    // Claude must match by product-type leaf on this sheet — not general retail logic.
    const taxonomy = formatMathisTaxonomyForPrompt();
    categorySection = strictMode
      ? `EXACTLY one leaf path from this Mathis Brothers taxonomy (copy character-for-character). Match by the product-type leaf on the sheet (e.g. a Daybed → "Baby & Kids > Kids Furniture > Daybeds" because that is the ONLY Daybeds path). Do not reassign based on adult/kids assumptions:

${taxonomy}

If nothing fits, use "Uncategorized".`
      : `exactly one leaf path from this Mathis Brothers taxonomy (copy character-for-character). Match the product TYPE to the leaf name on this sheet — e.g. Daybed → "Baby & Kids > Kids Furniture > Daybeds" (only Daybeds path); do NOT pick Sofas or Beds instead:

${taxonomy}

If nothing fits, use "Uncategorized".`;
  } else if (availableCategories?.length) {
    const guide = buildCategoryGuide(availableCategories);
    categorySection = strictMode
      ? `EXACTLY one of these categories (copy the name character-for-character):\n${availableCategories.map((c) => `- ${c}`).join("\n")}`
      : `exactly one of these categories:\n${availableCategories.map((c) => `- ${c}`).join("\n")}\n\nCategory guide:\n${guide}`;
  } else if (isBestBuy) {
    categorySection = `the most specific matching Best Buy category path (Category > Subcategory > Product Type) from Best Buy's real taxonomy:

TV & Home Theater: TVs > LED & QLED TVs | TVs > OLED TVs | TVs > 8K TVs | TVs > Smart TVs | Projectors > Home Theater Projectors | Projectors > Business Projectors | Sound Bars | Home Theater Systems > Home Theater in a Box | Home Theater Systems > AV Receivers | TV Mounts & Accessories > TV Mounts | TV Mounts & Accessories > TV Stands | TV Mounts & Accessories > HDMI Cables

Computers & Tablets: Laptops > Windows Laptops | Laptops > MacBooks | Laptops > Chromebooks | Laptops > 2-in-1 Laptops | Laptops > Gaming Laptops | Desktop Computers > All-in-One Desktops | Desktop Computers > Windows Desktops | Desktop Computers > Mac Desktops | Tablets > iPad | Tablets > Android Tablets | Tablets > Windows Tablets | Monitors > Gaming Monitors | Monitors > 4K Monitors | Monitors > Ultrawide Monitors | Printers > All-in-One Printers | Printers > Laser Printers | Computer Accessories > External Hard Drives | Computer Accessories > USB Hubs | Computer Accessories > Webcams | Computer Accessories > Keyboards | Computer Accessories > Mice | Computer Storage > SSDs | Computer Storage > USB Flash Drives | Computer Components > RAM | Computer Components > Graphics Cards | Computer Components > CPUs

Cell Phones & Wearables: Cell Phones > Apple iPhone | Cell Phones > Samsung Galaxy | Cell Phones > Google Pixel | Cell Phones > Android Phones | Cell Phone Accessories > Phone Cases | Cell Phone Accessories > Screen Protectors | Cell Phone Accessories > Wireless Chargers | Cell Phone Accessories > Charging Cables | Cell Phone Accessories > Phone Holders | Wearable Technology > Apple Watch | Wearable Technology > Samsung Galaxy Watch | Wearable Technology > Fitness Trackers | Wearable Technology > Smart Glasses | Prepaid Phones

Cameras & Camcorders: Digital Cameras > DSLR Cameras | Digital Cameras > Mirrorless Cameras | Digital Cameras > Point & Shoot Cameras | Camcorders > HD Camcorders | Camcorders > 4K Camcorders | Action Cameras > GoPro | Drones > Camera Drones | Drones > Racing Drones | Camera Lenses | Camera Accessories > Camera Bags & Cases | Camera Accessories > Memory Cards | Camera Accessories > Tripods & Monopods | Camera Accessories > Batteries & Chargers | Photo Printing

Audio: Headphones > Over-Ear Headphones | Headphones > On-Ear Headphones | Headphones > Noise-Canceling Headphones | Earbuds > True Wireless Earbuds | Earbuds > Wired Earbuds | Portable Speakers > Bluetooth Speakers | Portable Speakers > Waterproof Speakers | Home Audio > Bookshelf Speakers | Home Audio > Floor Standing Speakers | Home Audio > Subwoofers | Turntables & Record Players | Musical Instruments > Guitars | Musical Instruments > Keyboards & Pianos | Musical Instruments > DJ Equipment | Voice Recorders

Video Games: Video Games > PlayStation Games | Video Games > Xbox Games | Video Games > Nintendo Switch Games | Video Games > PC Games | Gaming Consoles > PlayStation 5 | Gaming Consoles > Xbox Series X|S | Gaming Consoles > Nintendo Switch | PC Gaming > Gaming Desktops | PC Gaming > Gaming Laptops | Gaming Accessories > Controllers | Gaming Accessories > Gaming Headsets | Gaming Accessories > Gaming Keyboards | Gaming Accessories > Gaming Mice | Gaming Accessories > Gaming Chairs | VR Headsets

Appliances: Refrigerators > French Door Refrigerators | Refrigerators > Side-by-Side Refrigerators | Refrigerators > Bottom Freezer Refrigerators | Refrigerators > Top Freezer Refrigerators | Refrigerators > Counter-Depth Refrigerators | Washing Machines > Front Load Washers | Washing Machines > Top Load Washers | Dryers > Gas Dryers | Dryers > Electric Dryers | Dishwashers > Built-In Dishwashers | Dishwashers > Portable Dishwashers | Ranges & Ovens > Gas Ranges | Ranges & Ovens > Electric Ranges | Ranges & Ovens > Induction Ranges | Ranges & Ovens > Wall Ovens | Microwaves > Over-the-Range Microwaves | Microwaves > Countertop Microwaves | Freezers > Chest Freezers | Freezers > Upright Freezers | Cooktops > Gas Cooktops | Cooktops > Electric Cooktops | Range Hoods | Appliance Accessories

Smart Home: Smart Speakers & Displays > Amazon Echo | Smart Speakers & Displays > Google Nest | Smart Speakers & Displays > Apple HomePod | Smart Lighting > Smart Bulbs | Smart Lighting > Smart Light Strips | Smart Thermostats > Nest Thermostats | Smart Thermostats > Ecobee | Smart Security > Indoor Security Cameras | Smart Security > Outdoor Security Cameras | Smart Security > Video Doorbells | Smart Security > Smart Locks | Smart Plugs & Power Strips | Smart Home Hubs & Controllers | Smart Displays

Health, Fitness & Beauty: Fitness Equipment > Treadmills | Fitness Equipment > Exercise Bikes | Fitness Equipment > Ellipticals | Fitness Equipment > Rowing Machines | Fitness Equipment > Weight Benches | Fitness Accessories > Resistance Bands | Fitness Accessories > Yoga Mats | Fitness Accessories > Dumbbells & Weights | Electric Shavers & Trimmers > Men's Electric Shavers | Electric Shavers & Trimmers > Women's Epilators | Hair Care > Hair Dryers | Hair Care > Hair Straighteners & Curlers | Hair Care > Electric Toothbrushes | Personal Care > Massagers | Personal Care > Blood Pressure Monitors | Personal Care > Heating Pads | Medical Monitoring > Glucose Monitors | Medical Monitoring > Pulse Oximeters

Car Electronics & GPS: Car Stereos > Single-DIN Car Stereos | Car Stereos > Double-DIN Car Stereos | Car Speakers > Coaxial Speakers | Car Speakers > Component Speakers | Car Amplifiers | GPS & Navigation > Portable GPS | GPS & Navigation > Dash Cams | Car Video > Backup Cameras | Car Video > In-Car DVD Players | Car Security > Remote Starters | Car Security > Car Alarms | Radar Detectors | Car Accessories > Car Chargers | Car Accessories > Car Mounts

Networking: Routers > Wi-Fi 6 Routers | Routers > Mesh Wi-Fi Systems | Routers > Gaming Routers | Modems & Gateways | Wi-Fi Range Extenders | Network Switches | Network Attached Storage (NAS) | Network Adapters | Ethernet Cables | Powerline Adapters

Movies & Music: Blu-ray & DVD Players | 4K Ultra HD Blu-ray Players | Media Streaming Devices > Roku | Media Streaming Devices > Amazon Fire TV | Media Streaming Devices > Apple TV | Blu-ray Movies | 4K Ultra HD Movies | CDs & Vinyl

Office & School Supplies: Office Electronics > All-in-One Printers | Office Electronics > Scanners | Office Electronics > Label Makers | Office Electronics > Calculators | Office Furniture > Desks | Office Furniture > Office Chairs | Office Supplies > Paper & Notebooks | Office Supplies > Pens & Markers | Shredders | Whiteboards

Output the category as: "Category > Subcategory > Product Type" (e.g. "Computers & Tablets > Laptops > Gaming Laptops")`;
  } else {
    const taxonomies: Record<string, string> = {
      amazon: "Amazon product categories (Electronics > Cameras, Home & Kitchen > Cookware, Clothing > Men's Shoes, etc.)",
      bestbuy: "Best Buy categories (TV & Home Theater, Computers & Tablets, Cell Phones, Appliances, Gaming, etc.)",
      walmart: "Walmart categories (Electronics, Home, Clothing, Baby, Sports & Outdoors, Food, etc.)",
      mathis: "Mathis Brothers categories (Baby & Kids, Bedding & Bath, Decor, Furniture, Home Improvement, Kitchen, Mattress, Organization, Outdoor, Rugs, Seasonal)",
      sears: "Sears categories (Appliances, Tools, Clothing, Shoes, Electronics, Lawn & Garden, etc.)",
    };
    categorySection = taxonomies[mpLower] ?? `${marketplace} product categories`;
  }

  const storeContext = isMathis
    ? "You are a product categorization expert for Mathis Brothers / Mathis Home. You are given the official Mirakl taxonomy sheet (Department > Category > Subcategory > Product Type). Your job is to match each product to the leaf path whose NAME best matches the product type — using ONLY the taxonomy list. Do not invent paths. Do not relocate a product to a different department based on assumptions about adult vs kids, room type, or how a retailer 'usually' organizes furniture."
    : isTemu
    ? "You are a product categorization expert for Temu, a global e-commerce marketplace. You are given Temu's official category sheet (Category > Subcategory > Sub-Subcategory). Match each product to the single most specific leaf path from that sheet."
    : isBestBuy
    ? "You are a product categorization expert for Best Buy, a major US consumer electronics and appliance retailer. Best Buy organizes products by Category > Subcategory > Product Type. Match each product to the most specific product type that matches Best Buy's real taxonomy."
    : "You are a product categorization expert for a major retail marketplace.";

  const reasoningInstruction = isMathis
    ? `For each product, match it using the TAXONOMY only:
STEP 1 — Identify the product type from the name/description (e.g. "Daybed", "Sofa", "Crib", "Table Lamp").
STEP 2 — Search the taxonomy list for a leaf (or path segment) with that same product-type name.
STEP 3 — If exactly one path contains that leaf (e.g. Daybeds only under Baby & Kids), YOU MUST use that path. Do not pick a "similar" adult Furniture path like Sofas.
STEP 4 — Only if no product-type leaf matches, fall back to the closest listed path — still from the list only.
Do NOT use outside assumptions (adult daybed → living room sofas, etc.). The taxonomy is the source of truth.`
    : `For each product, first think: "What is this product? What does it do / who uses it?" — then pick the best category. Use your knowledge of real-world products.`;

  const mathisSizeRule = isMathis ? `
MATHIS RULES (mandatory — taxonomy over assumptions):
1. Match by PRODUCT TYPE NAME in the taxonomy first. Example: product is a "Daybed" and the sheet only has "Baby & Kids > Kids Furniture > Daybeds" → assign that path. Never substitute Sofas, Beds, or Living Room because it "looks adult".
2. Department names on the sheet are organizational labels for Mirakl — they are NOT a signal to re-interpret the product. A daybed under Baby & Kids stays Baby & Kids even if branding/size feels adult.
3. Never invent a path. Never pick a nearby category that is a different product type.
4. Prefer the deepest leaf that literally matches the product type.
5. Use "Uncategorized" only if no listed path's product type matches at all.
6. Lighting → "Decor > Lighting …". Window treatments → "Decor > Window Treatments …". Holiday decor → "Seasonal > …".` : "";

  const rules = availableCategories?.length ? `
RULES:
1. Output EXACTLY one category name from the list above (copy it character-for-character) OR "Uncategorized" if truly no fit exists
2. Never invent category names. Never output "General", "Other", "Furniture", "Unknown", etc.
3. "Uncategorized" is only for products that genuinely don't belong in ANY listed category
4. Use product name, brand, description, vendor category as signals to identify WHAT the product is — then map that to the taxonomy leaf
5. Do not override a direct taxonomy product-type match with general retail logic${mathisSizeRule}` : "";

  const usesTaxonomySheet = isTemu || isMathis;

  const jsonExample = isTemu
    ? `[{"index":1,"category":"Women's Clothing > Tops > T-Shirts","path":"Women's Clothing > Tops > T-Shirts","confidence":0.95},...]`
    : isMathis
    ? `[{"index":1,"category":"Baby & Kids > Kids Furniture > Daybeds","path":"Baby & Kids > Kids Furniture > Daybeds","confidence":0.95},...]`
    : `[{"index":1,"category":"Category Name","path":"Category Name","confidence":0.95},...]`;

  const pathHint = isTemu
    ? `- category and path: must be the exact leaf path from the taxonomy sheet (e.g. "Women's Clothing > Tops > T-Shirts")`
    : isMathis
    ? `- category and path: must be the exact leaf path from the taxonomy sheet (e.g. "Baby & Kids > Kids Furniture > Daybeds" when the product is a daybed — because that is where Daybeds lives on the sheet)`
    : `- path: full path e.g. "Mathis Brothers > Seasonal"`;

  const prompt = `${storeContext}

${reasoningInstruction}

Categorize each product into ${categorySection}.

Products:
${list}

Respond ONLY with a JSON array — no markdown, no explanation:
${jsonExample}
${rules}
${pathHint}
- confidence: 0.0–1.0 (how certain you are)
- Return exactly ${products.length} items in the same order as the product list`;

  const { text } = await generateText({
    model: anthropic(model),
    prompt,
    maxOutputTokens: usesTaxonomySheet ? 2500 : 2000,
  });

  const fallbackCat = availableCategories?.[0] ?? "General";
  const allowedSet = availableCategories ? new Set([...availableCategories, "Uncategorized"]) : null;

  const mapResult = (r: { index: number; category: string; path: string; confidence: number }) => {
    let cat = r.category?.trim() ?? "";
    if (allowedSet && !allowedSet.has(cat)) {
      // Normalize spacing around ">" then try case-insensitive / accent-insensitive match
      const fold = (s: string) =>
        s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
      const compact = (s: string) => s.replace(/\s*>\s*/g, " > ").replace(/\s+/g, " ").trim();
      const compactCat = compact(cat);
      const foldedCat = fold(compactCat);
      const ciMatch = (availableCategories ?? []).find((a) => {
        const ca = compact(a);
        return ca.toLowerCase() === compactCat.toLowerCase() || fold(ca) === foldedCat;
      });
      if (ciMatch) {
        cat = ciMatch;
      } else {
        // Word-overlap fallback — require a stronger score for long Temu paths
        const norm = (s: string) => fold(s).replace(/[^a-z0-9]+/g, " ").trim();
        const normCat = norm(cat);
        let best: string | null = null;
        let bestScore = 0;
        for (const allowed of availableCategories ?? []) {
          const normAllowed = norm(allowed);
          const score = normAllowed.split(" ").filter((w) => w.length > 2 && normCat.includes(w)).length
                      + normCat.split(" ").filter((w) => w.length > 2 && normAllowed.includes(w)).length;
          if (score > bestScore) { bestScore = score; best = allowed; }
        }
        const minScore = usesTaxonomySheet ? 4 : 2;
        cat = bestScore >= minScore ? best! : "Uncategorized";
      }
    }
    // For taxonomy-sheet marketplaces (Temu/Mathis), path always mirrors the validated leaf category
    const path = usesTaxonomySheet ? cat : (r.path?.trim() || cat);
    return {
      productId: products[r.index - 1]?.id ?? "",
      category: cat,
      path,
      confidence: r.confidence ?? 0.5,
    };
  };

  try {
    const parsed = JSON.parse(text.trim()) as { index: number; category: string; path: string; confidence: number }[];
    return parsed.map(mapResult).filter((r) => r.productId);
  } catch {
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]) as { index: number; category: string; path: string; confidence: number }[];
        return parsed.map(mapResult).filter((r) => r.productId);
      } catch { /* fall through */ }
    }
    return products.map((p) => ({ productId: p.id, category: fallbackCat, path: fallbackCat, confidence: 0.1 }));
  }
}
