import JSZip from "jszip";
import ExcelJS from "exceljs";
import type { Product, ExportTemplate } from "@prisma/client";

type Column = { key: string; label: string; required?: boolean };

export async function generateExportZip(
  products: Product[],
  templates: ExportTemplate[],
): Promise<Buffer> {
  const zip = new JSZip();

  for (const template of templates) {
    const columns = template.columns as Column[];
    // Only include products that passed verification; if not yet verified, include all.
    const anyVerified = products.some((p) => p.verifyStatus != null);
    const passedVerification = anyVerified
      ? products.filter((p) => p.verifyStatus === "ok" || p.verifyStatus === "warning")
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
  // Normalize key: lowercase, collapse whitespace/hyphens/underscores
  const nk = key.toLowerCase().replace(/[\s_\-]+/g, "_").trim();

  // Core product fields — short keys and full Amazon column name variants
  const coreMap: Record<string, unknown> = {
    // Name / Title
    name: p.name,
    title: p.name,
    product_name: p.name,
    item_name: p.name,
    feed_product_type: p.marketplaceCategory ?? "",

    // SKU
    sku: p.vendorSku,
    vendor_sku: p.vendorSku,
    seller_sku: p.vendorSku,
    merchant_sku: p.vendorSku,

    // IDs
    upc: p.upc,
    ean: p.upc,
    barcode: p.upc,
    gtin: p.upc,
    asin: p.asin,
    merchant_suggested_asin: p.asin ?? "",

    // External Product ID (Amazon ListingLoader convention)
    external_product_id: p.upc ?? p.asin ?? "",
    external_product_id_type: p.upc ? "UPC" : p.asin ? "ASIN" : "",

    // Listing action for Amazon flat files (always "Add" for new/update)
    listing_action: "Add",
    update_delete: "PartialUpdate",
    operation_type: "Update",

    // Brand / Manufacturer
    brand: p.brand,
    brand_name: p.brand,
    manufacturer: p.brand,

    // Description
    description: p.description,
    product_description: p.description ?? "",
    bullet_point1: "",
    bullet_point2: "",
    bullet_point3: "",
    bullet_point4: "",
    bullet_point5: "",

    // Price
    price: p.price,
    standard_price: p.price ?? "",
    sale_price: "",
    msrp: p.price ?? "",

    // Image
    image_url: p.imageUrl,
    imageurl: p.imageUrl,
    main_image_url: p.imageUrl ?? "",
    other_image_url1: "",

    // Category
    category: p.marketplaceCategory,
    category_path: p.categoryPath,
    item_type: p.marketplaceCategory ?? "",
    item_type_name: p.categoryPath ?? p.marketplaceCategory ?? "",
    browse_node: "",

    // Misc Amazon fields we leave blank
    unspsc_code: "",
    national_stock_number: "",
    merchant_catalog_number: p.vendorSku ?? "",
  };

  if (nk in coreMap) return coreMap[nk];

  // Fall back to vendorData (raw spreadsheet columns) — exact then case-insensitive
  const vd = p.vendorData as Record<string, unknown> | null;
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
