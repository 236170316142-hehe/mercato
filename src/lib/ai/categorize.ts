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
  [/seasonal|holiday/i,
    "Halloween/holiday WEARABLE items for teens & adults ONLY: adult/teen costumes (ANY character — pirate, witch, ninja, princess, cultural, fantasy, etc.), adult costume accessories (wigs, hats, masks, props, capes). Size signals for ADULT → Seasonal: Adult, Teen, XL, L, M, S when paired with adult context, Plus Size, 12-14, 14-16, 16-18, One Size. Also: holiday home decor, Christmas trees, ornaments, wreaths, lights. NOT for child/toddler/infant costumes → those go to Baby & Kids."],
  [/baby|kid|youth|child|nursery|toddler/i,
    "CRITICAL — This category covers ALL costumes and wearable items for children and babies, regardless of whether 'Costume' appears in the name. A product like 'Chinese Girl - T4' or 'Dragon - 12-18M' IS a costume for a child. Size codes that always mean Baby & Kids: T1, T2, T3, T4, T5, T6, T7 (toddler sizes), 0-3M, 3-6M, 6-12M, 12-18M, 18-24M, 2T, 3T, 4T (infant/toddler), S (4-6), M (7-8), L (8-10) when listed as a child age range like '(4-6)' or '(7-9)'. If a product has a character name (animal, nationality, occupation, fantasy character) followed by one of these size codes, it is ALWAYS a child costume → Baby & Kids. Also: children's clothing, stuffed animals, kids toys, baby gear, nursery & kids bedroom furniture, kids bedding."],
  [/living\s*room/i,
    "Living room furniture ONLY: sofas, sectionals, loveseats, recliners, accent chairs, ottomans, coffee tables, end tables, entertainment centers, TV stands, console tables. NOT costumes, NOT accessories."],
  [/bedroom/i,
    "Adult bedroom furniture: beds, headboards, bed frames, dressers, nightstands, armoires, bedroom sets/suites."],
  [/dining/i,
    "Dining room: dining tables, dining chairs, bar stools, china cabinets, buffets, sideboards, dining sets."],
  [/outdoor|patio/i,
    "Outdoor & patio FURNITURE only: outdoor sofas, lounge chairs, patio dining sets, fire pits, umbrellas, garden benches, outdoor storage. IMPORTANT — this is NOT for costumes, figurines, decorative statues, or any wearable item. A 'Chinese Girl', 'Dragon', 'Princess', or any character name is a COSTUME, not an outdoor product — assign it to Seasonal or Baby & Kids based on the size."],
  [/mattress|sleep|foundation/i,
    "Sleep products: mattresses (all types), box springs, mattress toppers/protectors, adjustable bases, bed pillows, mattress pads."],
  [/rug/i,
    "Floor coverings: area rugs, runners, accent rugs, outdoor rugs, rug pads."],
  [/bedding|bath|linen/i,
    "Bed & bath textiles: comforter sets, duvet covers, sheet sets, pillowcases, blankets, throws, towels, bath accessories."],
  [/decor|accent/i,
    "Decorative home accessories: wall art, mirrors, sculptures, vases, candles, picture frames, decorative pillows, clocks, faux plants."],
  [/lighting|lamp/i,
    "Light fixtures & lamps: chandeliers, pendant lights, ceiling fans, table lamps, floor lamps, wall sconces, lamp shades."],
  [/kitchen/i,
    "Kitchen furniture & storage: kitchen islands, bar stools, kitchen carts, kitchen cabinets, pantry storage."],
  [/office/i,
    "Home office furniture: desks, office chairs, bookcases, filing cabinets."],
  [/storage|organiz|shelv/i,
    "Storage & organization: shelving units, storage ottomans, bookcases, hall trees, coat racks, closet organizers."],
  [/accent|entry|entryway/i,
    "Entryway furniture: accent chairs, console tables, hall trees, entryway benches, coat racks."],
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
  // the live mathishome.com navigation) drives categorization instead of template names.
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
    // Full taxonomy from mathis_categories.csv — Claude must copy an exact leaf path.
    // Paths are 2 or 3 levels deep ("Living Room > Sofas", "Seasonal > Halloween > Adult Costumes").
    const taxonomy = formatMathisTaxonomyForPrompt();
    categorySection = strictMode
      ? `EXACTLY one leaf path from this Mathis Brothers taxonomy (copy character-for-character; paths are 2 or 3 levels deep):

${taxonomy}

If nothing fits, use "Uncategorized".`
      : `exactly one leaf path from this Mathis Brothers taxonomy (copy character-for-character; paths are 2 or 3 levels deep, e.g. "Living Room > Sofas" or "Seasonal > Halloween > Adult Costumes"):

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
      mathis: "Mathis Brothers categories (Living Room, Bedroom, Dining Room, Outdoor, Mattress, Rugs, Bedding & Bath, Baby & Kids, Decor, Lighting, Kitchen, Home Office, Storage, Seasonal)",
      sears: "Sears categories (Appliances, Tools, Clothing, Shoes, Electronics, Lawn & Garden, etc.)",
    };
    categorySection = taxonomies[mpLower] ?? `${marketplace} product categories`;
  }

  const storeContext = isMathis
    ? "You are a product categorization expert for Mathis Brothers, a large Oklahoma-based retailer that sells furniture, mattresses, rugs, bedding, home decor, lighting, AND seasonal/holiday items including Halloween costumes for all ages. You are given Mathis's official category sheet (built from mathishome.com). Match each product to the single most specific leaf path from that sheet."
    : isTemu
    ? "You are a product categorization expert for Temu, a global e-commerce marketplace. You are given Temu's official category sheet (Category > Subcategory > Sub-Subcategory). Match each product to the single most specific leaf path from that sheet."
    : isBestBuy
    ? "You are a product categorization expert for Best Buy, a major US consumer electronics and appliance retailer. Best Buy organizes products by Category > Subcategory > Product Type. Match each product to the most specific product type that matches Best Buy's real taxonomy."
    : "You are a product categorization expert for a major retail marketplace.";

  const reasoningInstruction = `For each product, first think: "What is this product? What does it do / who uses it?" — then pick the best category. Use your knowledge of real-world products.`;

  const mathisSizeRule = isMathis ? `
