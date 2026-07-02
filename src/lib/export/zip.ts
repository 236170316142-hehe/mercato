import JSZip from "jszip";
import ExcelJS from "exceljs";
import type { Product, ExportTemplate } from "@prisma/client";

type Column = { key: string; label: string; required?: boolean };

export async function generateExportZip(
  products: Product[],
  templates: ExportTemplate[],
  marketplace = "amazon",
): Promise<Buffer> {
  const zip = new JSZip();

  for (const template of templates) {
    const columns = template.columns as Column[];
    const anyVerified = products.some((p) => p.verifyStatus != null);
    const passedVerification = anyVerified
      ? marketplace === "amazon_us"
        ? products.filter((p) => p.verifyStatus === "ok")
        : products.filter((p) => p.verifyStatus === "ok" || p.verifyStatus === "warning" || p.verifyStatus === "not_found")
      : products;
    // Further filter by template's category scope
    const filtered = template.category
      ? passedVerification.filter((p) => p.marketplaceCategory === template.category)
      : passedVerification;

    if (template.fileFormat === "csv") {
      const csv = generateCsv(filtered, columns);
      zip.file(`${sanitize(template.name)}.csv`, csv);
    } else {
      const buffer = await generateXlsx(filtered, columns, template.name);
      zip.file(`${sanitize(template.name)}.xlsx`, buffer);
    }
  }

  return zip.generateAsync({ type: "nodebuffer" }) as unknown as Promise<Buffer>;
}

function generateCsv(products: Product[], columns: Column[]): string {
  const header = columns.map((c) => `"${c.label}"`).join(",");
  const rows = products.map((p) =>
    columns
      .map((c) => {
        const val = getProductField(p, c.key);
        return `"${String(val ?? "").replace(/"/g, '""')}"`;
      })
      .join(",")
  );
  return [header, ...rows].join("\n");
}

async function generateXlsx(products: Product[], columns: Column[], sheetName: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName.slice(0, 31));

  ws.columns = columns.map((c) => ({
    header: c.label,
    key: c.key,
    width: Math.max(c.label.length + 4, 20),
  }));

  // Style header row
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2E8F0" } };

  for (const p of products) {
    const row: Record<string, unknown> = {};
    for (const col of columns) {
      row[col.key] = getProductField(p, col.key) ?? "";
    }
    ws.addRow(row);
  }

  return wb.xlsx.writeBuffer() as unknown as Promise<Buffer>;
}

