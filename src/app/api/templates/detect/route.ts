import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { authGuard } from "@/lib/auth-helpers";
import { readXlsxGrid } from "@/lib/vendor/xlsx-lite";
import { detectTemplateCategory } from "@/lib/ai/detect-template-category";

export async function POST(req: NextRequest) {
  const { response } = await authGuard();
  if (response) return response;

  let form: FormData;
  try { form = await req.formData(); } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "No file" }, { status: 400 });

  const ext = path.extname(file.name).toLowerCase();
  const buffer = Buffer.from(await file.arrayBuffer());

  let headers: string[] = [];
  let sheetName: string | null = null;

  if (ext === ".csv" || ext === ".tsv") {
    const text = buffer.toString("utf-8").replace(/^﻿/, "");
    const delim = ext === ".tsv" ? "\t" : (text.includes("\t") ? "\t" : ",");
    const firstLine = text.split(/\r?\n/)[0] ?? "";
    headers = firstLine.split(delim).map((h) => h.replace(/^"|"$/g, "").trim()).filter(Boolean);
  } else {
    try {
      const result = await readXlsxGrid(buffer, 5);
      sheetName = result.sheetName;
      const row = result.grid.find((r) => r.filter((c) => c.trim()).length >= 2) ?? [];
      headers = row.map((h) => h.trim()).filter(Boolean);
    } catch {
      return NextResponse.json({ category: null, sheetName: null });
    }
  }

  const category = await detectTemplateCategory(file.name, sheetName, headers);
  return NextResponse.json({ category, sheetName });
}
