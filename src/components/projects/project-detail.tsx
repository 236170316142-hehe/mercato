"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  FileSpreadsheet, ShieldCheck, Tag, Download,
  CheckCircle2, Loader2, ChevronRight, ArrowLeft, Trash2,
} from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { ProductsTable } from "./products-table";
import { VerifyStep } from "./steps/verify-step";
import { CategorizeStep } from "./steps/categorize-step";
import { ExportStep } from "./steps/export-step";

type Product = {
  id: string;
  name: string;
  vendorSku: string | null;
  upc: string | null;
  asin: string | null;
  brand: string | null;
  price: number | null;
  imageUrl: string | null;
  verifyStatus: string | null;
  verifyFields: Record<string, unknown>[] | null;
  marketplaceCategory: string | null;
  categoryPath: string | null;
  categorizedAt: Date | null;
  verifiedAt: Date | null;
};

type Project = {
  id: string;
  name: string;
  marketplace: string;
  status: string;
};

const STEPS = [
  { key: "uploaded",     label: "Upload",      icon: FileSpreadsheet, desc: "Vendor file imported" },
  { key: "verified",     label: "Verify",       icon: ShieldCheck, desc: "Check against marketplace" },
  { key: "categorized",  label: "Categorize",   icon: Tag,         desc: "AI category assignment" },
  { key: "done",         label: "Export",       icon: Download,    desc: "Generate & download ZIP" },
];

const AMAZON_SKIP_CATEGORIZE = true;
// These marketplaces have no public API for verification — skip straight to Categorize
const SKIP_VERIFY = new Set(["temu", "bestbuy", "mathis", "sears"]);


function stepIndex(status: string) {
  if (["verifying", "verified"].includes(status)) return 1;
  if (["categorizing", "categorized"].includes(status)) return 2;
  if (["exporting", "done"].includes(status)) return 3;
  return 0;
}

const MARKETPLACE_LABELS: Record<string, string> = {
  amazon_us: "Amazon US", amazon: "Amazon", bestbuy: "Best Buy", walmart: "Walmart",
  temu: "Temu", mathis: "Mathis", sears: "Sears",
};

const MARKETPLACE_DOMAIN: Record<string, string> = {
  amazon_us: "amazon.com", amazon: "amazon.com", bestbuy: "bestbuy.com", walmart: "walmart.com",
  temu: "temu.com", mathis: "mathishome.com", sears: "sears.com",
};

function MarketplaceLogo({ marketplace, className }: { marketplace: string; className?: string }) {
  const domain = MARKETPLACE_DOMAIN[marketplace];
  if (!domain) return null;
  return (
    <img
      src={`https://www.google.com/s2/favicons?domain=${domain}&sz=64`}
      alt=""
      className={cn("shrink-0 rounded-sm", className)}
    />
  );
}

