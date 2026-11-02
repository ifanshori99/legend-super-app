// Loading and failure states for the public website (PRD: every screen has
// loading, empty, error and offline states). The skeleton mirrors the page
// rhythm — header bar, hero split, card row — so the shift to content is calm.
import { Link, useRouter } from "@tanstack/react-router";
import { RotateCw } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api/client";

export function WebsitePending() {
  const t = useT();
  return (
    <div aria-busy="true" className="min-h-dvh">
      <div className="border-b-(length:--border-w)">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center px-gutter">
          <Skeleton className="h-6 w-36" />
        </div>
      </div>
      <div className="mx-auto w-full max-w-6xl px-gutter py-10">
        <div className="grid items-center gap-8 lg:grid-cols-2">
          <div className="grid gap-4">
            <Skeleton className="h-9 w-2/3" />
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-5/6" />
            <Skeleton className="h-12 w-52 rounded-control" />
          </div>
          <Skeleton className="aspect-[4/3] w-full rounded-2xl" />
        </div>
        <div className="mt-12 grid gap-4 sm:grid-cols-3">
          <Skeleton className="h-40 rounded-xl" />
          <Skeleton className="h-40 rounded-xl" />
          <Skeleton className="h-40 rounded-xl" />
        </div>
      </div>
      <span role="status" className="sr-only">
        {t("app.loading")}
      </span>
    </div>
  );
}

/** Route error boundary: offline gets its own hint and a retry action. */
export function WebsiteError({
  error,
  reset,
}: {
  /** TanStack Router hands the boundary an `unknown` error. */
  error: unknown;
  reset: () => void;
}) {
  const t = useT();
  const router = useRouter();
  const offline = error instanceof ApiError && error.status === 0;
  return (
    <div className="mx-auto w-full max-w-2xl px-gutter py-16">
      <ErrorState
        title={
          offline
            ? t("website.state.offlineTitle")
            : t("website.state.errorTitle")
        }
        description={
          offline
            ? t("website.state.offlineHint")
            : t("website.state.errorHint")
        }
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                reset();
                void router.invalidate();
              }}
            >
              <RotateCw aria-hidden="true" />
              {t("common.retry")}
            </Button>
            <Button asChild variant="ghost" size="sm">
              <Link to="/">{t("website.nav.home")}</Link>
            </Button>
          </div>
        }
      />
    </div>
  );
}
