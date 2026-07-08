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
    ...FIELD_ORDER.flatMap(f => [`${capitalize(f)} (Catalog)`, `${capitalize(f)} (${mpLabel})`, `${capitalize(f)} Result`]),
  ].map(h => `"${h}"`).join(",");

  const rows = project.products.map((p) => {
    const fields = (p.verifyFields ?? []) as FieldResult[];
    const byField = Object.fromEntries(fields.map(f => [f.field, f]));

    const cells = [
      p.vendorSku ?? "",
      p.upc ?? "",
      p.asin ?? "",
      p.name,
      p.verifyStatus ?? "pending",
      ...FIELD_ORDER.flatMap(f => {
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
