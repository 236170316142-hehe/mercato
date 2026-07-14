import { NextRequest, NextResponse } from "next/server";
import { authGuard } from "@/lib/auth-helpers";
import { prisma } from "@/lib/db";

type FieldResult = { field: string; label: string; stored: string; live: string; severity: string; note?: string };

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { user, response } = await authGuard();
  if (response) return response;
  const { id } = await params;

  const project = await prisma.project.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true,
      marketplace: true,
      products: {
        select: {
          id: true, name: true, vendorSku: true, upc: true, asin: true, brand: true,
          verifyStatus: true, verifyFields: true,
        },
        orderBy: { name: "asc" },
      },
    },
  });

  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (project.userId !== user!.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // Build CSV
  const FIELD_ORDER = ["title", "brand", "model", "images", "description", "dimensions"];
  const mpLabel =
    project.marketplace === "walmart" ? "Walmart" :
    project.marketplace === "amazon_us" ? "Amazon US" :
    "Amazon";

  const FIELD_LABELS: Record<string, string> = { model: "Model Number" };
  const header = [
    "SKU", "UPC", "ASIN", "Product Name", "Overall Status",
    "Catalog Image URL", `${mpLabel} Image URL`, "Image Result", "Image Note",
    ...FIELD_ORDER.filter(f => f !== "images").flatMap(f => {
      const label = FIELD_LABELS[f] ?? capitalize(f);
      return [`${label} (Catalog)`, `${label} (${mpLabel})`, `${label} Result`];
    }),
  ].map(h => `"${h}"`).join(",");

  // Numeric-ID fields (UPC, ASIN, SKU) must be forced to text in Excel, otherwise
  // 12-digit UPCs render as scientific notation (7.56E+11). The =""VALUE"" formula
  // trick tells Excel to evaluate the cell as a text string, not a number.
  const numId = (v: string | null | undefined) =>
    v ? `"=""${String(v).replace(/"/g, '""')}"""` : `""`;

  const rows = project.products.map((p) => {
    const fields = (p.verifyFields ?? []) as FieldResult[];
    const byField = Object.fromEntries(fields.map(f => [f.field, f]));

    const imgField = byField["images"];
    const textCells = [
      p.name,
      p.verifyStatus ?? "pending",
      imgField?.stored ?? "",
      imgField?.live ?? "",
      imgField?.severity ?? "N/A",
      imgField?.note ?? "",
      ...FIELD_ORDER.filter(f => f !== "images").flatMap(f => {
        const fr = byField[f];
        return fr ? [fr.stored, fr.live, fr.severity] : ["N/A", "N/A", "N/A"];
      }),
    ].map(c => `"${String(c ?? "").replace(/"/g, '""')}"`);

    return [
      numId(p.vendorSku),
      numId(normalizeUpc(p.upc) ?? p.upc),
      numId(p.asin),
      ...textCells,
    ].join(",");
  });

  const csv = "﻿" + [header, ...rows].join("\n");

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="verification-report-${id}.csv"`,
    },
  });
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function normalizeUpc(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = String(raw).trim();
  if (/^\d[\d.]*[eE][+\-]?\d+$/.test(s)) {
    const n = Number(s);
    if (!isNaN(n) && n > 0) s = Math.round(n).toString();
  }
  s = s.replace(/[^0-9]/g, "");
  if (!s || s.length < 8) return null;
  if (s.length < 12) s = s.padStart(12, "0");
  if (s.length > 14) s = s.slice(-14);
  return s;
}