function getProductField(p: Product, key: string): unknown {
  const nk = key.toLowerCase().replace(/[\s_\-]+/g, "_").trim();
  const vd = p.vendorData as Record<string, unknown> | null;
  const ld = p.liveData as Record<string, unknown> | null;

  // Look up from vendorData by any of the given normalized aliases
  const fromVendor = (...aliases: string[]): unknown => {
    if (!vd) return undefined;
    for (const alias of aliases) {
      const na = alias.toLowerCase().replace(/[\s_\-]+/g, "_").trim();
      if (alias in vd) return vd[alias];
      const hit = Object.keys(vd).find((k) => k.toLowerCase().replace(/[\s_\-]+/g, "_").trim() === na);
      if (hit !== undefined) return vd[hit];
    }
    return undefined;
  };

  // Look up from liveData (Keepa NormalizedProduct)
  const fromLive = (field: string): unknown => ld?.[field] ?? undefined;

  // Keepa prices are in cents — convert to dollars
  const livePrice = typeof ld?.price === "number" && ld.price > 0 ? ld.price / 100 : null;
  // Verified ASIN from Keepa
  const verifiedAsin = typeof ld?.asin === "string" ? ld.asin : null;

  // Resolve price: product DB field → vendor data → Keepa live price
  const price = p.price != null
    ? p.price
    : (fromVendor("price", "retail_price", "unit_price", "cost", "msrp", "list_price") ?? livePrice ?? "");

  const coreMap: Record<string, unknown> = {
    // Name / Title — prefer vendor name, fall back to verified Amazon title
    name: p.name || fromLive("title") || "",
    title: p.name || fromLive("title") || "",
    product_name: p.name || fromLive("title") || "",
    item_name: p.name || fromLive("title") || "",

    // SKU
    sku: p.vendorSku, vendor_sku: p.vendorSku, seller_sku: p.vendorSku, merchant_sku: p.vendorSku,

    // IDs — fall back to liveData (verified ASIN from Keepa) when DB field is null
    upc: p.upc ?? fromVendor("upc", "ean", "barcode", "gtin", "product_id", "item_number") ?? "",
    ean: p.upc ?? fromVendor("ean", "upc", "barcode", "gtin") ?? "",
    barcode: p.upc ?? fromVendor("barcode", "upc", "ean") ?? "",
    gtin: p.upc ?? fromVendor("gtin", "upc", "ean") ?? "",
    asin: p.asin ?? verifiedAsin ?? "",
    merchant_suggested_asin: p.asin ?? verifiedAsin ?? "",

    // External/Product ID — both Amazon naming conventions
    external_product_id: p.upc ?? fromVendor("upc", "ean", "barcode") ?? p.asin ?? verifiedAsin ?? "",
    external_product_id_type: (p.upc || fromVendor("upc", "ean", "barcode")) ? "UPC" : (p.asin || verifiedAsin) ? "ASIN" : "",
    product_id: p.upc ?? fromVendor("upc", "ean", "barcode", "product_id") ?? p.asin ?? verifiedAsin ?? "",
    product_id_type: (p.upc || fromVendor("upc", "ean", "barcode")) ? "UPC" : (p.asin || verifiedAsin) ? "ASIN" : "",

    // Listing actions
    listing_action: "Add",
    add_delete: "a",
    update_delete: "PartialUpdate",
    operation_type: "Update",

    // Brand / Manufacturer — fall back to verified Amazon brand
    brand: p.brand || fromLive("brand") || "",
    brand_name: p.brand || fromLive("brand") || "",
    manufacturer: p.brand || fromLive("brand") || "",

    // Description & bullets — fall back to verified Amazon description
    description: p.description || fromLive("description") || "",
    product_description: p.description || fromLive("description") || "",
    bullet_point1: fromVendor("bullet_point1", "bullet1", "feature1", "key_feature_1") ?? "",
    bullet_point2: fromVendor("bullet_point2", "bullet2", "feature2", "key_feature_2") ?? "",
    bullet_point3: fromVendor("bullet_point3", "bullet3", "feature3", "key_feature_3") ?? "",
    bullet_point4: fromVendor("bullet_point4", "bullet4", "feature4") ?? "",
    bullet_point5: fromVendor("bullet_point5", "bullet5", "feature5") ?? "",

    // Price variants
    price,
    standard_price: price,
    msrp: fromVendor("msrp", "list_price") ?? price,
    sale_price: fromVendor("sale_price", "promo_price") ?? "",
    minimum_seller_allowed_price: fromVendor("min_price", "minimum_price", "map_price") ?? price,
    maximum_seller_allowed_price: fromVendor("max_price", "maximum_price") ?? "",

    // Condition & quantity
    item_condition: "New",
    condition: "New",
    condition_type: "New",
    condition_note: "",
    quantity: fromVendor("quantity", "qty", "stock", "inventory", "available_qty", "on_hand") ?? "1",
    fulfillment_latency: fromVendor("lead_time", "fulfillment_latency", "handling_time") ?? "",

    // Image — fall back to verified Amazon image
    image_url: p.imageUrl || fromLive("image") || "",
    imageurl: p.imageUrl || fromLive("image") || "",
    main_image_url: p.imageUrl || fromLive("image") || "",
    other_image_url1: fromVendor("image_url2", "other_image_url1", "alternate_image1") ?? "",

    // Category
    feed_product_type: p.marketplaceCategory ?? "",
    category: p.marketplaceCategory, category_path: p.categoryPath,
    item_type: p.marketplaceCategory ?? "",
    item_type_name: p.categoryPath ?? p.marketplaceCategory ?? "",
    browse_node: "",

    // Misc
    merchant_catalog_number: p.vendorSku ?? "",
    unspsc_code: "", national_stock_number: "",
  };

  if (nk in coreMap) return coreMap[nk];

  // Fall back to vendorData — exact match first, then case-insensitive normalized
  if (vd) {
    if (key in vd) return vd[key];
    const match = Object.keys(vd).find(
      (k) => k.toLowerCase().replace(/[\s_\-]+/g, "_").trim() === nk
    );
    if (match) return vd[match];
  }

  return "";
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\- ]/g, "").trim().replace(/\s+/g, "_");
}
