"use client";

import { useState, useEffect } from "react";
import { Download, FileSpreadsheet, Loader2, CheckCircle2, Package, Shuffle } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

function matchTemplate(category: string, templates: Template[], fallback: Template): Template {
  if (templates.length <= 1) return fallback;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const normCat = norm(category);
  const catWords = normCat.split(" ").filter((w) => w.length > 2);
  let best = fallback;
  let bestScore = 0;
  for (const t of templates) {
    const normName = norm(t.name);
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

export function ExportStep({ projectId, marketplace, products, verifiedCount, projectStatus }: {
  projectId: string;
  marketplace: string;
  products: Product[];
  verifiedCount: number;
  projectStatus: string;
}) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(true);

  useEffect(() => {
    fetch(`/api/templates?marketplace=${marketplace}`)
      .then((r) => r.json())
      .then((data) => {
        const tpls: Template[] = data.templates ?? [];
        setTemplates(tpls);
        if (tpls.length > 0) setSelectedTemplateId(tpls[0].id);
        setFetching(false);
      })
      .catch(() => setFetching(false));
  }, [marketplace]);

  // Count products per category
  const categoryCounts = new Map<string, number>();
  for (const p of products) {
    if (p.marketplaceCategory) {
      categoryCounts.set(p.marketplaceCategory, (categoryCounts.get(p.marketplaceCategory) ?? 0) + 1);
    }
  }
  const categories = [...categoryCounts.entries()].sort((a, b) => b[1] - a[1]);
  const uncategorizedCount = products.filter((p) => !p.marketplaceCategory).length;

  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId);

  async function handleExport() {
    if (!selectedTemplateId) { toast.error("Select a template first"); return; }
    setLoading(true);
    const res = await fetch(`/api/projects/${projectId}/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: selectedTemplateId }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast.error(data.error ?? "Export failed");
      setLoading(false);
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `mercato-export-${projectId}.zip`;
    a.click();
    URL.revokeObjectURL(url);
    setLoading(false);
    toast.success(`ZIP downloaded — ${categories.length} file${categories.length !== 1 ? "s" : ""}`);
  }

  return (
    <div className="p-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-semibold">Export ZIP</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Choose a template format — one Excel file will be created per category
          </p>
        </div>
        <button
          onClick={handleExport}
          disabled={loading || fetching || !selectedTemplateId || categories.length === 0}
          className="inline-flex items-center gap-2 h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition disabled:opacity-50"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
          {loading ? "Generating ZIP…" : `Download ZIP (${categories.length} file${categories.length !== 1 ? "s" : ""})`}
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
        <div className="space-y-6">
          {/* Template picker */}
          {templates.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center border rounded-xl">
              <FileSpreadsheet className="w-10 h-10 text-muted-foreground mb-3" />
              <p className="text-sm font-medium mb-1">No templates uploaded yet</p>
              <p className="text-xs text-muted-foreground max-w-xs">
                Go to Templates and upload an Excel template for {marketplace}. Its columns will be used for all exported files.
              </p>
            </div>
          ) : (
            <div>
              <h3 className="text-sm font-medium mb-1">Fallback template</h3>
              <p className="text-xs text-muted-foreground mb-2">Used for categories that don&apos;t closely match any template name</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {templates.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setSelectedTemplateId(t.id)}
                    className={cn(
                      "flex items-center gap-3 p-3 rounded-xl border text-left transition-all",
                      selectedTemplateId === t.id
                        ? "border-primary bg-primary/5 ring-1 ring-primary"
                        : "border-border hover:border-primary/40 hover:bg-accent"
                    )}
                  >
                    <div className={cn(
                      "w-8 h-8 rounded-lg flex items-center justify-center shrink-0",
                      selectedTemplateId === t.id ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                    )}>
                      <FileSpreadsheet className="w-4 h-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{t.name}</p>
                      <p className="text-xs text-muted-foreground">{t.fileFormat.toUpperCase()} · {t.category ?? "all categories"}</p>
                    </div>
                    {selectedTemplateId === t.id && <CheckCircle2 className="w-4 h-4 text-primary shrink-0" />}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Category file preview */}
          {categories.length > 0 && selectedTemplate && (
            <div>
              <h3 className="text-sm font-medium mb-2">
                Files that will be created
                <span className="ml-2 text-xs text-muted-foreground font-normal">— template auto-matched per category</span>
              </h3>
              <div className="border rounded-xl divide-y overflow-hidden">
                {categories.map(([category, count]) => {
                  const matched = matchTemplate(category, templates, selectedTemplate);
                  const isDefault = matched.id === selectedTemplate.id;
                  return (
                    <div key={category} className="flex items-center gap-3 px-4 py-2.5">
                      <FileSpreadsheet className="w-4 h-4 text-muted-foreground shrink-0" />
                      <span className="text-sm flex-1 truncate">{category}</span>
                      <span className={cn(
                        "text-xs shrink-0 flex items-center gap-1",
                        isDefault ? "text-muted-foreground" : "text-blue-600 font-medium"
                      )}>
                        {!isDefault && <Shuffle className="w-3 h-3" />}
                        {matched.name}
                      </span>
                      <span className="text-xs text-muted-foreground shrink-0">{count} product{count !== 1 ? "s" : ""}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* No categories */}
          {categories.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-center border rounded-xl">
              <Package className="w-10 h-10 text-muted-foreground mb-3" />
              <p className="text-sm font-medium mb-1">No categorized products</p>
              <p className="text-xs text-muted-foreground">Run the Categorize step first before exporting.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
