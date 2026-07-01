"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, FolderOpen, Package, Clock, CheckCircle2, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type Project = {
  id: string;
  name: string;
  marketplace: string;
  marketplaceLabel: string;
  status: string;
  productCount: number;
  createdAt: string;
  updatedAt: string;
};

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: React.ElementType }> = {
  uploaded:    { label: "Uploaded",    color: "bg-blue-100 text-blue-700",    icon: Clock },
  verifying:   { label: "Verifying",   color: "bg-yellow-100 text-yellow-700", icon: Loader2 },
  verified:    { label: "Verified",    color: "bg-green-100 text-green-700",   icon: CheckCircle2 },
  categorizing:{ label: "Categorizing",color: "bg-purple-100 text-purple-700", icon: Loader2 },
  categorized: { label: "Categorized", color: "bg-purple-100 text-purple-700", icon: CheckCircle2 },
  exporting:   { label: "Exporting",   color: "bg-orange-100 text-orange-700", icon: Loader2 },
  done:        { label: "Done",        color: "bg-emerald-100 text-emerald-700",icon: CheckCircle2 },
};

const MARKETPLACE_EMOJI: Record<string, string> = {
  amazon: "🟠", bestbuy: "🔵", walmart: "🔷", temu: "🟣", mathis: "🟤", sears: "⚫",
};

const PROGRESS: Record<string, number> = {
  uploaded: 14, verifying: 28, verified: 42,
  categorizing: 57, categorized: 71, exporting: 85, done: 100,
};

export function ProjectsView({ projects: initial }: { projects: Project[] }) {
  const router = useRouter();
  const [projects, setProjects] = useState(initial);
  const [deleting, setDeleting] = useState<string | null>(null);

  async function handleDelete(e: React.MouseEvent, id: string, name: string) {
    e.preventDefault();
    e.stopPropagation();
    if (!window.confirm(`Delete "${name}" and all its products? This cannot be undone.`)) return;
    setDeleting(id);
    try {
      const res = await fetch(`/api/projects/${id}`, { method: "DELETE" });
      if (!res.ok) { toast.error("Failed to delete project"); return; }
      setProjects((prev) => prev.filter((p) => p.id !== id));
      toast.success(`"${name}" deleted`);
      router.refresh();
    } catch {
      toast.error("Failed to delete project");
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div className="p-8 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Projects</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {projects.length} {projects.length === 1 ? "project" : "projects"}
          </p>
        </div>
        <Link
          href="/projects/new"
          className="inline-flex items-center gap-2 h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition"
        >
          <Plus className="w-4 h-4" />
          New project
        </Link>
      </div>

      {/* Empty state */}
      {projects.length === 0 && (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <div className="w-14 h-14 rounded-2xl bg-muted flex items-center justify-center mb-4">
            <FolderOpen className="w-7 h-7 text-muted-foreground" />
          </div>
          <h3 className="text-base font-semibold mb-1">No projects yet</h3>
          <p className="text-sm text-muted-foreground mb-6 max-w-xs">
            Upload a vendor file to start sourcing products across any marketplace.
          </p>
          <Link
            href="/projects/new"
            className="inline-flex items-center gap-2 h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition"
          >
            <Plus className="w-4 h-4" />
            Create your first project
          </Link>
        </div>
      )}

      {/* Grid */}
      {projects.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {projects.map((p) => {
            const status = STATUS_CONFIG[p.status] ?? { label: p.status, color: "bg-muted text-muted-foreground", icon: Clock };
            const StatusIcon = status.icon;
            const isDeleting = deleting === p.id;

            return (
              <div key={p.id} className="relative group">
                <Link
                  href={`/projects/${p.id}`}
                  className="flex flex-col gap-4 p-5 rounded-2xl border bg-card hover:shadow-md transition-all hover:border-primary/30"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 pr-6">
                      <p className="font-semibold text-sm truncate group-hover:text-primary transition">
                        {p.name}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {MARKETPLACE_EMOJI[p.marketplace]} {p.marketplaceLabel}
                      </p>
                    </div>
                    <span className={cn("inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full shrink-0", status.color)}>
                      <StatusIcon className={cn("w-3 h-3", ["verifying","categorizing","exporting"].includes(p.status) && "animate-spin")} />
                      {status.label}
                    </span>
                  </div>

                  <div className="flex items-center gap-4 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Package className="w-3.5 h-3.5" />
                      {p.productCount} products
                    </span>
                    <span className="flex items-center gap-1">
                      <Clock className="w-3.5 h-3.5" />
                      {new Date(p.updatedAt).toLocaleDateString()}
                    </span>
                  </div>

                  <div className="w-full bg-muted rounded-full h-1">
                    <div
                      className="bg-primary h-1 rounded-full transition-all"
                      style={{ width: `${PROGRESS[p.status] ?? 0}%` }}
                    />
                  </div>
                </Link>

                {/* Delete button — floats over card, outside the Link */}
                <button
                  onClick={(e) => handleDelete(e, p.id, p.name)}
                  disabled={isDeleting}
                  title="Delete project"
                  className="absolute top-3 right-3 w-7 h-7 rounded-lg flex items-center justify-center opacity-0 group-hover:opacity-100 bg-background border hover:bg-red-50 hover:border-red-300 hover:text-red-600 transition-all disabled:opacity-50 z-10"
                >
                  {isDeleting
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : <Trash2 className="w-3.5 h-3.5" />
                  }
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
