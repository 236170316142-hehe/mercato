type ExportJob = {
  status: "processing" | "done" | "error";
  zip?: Buffer;
  error?: string;
  createdAt: number;
  /** Human-readable phase ("Generating titles…") shown while the job runs. */
  phase?: string;
  /** Last time the job reported progress — lets the client distinguish a
   *  still-working job from a genuinely stalled one. */
  updatedAt: number;
};

// Module-level singleton — survives across requests in the same Node.js process.
// Works on Render (persistent server). Does not survive restarts.
//
// NOTE: this is per-process. On a multi-instance deployment a poll can land on
// an instance that does not hold the job and will 404 forever. Moving the ZIP
// to object storage (S3/R2) keyed by jobId is the fix if this is ever scaled
// past one instance.
const jobs = new Map<string, ExportJob>();

export function createJob(id: string): void {
  const now = Date.now();
  jobs.set(id, { status: "processing", createdAt: now, updatedAt: now });
  pruneOldJobs();
}

/** Report the current phase so the client can show real progress. */
export function setJobPhase(id: string, phase: string): void {
  const j = jobs.get(id);
  if (j && j.status === "processing") {
    jobs.set(id, { ...j, phase, updatedAt: Date.now() });
  }
}

export function resolveJob(id: string, zip: Buffer): void {
  const j = jobs.get(id);
  if (j) jobs.set(id, { ...j, status: "done", zip, updatedAt: Date.now() });
}

export function rejectJob(id: string, error: string): void {
  const j = jobs.get(id);
  if (j) jobs.set(id, { ...j, status: "error", error, updatedAt: Date.now() });
}

export function getJob(id: string): ExportJob | undefined {
  return jobs.get(id);
}

function pruneOldJobs(): void {
  // Keyed on updatedAt, not createdAt: a long-running export kept reporting
  // progress but its createdAt kept ageing, so a slow job could be pruned out
  // from under itself — or a just-finished ZIP evicted before the user's poll
  // collected it.
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, j] of jobs) {
    if (j.updatedAt < cutoff) jobs.delete(id);
  }
}
