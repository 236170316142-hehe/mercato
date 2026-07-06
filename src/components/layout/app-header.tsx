"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import {
  FolderOpen, Users, FileText, LogOut, ShoppingBag, ChevronDown,
} from "lucide-react";
import { cn } from "@/lib/utils";

type User = { id: string; name?: string | null; email?: string | null; role: string };

export function AppHeader({ user }: { user: User }) {
  const pathname = usePathname();
  const isAdmin = user.role === "admin";

  const isActive = (href: string) =>
    href === "/projects" ? pathname === "/projects" || pathname.startsWith("/projects") : pathname.startsWith(href);

  const userNav = [
    { href: "/projects", label: "Projects", icon: FolderOpen },
    { href: "/templates", label: "Templates", icon: FileText },
  ];

  const adminNav = [
    { href: "/admin/users", label: "Users", icon: Users },
    { href: "/admin/templates", label: "Templates", icon: FileText },
  ];

  const navItems = isAdmin ? adminNav : userNav;

  return (
    <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/65">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4">
        {/* Logo */}
        <Link href="/projects" className="flex items-center gap-2 shrink-0">
          <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-foreground">
            <ShoppingBag className="w-3.5 h-3.5 text-background" />
          </div>
          <span className="font-bold text-base tracking-tight">Mercato</span>
        </Link>

        {/* Nav */}
        <nav className="flex items-center gap-0.5 ml-2">
          {navItems.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={cn(
                "inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-sm font-medium transition-colors",
                isActive(href)
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent"
              )}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </Link>
          ))}
        </nav>

        {/* User */}
        <div className="ml-auto flex items-center">
          <div className="group relative">
            <button className="flex items-center gap-2 h-8 px-3 rounded-lg hover:bg-accent transition text-sm">
              <div className="w-6 h-6 rounded-full bg-primary flex items-center justify-center text-primary-foreground text-xs font-bold">
                {(user.name ?? user.email ?? "U")[0].toUpperCase()}
              </div>
              <span className="hidden sm:block font-medium max-w-[120px] truncate">
                {user.name ?? user.email}
              </span>
              <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
            </button>

            {/* Dropdown */}
            <div className="absolute right-0 top-full mt-1 w-48 rounded-xl border bg-card shadow-lg opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-50">
              <div className="px-3 py-2.5 border-b">
                <p className="text-sm font-medium truncate">{user.name ?? "User"}</p>
                <p className="text-xs text-muted-foreground truncate">{user.email}</p>
                <span className="text-xs font-medium px-1.5 py-0.5 rounded-full bg-primary/10 text-primary mt-1 inline-block capitalize">
                  {user.role}
                </span>
              </div>
              <div className="p-1">
                <button
                  onClick={() => signOut({ callbackUrl: "/login" })}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm text-destructive hover:bg-destructive/10 transition"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  Sign out
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
