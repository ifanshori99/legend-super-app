// Loading and failure blocks shared by the settings screens. A failed request
// with no connection is "offline" (retry restores it); anything else is an
// error with a retry. Both say what to do next (PRD: pesan error + petunjuk).
import { WifiOff } from "lucide-react";
import { useT } from "@/components/i18n";
import { ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { isOfflineError } from "../errors";

export function QueryFailure({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) {
  const t = useT();
  const offline = isOfflineError(error);
  return (
    <ErrorState
      icon={offline ? WifiOff : undefined}
      title={
        offline
          ? t("tenantSettings.state.offlineTitle")
          : t("tenantSettings.state.errorTitle")
      }
      description={
        offline
          ? t("tenantSettings.state.offlineHint")
          : t("tenantSettings.state.errorHint")
      }
      onRetry={onRetry}
    />
  );
}

export function CardSkeletons({ count }: { count: number }) {
  const t = useT();
  return (
    <div
      role="status"
      aria-busy="true"
      className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
    >
      <span className="sr-only">{t("common.loading")}</span>
      {Array.from({ length: count }, (_, index) => (
        <Skeleton key={index} className="h-44 rounded-container" />
      ))}
    </div>
  );
}