export function ProjectDetail({ project: initial, products: initialProducts }: {
  project: Project;
  products: Product[];
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const skipVerify = SKIP_VERIFY.has(initial.marketplace);
  const [project, setProject] = useState(initial);
  const [products, setProducts] = useState(initialProducts);
  const [activeStep, setActiveStep] = useState(() => {
    const idx = stepIndex(initial.status);
    // If this marketplace skips verification and we land on the verify step, advance to categorize
    if (SKIP_VERIFY.has(initial.marketplace) && idx === 1) return 2;
    return idx;
  });
  const [loading, setLoading] = useState(false);
  // Cumulative progress across the multi-pass verify loop; null when idle.
  const [verifyProgress, setVerifyProgress] = useState<{ done: number; total: number } | null>(null);

  const currentStepIndex = stepIndex(project.status);

  async function refreshProject() {
    const res = await fetch(`/api/projects/${project.id}`);
    if (res.ok) {
      const data = await res.json();
      setProject(data.project);
      setProducts(data.products);
    }
  }

  // `force` re-checks every product (explicit "Re-verify"); the default resumes,
  // processing only products that have not been verified yet.
  //
  // A single request is capped by the route's `maxDuration`, so large catalogs
  // (500+) always come back partial. Rather than making the user click Verify
  // four or five times, we drive the resume loop here: keep POSTing while the
  // server reports work remaining, reporting cumulative progress as we go.
  async function runVerify(force = false) {
    setLoading(true);
    setVerifyProgress(null);
    try {
      let totalVerified = 0;
      let totalSkipped = 0;
      // Only the first request carries `force`; the follow-up passes must resume
      // (force=1 would re-check the products we just finished, and never end).
      let useForce = force;

      // Bounds the loop so a server that stops making progress can't spin
      // forever. Each pass covers up to `maxDuration` of work, so this is far
      // more headroom than any real catalog needs.
      for (let pass = 0; pass < 25; pass++) {
        const res = await fetch(
          `/api/projects/${project.id}/verify${useForce ? "?force=1" : ""}`,
          { method: "POST" },
        );
        const data = await res.json();
        useForce = false;

        if (!res.ok) {
          if (data.code === "INSUFFICIENT_KEEPA_TOKENS") {
            toast.warning(data.error ?? "Not enough Keepa tokens available to verify");
          } else if (data.resumable && (data.verified > 0 || totalVerified > 0)) {
            toast.warning(`Verification stopped after ${totalVerified + (data.verified ?? 0)} products — results so far are saved. Run Verify again to continue.`);
          } else {
            toast.error(data.error ?? "Verification failed");
          }
          await refreshProject();
          return;
        }

        totalVerified += data.verified ?? 0;
        totalSkipped += data.skipped ?? 0;

        if (data.remaining > 0) {
          setVerifyProgress({ done: totalVerified, total: totalVerified + data.remaining });
          // A pass that verified nothing but still reports work left would loop
          // without end — surface it and keep the partial results.
          if (!data.verified) {
            toast.warning(`Verified ${totalVerified} products — ${data.remaining} still to check. Run Verify again to continue.`);
            break;
          }
          continue;
        }

        if (totalSkipped > 0) {
          toast.warning(`Verified ${totalVerified} products. ${totalSkipped} skipped (Keepa tokens ran low — previous results preserved). Re-verify when tokens refill.`);
        } else {
          toast.success(`Verified ${totalVerified} products`);
        }
        break;
      }

      await refreshProject();
      setActiveStep(1);
    } catch (e) {
      console.error("Verify error:", e);
      toast.error("Verification failed — check the server console for details.");
    } finally {
      setLoading(false);
      setVerifyProgress(null);
    }
  }

  async function runCategorize(force = false) {
    setLoading(true);
    try {
      const res = await fetch(`/api/projects/${project.id}/categorize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Categorization failed");
      } else {
        const matched = typeof data.matched === "number" ? data.matched : data.categorized;
        const unmatched = typeof data.unmatched === "number" ? data.unmatched : 0;
        if (matched === 0 && unmatched > 0) {
          toast.warning(`No category match for ${unmatched} product${unmatched === 1 ? "" : "s"}`);
        } else if (unmatched > 0) {
          toast.success(`Categorized ${matched} product${matched === 1 ? "" : "s"} (${unmatched} unmatched)`);
        } else {
          toast.success(`Categorized ${matched} product${matched === 1 ? "" : "s"}`);
        }
        await refreshProject();
        setActiveStep(2);
      }
    } catch (e) {
      console.error("Categorize error:", e);
      toast.error("Categorization failed — check the server console for details.");
    } finally {
      setLoading(false);
    }
  }

  async function handleApproveProduct(productId: string) {
    const res = await fetch(`/api/products/${productId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verifyStatus: "ok" }),
    });
    if (!res.ok) { toast.error("Failed to approve product"); return; }
    setProducts((prev) => prev.map((p) => p.id === productId ? { ...p, verifyStatus: "ok" } : p));
  }

  async function handleMarkDiscontinued(productId: string) {
    const res = await fetch(`/api/products/${productId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verifyStatus: "discontinued" }),
    });
    if (!res.ok) { toast.error("Failed to mark product as discontinued"); return; }
    setProducts((prev) => prev.map((p) => p.id === productId ? { ...p, verifyStatus: "discontinued" } : p));
  }

  async function handleDelete() {
    const ok = await confirm({
      title: `Delete "${project.name}"?`,
      description: "This will permanently delete the project and all its products. This cannot be undone.",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    const res = await fetch(`/api/projects/${project.id}`, { method: "DELETE" });
    if (!res.ok) { toast.error("Failed to delete project"); return; }
    toast.success(`"${project.name}" deleted`);
    router.push("/projects");
  }

  const verifiedCount     = products.filter((p) => p.verifyStatus === "ok").length;
  const exportCount       = products.filter((p) => p.verifyStatus === "ok" || p.verifyStatus === "warning").length;
  const warningCount      = products.filter((p) => p.verifyStatus === "warning").length;
  const mismatchCount     = products.filter((p) => p.verifyStatus === "mismatch").length;
  const notFoundCount     = products.filter((p) => p.verifyStatus === "not_found").length;
  const discontinuedCount = products.filter((p) => p.verifyStatus === "discontinued").length;
  const categorizedCount = products.filter((p) => p.marketplaceCategory).length;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b py-5 shrink-0">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 sm:gap-4 sm:px-8">
          <Link
            href="/projects"
            title="Back to projects"
            aria-label="Back to projects"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border text-muted-foreground transition hover:bg-accent hover:text-foreground"
          >
            <ArrowLeft className="w-4.5 h-4.5" />
          </Link>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="font-bold text-lg truncate">{project.name}</h1>
              <span className="flex items-center gap-1.5 text-muted-foreground text-sm shrink-0">
                <MarketplaceLogo marketplace={project.marketplace} className="w-4 h-4" />
                {MARKETPLACE_LABELS[project.marketplace]}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">{products.length} products</p>
          </div>
          <button
            onClick={handleDelete}
            title="Delete project"
            className="ml-2 w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:bg-red-50 hover:text-red-600 hover:border hover:border-red-200 transition-all"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Stepper */}
      <div className="py-4 shrink-0">
        <div className="mx-auto flex max-w-6xl items-center gap-0 overflow-x-auto px-4 sm:px-8">
          {STEPS.map((step, idx) => {
            const Icon = step.icon;
            const isSkipVerifyStep = skipVerify && idx === 1;
            const isAmazonCategorize = AMAZON_SKIP_CATEGORIZE && project.marketplace === "amazon_us" && idx === 2;
            const isSkipped = isSkipVerifyStep || isAmazonCategorize;
            // For skip-verify marketplaces, step 2 (Categorize) is reachable once the project is uploaded
            const maxStep = skipVerify ? Math.max(currentStepIndex, 2) : currentStepIndex;
            // A step the project has reached is itself complete (e.g. status "uploaded"
            // means the Upload step finished), so it stays navigable and shows as done.
            const done = !isSkipped && maxStep >= idx;
            const active = activeStep === idx;
            const current = currentStepIndex === idx;
            const isLoading = loading && current;

            return (
              <div key={step.key} className="flex items-center flex-1 last:flex-none">
                <button
                  onClick={() => !isSkipped && idx <= maxStep && setActiveStep(idx)}
                  disabled={isSkipped || idx > maxStep}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2 rounded-xl transition-all",
                    active ? "bg-primary/10" : "hover:bg-accent",
                    (isSkipped || idx > maxStep) && "opacity-40 cursor-not-allowed"
                  )}
                >
                  <div className={cn(
                    "w-8 h-8 rounded-full flex items-center justify-center shrink-0 transition-colors",
                    isSkipped ? "bg-muted text-muted-foreground" :
                    done ? "bg-primary text-primary-foreground" :
                    active ? "bg-primary text-primary-foreground" :
                    "bg-muted text-muted-foreground"
                  )}>
                    {isLoading ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : done ? (
                      <CheckCircle2 className="w-4 h-4" />
                    ) : (
                      <Icon className="w-4 h-4" />
                    )}
                  </div>
                  <div className="text-left hidden lg:block">
                    <p className={cn("text-xs font-semibold", active ? "text-primary" : done ? "text-foreground" : "text-muted-foreground")}>
                      {step.label}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {isLoading && verifyProgress && step.key === "verified"
                        ? `${verifyProgress.done} / ${verifyProgress.total} checked` :
                       isSkipVerifyStep ? "Not required" :
                       isAmazonCategorize ? "Not required for Amazon" :
                       step.desc}
                    </p>
                  </div>
                </button>
                {idx < STEPS.length - 1 && (
                  <ChevronRight className="w-4 h-4 text-muted-foreground mx-1 shrink-0" />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Step content */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl">
        {activeStep === 0 && (
          <ProductsTable
            products={products}
            onNext={() => setActiveStep(skipVerify ? 2 : 1)}
            onRunVerify={runVerify}
            loading={loading}
            projectStatus={project.status}
            skipVerify={skipVerify}
          />
        )}
        {activeStep === 1 && (
          <VerifyStep
            projectId={project.id}
            projectName={project.name}
            products={products}
            verifiedCount={verifiedCount}
            warningCount={warningCount}
            mismatchCount={mismatchCount}
            notFoundCount={notFoundCount}
            discontinuedCount={discontinuedCount}
            loading={loading}
            projectStatus={project.status}
            onRunVerify={runVerify}
            onApproveProduct={handleApproveProduct}
            onMarkDiscontinued={handleMarkDiscontinued}
            marketplace={project.marketplace}
            onNext={() => setActiveStep(project.marketplace === "amazon_us" ? 3 : 2)}
          />
        )}
        {activeStep === 2 && (
          <CategorizeStep
            projectId={project.id}
            projectName={project.name}
            products={products}
            categorizedCount={categorizedCount}
            loading={loading}
            projectStatus={project.status}
            marketplace={project.marketplace}
            onRunCategorize={runCategorize}
            onNext={() => setActiveStep(3)}
          />
        )}
        {activeStep === 3 && (
          <ExportStep
            projectId={project.id}
            projectName={project.name}
            marketplace={project.marketplace}
            products={products}
            verifiedCount={exportCount}
            projectStatus={project.status}
          />
        )}
        </div>
      </div>
    </div>
  );
}
