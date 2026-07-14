"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Plus, FolderOpen, Package, Clock, CheckCircle2, Loader2, Trash2,
  Search, ChevronLeft, ChevronRight, X, ChevronDown, Check, Square, CheckSquare,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useConfirm } from "@/components/ui/confirm-dialog";

const PAGE_SIZE = 12;

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

type FilterOption = {
  value: string;
  label: string;
  logoDomain?: string;
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

const STATUS_OPTIONS: FilterOption[] = Object.entries(STATUS_CONFIG).map(([value, { label }]) => ({ value, label }));

const MARKETPLACE_DOMAIN: Record<string, string> = {
  amazon: "amazon.com",
  amazon_us: "amazon.com",
  bestbuy: "bestbuy.com",
  walmart: "walmart.com",
  temu: "temu.com",
  mathis: "mathishome.com",
  sears: "sears.com",
};

const MARKETPLACE_LABELS: Record<string, string> = {
  amazon: "Amazon",
  amazon_us: "Amazon US",
  bestbuy: "Best Buy",
  walmart: "Walmart",
  temu: "Temu",
  mathis: "Mathis",
  sears: "Sears",
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

const PROGRESS: Record<string, number> = {
  uploaded: 14, verifying: 28, verified: 42,
  categorizing: 57, categorized: 71, exporting: 85, done: 100,
};

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const fieldClass =
  "h-9 rounded-lg border border-border bg-background px-3 text-sm text-foreground shadow-sm transition " +
  "hover:border-foreground/20 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40";

/** Local calendar day as YYYY-MM-DD for date-input comparison */
function toDayKey(iso: string) {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatDisplayDate(value: string) {
  if (!value) return "";
  const [y, m, d] = value.split("-");
  if (!y || !m || !d) return value;
  return `${d}/${m}/${y}`;
}

function parseDayKey(value: string) {
  if (!value) return null;
  const [y, m, d] = value.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function useDismissible(open: boolean, onClose: () => void, rootRef: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, rootRef]);
}

function FilterSelect({
  value,
  onChange,
  options,
  placeholder,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  options: FilterOption[];
  placeholder: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);
  useDismissible(open, () => setOpen(false), rootRef);

  return (
    <div ref={rootRef} className={cn("relative min-w-0", className)}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          fieldClass,
          "w-full inline-flex items-center gap-2 text-left",
          open && "ring-2 ring-primary/20 border-primary/40",
          !selected && "text-muted-foreground"
        )}
      >
        {selected?.logoDomain && <MarketplaceLogo marketplace={selected.value} className="w-4 h-4" />}
        <span className="flex-1 truncate">{selected?.label ?? placeholder}</span>
        <ChevronDown className={cn("w-3.5 h-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <ul
          role="listbox"
          className="absolute z-30 mt-1.5 w-full min-w-44 overflow-hidden rounded-xl border border-border bg-card py-1 shadow-lg"
        >
          <li>
            <button
              type="button"
              role="option"
              aria-selected={!value}
              onClick={() => { onChange(""); setOpen(false); }}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-2 text-sm text-left transition-colors hover:bg-muted",
                !value && "bg-muted font-medium"
              )}
            >
              <span className="w-4 shrink-0 flex justify-center">
                {!value && <Check className="w-3.5 h-3.5" />}
              </span>
              <span className="truncate">{placeholder}</span>
            </button>
          </li>
          {options.map((o) => {
            const active = o.value === value;
            return (
              <li key={o.value}>
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => { onChange(o.value); setOpen(false); }}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-2 text-sm text-left transition-colors hover:bg-muted",
                    active && "bg-muted font-medium"
                  )}
                >
                  <span className="w-4 shrink-0 flex justify-center">
                    {active && <Check className="w-3.5 h-3.5" />}
                  </span>
                  {o.logoDomain && <MarketplaceLogo marketplace={o.value} className="w-4 h-4" />}
                  <span className="truncate">{o.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function FilterDate({
  value,
  onChange,
  min,
  max,
  placeholder = "DD/MM/YYYY",
  ariaLabel,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  min?: string;
  max?: string;
  placeholder?: string;
  ariaLabel: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = parseDayKey(value);
  const minDate = parseDayKey(min ?? "");
  const maxDate = parseDayKey(max ?? "");
  const initialMonth = selected ?? new Date();
  const [viewYear, setViewYear] = useState(initialMonth.getFullYear());
  const [viewMonth, setViewMonth] = useState(initialMonth.getMonth());

  useDismissible(open, () => setOpen(false), rootRef);

  useEffect(() => {
    if (!open) return;
    const base = parseDayKey(value) ?? new Date();
    setViewYear(base.getFullYear());
    setViewMonth(base.getMonth());
  }, [open, value]);

  const today = new Date();
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const startWeekday = new Date(viewYear, viewMonth, 1).getDay();

  const cells: Array<Date | null> = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) cells.push(new Date(viewYear, viewMonth, day));

  function isDisabled(date: Date) {
    if (minDate) {
      const minStart = new Date(minDate.getFullYear(), minDate.getMonth(), minDate.getDate());
      if (date < minStart) return true;
    }
    if (maxDate) {
      const maxStart = new Date(maxDate.getFullYear(), maxDate.getMonth(), maxDate.getDate());
      if (date > maxStart) return true;
    }
    return false;
  }

  function pickLocal(date: Date) {
    if (isDisabled(date)) return;
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    onChange(`${y}-${m}-${d}`);
    setOpen(false);
  }

  function shiftMonth(delta: number) {
    const next = new Date(viewYear, viewMonth + delta, 1);
    setViewYear(next.getFullYear());
    setViewMonth(next.getMonth());
  }

  return (
    <div ref={rootRef} className={cn("relative min-w-0", className)}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          fieldClass,
          "w-full inline-flex items-center gap-2 text-left",
          open && "ring-2 ring-primary/20 border-primary/40",
          !value && "text-muted-foreground"
        )}
      >
        <CalendarDays className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate tabular-nums">
          {value ? formatDisplayDate(value) : placeholder}
        </span>
        {value ? (
          <span
            role="button"
            tabIndex={-1}
            aria-label={`Clear ${ariaLabel}`}
            onClick={(e) => {
              e.stopPropagation();
              onChange("");
            }}
            className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="w-3 h-3" />
          </span>
        ) : (
          <ChevronDown className={cn("w-3.5 h-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={ariaLabel}
          className="absolute z-30 mt-1.5 w-72 rounded-xl border border-border bg-card p-3 shadow-lg"
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => shiftMonth(-1)}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-muted hover:text-foreground transition"
              aria-label="Previous month"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <p className="text-sm font-semibold tracking-tight">
              {MONTHS[viewMonth]} {viewYear}
            </p>
            <button
              type="button"
              onClick={() => shiftMonth(1)}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-muted hover:text-foreground transition"
              aria-label="Next month"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          <div className="mb-1 grid grid-cols-7 gap-1">
            {WEEKDAYS.map((d) => (
              <div key={d} className="h-8 text-center text-[11px] font-medium text-muted-foreground leading-8">
                {d}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-1">
            {cells.map((date, idx) => {
              if (!date) return <div key={`e-${idx}`} className="h-8" />;
              const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
              const disabled = isDisabled(date);
              const isSelected = selected ? sameDay(date, selected) : false;
              const isToday = sameDay(date, today);
              return (
                <button
                  key={key}
                  type="button"
                  disabled={disabled}
                  onClick={() => pickLocal(date)}
                  className={cn(
                    "h-8 rounded-lg text-sm tabular-nums transition",
                    disabled && "cursor-not-allowed text-muted-foreground/40",
                    !disabled && !isSelected && "hover:bg-muted text-foreground",
                    isToday && !isSelected && "ring-1 ring-border font-medium",
                    isSelected && "bg-primary text-primary-foreground font-medium hover:bg-primary"
                  )}
                >
                  {date.getDate()}
                </button>
              );
            })}
          </div>

          <div className="mt-3 flex items-center justify-between border-t border-border pt-2">
            <button
              type="button"
              onClick={() => { onChange(""); setOpen(false); }}
              className="text-xs font-medium text-muted-foreground hover:text-foreground transition"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={() => pickLocal(new Date())}
              disabled={isDisabled(new Date())}
              className="text-xs font-medium text-foreground hover:underline disabled:opacity-40 disabled:no-underline"
            >
              Today
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function ProjectsView({ projects: initial }: { projects: Project[] }) {
  const router = useRouter();
  const confirm = useConfirm();
  const [projects, setProjects] = useState(initial);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [marketplaceFilter, setMarketplaceFilter] = useState("");
  const [page, setPage] = useState(1);

  const marketplaceOptions = useMemo(() => {
    return Object.entries(MARKETPLACE_LABELS)
      .map(([value, label]) => ({
        value,
        label,
        logoDomain: MARKETPLACE_DOMAIN[value],
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, []);

  const hasActiveFilters = !!(search || statusFilter || marketplaceFilter);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return projects.filter((p) => {
      if (q) {
        const matchesSearch =
          p.name.toLowerCase().includes(q) ||
          p.marketplaceLabel.toLowerCase().includes(q) ||
          p.status.toLowerCase().includes(q);
        if (!matchesSearch) return false;
      }
      if (statusFilter && p.status !== statusFilter) return false;
      if (marketplaceFilter && p.marketplace !== marketplaceFilter) return false;
      return true;
    });
  }, [projects, search, statusFilter, marketplaceFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const paginated = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  function resetPage() {
    setPage(1);
  }

  function getPageNumbers(current: number, total: number): (number | "ellipsis")[] {
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
    const pages = new Set<number>([1, 2, total - 1, total, current - 1, current, current + 1]);
    const sorted = [...pages].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);
    const result: (number | "ellipsis")[] = [];
    let prev = 0;
    for (const n of sorted) {
      if (prev && n - prev > 1) result.push("ellipsis");
      result.push(n);
      prev = n;
    }
    return result;
  }

  function clearFilters() {
    setSearch("");
    setStatusFilter("");
    setMarketplaceFilter("");
    setPage(1);
  }

  function toggleSelect(e: React.MouseEvent, id: string) {
    e.preventDefault();
    e.stopPropagation();
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    if (selected.size === paginated.length && paginated.every((p) => selected.has(p.id))) {
      setSelected(new Set());
    } else {
      setSelected(new Set(paginated.map((p) => p.id)));
    }
  }

  async function handleDelete(e: React.MouseEvent, id: string, name: string) {
    e.preventDefault();
    e.stopPropagation();
    const ok = await confirm({
      title: `Delete "${name}"?`,
      description: "This will permanently delete the project and all its products. This cannot be undone.",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    setDeleting(id);
    try {
      const res = await fetch(`/api/projects/${id}`, { method: "DELETE" });
      if (!res.ok) { toast.error("Failed to delete project"); return; }
      setProjects((prev) => prev.filter((p) => p.id !== id));
      setSelected((prev) => { const next = new Set(prev); next.delete(id); return next; });
      toast.success(`"${name}" deleted`);
      router.refresh();
    } catch {
      toast.error("Failed to delete project");
    } finally {
      setDeleting(null);
    }
  }

  async function handleBulkDelete() {
    const ids = [...selected];
    const count = ids.length;
    const ok = await confirm({
      title: `Delete ${count} project${count === 1 ? "" : "s"}?`,
      description: `This will permanently delete ${count === 1 ? "this project" : `all ${count} selected projects`} and their products. This cannot be undone.`,
      confirmLabel: `Delete ${count}`,
    });
    if (!ok) return;
    setBulkDeleting(true);
    try {
      const res = await fetch("/api/projects", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) { toast.error("Failed to delete projects"); return; }
      setProjects((prev) => prev.filter((p) => !ids.includes(p.id)));
      setSelected(new Set());
      toast.success(`${count} project${count === 1 ? "" : "s"} deleted`);
      router.refresh();
    } catch {
      toast.error("Failed to delete projects");
    } finally {
      setBulkDeleting(false);
    }
  }

  const allPageSelected = paginated.length > 0 && paginated.every((p) => selected.has(p.id));

  return (
    <div className="p-8 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Projects</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {filtered.length} {filtered.length === 1 ? "project" : "projects"}
            {hasActiveFilters && ` (of ${projects.length})`}
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

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="mb-4 flex items-center gap-3 px-4 py-2.5 rounded-xl border border-border bg-muted/60 backdrop-blur-sm">
          <button
            type="button"
            onClick={toggleSelectAll}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground hover:text-primary transition"
          >
            {allPageSelected
              ? <CheckSquare className="w-4 h-4 text-primary" />
              : <Square className="w-4 h-4" />}
            {allPageSelected ? "Deselect all" : "Select all on page"}
          </button>
          <span className="text-sm text-muted-foreground">
            {selected.size} selected
          </span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="inline-flex items-center gap-1 h-8 px-3 rounded-lg border text-sm text-muted-foreground hover:bg-background transition"
          >
            <X className="w-3.5 h-3.5" />
            Clear
          </button>
          <button
            type="button"
            onClick={handleBulkDelete}
            disabled={bulkDeleting}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 transition disabled:opacity-50"
          >
            {bulkDeleting
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <Trash2 className="w-3.5 h-3.5" />}
            Delete {selected.size}
          </button>
        </div>
      )}


      {/* Search + filters — single row */}
      {projects.length > 0 && (
        <div className="mb-6 flex flex-wrap items-center gap-2">
          <div className="relative min-w-48 flex-1 basis-48 max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => { setSearch(e.target.value); resetPage(); }}
              placeholder="Search projects..."
              className={cn(fieldClass, "w-full pl-9 pr-3")}
            />
          </div>

          <FilterSelect
            value={statusFilter}
            onChange={(v) => { setStatusFilter(v); resetPage(); }}
            options={STATUS_OPTIONS}
            placeholder="All statuses"
            className="w-42"
          />

          <FilterSelect
            value={marketplaceFilter}
            onChange={(v) => { setMarketplaceFilter(v); resetPage(); }}
            options={marketplaceOptions}
            placeholder="All marketplaces"
            className="w-46"
          />

          <button
            type="button"
            onClick={clearFilters}
            disabled={!hasActiveFilters}
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-border text-sm text-muted-foreground shadow-sm transition enabled:hover:bg-muted enabled:hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <X className="w-3.5 h-3.5" />
            Clear
          </button>
        </div>
      )}

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

      {/* No filter results */}
      {projects.length > 0 && filtered.length === 0 && (
        <div className="flex flex-col items-center justify-center py-24 text-center gap-3">
          <p className="text-sm text-muted-foreground">
            No projects match the current filters
            {search ? ` for “${search}”` : ""}
          </p>
          <button
            type="button"
            onClick={clearFilters}
            className="text-sm font-medium text-primary hover:underline"
          >
            Clear filters
          </button>
        </div>
      )}

      {/* Grid */}
      {paginated.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {paginated.map((p) => {
            const status = STATUS_CONFIG[p.status] ?? { label: p.status, color: "bg-muted text-muted-foreground", icon: Clock };
            const StatusIcon = status.icon;
            const isDeleting = deleting === p.id;
            const isSelected = selected.has(p.id);

            return (
              <div key={p.id} className={cn("relative group", isSelected && "ring-2 ring-primary rounded-2xl")}>
                <Link
                  href={`/projects/${p.id}`}
                  className={cn(
                    "flex flex-col gap-4 p-5 rounded-2xl border bg-card hover:shadow-md transition-all hover:border-primary/30",
                    isSelected && "border-primary/30"
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    {/* Checkbox */}
                    <button
                      type="button"
                      onClick={(e) => toggleSelect(e, p.id)}
                      title={isSelected ? "Deselect" : "Select"}
                      className={cn(
                        "mt-0.5 shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-all",
                        isSelected
                          ? "bg-primary border-primary text-primary-foreground"
                          : "border-border bg-background hover:border-primary"
                      )}
                    >
                      {isSelected && <Check className="w-2.5 h-2.5" />}
                    </button>

                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-sm truncate group-hover:text-primary transition">
                        {p.name}
                      </p>
                      <p className="flex items-center gap-1.5 text-xs text-muted-foreground mt-0.5">
                        <MarketplaceLogo marketplace={p.marketplace} className="w-3.5 h-3.5" />
                        {MARKETPLACE_LABELS[p.marketplace] ?? p.marketplaceLabel}
                      </p>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className={cn("inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full", status.color)}>
                        <StatusIcon className={cn("w-3 h-3", ["verifying","categorizing","exporting"].includes(p.status) && "animate-spin")} />
                        {status.label}
                      </span>
                      {/* Delete button — always visible */}
                      <button
                        onClick={(e) => handleDelete(e, p.id, p.name)}
                        disabled={isDeleting}
                        title="Delete project"
                        className="w-7 h-7 rounded-lg flex items-center justify-center text-muted-foreground hover:bg-red-50 hover:text-red-600 transition-all disabled:opacity-50"
                      >
                        {isDeleting
                          ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          : <Trash2 className="w-3.5 h-3.5" />
                        }
                      </button>
                    </div>
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
              </div>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {filtered.length > PAGE_SIZE && (
        <div className="flex items-center justify-between mt-8">
          <p className="text-xs text-muted-foreground">
            Page {currentPage} of {totalPages}
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              className="inline-flex items-center gap-1 h-8 px-3 rounded-lg border text-sm font-medium hover:bg-muted transition disabled:opacity-40 disabled:pointer-events-none"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              Prev
            </button>

            {getPageNumbers(currentPage, totalPages).map((n, i) =>
              n === "ellipsis" ? (
                <span key={`e-${i}`} className="px-1 text-sm text-muted-foreground">
                  …
                </span>
              ) : (
                <button
                  key={n}
                  onClick={() => setPage(n)}
                  aria-current={n === currentPage ? "page" : undefined}
                  className={cn(
                    "inline-flex items-center justify-center h-8 min-w-8 px-2 rounded-lg border text-sm font-medium transition",
                    n === currentPage
                      ? "bg-primary text-primary-foreground border-primary"
                      : "hover:bg-muted"
                  )}
                >
                  {n}
                </button>
              )
            )}

            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
              className="inline-flex items-center gap-1 h-8 px-3 rounded-lg border text-sm font-medium hover:bg-muted transition disabled:opacity-40 disabled:pointer-events-none"
            >
              Next
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
