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
        : products.filter((p) => ["ok", "warning", "not_found"].includes(p.verifyStatus ?? ""))
      : products;

    // Filter by template's category scope
    const filtered = template.category
      ? passedVerification.filter((p) => p.marketplaceCategory === template.category)
      : passedVerification;

    const fileName = sanitize(template.name);

    if (template.fileFormat === "csv") {
      zip.file(`${fileName}.csv`, generateCsv(filtered, columns));
    } else {
      const fileData = template.fileData ? (template.fileData as Buffer) : null;
      const buffer = fileData
        ? await fillTemplateXlsx(filtered, columns, fileData)
        : await createXlsxFromScratch(filtered, columns, template.name);
      zip.file(`${fileName}.xlsx`, buffer);
    }
  }

  return zip.generateAsync({ type: "nodebuffer" }) as unknown as Promise<Buffer>;
}

// ── Fill existing template file with product rows ─────────────────────────────

async function fillTemplateXlsx(
  products: Product[],
  columns: Column[],
  fileData: Buffer,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  // ExcelJS type expects bare Buffer; Prisma Bytes resolves to Buffer<ArrayBuffer> in TS5
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await wb.xlsx.load(fileData as any);

  const ws = wb.worksheets[0];
  if (!ws) return createXlsxFromScratch(products, columns, "Sheet1");

  // Find the header row — the row with the highest count of non-empty cells
  let headerRowNum = 1;
  let maxCells = 0;
  ws.eachRow((row, rowNumber) => {
    let count = 0;
    row.eachCell(() => count++);
    if (count > maxCells) { maxCells = count; headerRowNum = rowNumber; }
  });

  // Build a map: normalised header text → 1-based column index
  const headerToCol = new Map<string, number>();
  const headerRow = ws.getRow(headerRowNum);
  headerRow.eachCell((cell, colNumber) => {
    const text = normalizeKey(String(cell.value ?? ""));
    if (text) headerToCol.set(text, colNumber);
  });

  // Remove all rows after the header
  const lastRow = ws.lastRow?.number ?? headerRowNum;
  for (let r = lastRow; r > headerRowNum; r--) {
    ws.spliceRows(r, 1);
  }

  // Map each column definition to a column index in the template
  const colIndexMap: [Column, number][] = [];
  for (const col of columns) {
    const byLabel = headerToCol.get(normalizeKey(col.label));
    const byKey   = headerToCol.get(normalizeKey(col.key));
    const idx = byLabel ?? byKey;
    if (idx !== undefined) colIndexMap.push([col, idx]);
  }

  // Add one row per product
  for (const p of products) {
    const newRow = ws.addRow([]);
    for (const [col, colIdx] of colIndexMap) {
      newRow.getCell(colIdx).value = (getProductField(p, col.key) ?? "") as ExcelJS.CellValue;
    }
    newRow.commit();
  }

  return wb.xlsx.writeBuffer() as unknown as Promise<Buffer>;
}

// ── Create a fresh workbook when no template file is stored ───────────────────

async function createXlsxFromScratch(
  products: Product[],
  columns: Column[],
  sheetName: string,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName.slice(0, 31));

  ws.columns = columns.map((c) => ({
    header: c.label,
    key: c.key,
    width: Math.max(c.label.length + 4, 20),
  }));

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

// ── CSV ───────────────────────────────────────────────────────────────────────

function generateCsv(products: Product[], columns: Column[]): string {
  const header = columns.map((c) => `"${c.label}"`).join(",");
  const rows = products.map((p) =>
    columns.map((c) => {
      const val = getProductField(p, c.key);
      return `"${String(val ?? "").replace(/"/g, '""')}"`;
    }).join(",")
  );
  return [header, ...rows].join("\n");
}

// ── Field resolver ────────────────────────────────────────────────────────────

