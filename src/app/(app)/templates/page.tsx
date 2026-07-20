import { requireUser } from "@/lib/auth-helpers";
import { prisma } from "@/lib/db";
import { AdminTemplatesClient } from "@/components/admin/templates-client";

export default async function TemplatesPage() {
  const user = await requireUser();

  // Load this user's templates + global (admin-created) templates
  const templates = await prisma.exportTemplate.findMany({
    where: { OR: [{ userId: user.id }, { userId: null }] },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
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
