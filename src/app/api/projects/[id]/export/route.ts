import { NextRequest, NextResponse } from "next/server";
import { authGuard } from "@/lib/auth-helpers";
import { prisma } from "@/lib/db";
import { generateExportZip } from "@/lib/export/zip";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { user, response } = await authGuard();
  if (response) return response;
  const { id } = await params;

  const { templateIds } = await req.json();

  if (!templateIds?.length) {
    return NextResponse.json({ error: "templateIds required" }, { status: 400 });
  }

  const [project, templates] = await Promise.all([
    prisma.project.findUnique({
      where: { id },
      include: { products: true },
    }),
    prisma.exportTemplate.findMany({ where: { id: { in: templateIds } } }),
  ]);

  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (project.userId !== user!.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  await prisma.project.update({ where: { id }, data: { status: "exporting" } });

  try {
    const zipBuffer = await generateExportZip(project.products, templates, project.marketplace);
    await prisma.project.update({ where: { id }, data: { status: "done" } });

    return new Response(zipBuffer as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="mercato-${id}.zip"`,
      },
    });
  } catch (err) {
    await prisma.project.update({ where: { id }, data: { status: "categorized" } });
    const msg = err instanceof Error ? err.message : "Export failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
