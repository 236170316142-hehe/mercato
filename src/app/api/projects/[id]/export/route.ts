import { NextRequest, NextResponse } from "next/server";
import { authGuard } from "@/lib/auth-helpers";
import { prisma } from "@/lib/db";
import type { ExportTemplate } from "@prisma/client";
import { generateCategoryZip, generateExportZip, generateFlatCategoryZip, generateFlatExport, generateSingleTemplateExport, type TemplateRow } from "@/lib/export/zip";
import { createJob, resolveJob, rejectJob, getJob } from "@/lib/export/job-store";

export const maxDuration = 300;

// Poll job status / download completed ZIP
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { user, response } = await authGuard();
  if (response) return response;
  const { id } = await params;

  const jobId = req.nextUrl.searchParams.get("jobId");
  if (!jobId) return NextResponse.json({ error: "jobId required" }, { status: 400 });

  const job = getJob(jobId);
  if (!job) return NextResponse.json({ error: "Job not found or expired" }, { status: 404 });

  if (job.status === "processing") {
    return NextResponse.json({ status: "processing" });
  }

  if (job.status === "error") {
    return NextResponse.json({ status: "error", error: job.error }, { status: 500 });
  }

  // Done — serve the ZIP
  return new Response(job.zip as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="mercato-${id}.zip"`,
    },
  });
}

// Start export job — lightweight auth + existence check only, then returns { jobId } immediately.
// All heavy DB queries (products, template fileData) run inside the background job.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { user, response } = await authGuard();
  if (response) return response;
  const { id } = await params;

  const body = await req.json().catch(() => ({}));
  const autoMatch: boolean = body.autoMatch ?? false;
  const templateId: string | undefined = body.templateId;
  const templateIds: string[] = body.templateIds ?? [];

  if (!autoMatch && !templateId && !templateIds.length) {
    return NextResponse.json({ error: "autoMatch, templateId or templateIds required" }, { status: 400 });
  }

  // Lightweight check — just ownership, no heavy data loaded
  const projectMeta = await prisma.project.findUnique({
    where: { id },
    select: { id: true, userId: true, marketplace: true },
  });
  if (!projectMeta) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  if (projectMeta.userId !== user!.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const jobId = `${id}_${Date.now()}`;
  createJob(jobId);

  // Mark exporting — this is fast (no data load)
  await prisma.project.update({ where: { id }, data: { status: "exporting" } });

  // All heavy work (loading products JSON, loading template fileData BYTEA) runs here in background.
  // The HTTP response returns the jobId above; client polls GET until done.
  void (async () => {
    try {
      // Never load fileData (large BYTEA blob) — all export paths use createXlsxFromScratch
      // which only needs column definitions. fillTemplateXlsx / ExcelJS blocks the event loop.
      const useAutoMatch = autoMatch || !!templateId;
      const useTemplateIds = !autoMatch && !templateId && templateIds.length > 0;

      // "amazon_us" and "amazon" share the same template pool; use lowercase for case-insensitive match
      const mp = projectMeta.marketplace;
      const mpLower = mp.toLowerCase();
      const mpFamily = mpLower === "amazon_us" || mpLower === "amazon" ? ["amazon_us", "amazon"] : [mpLower];

      // Always use the lightweight TemplateRow select (no fileData)
      const templateSelect = { id: true, name: true, marketplace: true, category: true, fileFormat: true, columns: true };
      const [project, allTemplates] = await Promise.all([
        prisma.project.findUnique({ where: { id }, include: { products: true } }),
        useAutoMatch
          ? prisma.exportTemplate.findMany({
              where: { marketplace: { in: mpFamily, mode: "insensitive" }, OR: [{ userId: user!.id }, { userId: null }] },
              select: templateSelect,
            }) as Promise<TemplateRow[]>
          : prisma.exportTemplate.findMany({
              where: { id: { in: templateIds }, OR: [{ userId: user!.id }, { userId: null }] },
              select: templateSelect,
            }) as Promise<TemplateRow[]>,
      ]);

      if (!project) throw new Error("Project not found");

      // Mathis and Temu always use category-split export and require templates.
      // All other marketplaces fall back to a flat single-file export when no templates are present.
      const usesTemplates = mpLower === "mathis";
      if (usesTemplates && !allTemplates.length) {
        throw new Error(`No templates found for ${projectMeta.marketplace}. Upload templates first.`);
      }

      const isTemu = mpLower === "temu";

      let zipBuffer: Buffer;
      if (isTemu && allTemplates.length) {
        // Temu with uploaded templates: match each category to the closest template
        // and export in that template's column format — one file per matched category
        zipBuffer = await generateCategoryZip(project.products, allTemplates, projectMeta.marketplace, templateId) as Buffer;
      } else if (isTemu) {
        // Temu without templates: split by AI-assigned category using flat columns
        zipBuffer = await generateFlatCategoryZip(project.products, projectMeta.marketplace) as Buffer;
      } else if (!allTemplates.length) {
        // Non-Mathis with no templates → flat export (one file, standard columns)
        zipBuffer = await generateFlatExport(project.products, projectMeta.marketplace) as Buffer;
      } else if (useTemplateIds) {
        // Non-Mathis: user picked a specific template → all products in one file.
        // For Walmart: load fileData to preserve original template formatting & dropdowns.
        let templateFileData: Buffer | null = null;
        if (mpLower === "walmart" && allTemplates[0]) {
          const withData = await prisma.exportTemplate.findUnique({
            where: { id: allTemplates[0].id },
            select: { fileData: true },
          });
          templateFileData = withData?.fileData ? Buffer.from(withData.fileData as unknown as ArrayBuffer) : null;
        }
        zipBuffer = await generateSingleTemplateExport(project.products, allTemplates[0], projectMeta.marketplace, templateFileData) as Buffer;
      } else if (useAutoMatch) {
        zipBuffer = await generateCategoryZip(project.products, allTemplates, projectMeta.marketplace, templateId) as Buffer;
      } else {
        zipBuffer = await generateExportZip(project.products, allTemplates as unknown as ExportTemplate[], projectMeta.marketplace) as Buffer;
      }

      resolveJob(jobId, zipBuffer as Buffer);
      await prisma.project.update({ where: { id }, data: { status: "done" } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[export] background job failed:", msg);
      rejectJob(jobId, msg);
      await prisma.project.update({ where: { id }, data: { status: "categorized" } }).catch(() => {});
    }
  })();

  return NextResponse.json({ jobId });
}
