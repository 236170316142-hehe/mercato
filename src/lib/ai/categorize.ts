import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";

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
  // Constrained mode = template names drive the allowed category list (Mathis always; Best Buy when templates uploaded)
  const isConstrained = (isMathis || isBestBuyTop) && !!availableCategories?.length;

  // Smaller batches for constrained-category marketplaces so the AI reasons carefully per product.
  const BATCH = isConstrained ? 8 : 20;
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
  if (availableCategories?.length) {
    const guide = buildCategoryGuide(availableCategories);
    categorySection = strictMode
      ? `EXACTLY one of these categories (copy the name character-for-character):\n${availableCategories.map((c) => `- ${c}`).join("\n")}`
      : `exactly one of these categories:\n${availableCategories.map((c) => `- ${c}`).join("\n")}\n\nCategory guide:\n${guide}`;
  } else if (isTemu) {
    categorySection = `the most specific matching Temu category path (Category > Subcategory > Product Type) from Temu's real taxonomy:

Women's Clothing: Tops > T-Shirts | Tops > Blouses & Shirts | Tops > Hoodies & Sweatshirts | Tops > Bodysuits | Dresses > Casual Dresses | Dresses > Formal & Evening Dresses | Dresses > Mini Dresses | Dresses > Maxi Dresses | Bottoms > Pants & Trousers | Bottoms > Jeans | Bottoms > Shorts | Bottoms > Skirts | Bottoms > Leggings | Outerwear > Jackets & Coats | Outerwear > Blazers | Swimwear > Bikinis | Swimwear > One-Piece Swimsuits | Lingerie & Sleepwear > Bras | Lingerie & Sleepwear > Underwear | Lingerie & Sleepwear > Pajamas & Nightwear | Activewear > Sports Bras | Activewear > Yoga Pants | Activewear > Athletic Sets | Sets & Co-ords > Matching Sets | Costumes & Cosplay > Halloween Costumes | Costumes & Cosplay > Cosplay Costumes

Men's Clothing: Tops > T-Shirts | Tops > Shirts & Polos | Tops > Hoodies & Sweatshirts | Tops > Sweaters | Bottoms > Pants & Trousers | Bottoms > Jeans | Bottoms > Shorts | Outerwear > Jackets & Coats | Outerwear > Vests | Swimwear > Swim Trunks | Activewear > Athletic Tops | Activewear > Athletic Bottoms | Underwear & Lounge > Underwear | Underwear & Lounge > Sleepwear | Costumes & Cosplay > Halloween Costumes

Kids' Fashion: Girls' Clothing > Dresses | Girls' Clothing > Tops | Girls' Clothing > Pants & Leggings | Boys' Clothing > Tops | Boys' Clothing > Pants & Shorts | Baby & Toddler > Onesies & Rompers | Baby & Toddler > Sets | Baby & Toddler > Sleepwear | Kids' Costumes > Halloween Costumes | Kids' Costumes > Dress-Up

Shoes: Women's Shoes > Heels | Women's Shoes > Flats | Women's Shoes > Sneakers | Women's Shoes > Sandals | Women's Shoes > Boots | Women's Shoes > Slippers | Men's Shoes > Sneakers | Men's Shoes > Loafers & Dress Shoes | Men's Shoes > Boots | Men's Shoes > Sandals | Kids' Shoes > Girls' Shoes | Kids' Shoes > Boys' Shoes

Bags & Luggage: Handbags > Shoulder Bags | Handbags > Tote Bags | Handbags > Clutches | Crossbody Bags | Backpacks | Wallets & Cardholders | Luggage & Travel Bags > Suitcases | Luggage & Travel Bags > Duffel Bags | Fanny Packs & Belt Bags

Jewelry & Accessories: Necklaces | Earrings > Stud Earrings | Earrings > Hoop Earrings | Earrings > Drop & Dangle Earrings | Bracelets & Bangles | Rings | Anklets | Watches > Women's Watches | Watches > Men's Watches | Sunglasses & Eyewear | Hats & Caps > Baseball Caps | Hats & Caps > Beanies | Scarves & Wraps | Belts | Hair Accessories > Clips & Pins | Hair Accessories > Headbands | Hair Accessories > Scrunchies | Gloves & Mittens | Socks & Hosiery

Beauty & Health: Skincare > Serums & Essences | Skincare > Moisturizers & Creams | Skincare > Cleansers & Toners | Skincare > Face Masks | Skincare > Sunscreen | Makeup > Foundation & Concealer | Makeup > Lipstick & Lip Gloss | Makeup > Eyeshadow | Makeup > Mascara & Eyeliner | Makeup > Blush & Bronzer | Makeup > Makeup Brushes & Tools | Hair Care > Shampoo & Conditioner | Hair Care > Hair Masks & Treatments | Hair Care > Styling Tools | Hair Care > Hair Extensions & Wigs | Nail Care > Nail Polish | Nail Care > Nail Art Supplies | Nail Care > Nail Tools | Fragrances & Perfumes | Personal Care > Body Wash & Soap | Personal Care > Deodorant | Personal Care > Razors & Shavers | Health & Wellness > Vitamins & Supplements | Health & Wellness > Massagers & Relaxation | Oral Care > Toothbrushes | Oral Care > Teeth Whitening

Home & Kitchen: Bedding > Comforters & Duvets | Bedding > Sheet Sets | Bedding > Pillows & Pillowcases | Bedding > Mattress Covers | Bath > Towels | Bath > Bath Mats | Bath > Shower Curtains | Bath > Bathroom Accessories | Kitchen & Dining > Cookware | Kitchen & Dining > Bakeware | Kitchen & Dining > Kitchen Utensils & Gadgets | Kitchen & Dining > Dinnerware & Plates | Kitchen & Dining > Glasses & Drinkware | Kitchen & Dining > Food Storage & Containers | Home Decor > Wall Art & Posters | Home Decor > Candles & Holders | Home Decor > Vases & Decorative Objects | Home Decor > Throw Pillows & Blankets | Home Decor > Rugs & Mats | Home Decor > Mirrors | Storage & Organization > Closet Organizers | Storage & Organization > Drawer Organizers | Storage & Organization > Storage Boxes & Bins | Storage & Organization > Shelving Units | Furniture > Chairs | Furniture > Tables | Furniture > Desks | Furniture > Shelves & Bookcases | Garden & Outdoor > Planters & Pots | Garden & Outdoor > Garden Tools | Garden & Outdoor > Outdoor Decor | Lighting > LED Strip Lights | Lighting > String Lights | Lighting > Desk Lamps | Lighting > Night Lights | Cleaning > Mops & Brooms | Cleaning > Cleaning Brushes & Scrubbers | Cleaning > Laundry Accessories

Electronics: Phone Accessories > Phone Cases & Covers | Phone Accessories > Screen Protectors | Phone Accessories > Chargers & Cables | Phone Accessories > Phone Holders & Stands | Computers & Tablets > Laptop Accessories | Computers & Tablets > Tablet Cases | Computers & Tablets > Keyboards & Mice | Audio > Earbuds & In-Ear Headphones | Audio > Headphones | Audio > Bluetooth Speakers | Cameras & Photography > Camera Accessories | Cameras & Photography > Ring Lights | Cameras & Photography > Tripods & Stabilizers | Smart Home > Smart Bulbs | Smart Home > Smart Plugs | Smart Home > Security Cameras | Wearables > Smartwatches | Wearables > Fitness Trackers | Gaming > Gaming Controllers | Gaming > Gaming Headsets | Gaming > Gaming Accessories | TV Accessories > TV Mounts | TV Accessories > Streaming Devices | Power & Batteries > Power Banks | Power & Batteries > Surge Protectors & Extension Cords

Sports & Outdoors: Exercise & Fitness > Dumbbells & Weights | Exercise & Fitness > Resistance Bands | Exercise & Fitness > Yoga Mats | Exercise & Fitness > Jump Ropes | Exercise & Fitness > Ab Rollers | Outdoor Recreation > Camping Gear | Outdoor Recreation > Hiking Accessories | Outdoor Recreation > Cycling Accessories | Team Sports > Basketball Accessories | Team Sports > Soccer Accessories | Water Sports > Swimming Accessories | Water Sports > Beach Accessories | Sports Apparel > Athletic Tops | Sports Apparel > Athletic Bottoms | Sports Accessories > Water Bottles | Sports Accessories > Sports Bags

Toys & Games: Action Figures & Collectibles | Dolls & Stuffed Animals > Plush Toys | Dolls & Stuffed Animals > Dolls | Building Toys > Building Blocks | Building Toys > Model Kits | Board Games & Card Games | Puzzles | Educational Toys > STEM Toys | Educational Toys > Learning Toys | Ride-On Toys > Scooters | Ride-On Toys > Electric Ride-Ons | Arts & Crafts > Craft Kits | Arts & Crafts > Drawing & Painting | Outdoor Play > Balls | Outdoor Play > Bubbles & Blowers | Remote Control Toys

Pet Supplies: Dog Supplies > Dog Collars & Leashes | Dog Supplies > Dog Beds & Furniture | Dog Supplies > Dog Toys | Dog Supplies > Dog Grooming | Dog Supplies > Dog Clothing & Accessories | Cat Supplies > Cat Toys | Cat Supplies > Cat Beds | Cat Supplies > Litter & Accessories | Cat Supplies > Cat Grooming | Small Animal Supplies | Bird Supplies | Fish & Aquatics | Pet Apparel

Automotive: Car Electronics > Dash Cams | Car Electronics > Car Chargers | Car Electronics > GPS & Navigation | Car Accessories > Seat Covers | Car Accessories > Car Floor Mats | Car Accessories > Air Fresheners | Car Care > Car Cleaning Kits | Tools & Equipment

Tools & Home Improvement: Power Tools | Hand Tools | Hardware & Fasteners | Electrical > Extension Cords | Electrical > Smart Plugs | Plumbing | Painting Supplies | Safety & Security

Office & School Supplies: Stationery > Pens & Pencils | Stationery > Notebooks & Journals | Art Supplies > Markers & Highlighters | Art Supplies > Paints & Canvases | Organization > Binders & Folders | Backpacks & Bags

Party & Seasonal: Party Decorations > Balloons & Banners | Party Decorations > Table Decorations | Halloween > Halloween Costumes | Halloween > Halloween Decorations | Halloween > Halloween Props & Accessories | Christmas > Christmas Ornaments | Christmas > Christmas Lights | Christmas > Christmas Decorations | Valentine's Day | Easter | Birthday Supplies

Output the category as: "Category > Subcategory > Product Type" (e.g. "Women's Clothing > Tops > T-Shirts")`;
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
    ? "You are a product categorization expert for Mathis Brothers, a large Oklahoma-based retailer that sells furniture, mattresses, rugs, bedding, home decor, lighting, AND seasonal/holiday items including Halloween costumes for all ages."
    : isTemu
    ? "You are a product categorization expert for Temu, a global e-commerce marketplace. Temu organizes products by Category > Subcategory > Product Type. Match each product to the most specific product type available in the provided list."
    : isBestBuy
    ? "You are a product categorization expert for Best Buy, a major US consumer electronics and appliance retailer. Best Buy organizes products by Category > Subcategory > Product Type. Match each product to the most specific product type that matches Best Buy's real taxonomy."
    : "You are a product categorization expert for a major retail marketplace.";

  const reasoningInstruction = `For each product, first think: "What is this product? What does it do / who uses it?" — then pick the best category. Use your knowledge of real-world products.`;

  const mathisSizeRule = isMathis ? `
SIZE CODE → CATEGORY RULE (Mathis, mandatory):
- T1/T2/T3/T4/T5/T6/T7 in the name = toddler costume → Baby & Kids
- 0-3M / 3-6M / 6-12M / 12-18M / 18-24M / 2T / 3T / 4T = infant/toddler → Baby & Kids
- (4-6) / (4-7) / (6-8) / (7-9) / (7-10) / (8-10) / (10-12) as child age range = child costume → Baby & Kids
- "Infant", "Toddler", "Baby", "Kids", "Child", "Boys", "Girls" in the name → Baby & Kids (unless clearly a furniture item)
- Adult / Teen / Plus / XL / (12-14) / (14-16) / (16-18) → Seasonal
- Any character name (nationality, animal, occupation, fantasy) + child size code → Baby & Kids costume
- Any character name + adult size or no size → Seasonal costume
- "Outdoor" category is for PATIO FURNITURE only — NEVER assign a costume or wearable item to Outdoor` : "";

  const rules = availableCategories?.length ? `
RULES:
1. Output EXACTLY one category name from the list above (copy it character-for-character) OR "Uncategorized" if truly no fit exists
2. Never invent category names. Never output "General", "Other", "Furniture", "Unknown", etc.
3. "Uncategorized" is only for products that genuinely don't belong in ANY listed category
4. Use all available information: product name, brand, description, vendor category, web context
5. If the product name includes a size, use it as a strong signal for age/audience${mathisSizeRule}` : "";

  const prompt = `${storeContext}

${reasoningInstruction}

Categorize each product into ${categorySection}.

Products:
${list}

Respond ONLY with a JSON array — no markdown, no explanation:
[{"index":1,"category":"Category Name","path":"Category Name","confidence":0.95},...]
${rules}
- path: full path e.g. "Mathis Brothers > Seasonal"
- confidence: 0.0–1.0 (how certain you are)
- Return exactly ${products.length} items in the same order as the product list`;

  const { text } = await generateText({
    model: anthropic(model),
    prompt,
    maxOutputTokens: 2000,
  });

  const fallbackCat = availableCategories?.[0] ?? "General";
  const allowedSet = availableCategories ? new Set([...availableCategories, "Uncategorized"]) : null;

  const mapResult = (r: { index: number; category: string; path: string; confidence: number }) => {
    let cat = r.category?.trim() ?? "";
    if (allowedSet && !allowedSet.has(cat)) {
      // AI returned something slightly off — try word-overlap mapping before giving up
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const normCat = norm(cat);
      let best: string | null = null;
      let bestScore = 0;
      for (const allowed of availableCategories ?? []) {
        const normAllowed = norm(allowed);
        const score = normAllowed.split(" ").filter(w => w.length > 2 && normCat.includes(w)).length
                    + normCat.split(" ").filter(w => w.length > 2 && normAllowed.includes(w)).length;
        if (score > bestScore) { bestScore = score; best = allowed; }
      }
      cat = bestScore >= 2 ? best! : "Uncategorized";
    }
    return {
      productId: products[r.index - 1]?.id ?? "",
      category: cat,
      path: r.path?.trim() || cat,
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
