import { requireUser } from "@/lib/auth-helpers";
import { prisma } from "@/lib/db";
import { AdminTemplatesClient } from "@/components/admin/templates-client";

export default async function TemplatesPage() {
  const user = await requireUser();

  // Fetch admin user IDs so their templates also appear as global defaults.
  // Some may have userId=adminId instead of null if uploaded before the null convention.
  const adminUsers = await prisma.user.findMany({ where: { role: "admin" }, select: { id: true } });
  const adminIds = adminUsers.map((u) => u.id);
  const adminIdSet = new Set(adminIds);

  const rawTemplates = await prisma.exportTemplate.findMany({
    where: {
      OR: [
        { userId: user.id },
        { userId: null },
        ...(adminIds.length > 0 ? [{ userId: { in: adminIds } }] : []),
      ],
    },
    orderBy: { createdAt: "desc" },
  });

  // Treat admin-owned templates as userId=null for display (shows Admin badge, hides edit/delete).
  const templates = rawTemplates.map((t) => ({
    ...t,
    userId: t.userId === null || adminIdSet.has(t.userId ?? "") ? null : t.userId,
  }));

  return (
    <div className="mx-auto max-w-6xl px-8 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">My Templates</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Upload your marketplace template files — columns are auto-detected and used for export
        </p>
      </div>
      <AdminTemplatesClient templates={templates} isAdmin={(user as { role?: string }).role === "admin"} />
    </div>
  );
}
