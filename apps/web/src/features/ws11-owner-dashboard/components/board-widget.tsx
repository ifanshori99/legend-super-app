// Loading, empty and error pieces of the dashboard's data widgets. Every data
// region gets all three (PRD: setiap daftar punya state loading, empty, error),
// and an error keeps its retry next to the widget that failed.
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { RotateCw } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

export function BoardEmpty({ retry }: { retry?: () => void }) {
  const t = useT();
  return (
    <EmptyState
      title={t("ownerDashboard.empty.title")}
      description={t("ownerDashboard.empty.hint")}
      action={
        retry && (
          <Button variant="outline" size="sm" onClick={retry}>
            <RotateCw aria-hidden="true" />
            {t("common.retry")}
          </Button>
        )
      }
    />
  );
}

export function BoardError({ retry }: { retry: () => void }) {
  return <ErrorState onRetry={retry} />;
}

/** A widget that failed keeps its own card and retry, next to its neighbours. */
export function WidgetErrorCard({ retry }: { retry: () => void }) {
  return (
    <div className="min-w-0 rounded-xl border-(length:--border-w) bg-card">
      <BoardError retry={retry} />
    </div>
  );
}

/** Skeleton shaped like a metric tile, not a bare grey box. */
export function TileSkeleton() {
  const t = useT();
  return (
    <div
      className="grid gap-2 rounded-xl border-(length:--border-w) bg-card p-card"
      aria-busy="true"
    >
      <span className="sr-only">{t("common.loading")}</span>
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-8 w-32" />
      <Skeleton className="h-4 w-40" />
    </div>
  );
}

/** Skeleton rows inside a table frame. */
export function RowsSkeleton({ rows = 4 }: { rows?: number }) {
  const t = useT();
  return (
    <div className="grid gap-2 p-card" aria-busy="true">
      <span className="sr-only">{t("common.loading")}</span>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-row" />
      ))}
    </div>
  );
}
