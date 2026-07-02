"use client";

import { useState, useEffect } from "react";
import { Download, FileSpreadsheet, Loader2, Package } from "lucide-react";
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

export function ExportStep({ projectId, marketplace, products, verifiedCount, projectStatus }: {
  projectId: string;
  marketplace: string;
  products: Product[];
  verifiedCount: number;
  projectStatus: string;
}) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(true);

  useEffect(() => {
    fetch(`/api/templates?marketplace=${marketplace}`)
      .then((r) => r.json())
      .then((data) => {
        const tpls: Template[] = data.templates ?? [];
        setTemplates(tpls);
        // Auto-select all templates for Amazon (single template workflow)
        if (marketplace === "amazon" && tpls.length > 0) {
          setSelected(tpls.map((t) => t.id));
        }
        setFetching(false);
      })
      .catch(() => setFetching(false));
  }, [marketplace]);

  const categories = [...new Set(products.map((p) => p.marketplaceCategory).filter(Boolean))];

  function toggleTemplate(id: string) {
    setSelected((s) => s.includes(id) ? s.filter((x) => x !== id) : [...s, id]);
  }

  async function handleExport() {
    if (!selected.length) { toast.error("Select at least one template"); return; }
    setLoading(true);
    const res = await fetch(`/api/projects/${projectId}/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateIds: selected }),
    });
    if (!res.ok) {
      const data = await res.json();
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
    toast.success("Export downloaded!");
  }

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-semibold">Export Files</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Select templates to generate and download as a ZIP
          </p>
        </div>
        <button
          onClick={handleExport}
          disabled={loading || !selected.length}
          className="inline-flex items-center gap-2 h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition disabled:opacity-50"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
          {loading ? "Generating…" : `Export ZIP (${selected.length})`}
        </button>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="rounded-xl border p-4 bg-green-50 border-green-200">
          <p className="text-2xl font-bold text-green-700">{verifiedCount > 0 ? verifiedCount : products.length}</p>
          <p className="text-sm text-muted-foreground">
            {verifiedCount > 0 ? "Verified — included in export" : "Products in export"}
          </p>
        </div>
        <div className="rounded-xl border p-4 bg-card">
          <p className="text-2xl font-bold">{products.length}</p>
          <p className="text-sm text-muted-foreground">Total products</p>
        </div>
        <div className="rounded-xl border p-4 bg-card">
          <p className="text-2xl font-bold">{categories.length}</p>
          <p className="text-sm text-muted-foreground">Categories found</p>
        </div>
      </div>

      {/* Categories detected */}
      {categories.length > 0 && (
        <div className="mb-6">
          <h3 className="text-sm font-medium mb-2">Categories detected</h3>
          <div className="flex flex-wrap gap-2">
            {categories.map((cat) => (
              <span key={cat} className="text-xs px-2.5 py-1 rounded-full bg-primary/10 text-primary font-medium">
                {cat}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Templates */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium">Select templates</h3>
          {templates.length > 0 && (
            <button
              onClick={() => setSelected(selected.length === templates.length ? [] : templates.map((t) => t.id))}
              className="text-xs text-primary hover:underline"
            >
              {selected.length === templates.length ? "Deselect all" : "Select all"}
            </button>
          )}
        </div>

        {fetching && (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        )}

        {!fetching && templates.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-center border rounded-xl">
            <FileSpreadsheet className="w-10 h-10 text-muted-foreground mb-3" />
            <p className="text-sm font-medium mb-1">No templates yet</p>
            <p className="text-xs text-muted-foreground mb-4">
              Ask your admin to create export templates for {marketplace}.
            </p>
          </div>
        )}

        {!fetching && templates.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {templates.map((t) => {
              const isSelected = selected.includes(t.id);
              return (
                <button
                  key={t.id}
                  onClick={() => toggleTemplate(t.id)}
                  className={cn(
                    "flex items-center gap-3 p-4 rounded-xl border text-left transition-all",
                    isSelected
                      ? "border-primary bg-primary/5 ring-1 ring-primary"
                      : "border-border hover:border-primary/40 hover:bg-accent"
                  )}
                >
                  <div className={cn(
                    "w-9 h-9 rounded-lg flex items-center justify-center shrink-0",
                    isSelected ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                  )}>
                    <FileSpreadsheet className="w-4 h-4" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{t.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {t.category ?? "All categories"} · {t.fileFormat.toUpperCase()}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
