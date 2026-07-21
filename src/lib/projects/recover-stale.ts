import { prisma } from "@/lib/db";

/**
 * Transient project statuses are written at the *start* of a long-running
 * request (verify / categorize / export) and only cleared when that same
 * request finishes. If the request is killed before it completes — the 300s
 * `maxDuration` ceiling, a server restart, a crash, or the machine sleeping —
 * the project is stranded in the transient status forever, because nothing
 * else ever resets it.
 *
 * This recovers any project that has sat in a transient status past the point
 * where a live request could still be running, mapping each transient status
 * back to the same stable status its own route's error handler falls back to.
 */

// `maxDuration` is 300s; add a buffer so we never clobber a run that is
// legitimately still in progress near the ceiling.
const STALE_MS = 6 * 60 * 1000;

// transient status → the stable status to recover to (mirrors each route's
// catch handler: verify → uploaded, categorize → verified, export → categorized).
const RECOVERY: Record<string, string> = {
  verifying: "uploaded",
  categorizing: "verified",
  exporting: "categorized",
};

/**
 * Reset stale in-progress projects. Scope the sweep with `userId` (list view)
 * or `id` (single project) to avoid touching unrelated rows.
 */
export async function recoverStaleProjects(
  scope: { userId?: string; id?: string } = {},
): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_MS);
  try {
    await Promise.all(
      Object.entries(RECOVERY).map(([from, to]) =>
        prisma.project.updateMany({
          where: { ...scope, status: from, updatedAt: { lt: cutoff } },
          data: { status: to },
        }),
      ),
    );
  } catch (err) {
    // Recovery is best-effort — never let it block the page/route it guards.
    console.error("[recover-stale] failed to reset stale projects:", err);
  }
}
