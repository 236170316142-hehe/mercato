// Streamed instantly on navigation while the project page's data loads.
// Mirrors the real layout (header → stepper → step content) so the transition
// doesn't shift once the data arrives.

function Shimmer({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-muted ${className}`} />;
}

export default function ProjectLoading() {
  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b py-5 shrink-0">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 sm:gap-4 sm:px-8">
          <Shimmer className="h-9 w-9 shrink-0 rounded-lg" />
          <div className="flex-1 min-w-0 space-y-2">
            <Shimmer className="h-5 w-48 max-w-full" />
            <Shimmer className="h-3 w-24" />
          </div>
          <Shimmer className="h-8 w-8 shrink-0 rounded-lg" />
        </div>
      </div>

      {/* Stepper */}
      <div className="py-4 shrink-0">
        <div className="mx-auto flex max-w-6xl items-center gap-0 overflow-x-auto px-4 sm:px-8">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-center flex-1 last:flex-none">
              <div className="flex items-center gap-3 px-3 py-2">
                <Shimmer className="h-8 w-8 shrink-0 rounded-full" />
                <div className="hidden lg:block space-y-1.5">
                  <Shimmer className="h-3 w-20" />
                  <Shimmer className="h-2.5 w-28" />
                </div>
              </div>
              {i < 3 && <Shimmer className="mx-1 h-4 w-4 shrink-0" />}
            </div>
          ))}
        </div>
      </div>

      {/* Step content */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl">
          <div className="p-4 sm:p-8">
            <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-2">
                <Shimmer className="h-5 w-44" />
                <Shimmer className="h-3.5 w-64 max-w-full" />
              </div>
              <Shimmer className="h-9 w-36 shrink-0 rounded-lg" />
            </div>

            {/* Search */}
            <Shimmer className="mb-4 h-9 w-full rounded-lg" />

            {/* Table */}
            <div className="overflow-hidden rounded-xl border">
              <div className="flex gap-4 border-b bg-muted/50 px-4 py-3">
                <Shimmer className="h-3.5 flex-1" />
                <Shimmer className="hidden h-3.5 w-24 sm:block" />
                <Shimmer className="hidden h-3.5 w-24 sm:block" />
                <Shimmer className="hidden h-3.5 w-16 md:block" />
              </div>
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4 border-b px-4 py-3 last:border-b-0">
                  <div className="flex-1 space-y-1.5">
                    <Shimmer className="h-3.5 w-3/4 max-w-sm" />
                    <Shimmer className="h-2.5 w-24" />
                  </div>
                  <Shimmer className="hidden h-3.5 w-24 sm:block" />
                  <Shimmer className="hidden h-3.5 w-24 sm:block" />
                  <Shimmer className="hidden h-5 w-12 rounded-full md:block" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