WEARABLE / COSTUME RULES (Mathis, mandatory) — decide in TWO steps:

STEP 1 — Is this actually a costume or costume/dress-up item?
A costume is a themed outfit or accessory for Halloween, cosplay, theatrical, or dress-up play (pirate, witch, princess, superhero, animal, historical/fantasy character, etc.).
- REAL clothing, footwear, and genuine cultural/religious/ceremonial garments are NOT costumes. Examples that are NOT costumes: a kippah/yarmulke (real Jewish headwear), a hijab, a turban worn as real attire, a regular suit, dress, shirt, jacket, hat, or shoes meant to actually wear.
- If the item is NOT a costume AND does not fit any furniture/home/decor/seasonal-decor path on the sheet, output "Uncategorized". Mathis is a furniture & home retailer — it does NOT sell everyday apparel, so real clothing has no home here and must be "Uncategorized". Do NOT force real apparel into a costume path.

STEP 2 — Only if STEP 1 says it IS a costume item, use the size/audience signal to pick the path:
- Full costume (themed outfit), child size → "Baby & Kids > Kids' Costumes > Child Costumes"
  Child size codes: (4-6)/(4-7)/(6-8)/(7-9)/(7-10)/(8-10)/(10-12), or the words Kids/Child/Boys/Girls/Youth
- Full costume, infant/toddler size → "Baby & Kids > Kids' Costumes > Infant & Toddler Costumes"
  Infant/toddler codes: T1–T7, 0-3M/3-6M/6-12M/12-18M/18-24M, 2T/3T/4T, or the words Infant/Toddler/Baby
- Full costume, adult size or no size → "Seasonal > Halloween > Adult Costumes"
- Full costume, teen size ((12-14)/(14-16)/(16-18)/Teen) → "Seasonal > Halloween > Teen Costumes"
- Costume ACCESSORY (a single piece worn WITH a costume: hat, crown, tiara, wig, mask, cape, gloves, prop, jewelry, belt, sash) — regardless of child or adult size → "Seasonal > Halloween > Costume Accessories". (There is no separate kids-accessory leaf, so all costume accessories use this path.) Wigs and masks specifically → "Seasonal > Halloween > Wigs & Masks".
- Outdoor paths are for PATIO products only — NEVER assign a costume or wearable item to an Outdoor path.

Note: A hat, crown, or top hat alone is an ACCESSORY, not a full costume — do not send it to a Kids'/Child Costumes path.` : "";

  const rules = availableCategories?.length ? `
RULES:
1. Output EXACTLY one category name from the list above (copy it character-for-character) OR "Uncategorized" if truly no fit exists
2. Never invent category names. Never output "General", "Other", "Furniture", "Unknown", etc.
3. "Uncategorized" is only for products that genuinely don't belong in ANY listed category
4. Use all available information: product name, brand, description, vendor category, web context
5. If the product name includes a size, use it as a strong signal for age/audience${mathisSizeRule}` : "";

  const usesTaxonomySheet = isTemu || isMathis;

  const jsonExample = isTemu
    ? `[{"index":1,"category":"Women's Clothing > Tops > T-Shirts","path":"Women's Clothing > Tops > T-Shirts","confidence":0.95},...]`
    : isMathis
    ? `[{"index":1,"category":"Living Room > Sofas","path":"Living Room > Sofas","confidence":0.95},...]`
    : `[{"index":1,"category":"Category Name","path":"Category Name","confidence":0.95},...]`;

  const pathHint = isTemu
    ? `- category and path: must be the exact leaf path from the taxonomy sheet (e.g. "Women's Clothing > Tops > T-Shirts")`
    : isMathis
    ? `- category and path: must be the exact leaf path from the taxonomy sheet (e.g. "Living Room > Sofas" or "Seasonal > Halloween > Adult Costumes")`
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
      // Normalize spacing around ">" then try case-insensitive exact match
      const compact = (s: string) => s.replace(/\s*>\s*/g, " > ").replace(/\s+/g, " ").trim();
      const compactCat = compact(cat);
      const ciMatch = (availableCategories ?? []).find(
        (a) => a.toLowerCase() === compactCat.toLowerCase(),
      );
      if (ciMatch) {
        cat = ciMatch;
      } else {
        // Word-overlap fallback — require a stronger score for long Temu paths
        const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
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
