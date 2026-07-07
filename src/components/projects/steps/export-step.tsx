"use client";

import { useState, useEffect, useRef } from "react";
import { Download, FileSpreadsheet, Loader2, Package, Shuffle } from "lucide-react";
import { toast } from "sonner";

type Template = {
  id: string;
  name: string;
  marketplace: string;
  category: string | null;
  fileFormat: string;
};

type Product = {
  id: string;
  name: string;
  marketplaceCategory: string | null;
};

function matchTemplate(category: string, templates: Template[]): Template {
  if (templates.length === 1) return templates[0];
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const normCat = norm(category);
  const catWords = normCat.split(" ").filter((w) => w.length > 2);
  let best = templates[0];
  let bestScore = 0;
  for (const t of templates) {
    const normName = norm(t.category || t.name);
    const nameWords = normName.split(" ").filter((w) => w.length > 2);
    let score = 0;
    for (const word of catWords) if (nameWords.includes(word)) score += 2;
    for (const word of nameWords) if (catWords.includes(word)) score += 1;
    if (normName.includes(normCat)) score += 5;
    if (normCat.includes(normName)) score += 3;
    if (score > bestScore) { bestScore = score; best = t; }
  }
  return best;
}

export function ExportStep({ projectId, marketplace, products, projectStatus }: {
  projectId: string;
  marketplace: string;
  products: Product[];
  verifiedCount: number;
  projectStatus: string;
}) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");
  const [fetching, setFetching] = useState(true);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    fetch(`/api/templates?marketplace=${marketplace}`)
      .then((r) => r.json())
      .then((data) => { setTemplates(data.templates ?? []); setFetching(false); })
      .catch(() => setFetching(false));
  }, [marketplace]);

  const categoryCounts = new Map<string, number>();
  for (const p of products) {
    if (p.marketplaceCategory) {
      categoryCounts.set(p.marketplaceCategory, (categoryCounts.get(p.marketplaceCategory) ?? 0) + 1);
    }
  }
  const categories = [...categoryCounts.entries()].sort((a, b) => b[1] - a[1]);
  const uncategorizedCount = products.filter((p) => !p.marketplaceCategory).length;

  const hasTemplates = templates.length > 0;
  const canExport = hasTemplates && categories.length > 0 && !loading && !fetching;

  async function handleExport() {
    setLoading(true);
    setStatusMsg("Starting export…");
    try {
      // 1. Kick off the background job
      const startRes = await fetch(`/api/projects/${projectId}/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoMatch: true }),
      });

      if (!startRes.ok) {
        const text = await startRes.text().catch(() => "");
        let msg = "Export failed";
        try { msg = (JSON.parse(text) as { error?: string }).error ?? (text.slice(0, 300) || msg); } catch { msg = text.slice(0, 300) || msg; }
        toast.error(msg);
        return;
      }

      const { jobId } = (await startRes.json()) as { jobId: string };
      setStatusMsg("Processing files…");

      // 2. Poll until done (max 5 min)
      const deadline = Date.now() + 5 * 60 * 1000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2500));
        if (!mountedRef.current) return;

        const pollRes = await fetch(
          `/api/projects/${projectId}/export?jobId=${encodeURIComponent(jobId)}`
        );

        const contentType = pollRes.headers.get("content-type") ?? "";

        if (contentType.includes("application/zip")) {
          const blob = await pollRes.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `mercato-export-${projectId}.zip`;
          a.click();
          URL.revokeObjectURL(url);
          toast.success(`ZIP downloaded — ${categories.length} file${categories.length !== 1 ? "s" : ""}`);
          return;
        }

        if (!pollRes.ok) {
          const data = await pollRes.json().catch(() => ({ error: "Export failed" })) as { error?: string };
          toast.error(data.error ?? "Export failed");
          return;
        }

        const data = (await pollRes.json()) as { status: string; error?: string };
        if (data.status === "error") {
          toast.error(data.error ?? "Export failed");
          return;
        }
        // status === "processing" → keep polling
      }

      toast.error("Export timed out — please try again");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed — check server logs");
    } finally {
      if (mountedRef.current) {
        setLoading(false);
        setStatusMsg("");
      }
    }
  }

  return (
    <div className="p-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-semibold">Export ZIP</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            One Excel file per category — templates matched automatically
          </p>
        </div>
        <button
          onClick={handleExport}
          disabled={!canExport}
          className="inline-flex items-center gap-2 h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition disabled:opacity-50"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
          {loading ? (statusMsg || "Generating ZIP…") : `Download ZIP (${categories.length} file${categories.length !== 1 ? "s" : ""})`}
        </button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="rounded-xl border p-4 bg-green-50 border-green-200">
          <p className="text-2xl font-bold text-green-700">{categories.length}</p>
          <p className="text-sm text-muted-foreground">Categories → files</p>
        </div>
        <div className="rounded-xl border p-4">
          <p className="text-2xl font-bold">{products.length - uncategorizedCount}</p>
          <p className="text-sm text-muted-foreground">Products to export</p>
        </div>
        <div className="rounded-xl border p-4">
          <p className="text-2xl font-bold">{templates.length}</p>
          <p className="text-sm text-muted-foreground">Templates available</p>
        </div>
      </div>

      {fetching && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {!fetching && (
        <div className="space-y-4">
          {/* No templates */}
          {!hasTemplates && (
            <div className="flex flex-col items-center justify-center py-12 text-center border rounded-xl">
              <FileSpreadsheet className="w-10 h-10 text-muted-foreground mb-3" />
              <p className="text-sm font-medium mb-1">No templates uploaded yet</p>
              <p className="text-xs text-muted-foreground max-w-xs">
                Go to Templates and upload an Excel template for {marketplace}. Its columns will be used for all exported files.
              </p>
            </div>
          )}

          {/* No categories */}
          {hasTemplates && categories.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-center border rounded-xl">
              <Package className="w-10 h-10 text-muted-foreground mb-3" />
              <p className="text-sm font-medium mb-1">No categorized products</p>
              <p className="text-xs text-muted-foreground">Run the Categorize step first before exporting.</p>
            </div>
          )}

          {/* Category → template file list */}
          {hasTemplates && categories.length > 0 && (
            <div>
              <h3 className="text-sm font-medium mb-2">Files that will be created</h3>
              <div className="border rounded-xl divide-y overflow-hidden">
                {categories.map(([category, count]) => {
                  const matched = matchTemplate(category, templates);
                  return (
                    <div key={category} className="flex items-center gap-3 px-4 py-2.5">
                      <FileSpreadsheet className="w-4 h-4 text-muted-foreground shrink-0" />
                      <span className="text-sm flex-1 truncate">{category}</span>
                      <span className="flex items-center gap-1 text-xs text-blue-600 font-medium shrink-0">
                        <Shuffle className="w-3 h-3" />
                        {matched.name}
                      </span>
                      <span className="text-xs text-muted-foreground shrink-0">
                        {count} product{count !== 1 ? "s" : ""}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
