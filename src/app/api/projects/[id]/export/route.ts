import { NextRequest, NextResponse } from "next/server";
import { authGuard } from "@/lib/auth-helpers";
import { prisma } from "@/lib/db";
import { generateCategoryZip, generateExportZip } from "@/lib/export/zip";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { user, response } = await authGuard();
  if (response) return response;
  const { id } = await params;

  const body = await req.json();
  // New mode: single templateId → one file per category
  // Legacy mode: templateIds array → one file per template
  const templateId: string | undefined = body.templateId;
  const templateIds: string[] = body.templateIds ?? [];

  if (!templateId && !templateIds.length) {
    return NextResponse.json({ error: "templateId or templateIds required" }, { status: 400 });
  }

  try {
    const [project, templates] = await Promise.all([
      prisma.project.findUnique({ where: { id }, include: { products: true } }),
      prisma.exportTemplate.findMany({
        where: {
          id: templateId ? templateId : { in: templateIds },
          OR: [{ userId: user!.id }, { userId: null }],
        },
      }),
    ]);

    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    if (project.userId !== user!.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    if (!templates.length) return NextResponse.json({ error: "Template not found" }, { status: 404 });

    await prisma.project.update({ where: { id }, data: { status: "exporting" } });

    const zipBuffer = templateId
      ? await generateCategoryZip(project.products, templates[0], project.marketplace)
      : await generateExportZip(project.products, templates, project.marketplace);

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
