import { NextRequest, NextResponse } from "next/server";
import { authGuard } from "@/lib/auth-helpers";
import { prisma } from "@/lib/db";

type FieldResult = { field: string; label: string; stored: string; live: string; severity: string };

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
  const FIELD_ORDER = ["title", "brand", "images", "description", "dimensions"];
  const mpLabel =
    project.marketplace === "walmart" ? "Walmart" :
    project.marketplace === "amazon_us" ? "Amazon US" :
    "Amazon";

  const header = [
    "SKU", "UPC", "ASIN", "Product Name", "Overall Status",
    "Catalog Image URL", `${mpLabel} Image URL`,
    ...FIELD_ORDER.filter(f => f !== "images").flatMap(f => [`${capitalize(f)} (Catalog)`, `${capitalize(f)} (${mpLabel})`, `${capitalize(f)} Result`]),
  ].map(h => `"${h}"`).join(",");

  const rows = project.products.map((p) => {
    const fields = (p.verifyFields ?? []) as FieldResult[];
    const byField = Object.fromEntries(fields.map(f => [f.field, f]));

    const imgField = byField["images"];
    const cells = [
      p.vendorSku ?? "",
      normalizeUpc(p.upc) ?? p.upc ?? "",
      p.asin ?? "",
      p.name,
      p.verifyStatus ?? "pending",
      imgField?.stored ?? "",
      imgField?.live ?? "",
      ...FIELD_ORDER.filter(f => f !== "images").flatMap(f => {
        const fr = byField[f];
        return fr ? [fr.stored, fr.live, fr.severity] : ["N/A", "N/A", "N/A"];
      }),
    ];

    return cells.map(c => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",");
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