function getProductField(p: Product, key: string): unknown {
  const nk = normalizeKey(key);
  const vd = p.vendorData as Record<string, unknown> | null;
  const ld = p.liveData as Record<string, unknown> | null;

  const fromVendor = (...aliases: string[]): unknown => {
    if (!vd) return undefined;
    for (const alias of aliases) {
      const na = normalizeKey(alias);
      if (alias in vd) return vd[alias];
      const hit = Object.keys(vd).find((k) => normalizeKey(k) === na);
      if (hit !== undefined) return vd[hit];
    }
    return undefined;
  };

  const fromLive = (field: string): unknown => ld?.[field] ?? undefined;

  const livePrice = typeof ld?.price === "number" && ld.price > 0 ? ld.price / 100 : null;
  const verifiedAsin = typeof ld?.asin === "string" ? ld.asin : null;

  const price = p.price != null
    ? p.price
    : (fromVendor("price", "retail_price", "unit_price", "cost", "msrp", "list_price") ?? livePrice ?? "");

  const coreMap: Record<string, unknown> = {
    // Name / Title
    name: p.name || fromLive("title") || "",
    title: p.name || fromLive("title") || "",
    product_name: p.name || fromLive("title") || "",
    item_name: p.name || fromLive("title") || "",

    // SKU
    sku: p.vendorSku, vendor_sku: p.vendorSku, seller_sku: p.vendorSku,
    merchant_sku: p.vendorSku, sku_id: p.vendorSku,

    // IDs
    upc: p.upc ?? fromVendor("upc", "ean", "barcode", "gtin", "product_id", "item_number") ?? "",
    ean: p.upc ?? fromVendor("ean", "upc", "barcode", "gtin") ?? "",
    barcode: p.upc ?? fromVendor("barcode", "upc", "ean") ?? "",
    gtin: p.upc ?? fromVendor("gtin", "upc", "ean") ?? "",
    asin: p.asin ?? verifiedAsin ?? "",
    merchant_suggested_asin: p.asin ?? verifiedAsin ?? "",

    // Temu / generic marketplace IDs
    goods_id: p.upc ?? p.vendorSku ?? "",
    product_id: p.upc ?? fromVendor("upc", "ean", "barcode", "product_id") ?? p.asin ?? verifiedAsin ?? "",

    // External ID (Amazon flat-file)
    external_product_id: p.upc ?? fromVendor("upc", "ean", "barcode") ?? p.asin ?? verifiedAsin ?? "",
    external_product_id_type: (p.upc || fromVendor("upc", "ean", "barcode")) ? "UPC" : (p.asin || verifiedAsin) ? "ASIN" : "",
    product_id_type: (p.upc || fromVendor("upc", "ean", "barcode")) ? "UPC" : (p.asin || verifiedAsin) ? "ASIN" : "",

    // Listing actions
    listing_action: "Add",
    add_delete: "a",
    update_delete: "PartialUpdate",
    operation_type: "Update",

    // Status (Temu / Best Buy / generic)
    status: fromVendor("status") ?? "on_sale",
    active: "Y",

    // Brand / Manufacturer
    brand: p.brand || fromLive("brand") || "",
    brand_name: p.brand || fromLive("brand") || "",
    manufacturer: p.brand || fromLive("brand") || "",

    // Description / Details
    description: p.description || fromLive("description") || fromVendor("details", "description") || "",
    product_description: p.description || fromLive("description") || "",
    details: p.description || fromLive("description") || fromVendor("details", "description") || "",
    bullet_point1: fromVendor("bullet_point1", "bullet1", "feature1", "key_feature_1") ?? "",
    bullet_point2: fromVendor("bullet_point2", "bullet2", "feature2", "key_feature_2") ?? "",
    bullet_point3: fromVendor("bullet_point3", "bullet3", "feature3", "key_feature_3") ?? "",
    bullet_point4: fromVendor("bullet_point4", "bullet4", "feature4") ?? "",
    bullet_point5: fromVendor("bullet_point5", "bullet5", "feature5") ?? "",

    // Price
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

    // Image
    image_url: p.imageUrl || fromLive("image") || "",
    imageurl: p.imageUrl || fromLive("image") || "",
    main_image_url: p.imageUrl || fromLive("image") || "",
    other_image_url1: fromVendor("image_url2", "other_image_url1", "alternate_image1") ?? "",

    // Category
    category: p.marketplaceCategory ?? "",
    category_name: p.marketplaceCategory ?? "",
    feed_product_type: p.marketplaceCategory ?? "",
    item_type: p.marketplaceCategory ?? "",
    item_type_name: p.categoryPath ?? p.marketplaceCategory ?? "",
    category_path: p.categoryPath ?? "",
    browse_node: "",
    product_type: p.marketplaceCategory ?? "",

    // Customisation / technique (Temu-specific — pass through from vendorData if present)
    customization_processing_technique: fromVendor("customization_processing_technique", "processing_technique") ?? "",
    primary_technique: fromVendor("primary_technique", "technique") ?? "",
    secondary_technique: fromVendor("secondary_technique") ?? "",

    // Misc
    merchant_catalog_number: p.vendorSku ?? "",
    unspsc_code: "",
    national_stock_number: "",
  };

  if (nk in coreMap) return coreMap[nk];

  // Fall back to vendorData — exact match first, then normalised
  if (vd) {
    if (key in vd) return vd[key];
    const match = Object.keys(vd).find((k) => normalizeKey(k) === nk);
    if (match) return vd[match];
  }

  return "";
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeKey(s: string): string {
  return s.toLowerCase().replace(/[\s_\-]+/g, "_").trim();
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\- ]/g, "").trim().replace(/\s+/g, "_");
}
