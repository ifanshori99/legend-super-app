import { RotateCw } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useOutletClock } from "@/lib/tenant-context";
import { Notice } from "@/features/ws04-pos-kasir/components/shared";
import { formatClock, type KitchenVoidNotice } from "../kitchen-void";

// The kitchen notices above the order lines: loading, error (retry), empty
// ("no notice") and the notice itself. A kitchen void never changes the bill,
// so the notice always says so and points to the POS void.
export function KitchenNotices({
  isLoading,
  isError,
  notices,
  onRetry,
  isRetrying = false,
}: {
  isLoading: boolean;
  isError: boolean;
  notices: readonly KitchenVoidNotice[];
  onRetry: () => void;
  isRetrying?: boolean;
}) {
  const t = useT();
  const { timeZone } = useOutletClock();

  if (isLoading)
    return (
      <div role="status" aria-busy="true">
        <Notice tone="info" title={t("posOrderDetail.notice.loadingTitle")}>
          <p>{t("posOrderDetail.notice.loadingHint")}</p>
          <Skeleton className="mt-3 h-4 w-2/5" />
        </Notice>
      </div>
    );

  if (isError)
    return (
      <Notice tone="danger" title={t("posOrderDetail.notice.errorTitle")}>
        <p>{t("posOrderDetail.notice.errorHint")}</p>
        <Button
          variant="outline"
          className="mt-3"
          loading={isRetrying}
          onClick={onRetry}
        >
          <RotateCw aria-hidden="true" />
          {t("common.retry")}
        </Button>
      </Notice>
    );

  if (notices.length === 0)
    return (
      <Notice tone="info" title={t("posOrderDetail.notice.emptyTitle")}>
        <p>{t("posOrderDetail.notice.emptyHint")}</p>
      </Notice>
    );

  return (
    <div className="grid gap-3">
      {notices.map((notice) => {
        const time = formatClock(notice.occurredAt, timeZone);
        const count = notice.itemIds.length;
        const what = notice.ticketCancelled
          ? t("posOrderDetail.notice.ticket", { time, count })
          : t("posOrderDetail.notice.item", { time, count });
        return (
          <Notice
            key={notice.eventId}
            tone="warning"
            role="status"
            title={t("posOrderDetail.notice.title")}
          >
            <p>
              {what}
              {notice.reason
                ? ` ${t("posOrderDetail.notice.reason", { reason: notice.reason })}`
                : ""}
            </p>
            <p>{t("posOrderDetail.notice.billUnchanged")}</p>
          </Notice>
        );
      })}
    </div>
  );
}
