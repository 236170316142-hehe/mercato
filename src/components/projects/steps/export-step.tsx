"use client";

import { useState, useEffect, useRef } from "react";
import { AlertTriangle, Download, FileSpreadsheet, Loader2, Package, Shuffle } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type Template = {
  id: string;
  name: string;
  marketplace: string;
  category: string | null;
  fileFormat: string;
  userId: string | null;
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
    if (normName === normCat) score += 10;
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
  // For single-template marketplaces: user picks which template to export with
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const mountedRef = useRef(true);

  const isMathis = marketplace === "mathis";
  const isTemu = marketplace === "temu";
  const isBestBuy = marketplace === "bestbuy";
  // Category-split marketplaces: one file per category, matched to template automatically.
  // Walmart uses single-template picker (like Amazon) so users can choose their template.
  const usesCategoryZip = isMathis || isTemu || isBestBuy;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    fetch(`/api/templates?marketplace=${marketplace}`)
      .then((r) => r.json())
      .then((data) => {
        const tpls: Template[] = data.templates ?? [];
        setTemplates(tpls);
        // Auto-select first template for single-template marketplaces
        if (!usesCategoryZip && tpls.length > 0) setSelectedTemplateId(tpls[0].id);
        setFetching(false);
      })
      .catch(() => setFetching(false));
  }, [marketplace, isMathis]);

  const categoryCounts = new Map<string, number>();
  for (const p of products) {
    if (p.marketplaceCategory && p.marketplaceCategory !== "Uncategorized") {
      categoryCounts.set(p.marketplaceCategory, (categoryCounts.get(p.marketplaceCategory) ?? 0) + 1);
    }
  }
  const categories = [...categoryCounts.entries()].sort((a, b) => b[1] - a[1]);
  // "Uncategorized" (AI flagged) + null (never categorized) — both are excluded from export
  const uncategorizedCount = products.filter((p) => !p.marketplaceCategory || p.marketplaceCategory === "Uncategorized").length;
  const exportableCount = products.length - uncategorizedCount;

  const hasTemplates = templates.length > 0;

  // Category-split (Mathis/Temu/BestBuy): needs categorized products; Mathis also requires templates
  // Other: needs at least 1 product; if templates exist, one must be selected
  const canExport = !loading && !fetching && (
    usesCategoryZip
      ? (isMathis ? hasTemplates : true) && categories.length > 0
      : products.length > 0 && (!hasTemplates || !!selectedTemplateId)
  );

  async function handleExport() {
    setLoading(true);
    setStatusMsg("Starting export…");
    try {
      // Category-split (Mathis/Temu/BestBuy): autoMatch=true — server matches each category to closest template
      // Single-template with selection: pass templateIds=[selectedId]
      // Fallback: autoMatch=true → flat export
      const body = usesCategoryZip
        ? { autoMatch: true }
        : hasTemplates && selectedTemplateId
          ? { templateIds: [selectedTemplateId] }
          : { autoMatch: true };

      const startRes = await fetch(`/api/projects/${projectId}/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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
          const fileCount = usesCategoryZip ? categories.length : 1;
          toast.success(`ZIP downloaded — ${fileCount} file${fileCount !== 1 ? "s" : ""}`);
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

  const buttonLabel = loading
    ? (statusMsg || "Generating ZIP…")
    : usesCategoryZip
      ? `Download ZIP (${categories.length} file${categories.length !== 1 ? "s" : ""})`
      : `Download ZIP (${products.length} product${products.length !== 1 ? "s" : ""})`;

  return (
    <div className="p-4 sm:p-8">
      {/* Header */}
      <div className="flex flex-col gap-3 mb-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Export ZIP</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            {usesCategoryZip
              ? "One Excel file per category — templates matched automatically"
              : "Export all products using your chosen template"}
          </p>
        </div>
        <button
          onClick={handleExport}
          disabled={!canExport}
          className="inline-flex items-center gap-2 h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition disabled:opacity-50"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
          {buttonLabel}
        </button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        {usesCategoryZip ? (
          <>
            <div className="rounded-xl border p-4 bg-green-50 border-green-200">
              <p className="text-2xl font-bold text-green-700">{categories.length}</p>
              <p className="text-sm text-muted-foreground">Categories → files</p>
            </div>
            <div className="rounded-xl border p-4">
              <p className="text-2xl font-bold">{exportableCount}</p>
              <p className="text-sm text-muted-foreground">Products to export</p>
            </div>
            <div className="rounded-xl border p-4">
              <p className="text-2xl font-bold">{templates.length}</p>
              <p className="text-sm text-muted-foreground">Templates available</p>
            </div>
          </>
        ) : (
          <>
            <div className="rounded-xl border p-4 bg-green-50 border-green-200">
              <p className="text-2xl font-bold text-green-700">{products.length}</p>
              <p className="text-sm text-muted-foreground">Products to export</p>
            </div>
            <div className="rounded-xl border p-4">
              <p className="text-2xl font-bold">{categories.length}</p>
              <p className="text-sm text-muted-foreground">Categories detected</p>
            </div>
            <div className="rounded-xl border p-4">
              <p className="text-2xl font-bold">{templates.length}</p>
              <p className="text-sm text-muted-foreground">Templates available</p>
            </div>
          </>
        )}
      </div>

      {/* Uncategorized warning banner */}
      {usesCategoryZip && !fetching && uncategorizedCount > 0 && (
        <div className="mb-4 rounded-xl border border-orange-200 bg-orange-50 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-orange-500 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-orange-800">
                {uncategorizedCount} product{uncategorizedCount !== 1 ? "s" : ""} {hasTemplates ? "will be added to the default template" : "will be excluded from the export"}
              </p>
              <p className="text-xs text-orange-700 mt-1">
                {hasTemplates
                  ? `These products were marked "Uncategorized" and will be placed in the first available template. ${exportableCount} categorized product${exportableCount !== 1 ? "s" : ""} will be matched to their specific templates.`
                  : `These products were marked "Uncategorized" and don't match any available category. Only ${exportableCount} product${exportableCount !== 1 ? "s" : ""} will be included in the ZIP.`}
              </p>
            </div>
          </div>
        </div>
      )}

      {fetching && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {!fetching && (
        <div className="space-y-4">

          {/* ── CATEGORY-SPLIT (Mathis / Temu / Best Buy) ── */}
          {usesCategoryZip && isMathis && !hasTemplates && (
            <div className="flex flex-col items-center justify-center py-12 text-center border rounded-xl">
              <FileSpreadsheet className="w-10 h-10 text-muted-foreground mb-3" />
              <p className="text-sm font-medium mb-1">No templates uploaded yet</p>
              <p className="text-xs text-muted-foreground max-w-xs">
                Go to Templates and upload an Excel template for {marketplace}. Its columns will be used for all exported files.
              </p>
            </div>
          )}

          {usesCategoryZip && !isMathis && !hasTemplates && categories.length > 0 && (
            <div className="mb-4 rounded-xl border border-blue-200 bg-blue-50 p-4">
              <div className="flex items-start gap-3">
                <FileSpreadsheet className="w-5 h-5 text-blue-500 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-blue-800">No templates — using flat column export</p>
                  <p className="text-xs text-blue-700 mt-1">
                    Upload templates per category in the Templates section to use custom column layouts. Without templates, the export uses standard columns.
                  </p>
                </div>
              </div>
            </div>
          )}

          {usesCategoryZip && categories.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-center border rounded-xl">
              <Package className="w-10 h-10 text-muted-foreground mb-3" />
              <p className="text-sm font-medium mb-1">No categorized products</p>
              <p className="text-xs text-muted-foreground">Run the Categorize step first before exporting.</p>
            </div>
          )}

          {usesCategoryZip && categories.length > 0 && (
            <div>
              <h3 className="text-sm font-medium mb-2">Files that will be created</h3>
              <div className="border rounded-xl divide-y overflow-hidden">
                {categories.map(([category, count]) => {
                  const matched = hasTemplates ? matchTemplate(category, templates) : null;
                  return (
                    <div key={category} className="flex items-center gap-3 px-4 py-2.5">
                      <FileSpreadsheet className="w-4 h-4 text-muted-foreground shrink-0" />
                      <span className="text-sm flex-1 truncate">{category}</span>
                      {matched && (
                        <span className="flex items-center gap-1 text-xs text-blue-600 font-medium shrink-0">
                          <Shuffle className="w-3 h-3" />
                          {matched.name}
                          {matched.userId === null && (
                            <span className="text-xs bg-purple-100 text-purple-700 px-1 py-0.5 rounded font-medium ml-1">Admin</span>
                          )}
                        </span>
                      )}
                      <span className="text-xs text-muted-foreground shrink-0">
                        {count} product{count !== 1 ? "s" : ""}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── SINGLE-TEMPLATE MARKETPLACES ── */}
          {!usesCategoryZip && products.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-center border rounded-xl">
              <Package className="w-10 h-10 text-muted-foreground mb-3" />
              <p className="text-sm font-medium mb-1">No products to export</p>
              <p className="text-xs text-muted-foreground">Upload and verify products first.</p>
            </div>
          )}

          {!usesCategoryZip && products.length > 0 && !hasTemplates && (
            <div className="flex flex-col items-center justify-center py-12 text-center border rounded-xl">
              <FileSpreadsheet className="w-10 h-10 text-muted-foreground mb-3" />
              <p className="text-sm font-medium mb-1">No templates uploaded yet</p>
              <p className="text-xs text-muted-foreground max-w-xs">
                Go to Templates and upload an Excel template for <span className="font-medium">{marketplace}</span>. Its columns will be used when exporting.
              </p>
            </div>
          )}

          {!usesCategoryZip && products.length > 0 && hasTemplates && (
            <div>
              <h3 className="text-sm font-medium mb-2">Choose export template</h3>
              <p className="text-xs text-muted-foreground mb-3">
                All {products.length} product{products.length !== 1 ? "s" : ""} will be exported into one file.
                {templates.some((t) => t.userId === null) && " Admin templates are available by default — no upload needed."}
              </p>
              <div className="border rounded-xl divide-y overflow-hidden">
                {templates.map((t) => (
                  <label
                    key={t.id}
                    className={cn(
                      "flex items-center gap-3 px-4 py-3 cursor-pointer transition hover:bg-muted/40",
                      selectedTemplateId === t.id && "bg-blue-50 border-blue-200"
                    )}
                  >
                    <input
                      type="radio"
                      name="template"
                      value={t.id}
                      checked={selectedTemplateId === t.id}
                      onChange={() => setSelectedTemplateId(t.id)}
                      className="accent-primary"
                    />
                    <FileSpreadsheet className="w-4 h-4 text-muted-foreground shrink-0" />
                    <span className="text-sm flex-1 font-medium">{t.name}</span>
                    {t.userId === null && (
                      <span className="text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded font-medium">Admin</span>
                    )}
                    {t.category && (
                      <span className="text-xs bg-muted px-2 py-0.5 rounded text-muted-foreground">{t.category}</span>
                    )}
                    <span className={cn(
                      "text-xs px-1.5 py-0.5 rounded font-medium",
                      t.fileFormat === "xlsx" ? "bg-green-100 text-green-700" : "bg-blue-100 text-blue-700"
                    )}>
                      {t.fileFormat.toUpperCase()}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
