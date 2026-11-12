// Loading, load-failure and submit-failure blocks shared by the three tabs.
import { useT } from "@/components/i18n";
import { ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";

export function FormLoading({
  error = false,
  onRetry,
}: {
  error?: boolean;
  onRetry?: () => void;
}) {
  const t = useT();
  if (error)
    return (
      <ErrorState
        title={t("hrisRequestsEmployee.form.loadErrorTitle")}
        description={t("hrisRequestsEmployee.form.loadErrorHint")}
        onRetry={onRetry}
      />
    );
  return (
    <div aria-busy="true" className="grid gap-4">
      <span className="sr-only" role="status">
        {t("hrisRequestsEmployee.form.loading")}
      </span>
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-12 w-full" />
    </div>
  );
}

export function SubmitFailure() {
  const t = useT();
  return (
    <div role="alert" className="grid gap-0.5">
      <p className="text-sm leading-5 font-semibold text-danger">
        {t("hrisRequestsEmployee.form.submitError")}
      </p>
      <p className="text-sm leading-5 text-muted-foreground">
        {t("hrisRequestsEmployee.form.submitErrorHint")}
      </p>
    </div>
  );
}
