"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Upload, ShieldCheck, Tag, Download,
  CheckCircle2, Loader2, ChevronRight, ArrowLeft, Trash2,
} from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";
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
  { key: "uploaded",     label: "Upload",      icon: Upload,      desc: "Vendor file imported" },
  { key: "verified",     label: "Verify",       icon: ShieldCheck, desc: "Check against marketplace" },
  { key: "categorized",  label: "Categorize",   icon: Tag,         desc: "AI category assignment" },
  { key: "done",         label: "Export",       icon: Download,    desc: "Generate & download ZIP" },
];


function stepIndex(status: string) {
  if (["verifying", "verified"].includes(status)) return 1;
  if (["categorizing", "categorized"].includes(status)) return 2;
  if (["exporting", "done"].includes(status)) return 3;
  return 0;
}

const MARKETPLACE_LABELS: Record<string, string> = {
  amazon: "Amazon", bestbuy: "Best Buy", walmart: "Walmart",
  temu: "Temu", mathis: "Mathis", sears: "Sears",
};

const MARKETPLACE_EMOJI: Record<string, string> = {
  amazon: "🟠", bestbuy: "🔵", walmart: "🔷", temu: "🟣", mathis: "🟤", sears: "⚫",
};

export function ProjectDetail({ project: initial, products: initialProducts }: {
  project: Project;
  products: Product[];
}) {
  const router = useRouter();
  const [project, setProject] = useState(initial);
  const [products, setProducts] = useState(initialProducts);
  const [activeStep, setActiveStep] = useState(() => stepIndex(initial.status));
  const [loading, setLoading] = useState(false);

  const currentStepIndex = stepIndex(project.status);

  async function refreshProject() {
    const res = await fetch(`/api/projects/${project.id}`);
    if (res.ok) {
      const data = await res.json();
      setProject(data.project);
      setProducts(data.products);
    }
  }

  async function runVerify() {
    setLoading(true);
    try {
      const res = await fetch(`/api/projects/${project.id}/verify`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Verification failed");
      } else {
        if (data.skipped > 0) {
          toast.warning(`Verified ${data.verified} products. ${data.skipped} skipped (Keepa tokens ran low — previous results preserved). Re-verify when tokens refill.`);
        } else {
          toast.success(`Verified ${data.verified} products`);
        }
        await refreshProject();
        setActiveStep(1);
      }
    } catch (e) {
      console.error("Verify error:", e);
      toast.error("Verification failed — check the server console for details.");
    } finally {
      setLoading(false);
    }
  }

  async function runCategorize() {
    setLoading(true);
    try {
      const res = await fetch(`/api/projects/${project.id}/categorize`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Categorization failed");
      } else {
        toast.success(`Categorized ${data.categorized} products`);
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
    if (!window.confirm(`Delete "${project.name}" and all its products? This cannot be undone.`)) return;
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
      <div className="border-b px-8 py-5 flex items-center gap-4 shrink-0">
        <Link href="/projects" className="text-muted-foreground hover:text-foreground transition">
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="font-bold text-lg truncate">{project.name}</h1>
            <span className="text-muted-foreground text-sm shrink-0">
              {MARKETPLACE_EMOJI[project.marketplace]} {MARKETPLACE_LABELS[project.marketplace]}
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

      {/* Stepper */}
      <div className="border-b px-8 py-4 shrink-0">
        <div className="flex items-center gap-0">
          {STEPS.map((step, idx) => {
            const Icon = step.icon;
            const done = currentStepIndex > idx;
            const active = activeStep === idx;
            const current = currentStepIndex === idx;
            const isLoading = loading && current;

            return (
              <div key={step.key} className="flex items-center flex-1 last:flex-none">
                <button
                  onClick={() => idx <= currentStepIndex && setActiveStep(idx)}
                  disabled={idx > currentStepIndex}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2 rounded-xl transition-all",
                    active ? "bg-primary/10" : "hover:bg-accent",
                    idx > currentStepIndex && "opacity-40 cursor-not-allowed"
                  )}
                >
                  <div className={cn(
                    "w-8 h-8 rounded-full flex items-center justify-center shrink-0 transition-colors",
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
                  <div className="text-left hidden sm:block">
                    <p className={cn("text-xs font-semibold", active ? "text-primary" : done ? "text-foreground" : "text-muted-foreground")}>
                      {step.label}
                    </p>
                    <p className="text-xs text-muted-foreground">{step.desc}</p>
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
        {activeStep === 0 && (
          <ProductsTable
            products={products}
            onNext={() => { setActiveStep(1); }}
            onRunVerify={runVerify}
            loading={loading}
            projectStatus={project.status}
          />
        )}
        {activeStep === 1 && (
          <VerifyStep
            projectId={project.id}
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
            onNext={() => setActiveStep(2)}
          />
        )}
        {activeStep === 2 && (
          <CategorizeStep
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
            marketplace={project.marketplace}
            products={products}
            verifiedCount={exportCount}
            projectStatus={project.status}
          />
        )}
      </div>
    </div>
  );
}
