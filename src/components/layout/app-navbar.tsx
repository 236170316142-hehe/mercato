"use client";

import { useState, useRef, useEffect } from "react";
import { signOut } from "next-auth/react";
import { LogOut, ChevronDown, Menu } from "lucide-react";
import { useSidebar } from "./sidebar-context";
import { ThemeToggle } from "@/components/theme-toggle";

type User = { id: string; name?: string | null; email?: string | null; role: string };

export function AppNavbar({ user }: { user: User }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const { toggleMobile } = useSidebar();

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    if (menuOpen) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [menuOpen]);

  return (
    <header className="sticky top-0 z-30 bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/65">
      <div className="flex h-14 items-center gap-3 border-b px-4">
        <button
          onClick={toggleMobile}
          className="rounded-lg p-1.5 hover:bg-accent md:hidden"
          aria-label="Open sidebar"
        >
          <Menu className="h-5 w-5" />
        </button>

        <div className="ml-auto flex items-center gap-1">
          <ThemeToggle />
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setMenuOpen((o) => !o)}
              className="flex h-8 items-center gap-2 rounded-lg px-3 text-sm transition hover:bg-accent"
            >
              <div className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
                {(user.name ?? user.email ?? "U")[0].toUpperCase()}
              </div>
              <span className="hidden max-w-[120px] truncate font-medium sm:block">
                {user.name ?? user.email}
              </span>
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            </button>

            {menuOpen && (
              <div className="absolute right-0 top-full z-50 mt-1 w-48 rounded-xl border bg-card shadow-lg">
                <div className="border-b px-3 py-2.5">
                  <p className="truncate text-sm font-medium">{user.name ?? "User"}</p>
                  <p className="truncate text-xs text-muted-foreground">{user.email}</p>
                  <span className="mt-1 inline-block rounded-full bg-primary/10 px-1.5 py-0.5 text-xs font-medium capitalize text-primary">
                    {user.role}
                  </span>
                </div>
                <div className="p-1">
                  <button
                    onClick={async () => {
                      setMenuOpen(false);
                      sessionStorage.setItem("mercato:logout-toast", "1");
                      await signOut({ redirect: false });
                      window.location.href = "/login";
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-destructive transition hover:bg-destructive/10"
                  >
                    <LogOut className="h-3.5 w-3.5" />
                    Sign out
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
