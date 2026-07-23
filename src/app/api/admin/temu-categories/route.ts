import { NextResponse } from "next/server";
import { authGuard } from "@/lib/auth-helpers";
import { clearTemuCache } from "@/lib/ai/temu-taxonomy";

// POST /api/admin/temu-categories/reload
// Clears the in-memory Temu category cache so the next categorization request
// re-reads temu_categories.csv from disk — use after updating the CSV file.
export async function POST() {
  const { user, response } = await authGuard();
  if (response) return response;
  if ((user as { role?: string }).role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  clearTemuCache();
  return NextResponse.json({ ok: true, message: "Temu category cache cleared — next request will reload from CSV." });
}
