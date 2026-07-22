"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  FolderOpen,
  Users,
  FileText,
  ChevronsLeft,
  ChevronsRight,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useSidebar } from "./sidebar-context";

type Props = {
  role: string;
};

const userNav = [
  { href: "/projects", label: "Projects", icon: FolderOpen },
  { href: "/templates", label: "Templates", icon: FileText },
];

const adminNav = [
  { href: "/projects", label: "Projects", icon: FolderOpen },
  { href: "/admin/users", label: "Users", icon: Users },
  { href: "/admin/templates", label: "Templates", icon: FileText },
];

export function Sidebar({ role }: Props) {
  const path = usePathname();
  const isAdmin = role === "admin";
  const navItems = isAdmin ? adminNav : userNav;
  const { collapsed, toggleCollapsed, mobileOpen, closeMobile } = useSidebar();

  return (
    <>
      {/* Mobile backdrop */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 md:hidden"
          onClick={closeMobile}
          aria-hidden="true"
        />
      )}

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r bg-card transition-[transform,width] duration-200 md:translate-x-0",
          collapsed ? "md:w-16" : "md:w-60",
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        {/* Brand + collapse toggle */}
        <div
          className={cn(
            "flex h-14 shrink-0 items-center gap-3 border-b px-4",
            collapsed && "md:justify-center md:gap-2 md:px-2"
          )}
        >
          <span
            className={cn(
              "truncate text-xl font-semibold tracking-wide [font-family:var(--font-brand)]",
              collapsed && "md:hidden"
            )}
          >
            Mercato
          </span>
          {collapsed && (
            <span className="hidden text-xl font-semibold tracking-wide [font-family:var(--font-brand)] md:block">
              M
            </span>
          )}

          <button
            onClick={closeMobile}
            className="ml-auto rounded p-1 hover:bg-accent md:hidden"
            aria-label="Close sidebar"
          >
            <X className="h-4 w-4" />
          </button>

          <button
            onClick={toggleCollapsed}
            className={cn(
              "hidden items-center justify-center rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground md:flex",
              !collapsed && "ml-auto"
            )}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? (
              <ChevronsRight className="h-4 w-4" />
            ) : (
              <ChevronsLeft className="h-4 w-4" />
            )}
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 space-y-0.5 overflow-y-auto overflow-x-hidden px-3 py-4">
          {navItems.map(({ href, label, icon: Icon }) => {
            const active = path.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                onClick={closeMobile}
                title={collapsed ? label : undefined}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                  collapsed && "md:justify-center md:px-0",
                  active
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className={cn(collapsed && "md:hidden")}>{label}</span>
              </Link>
            );
          })}
        </nav>
      </aside>
    </>
  );
}
