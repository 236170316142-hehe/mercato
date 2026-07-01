import { requireUser } from "@/lib/auth-helpers";
import { AppHeader } from "@/components/layout/app-header";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();

  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader
        user={{
          id: user.id,
          name: user.name,
          email: user.email,
          role: (user as { role?: string }).role ?? "user",
        }}
      />
      <main className="flex-1">{children}</main>
    </div>
  );
}
