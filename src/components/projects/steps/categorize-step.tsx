"use client";

import { Tag, Loader2, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";

type Product = {
  id: string;
  name: string;
  brand: string | null;
  marketplaceCategory: string | null;
  categoryPath: string | null;
  categorizedAt: Date | null;
};

export function CategorizeStep({ products, categorizedCount, loading, projectStatus, marketplace, onRunCategorize, onNext }: {
  products: Product[];
  categorizedCount: number;
  loading: boolean;
  projectStatus: string;
  marketplace: string;
  onRunCategorize: () => void;
  onNext: () => void;
}) {
  const hasResults = products.some((p) => p.marketplaceCategory);
  const total = products.length;

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-semibold">Auto-Categorization</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            AI assigns each product to the correct marketplace category
          </p>
        </div>
        <div className="flex items-center gap-3">
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
            {loading ? "Categorizing…" : hasResults ? "Continue →" : "Run categorization"}
          </button>
        </div>
      </div>

      {/* Progress */}
      {hasResults && (
        <div className="mb-6 p-4 rounded-xl border bg-card">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium">Categorized</span>
            <span className="text-sm text-muted-foreground">{categorizedCount} / {total}</span>
          </div>
          <div className="w-full bg-muted rounded-full h-2">
            <div
              className="bg-primary h-2 rounded-full transition-all"
              style={{ width: `${total > 0 ? (categorizedCount / total) * 100 : 0}%` }}
            />
          </div>
        </div>
      )}

      {!hasResults && !loading && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <Tag className="w-12 h-12 text-muted-foreground mb-4" />
          <h3 className="text-base font-semibold mb-1">Ready to categorize</h3>
          <p className="text-sm text-muted-foreground max-w-sm">
            Our AI will analyze each product and assign it to the correct category in the{" "}
            <span className="capitalize font-medium">{marketplace}</span> taxonomy.
          </p>
        </div>
      )}

      {loading && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <Loader2 className="w-10 h-10 animate-spin text-primary mb-4" />
          <p className="text-sm font-medium">Categorizing products with AI…</p>
          <p className="text-xs text-muted-foreground mt-1">This may take a minute</p>
        </div>
      )}

      {/* Results */}
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
              {products.map((p) => (
                <tr key={p.id} className="hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-3">
                    <p className="font-medium line-clamp-1">{p.name}</p>
                    {p.brand && <p className="text-xs text-muted-foreground">{p.brand}</p>}
                  </td>
                  <td className="px-4 py-3 font-medium text-sm">{p.marketplaceCategory ?? "—"}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{p.categoryPath ?? "—"}</td>
                  <td className="px-4 py-3 text-center">
                    {p.marketplaceCategory ? (
                      <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-green-100 text-green-700">
                        <CheckCircle2 className="w-3 h-3" />
                        Done
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">pending</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
