"use client";

import { useRef, useState } from "react";
import { Tag, Loader2, CheckCircle2, AlertTriangle, XCircle, Download, Upload } from "lucide-react";
import { toast } from "sonner";

type Product = {
  id: string;
  name: string;
  brand: string | null;
  vendorSku: string | null;
  marketplaceCategory: string | null;
  categoryPath: string | null;
  categorizedAt: Date | null;
};

export function CategorizeStep({ projectId, products, categorizedCount, loading, projectStatus, marketplace, onRunCategorize, onNext }: {
  projectId: string;
  products: Product[];
  categorizedCount: number;
  loading: boolean;
  projectStatus: string;
  marketplace: string;
  onRunCategorize: () => void;
  onNext: () => void;
}) {
  const isMathis = marketplace === "mathis";
  const isTemu = marketplace === "temu";
  const isBestBuy = marketplace === "bestbuy";
  const isWalmart = marketplace === "walmart";
  const hasResults = products.some((p) => p.marketplaceCategory);
  const total = products.length;
  const [uploading, setUploading] = useState(false);
  const csvRef = useRef<HTMLInputElement>(null);

  const uncategorized = products.filter((p) => p.marketplaceCategory === "Uncategorized");
  const categorized = products.filter((p) => p.marketplaceCategory && p.marketplaceCategory !== "Uncategorized");
  const pending = products.filter((p) => !p.marketplaceCategory);

  async function handleCsvUpload(file: File) {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/projects/${projectId}/categorize`, { method: "PUT", body: fd });
      const data = await res.json() as { updated?: number; total?: number; error?: string };
      if (!res.ok) { toast.error(data.error ?? "Upload failed"); return; }
      toast.success(`Categories imported — ${data.updated} of ${data.total} products updated`);
      window.location.reload();
    } catch {
      toast.error("Upload failed");
    } finally {
      setUploading(false);
    }
  }

  function downloadCsv() {
    const rows = [
      ["SKU", "Product Name", "Brand", "Category", "Category Path", "Status"],
      ...products.map((p) => [
        p.vendorSku ?? p.id,
        p.name,
        p.brand ?? "",
        p.marketplaceCategory ?? "",
        p.categoryPath ?? "",
        p.marketplaceCategory === "Uncategorized" ? "No match" : p.marketplaceCategory ? "Done" : "Pending",
      ]),
    ];
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${marketplace}_categories.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-semibold">Auto-Categorization</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            {isMathis
              ? "AI matches each product to an exact Mathis path (up to 4 levels)"
              : isTemu || isBestBuy
              ? "AI matches each product to an exact path from the shared category sheet"
              : `AI assigns each product to the correct ${marketplace} category`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {isWalmart && (
            <button
              onClick={onNext}
              disabled={loading}
              className="inline-flex items-center gap-2 h-9 px-4 rounded-lg border text-sm font-medium hover:bg-accent transition disabled:opacity-50"
            >
              Skip →
            </button>
          )}
          {/* Hidden CSV upload input */}
          <input
            ref={csvRef}
            type="file"
            accept=".csv,.tsv"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleCsvUpload(f); e.target.value = ""; }}
          />
          <button
            onClick={() => csvRef.current?.click()}
            disabled={uploading || loading}
            className="inline-flex items-center gap-2 h-9 px-4 rounded-lg border text-sm font-medium hover:bg-accent transition disabled:opacity-50"
            title="Upload a corrected category CSV (SKU, Category, Category Path columns)"
          >
            {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            Import Categories
          </button>
          {hasResults && (
            <button
              onClick={downloadCsv}
              className="inline-flex items-center gap-2 h-9 px-4 rounded-lg border text-sm font-medium hover:bg-accent transition"
            >
              <Download className="w-4 h-4" />
              Download CSV
            </button>
          )}
          {hasResults && (
            <button
              onClick={onRunCategorize}
              disabled={loading}
              className="inline-flex items-center gap-2 h-9 px-4 rounded-lg border text-sm font-medium hover:bg-accent transition disabled:opacity-50"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Tag className="w-4 h-4" />}
              Re-categorize
            </button>
          )}
          <button
            onClick={hasResults ? onNext : onRunCategorize}
            disabled={loading}
            className="inline-flex items-center gap-2 h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition disabled:opacity-50"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Tag className="w-4 h-4" />}
            {loading ? "Categorizing…" : hasResults ? "Continue to Export →" : "Run Categorization"}
          </button>
        </div>
      </div>

      {/* Progress */}
      {hasResults && (
        <div className="grid grid-cols-3 gap-4 mb-6">
          <div className="rounded-xl border p-4 bg-green-50 border-green-200">
            <p className="text-2xl font-bold text-green-700">{categorized.length}</p>
            <p className="text-sm text-muted-foreground">Categorized</p>
          </div>
          <div className={`rounded-xl border p-4 ${uncategorized.length > 0 ? "bg-orange-50 border-orange-200" : ""}`}>
            <p className={`text-2xl font-bold ${uncategorized.length > 0 ? "text-orange-600" : ""}`}>{uncategorized.length}</p>
            <p className="text-sm text-muted-foreground">Uncategorized</p>
          </div>
          <div className="rounded-xl border p-4">
            <p className="text-2xl font-bold">{total}</p>
            <p className="text-sm text-muted-foreground">Total products</p>
          </div>
        </div>
      )}

      {/* Uncategorized warning banner */}
      {hasResults && uncategorized.length > 0 && (
        <div className="mb-6 rounded-xl border border-orange-200 bg-orange-50 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-orange-500 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-orange-800">
                {uncategorized.length} product{uncategorized.length !== 1 ? "s" : ""} could not be matched to a{isMathis ? " Mathis" : ""} category
              </p>
              <p className="text-xs text-orange-700 mt-1">
                {isMathis
                  ? "These products don't fit any path in the Mathis category sheet (e.g. everyday apparel, fragrances, electronics, food). They will be excluded from the ZIP export. Review them below or remove them from the vendor file."
                  : "These products couldn't be confidently assigned a category. They will be excluded from the export. Try re-categorizing or check the product names."}
              </p>
            </div>
          </div>
        </div>
      )}

      {!hasResults && !loading && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <Tag className="w-12 h-12 text-muted-foreground mb-4" />
          <h3 className="text-base font-semibold mb-1">Ready to categorize</h3>
          <p className="text-sm text-muted-foreground max-w-sm">
            {isMathis
              ? "AI will match each product to the Mathis Home taxonomy (Department > Category > Subcategory > Product Type, up to 4 levels). Products that don't fit any path will be flagged."
              : isTemu || isBestBuy
              ? "AI will send each product plus the shared category sheet to Claude and assign the most specific Category > Subcategory > Sub-Subcategory path."
              : `AI will analyze each product and assign it to the correct category in the ${marketplace} taxonomy.`}
          </p>
        </div>
      )}

      {loading && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <Loader2 className="w-10 h-10 animate-spin text-primary mb-4" />
          <p className="text-sm font-medium">Categorizing products with AI…</p>
          <p className="text-xs text-muted-foreground mt-1">This may take a minute for large batches</p>
        </div>
      )}

      {/* Results table */}
      {hasResults && !loading && (
        <div className="rounded-xl border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Product</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Category</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Path</th>
                <th className="text-center px-4 py-3 font-medium text-muted-foreground">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {products.map((p) => {
                const isUncategorized = p.marketplaceCategory === "Uncategorized";
                return (
                  <tr key={p.id} className={`transition-colors ${isUncategorized ? "bg-orange-50/60 hover:bg-orange-50" : "hover:bg-muted/30"}`}>
                    <td className="px-4 py-3">
                      <p className="font-medium line-clamp-1">{p.name}</p>
                      {p.brand && <p className="text-xs text-muted-foreground">{p.brand}</p>}
                    </td>
                    <td className="px-4 py-3 font-medium text-sm">
                      {isUncategorized ? (
                        <span className="text-orange-600">No match found</span>
                      ) : (
                        p.marketplaceCategory ?? "—"
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{isUncategorized ? "—" : (p.categoryPath ?? "—")}</td>
                    <td className="px-4 py-3 text-center">
                      {isUncategorized ? (
                        <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-orange-100 text-orange-700">
                          <XCircle className="w-3 h-3" />
                          No match
                        </span>
                      ) : p.marketplaceCategory ? (
                        <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-green-100 text-green-700">
                          <CheckCircle2 className="w-3 h-3" />
                          Done
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">pending</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
