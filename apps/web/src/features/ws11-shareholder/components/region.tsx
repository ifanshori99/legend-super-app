// Shared state pieces of the shareholder dashboard: one error/offline frame
// with its own retry, and the estimate/official badge (SH-01).
import { CircleCheck, Clock, WifiOff } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { ErrorState } from "@/components/ui/feedback-state";
import type { RegionStatus } from "../hooks";

export function RegionFailure({
  status,
  retry,
}: {
  status: "error" | "offline";
  retry: () => void;
}) {
  const t = useT();
  if (status === "offline")
    return (
      <ErrorState
        icon={WifiOff}
        title={t("shareholderHome.offlineTitle")}
        description={t("shareholderHome.offlineHint")}
        onRetry={retry}
      />
    );
  return <ErrorState onRetry={retry} />;
}

export function isFailure(status: RegionStatus): status is "error" | "offline" {
  return status === "error" || status === "offline";
}

/** "Resmi" only for a closed, final period; everything else says "Estimasi". */
export function FinalityBadge({ official }: { official: boolean }) {
  const t = useT();
  return official ? (
    <Badge tone="success">
      <CircleCheck aria-hidden="true" />
      {t("shareholderHome.badge.official")}
    </Badge>
  ) : (
    <Badge tone="info">
      <Clock aria-hidden="true" />
      {t("shareholderHome.badge.estimate")}
    </Badge>
  );
}
