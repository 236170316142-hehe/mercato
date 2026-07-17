"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import {
  ShoppingBag,
  FolderOpen,
  Users,
  FileText,
  LogOut,
  Settings,
  ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";

type Props = {
  user: { name?: string | null; email?: string | null; role: string };
};

const userNav = [
  { href: "/projects", label: "Projects", icon: FolderOpen },
];

const adminNav = [
  { href: "/admin/users", label: "Users", icon: Users },
  { href: "/admin/templates", label: "Templates", icon: FileText },
];

export function Sidebar({ user }: Props) {
  const path = usePathname();
  const isAdmin = user.role === "admin";

  return (
    <aside className="w-60 shrink-0 flex flex-col border-r bg-card h-full">
      {/* Logo */}
      <div className="flex items-center gap-3 px-5 py-5 border-b">
        <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-foreground">
          <ShoppingBag className="w-4 h-4 text-background" />
        </div>
        <span className="font-bold text-base tracking-tight">Mercato</span>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
        <p className="text-xs font-medium text-muted-foreground px-2 pb-2 uppercase tracking-wider">
          Workspace
        </p>
        {userNav.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className={cn(
              "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
              path.startsWith(href)
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground"
            )}
          >
            <Icon className="w-4 h-4" />
            {label}
          </Link>
        ))}

        {isAdmin && (
          <>
            <p className="text-xs font-medium text-muted-foreground px-2 pb-2 pt-4 uppercase tracking-wider">
              Admin
            </p>
            {adminNav.map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                className={cn(
                  "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
                  path.startsWith(href)
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                )}
              >
                <Icon className="w-4 h-4" />
                {label}
              </Link>
            ))}
          </>
        )}
      </nav>

      {/* User footer */}
      <div className="border-t p-3">
        <div className="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-accent transition group">
          <div className="w-7 h-7 rounded-full bg-primary flex items-center justify-center text-primary-foreground text-xs font-bold shrink-0">
            {(user.name ?? user.email ?? "U")[0].toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{user.name ?? "User"}</p>
            <p className="text-xs text-muted-foreground truncate">{user.email}</p>
          </div>
          <button
            onClick={async () => {
              await signOut({ redirect: false });
              window.location.href = "/login";
            }}
            className="opacity-0 group-hover:opacity-100 transition text-muted-foreground hover:text-destructive"
            title="Sign out"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </aside>
  );
}
