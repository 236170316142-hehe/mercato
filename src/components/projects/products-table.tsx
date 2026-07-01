"use client";

import { useState } from "react";
import { Search, ShieldCheck, Loader2, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

type Product = {
  id: string;
  name: string;
  vendorSku: string | null;
  upc: string | null;
  asin: string | null;
  brand: string | null;
  verifyStatus: string | null;
};

const STATUS_BADGE: Record<string, string> = {
  ok: "bg-green-100 text-green-700",
  warning: "bg-yellow-100 text-yellow-700",
  mismatch: "bg-red-100 text-red-700",
  not_found: "bg-gray-100 text-gray-600",
  discontinued: "bg-purple-100 text-purple-700",
};

export function ProductsTable({ products, onNext, onRunVerify, loading, projectStatus }: {
  products: Product[];
  onNext: () => void;
  onRunVerify: () => void;
  loading: boolean;
  projectStatus: string;
}) {
  const [search, setSearch] = useState("");

  const filtered = products.filter((p) => {
    const q = search.toLowerCase();
    return (
      p.name.toLowerCase().includes(q) ||
      (p.vendorSku ?? "").toLowerCase().includes(q) ||
      (p.upc ?? "").toLowerCase().includes(q) ||
      (p.brand ?? "").toLowerCase().includes(q)
    );
  });

  const hasVerified = products.some((p) => p.verifyStatus);

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-semibold">Imported Products</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            {products.length} products from your vendor file
          </p>
        </div>
        <button
          onClick={hasVerified ? onNext : onRunVerify}
          disabled={loading}
          className="inline-flex items-center gap-2 h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition disabled:opacity-50"
        >
          {loading ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <ShieldCheck className="w-4 h-4" />
          )}
          {loading ? "Verifying…" : hasVerified ? "View verification →" : "Run verification"}
        </button>
      </div>

      {/* Search */}
      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search products…"
          className="w-full h-9 pl-9 pr-4 rounded-lg border bg-background text-sm outline-none focus:ring-2 focus:ring-ring transition"
        />
      </div>

      {/* Table */}
      <div className="rounded-xl border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">Product</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">SKU</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">UPC</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">Brand</th>
              <th className="text-center px-4 py-3 font-medium text-muted-foreground">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filtered.map((p) => (
              <tr key={p.id} className="hover:bg-muted/30 transition-colors">
                <td className="px-4 py-3">
                  <p className="font-medium line-clamp-1">{p.name}</p>
                  {p.asin && <p className="text-xs text-muted-foreground">ASIN: {p.asin}</p>}
                </td>
                <td className="px-4 py-3 text-muted-foreground">{p.vendorSku ?? "—"}</td>
                <td className="px-4 py-3 text-muted-foreground font-mono text-xs">{p.upc ?? "—"}</td>
                <td className="px-4 py-3 text-muted-foreground">{p.brand ?? "—"}</td>
                <td className="px-4 py-3 text-center">
                  {p.verifyStatus ? (
                    <span className={cn("text-xs font-medium px-2 py-0.5 rounded-full", STATUS_BADGE[p.verifyStatus] ?? "bg-muted text-muted-foreground")}>
                      {p.verifyStatus}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">pending</span>
                  )}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-muted-foreground text-sm">
                  No products match your search.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
