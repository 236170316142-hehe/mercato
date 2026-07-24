import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/mercato";

function createPrisma() {
  const adapter = new PrismaPg({
    connectionString: databaseUrl,
    keepAlive: true,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });
}

const globalForPrisma = globalThis as unknown as { prisma?: ReturnType<typeof createPrisma> };

export const prisma = globalForPrisma.prisma ?? createPrisma();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

/**
 * Run per-row DB work in bounded chunks.
 *
 * `Promise.all(rows.map(() => prisma.update(...)))` over a large project issues
 * every query at once. The pg pool is small (node-postgres defaults to 10
 * connections), so the overflow queues and fails with
 * "timeout exceeded when trying to connect" once it waits past
 * connectionTimeoutMillis — which is what a 1000+ product categorize run hit.
 *
 * Chunking keeps in-flight queries at or below the pool size, so writes are
 * still concurrent but never starve the pool.
 */
export async function inChunks<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  size = 10,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    const chunk = items.slice(i, i + size);
    out.push(...(await Promise.all(chunk.map(fn))));
  }
  return out;
}
