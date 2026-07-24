import { NextRequest, NextResponse } from "next/server";
import { authGuard } from "@/lib/auth-helpers";
import { prisma } from "@/lib/db";
import type { ExportTemplate } from "@prisma/client";
import { generateCategoryZip, generateExportZip, generateFlatCategoryZip, generateFlatExport, generateSingleTemplateExport, type TemplateRow } from "@/lib/export/zip";
import { createJob, resolveJob, rejectJob, getJob, setJobPhase } from "@/lib/export/job-store";
import { buildDownloadName, contentDisposition } from "@/lib/export/filename";

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
    // Echo the phase and a heartbeat so the client can show real progress and
    // tell a slow-but-alive job apart from a stalled one.
    return NextResponse.json({
      status: "processing",
      phase: job.phase ?? "Preparing…",
      updatedAt: job.updatedAt,
    });
  }

  if (job.status === "error") {
    return NextResponse.json({ status: "error", error: job.error }, { status: 500 });
  }

  // Done — serve the ZIP under a human-readable name
  // ("mercato-Spring Catalog-mathis-23-07-2026.zip" rather than the raw project id).
  const meta = await prisma.project.findUnique({
    where: { id },
    select: { name: true, marketplace: true },
  });
  const filename = buildDownloadName({
    projectName: meta?.name,
    marketplace: meta?.marketplace,
    extension: "zip",
  });

  return new Response(job.zip as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": contentDisposition(filename),
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
      const useAutoMatch = autoMatch || !!templateId;
      const useTemplateIds = !autoMatch && !templateId && templateIds.length > 0;

      // "amazon_us" and "amazon" share the same template pool; use lowercase for case-insensitive match
      const mp = projectMeta.marketplace;
      const mpLower = mp.toLowerCase();
      const mpFamily = mpLower === "amazon_us" || mpLower === "amazon" ? ["amazon_us", "amazon"] : [mpLower];

      // Include templates owned by admin users (some may have userId=adminId instead of null).
      const adminUserIds = (await prisma.user.findMany({ where: { role: "admin" }, select: { id: true } }))
        .map((u) => u.id);
      const adminOr = adminUserIds.length > 0 ? [{ userId: { in: adminUserIds } }] : [];
      const templateOwnerOr = [{ userId: user!.id }, { userId: null }, ...adminOr];

      // Include fileData so category-zip exports can use fillTemplateXlsx and preserve
      // original template formatting, column widths, styles, and dropdown validations.
      setJobPhase(jobId, "Loading products…");
      const templateSelect = { id: true, name: true, marketplace: true, category: true, fileFormat: true, columns: true, fileData: true };
      const [project, allTemplates] = await Promise.all([
        prisma.project.findUnique({ where: { id }, include: { products: true } }),
        useAutoMatch
          ? prisma.exportTemplate.findMany({
              where: { marketplace: { in: mpFamily, mode: "insensitive" }, OR: templateOwnerOr },
              select: templateSelect,
            }) as Promise<TemplateRow[]>
          : prisma.exportTemplate.findMany({
              where: { id: { in: templateIds }, OR: templateOwnerOr },
              select: templateSelect,
            }) as Promise<TemplateRow[]>,
      ]);

      if (!project) throw new Error("Project not found");

      // For Walmart exports: AI-generate optimised titles (meaning + attributes + USPs)
      // instead of copying vendor titles word-for-word. Falls back to vendor name on error.
      if (mpLower === "walmart" && project.products.length > 0) {
        try {
          setJobPhase(jobId, `Generating optimised titles for ${project.products.length} products…`);
          const { generateMarketplaceTitles } = await import("@/lib/ai/generate-title");
          const titleMap = await generateMarketplaceTitles("walmart", project.products);
          if (titleMap.size > 0) {
            project.products = project.products.map((p) =>
              titleMap.has(p.id) ? { ...p, name: titleMap.get(p.id)! } : p
            );
          }
        } catch (err) {
          console.warn("[export] title generation failed, using vendor names:", err);
        }
      }

      // Mathis requires templates (throws if none). Walmart, Best Buy and Temu gracefully
      // fall back to flat category ZIP when no templates are uploaded.
      const usesTemplates = mpLower === "mathis";
      if (usesTemplates && !allTemplates.length) {
        throw new Error(`No templates found for ${projectMeta.marketplace}. Upload templates first.`);
      }

      const isTemu = mpLower === "temu";
      const isBestBuy = mpLower === "bestbuy";
      const isWalmart = mpLower === "walmart";
      // Category-split marketplaces: products grouped by category, each group filled into
      // the closest matching uploaded template (one output file per template).
      const usesCategoryExport = isTemu || isBestBuy || isWalmart;

      setJobPhase(jobId, "Building spreadsheet files…");

      let zipBuffer: Buffer;
      if (useTemplateIds && allTemplates.length) {
        // User explicitly selected a template → all products in one file using that template.
        // This takes priority over category-split so Walmart (and any marketplace) can use
        // a manually chosen template instead of auto-matching by category.
        const tpl = allTemplates[0];
        const templateFileData = tpl?.fileData ? Buffer.from(tpl.fileData as unknown as ArrayBuffer) : null;
        zipBuffer = await generateSingleTemplateExport(project.products, tpl, projectMeta.marketplace, templateFileData) as Buffer;
      } else if (usesCategoryExport && allTemplates.length) {
        // With uploaded templates: match each category to the closest template
        // and export in that template's column format — one file per matched category
        zipBuffer = await generateCategoryZip(project.products, allTemplates, projectMeta.marketplace, templateId) as Buffer;
      } else if (usesCategoryExport) {
        // Without templates: split by AI-assigned category using flat columns
        zipBuffer = await generateFlatCategoryZip(project.products, projectMeta.marketplace) as Buffer;
      } else if (!allTemplates.length) {
        // Non-Mathis with no templates → flat export (one file, standard columns)
        zipBuffer = await generateFlatExport(project.products, projectMeta.marketplace) as Buffer;
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
