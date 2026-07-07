import { NextRequest, NextResponse } from "next/server";
import { authGuard } from "@/lib/auth-helpers";
import { prisma } from "@/lib/db";
import { generateCategoryZip, generateExportZip } from "@/lib/export/zip";

export const maxDuration = 300;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { user, response } = await authGuard();
  if (response) return response;
  const { id } = await params;

  const body = await req.json().catch(() => ({}));
  // Auto mode: no templateId — use all marketplace templates with auto-matching
  // Legacy single: templateId → specific fallback template
  // Legacy multi: templateIds[] → one file per template
  const autoMatch: boolean = body.autoMatch ?? false;
  const templateId: string | undefined = body.templateId;
  const templateIds: string[] = body.templateIds ?? [];

  if (!autoMatch && !templateId && !templateIds.length) {
    return NextResponse.json({ error: "autoMatch, templateId or templateIds required" }, { status: 400 });
  }

  try {
    const project = await prisma.project.findUnique({ where: { id }, include: { products: true } });
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    if (project.userId !== user!.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    // For category-split mode: fetch ALL templates for this marketplace so auto-matching works.
    // For legacy mode: fetch only the requested template IDs.
    const allTemplates = await prisma.exportTemplate.findMany({
      where: (autoMatch || templateId)
        ? { marketplace: project.marketplace, OR: [{ userId: user!.id }, { userId: null }] }
        : { id: { in: templateIds }, OR: [{ userId: user!.id }, { userId: null }] },
    });
    if (!allTemplates.length) return NextResponse.json({ error: "No templates found for this marketplace. Upload templates first." }, { status: 404 });

    await prisma.project.update({ where: { id }, data: { status: "exporting" } });

    const zipBuffer = (autoMatch || templateId)
      ? await generateCategoryZip(project.products, allTemplates, project.marketplace, templateId)
      : await generateExportZip(project.products, allTemplates, project.marketplace);

    await prisma.project.update({ where: { id }, data: { status: "done" } });

    return new Response(zipBuffer as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="mercato-${id}.zip"`,
      },
    });
  } catch (err) {
    await prisma.project.update({ where: { id }, data: { status: "categorized" } }).catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[export] failed:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
