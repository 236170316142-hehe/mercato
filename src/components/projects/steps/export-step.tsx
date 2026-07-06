"use client";

import { useState, useEffect } from "react";
import { Download, FileSpreadsheet, Loader2, AlertTriangle, CheckCircle2, Package } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

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

type CategoryMatch = {
  category: string;
  productCount: number;
  template: Template | null; // null = no template found for this category
};

export function ExportStep({ projectId, marketplace, products, verifiedCount, projectStatus }: {
  projectId: string;
  marketplace: string;
  products: Product[];
  verifiedCount: number;
  projectStatus: string;
}) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(true);

  useEffect(() => {
    fetch(`/api/templates?marketplace=${marketplace}`)
      .then((r) => r.json())
      .then((data) => { setTemplates(data.templates ?? []); setFetching(false); })
      .catch(() => setFetching(false));
  }, [marketplace]);

  // Build category → template matches
  const categoryMatches: CategoryMatch[] = (() => {
    const categoryCounts = new Map<string, number>();
    for (const p of products) {
      if (p.marketplaceCategory) {
        categoryCounts.set(p.marketplaceCategory, (categoryCounts.get(p.marketplaceCategory) ?? 0) + 1);
      }
    }

    const matches: CategoryMatch[] = [];
    for (const [category, productCount] of categoryCounts) {
      // Match by exact category name, case-insensitive fallback
      const template =
        templates.find((t) => t.category === category) ??
        templates.find((t) => t.category?.toLowerCase() === category.toLowerCase()) ??
        null;
      matches.push({ category, productCount, template });
    }
    // Sort: matched first, then unmatched
    return matches.sort((a, b) => (b.template ? 1 : 0) - (a.template ? 1 : 0) || a.category.localeCompare(b.category));
  })();

  const matchedCategories = categoryMatches.filter((m) => m.template !== null);
  const unmatchedCategories = categoryMatches.filter((m) => m.template === null);

  // Templates to use = one per matched category (deduplicated)
  const templateIds = [...new Set(matchedCategories.map((m) => m.template!.id))];

  async function handleExport() {
    if (!templateIds.length) { toast.error("No matched templates to export"); return; }
    setLoading(true);
    const res = await fetch(`/api/projects/${projectId}/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateIds }),
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
    toast.success(`ZIP downloaded — ${matchedCategories.length} file${matchedCategories.length !== 1 ? "s" : ""}`);
  }

  const uncategorizedCount = products.filter((p) => !p.marketplaceCategory).length;

  return (
    <div className="p-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-semibold">Export ZIP</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            One Excel file per category, bundled into a ZIP using your uploaded templates
          </p>
        </div>
        <button
          onClick={handleExport}
          disabled={loading || fetching || !templateIds.length}
          className="inline-flex items-center gap-2 h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition disabled:opacity-50"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
          {loading ? "Generating ZIP…" : `Download ZIP (${matchedCategories.length} file${matchedCategories.length !== 1 ? "s" : ""})`}
        </button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="rounded-xl border p-4 bg-green-50 border-green-200">
          <p className="text-2xl font-bold text-green-700">{matchedCategories.length}</p>
          <p className="text-sm text-muted-foreground">Categories matched</p>
        </div>
        <div className="rounded-xl border p-4 bg-card">
          <p className="text-2xl font-bold">{products.length - uncategorizedCount}</p>
          <p className="text-sm text-muted-foreground">Products categorized</p>
        </div>
        <div className="rounded-xl border p-4 bg-card">
          <p className="text-2xl font-bold">{unmatchedCategories.length}</p>
          <p className="text-sm text-muted-foreground">Missing templates</p>
        </div>
      </div>

      {fetching && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {!fetching && (
        <div className="space-y-3">
          {/* Matched pairs */}
          {matchedCategories.length > 0 && (
            <div>
              <h3 className="text-sm font-medium mb-2 text-green-700">
                <CheckCircle2 className="w-3.5 h-3.5 inline mr-1" />
                Ready to export
              </h3>
              <div className="space-y-2">
                {matchedCategories.map((m) => (
                  <div
                    key={m.category}
                    className="flex items-center gap-3 p-3 rounded-xl border border-green-200 bg-green-50"
                  >
                    <div className="w-8 h-8 rounded-lg bg-green-100 flex items-center justify-center shrink-0">
                      <FileSpreadsheet className="w-4 h-4 text-green-700" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{m.category}</p>
                      <p className="text-xs text-muted-foreground">
                        {m.productCount} product{m.productCount !== 1 ? "s" : ""} → {m.template!.name}.{m.template!.fileFormat}
                      </p>
                    </div>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium shrink-0">
                      {m.template!.fileFormat.toUpperCase()}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Unmatched categories */}
          {unmatchedCategories.length > 0 && (
            <div className="mt-4">
              <h3 className="text-sm font-medium mb-2 text-yellow-700">
                <AlertTriangle className="w-3.5 h-3.5 inline mr-1" />
                No template found — will be skipped
              </h3>
              <div className="space-y-2">
                {unmatchedCategories.map((m) => (
                  <div
                    key={m.category}
                    className="flex items-center gap-3 p-3 rounded-xl border border-yellow-200 bg-yellow-50"
                  >
                    <div className="w-8 h-8 rounded-lg bg-yellow-100 flex items-center justify-center shrink-0">
                      <AlertTriangle className="w-4 h-4 text-yellow-600" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{m.category}</p>
                      <p className="text-xs text-muted-foreground">
                        {m.productCount} product{m.productCount !== 1 ? "s" : ""} — upload a template with category "{m.category}" to include these
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* No categories at all */}
          {categoryMatches.length === 0 && !fetching && (
            <div className="flex flex-col items-center justify-center py-16 text-center border rounded-xl">
              <Package className="w-10 h-10 text-muted-foreground mb-3" />
              <p className="text-sm font-medium mb-1">No categorized products</p>
              <p className="text-xs text-muted-foreground">Run the Categorize step first before exporting.</p>
            </div>
          )}

          {/* Has categories but no templates at all */}
          {categoryMatches.length > 0 && templates.length === 0 && (
            <div className="flex flex-col items-center justify-center py-10 text-center border rounded-xl">
              <FileSpreadsheet className="w-10 h-10 text-muted-foreground mb-3" />
              <p className="text-sm font-medium mb-1">No templates uploaded yet</p>
              <p className="text-xs text-muted-foreground max-w-xs">
                Go to Templates and upload one Excel template per category for this marketplace.
                The template's category name must match the product category exactly.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
