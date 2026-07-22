import { requireUser } from "@/lib/auth-helpers";
import { SidebarProvider, SidebarInset } from "@/components/layout/sidebar-context";
import { Sidebar } from "@/components/layout/sidebar";
import { AppNavbar } from "@/components/layout/app-navbar";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const role = (user as { role?: string }).role ?? "user";

  return (
    <SidebarProvider>
      <div className="flex min-h-screen">
        <Sidebar role={role} />
        <SidebarInset>
          <AppNavbar
            user={{
              id: user.id,
              name: user.name,
              email: user.email,
              role,
            }}
          />
          <main className="flex-1">{children}</main>
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}
