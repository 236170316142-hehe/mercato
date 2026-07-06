"use client";

import { useState } from "react";
import {
  ShieldCheck, Loader2, ChevronDown, ChevronUp,
  CheckCircle2, AlertTriangle, XCircle, HelpCircle, Download, ThumbsUp, Ban,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

type FieldResult = {
  field: string;
  label: string;
  stored: string;
  live: string;
  match: boolean;
  severity: "ok" | "warning" | "mismatch";
};

type Product = {
  id: string;
  name: string;
  vendorSku: string | null;
  upc: string | null;
  asin: string | null;
  verifyStatus: string | null;
  verifyFields: Record<string, unknown>[] | null;
  verifiedAt: Date | null;
};

const STATUS_CONFIG = {
  ok:           { label: "Match",        color: "bg-green-100 text-green-700",   icon: CheckCircle2 },
  warning:      { label: "Warning",      color: "bg-yellow-100 text-yellow-700", icon: AlertTriangle },
  mismatch:     { label: "Mismatch",     color: "bg-red-100 text-red-700",       icon: XCircle },
  not_found:    { label: "Not found",    color: "bg-gray-100 text-gray-600",     icon: HelpCircle },
  discontinued: { label: "Discontinued", color: "bg-purple-100 text-purple-700", icon: Ban },
};

const FIELD_SEVERITY = {
  ok:      "text-green-600",
  warning: "text-yellow-600",
  mismatch: "text-red-600",
};

export function VerifyStep({ projectId, marketplace, products, verifiedCount, warningCount, mismatchCount, notFoundCount, discontinuedCount, loading, projectStatus, onRunVerify, onApproveProduct, onMarkDiscontinued, onNext }: {
  projectId: string;
  marketplace: string;
  products: Product[];
  verifiedCount: number;
  warningCount: number;
  mismatchCount: number;
  notFoundCount: number;
  discontinuedCount: number;
  loading: boolean;
  projectStatus: string;
  onRunVerify: () => void;
  onApproveProduct: (productId: string) => Promise<void>;
  onMarkDiscontinued: (productId: string) => Promise<void>;
  onNext: () => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [approving, setApproving] = useState<string | null>(null);
  const [discontinuing, setDiscontinuing] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<string | null>(null);
  const hasResults = products.some((p) => p.verifyStatus);

  const marketplaceLabel =
    marketplace === "walmart" ? "Walmart" :
    marketplace === "amazon_us" ? "Amazon US" :
    marketplace === "amazon" ? "Amazon" :
    marketplace.charAt(0).toUpperCase() + marketplace.slice(1);

  const visibleProducts = activeFilter
    ? products.filter((p) => (p.verifyStatus ?? "not_found") === activeFilter)
    : products;

  async function downloadReport() {
    setDownloading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/verify/report`);
      if (!res.ok) { toast.error("Failed to generate report"); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `verification-report.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Report downloaded");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-semibold">Marketplace Verification</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Compare catalog data against live {marketplaceLabel} listings — title, images, description &amp; dimensions
          </p>
        </div>
        <div className="flex items-center gap-3">
          {hasResults && (
            <button
              onClick={downloadReport}
              disabled={downloading}
              className="inline-flex items-center gap-2 h-9 px-4 rounded-lg border text-sm font-medium hover:bg-accent transition disabled:opacity-50"
            >
              {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              Download Report
            </button>
          )}
          {hasResults && (
            <button
              onClick={onRunVerify}
              disabled={loading}
              className="inline-flex items-center gap-2 h-9 px-4 rounded-lg border text-sm font-medium hover:bg-accent transition disabled:opacity-50"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
              Re-verify
            </button>
          )}
          <button
            onClick={hasResults ? onNext : onRunVerify}
            disabled={loading}
            className="inline-flex items-center gap-2 h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition disabled:opacity-50"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
            {loading ? "Verifying…" : hasResults ? "Continue →" : "Run verification"}
          </button>
        </div>
      </div>

      {/* Summary cards */}
      {hasResults && (
        <>
          <div className="grid grid-cols-5 gap-3 mb-3">
            {[
              { label: "Match",        status: "ok",           count: verifiedCount,    color: "border-green-200 bg-green-50",    text: "text-green-700",   ring: "ring-green-400" },
              { label: "Warning",      status: "warning",      count: warningCount,     color: "border-yellow-200 bg-yellow-50",  text: "text-yellow-700",  ring: "ring-yellow-400" },
              { label: "Mismatch",     status: "mismatch",     count: mismatchCount,    color: "border-red-200 bg-red-50",        text: "text-red-700",     ring: "ring-red-400" },
              { label: "Not Found",    status: "not_found",    count: notFoundCount,    color: "border-gray-200 bg-gray-50",      text: "text-gray-600",    ring: "ring-gray-400" },
              { label: "Discontinued", status: "discontinued", count: discontinuedCount, color: "border-purple-200 bg-purple-50", text: "text-purple-700",  ring: "ring-purple-400" },
            ].map((s) => {
              const isActive = activeFilter === s.status;
              return (
                <button
                  key={s.label}
                  onClick={() => { setActiveFilter(isActive ? null : s.status); setExpanded(null); }}
                  className={cn(
                    "rounded-xl border p-4 text-left transition-all w-full",
                    s.color,
                    isActive ? `ring-2 ${s.ring} shadow-sm` : "hover:shadow-sm hover:brightness-95",
                  )}
                >
                  <p className={cn("text-2xl font-bold", s.text)}>{s.count}</p>
                  <p className={cn("text-sm font-medium", s.text)}>{s.label}</p>
                </button>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground mb-6">
            {marketplace === "amazon_us" ? (
              <><span className="font-medium text-green-700">{verifiedCount} SKU{verifiedCount !== 1 ? "s" : ""}</span> will be included in the {marketplaceLabel} export file (Matched only). Warnings, mismatches and discontinued items are excluded.</>
            ) : (
              <><span className="font-medium text-green-700">{verifiedCount + warningCount + notFoundCount} SKU{(verifiedCount + warningCount + notFoundCount) !== 1 ? "s" : ""}</span> will be included in the export file (Match + Warning + Not Found). Mismatches and discontinued items are excluded.</>
            )}
            {activeFilter && (
              <> &nbsp;·&nbsp; Showing <span className="font-medium">{visibleProducts.length}</span> {activeFilter.replace("_", " ")} product{visibleProducts.length !== 1 ? "s" : ""}.{" "}
                <button onClick={() => setActiveFilter(null)} className="underline hover:no-underline">Clear filter</button>
              </>
            )}
          </p>
        </>
      )}

      {!hasResults && !loading && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <ShieldCheck className="w-12 h-12 text-muted-foreground mb-4" />
          <h3 className="text-base font-semibold mb-1">Ready to verify</h3>
          <p className="text-sm text-muted-foreground max-w-sm">
            We&apos;ll check each product against the live {marketplaceLabel} listing and flag any discrepancies in title, images, description and dimensions.
          </p>
        </div>
      )}

      {loading && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <Loader2 className="w-10 h-10 animate-spin text-primary mb-4" />
          <p className="text-sm font-medium">Verifying products against {marketplaceLabel}…</p>
          <p className="text-xs text-muted-foreground mt-1">This may take a few minutes</p>
        </div>
      )}

      {/* Product results */}
      {hasResults && !loading && (
        <div className="space-y-2">
          {visibleProducts.map((p) => {
            const cfg = STATUS_CONFIG[p.verifyStatus as keyof typeof STATUS_CONFIG] ?? STATUS_CONFIG.not_found;
            const Icon = cfg.icon;
            const fields = (p.verifyFields ?? []) as FieldResult[];
            const isOpen = expanded === p.id;

            return (
              <div key={p.id} className="border rounded-xl overflow-hidden">
                <button
                  className="w-full flex items-center gap-3 px-4 py-3 hover:bg-accent/50 transition text-left"
                  onClick={() => setExpanded(isOpen ? null : p.id)}
                >
                  <span className={cn("inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full shrink-0", cfg.color)}>
                    <Icon className="w-3 h-3" />
                    {cfg.label}
                  </span>
                  <span className="flex-1 text-sm font-medium truncate">{p.name}</span>
                  {p.verifyStatus === "warning" && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setApproving(p.id);
                        onApproveProduct(p.id).finally(() => setApproving(null));
                      }}
                      disabled={approving === p.id}
                      title="Approve as Match"
                      className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 hover:bg-green-200 transition shrink-0 disabled:opacity-50"
                    >
                      {approving === p.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <ThumbsUp className="w-3 h-3" />}
                      Approve
                    </button>
                  )}
                  {p.verifyStatus === "not_found" && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setDiscontinuing(p.id);
                        onMarkDiscontinued(p.id).finally(() => setDiscontinuing(null));
                      }}
                      disabled={discontinuing === p.id}
                      title="Mark as Discontinued"
                      className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 hover:bg-purple-200 transition shrink-0 disabled:opacity-50"
                    >
                      {discontinuing === p.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Ban className="w-3 h-3" />}
                      Discontinued
                    </button>
                  )}
                  {isOpen ? <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />}
                </button>

                {isOpen && (
                  <div className="border-t bg-muted/20 divide-y">
                    {/* SKU, UPC, ASIN always shown */}
                    <div className="grid grid-cols-[120px_1fr_1fr] gap-4 px-4 py-2.5 text-xs">
                      <span className="font-medium text-muted-foreground">SKU</span>
                      <p className="font-medium">{p.vendorSku ?? "—"}</p>
                      <div />
                    </div>
                    <div className="grid grid-cols-[120px_1fr_1fr] gap-4 px-4 py-2.5 text-xs">
                      <span className="font-medium text-muted-foreground">UPC</span>
                      <p className="font-medium">{p.upc ?? "—"}</p>
                      <div />
                    </div>
                    <div className="grid grid-cols-[120px_1fr_1fr] gap-4 px-4 py-2.5 text-xs">
                      <span className="font-medium text-muted-foreground">ASIN</span>
                      <div className="flex items-center gap-2">
                        <p className="font-medium font-mono">{p.asin ?? "—"}</p>
                        {p.asin && p.verifiedAt && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium">auto-detected</span>
                        )}
                      </div>
                      <div />
                    </div>
                    {/* Field comparison rows */}
                    {fields.map((f) => (
                      <div key={f.field} className="grid grid-cols-[120px_1fr_1fr] gap-4 px-4 py-2.5 text-xs">
                        <span className={cn("font-medium", FIELD_SEVERITY[f.severity])}>{f.label}</span>
                        <div>
                          <p className="text-muted-foreground mb-0.5">Catalog</p>
                          <p className="font-medium line-clamp-2">{f.stored}</p>
                        </div>
                        <div>
                          <p className="text-muted-foreground mb-0.5">{marketplaceLabel}</p>
                          <p className="font-medium line-clamp-2">{f.live}</p>
                        </div>
                      </div>
                    ))}
                    {fields.length === 0 && (
                      <div className="px-4 py-2.5 text-xs text-muted-foreground">No comparison data available for this product.</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
