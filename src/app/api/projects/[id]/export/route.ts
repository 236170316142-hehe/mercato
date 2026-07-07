import { NextRequest, NextResponse } from "next/server";
import { authGuard } from "@/lib/auth-helpers";
import { prisma } from "@/lib/db";
import { generateCategoryZip, generateExportZip } from "@/lib/export/zip";
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

// Start export job — returns immediately with { jobId }
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

  try {
    const project = await prisma.project.findUnique({ where: { id }, include: { products: true } });
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    if (project.userId !== user!.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const allTemplates = await prisma.exportTemplate.findMany({
      where: (autoMatch || templateId)
        ? { marketplace: project.marketplace, OR: [{ userId: user!.id }, { userId: null }] }
        : { id: { in: templateIds }, OR: [{ userId: user!.id }, { userId: null }] },
    });
    if (!allTemplates.length) {
      return NextResponse.json({ error: "No templates found for this marketplace. Upload templates first." }, { status: 404 });
    }

    const jobId = `${id}_${Date.now()}`;
    createJob(jobId);

    await prisma.project.update({ where: { id }, data: { status: "exporting" } });

    // Fire-and-forget: response returns to client immediately; processing continues in background.
    // This works on Render (persistent Node.js process) — the event loop stays alive.
    void (async () => {
      try {
        const zipBuffer = (autoMatch || templateId)
          ? await generateCategoryZip(project.products, allTemplates, project.marketplace, templateId)
          : await generateExportZip(project.products, allTemplates, project.marketplace);

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
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[export] setup failed:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
