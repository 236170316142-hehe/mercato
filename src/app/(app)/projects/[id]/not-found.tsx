import Link from "next/link";
import { ArrowLeft, FolderX } from "lucide-react";

export default function ProjectNotFound() {
  return (
    <div className="flex flex-col items-center justify-center px-8 py-24 text-center">
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-muted">
        <FolderX className="h-7 w-7 text-muted-foreground" />
      </div>
      <h1 className="mb-1 text-base font-semibold">Project not found</h1>
      <p className="mb-6 max-w-sm text-sm text-muted-foreground">
        This project doesn&apos;t exist or may have been deleted. Check the link, or head back to
        your projects.
      </p>
      <Link
        href="/projects"
        className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to projects
      </Link>
    </div>
  );
}
