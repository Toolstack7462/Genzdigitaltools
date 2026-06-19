import { Skeleton } from '@/components/ui/skeleton';

/**
 * Suspense fallback shown while a route's code-split chunk loads. A light skeleton
 * (not a blank screen / blocking spinner) so navigation always feels responsive.
 * Intentionally tiny and dependency-free beyond the shared Skeleton primitive, so it
 * stays in the main bundle and paints instantly while the real page chunk downloads.
 */
export default function PageLoader() {
  return (
    <div
      className="min-h-[60vh] w-full px-4 py-10 sm:px-6 lg:px-8"
      role="status"
      aria-busy="true"
      aria-label="Loading"
    >
      <div className="mx-auto max-w-5xl space-y-6">
        <Skeleton className="h-8 w-1/3" />
        <Skeleton className="h-4 w-2/3" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}
