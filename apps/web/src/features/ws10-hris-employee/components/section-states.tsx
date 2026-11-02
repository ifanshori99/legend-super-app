// The three non-ready states of one card on the employee PWA, defined once:
// a shaped skeleton, an empty state, and an error state that says what to do
// (DESIGN.md §4 "States, defined once"). The pages keep their own layout.
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { useT } from "@/components/i18n";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useOnline } from "@/lib/use-online";

export function SectionSkeleton({ rows = 2 }: { rows?: number }) {
  const t = useT();
  return (
    <div aria-busy="true" className="grid gap-2">
      <span className="sr-only" role="status">
        {t("common.loading")}
      </span>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-10 w-full" />
      ))}
    </div>
  );
}

export function SectionEmpty({
  icon,
  title,
  description,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <EmptyState
      icon={icon}
      title={title}
      description={description}
      action={action}
      className="py-6"
    />
  );
}

export function SectionError({
  title,
  description,
  onRetry,
}: {
  title: string;
  description: string;
  onRetry: () => void;
}) {
  const t = useT();
  const online = useOnline();
  return (
    <ErrorState
      className="py-6"
      title={online ? title : t("hris.state.offlineTitle")}
      description={online ? description : t("hris.state.offlineHint")}
      onRetry={onRetry}
    />
  );
}
