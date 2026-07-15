import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Ensure the marketplace taxonomy CSVs (read at runtime via fs in
  // src/lib/ai/*-taxonomy.ts) are bundled into the serverless function.
  outputFileTracingIncludes: {
    "/api/projects/[id]/categorize": ["./src/lib/ai/data/*.csv"],
  },
};

export default nextConfig;
