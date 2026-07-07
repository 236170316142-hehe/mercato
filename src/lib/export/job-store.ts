type ExportJob = {
  status: "processing" | "done" | "error";
  zip?: Buffer;
  error?: string;
  createdAt: number;
};

// Module-level singleton — survives across requests in the same Node.js process.
// Works on Render (persistent server). Does not survive restarts.
const jobs = new Map<string, ExportJob>();

export function createJob(id: string): void {
  jobs.set(id, { status: "processing", createdAt: Date.now() });
  pruneOldJobs();
}

export function resolveJob(id: string, zip: Buffer): void {
  const j = jobs.get(id);
  if (j) jobs.set(id, { ...j, status: "done", zip });
}

export function rejectJob(id: string, error: string): void {
  const j = jobs.get(id);
  if (j) jobs.set(id, { ...j, status: "error", error });
}

export function getJob(id: string): ExportJob | undefined {
  return jobs.get(id);
}

function pruneOldJobs(): void {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [id, j] of jobs) {
    if (j.createdAt < cutoff) jobs.delete(id);
  }
}
