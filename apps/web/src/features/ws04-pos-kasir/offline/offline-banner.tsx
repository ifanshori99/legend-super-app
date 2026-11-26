// O4 banner of the cashier screen (bead legend-wasr7.8, mockup
// design/mockups/pos/offline): offline with the queue count, offline without a
// usable kit, back online while sending, or stopped on a parked sale. Nothing
// shows while online with an empty queue.
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Notice } from "@/features/ws04-pos-kasir/components/shared";

export type OfflineBannerState = {
  online: boolean;
  pending: number;
  parked: number;
  hasKit: boolean;
};

export function OfflineBanner({
  state,
  onOpenQueue,
}: {
  state: OfflineBannerState;
  onOpenQueue: () => void;
}) {
  const t = useT();
  const { online, pending, parked, hasKit } = state;
  if (online && pending === 0) return null;
  const action = pending > 0 && (
    <Button
      type="button"
      variant="outline"
      onClick={onOpenQueue}
      className="mt-2 bg-card font-bold"
    >
      {t("posKasirOffline.banner.openQueue")}
    </Button>
  );
  if (parked > 0)
    return (
      <Notice
        tone="danger"
        title={t("posKasirOffline.banner.stoppedTitle")}
        data-slot="pos-offline-banner"
      >
        <p>{t("posKasirOffline.banner.stoppedBody", { count: parked })}</p>
        {action}
      </Notice>
    );
  if (online)
    return (
      <Notice
        tone="info"
        title={t("posKasirOffline.banner.sendingTitle", { count: pending })}
        data-slot="pos-offline-banner"
      >
        <p>{t("posKasirOffline.banner.sendingBody")}</p>
        {action}
      </Notice>
    );
  if (!hasKit)
    return (
      <Notice
        tone="danger"
        title={t("posKasirOffline.banner.noKitTitle")}
        data-slot="pos-offline-banner"
      >
        <p>{t("posKasirOffline.banner.noKitBody")}</p>
        {action}
      </Notice>
    );
  return (
    <div className="grid gap-2" data-slot="pos-offline-banner">
      <Notice
        tone="warning"
        role="status"
        title={
          pending > 0
            ? t("posKasirOffline.banner.offlineTitle", { count: pending })
            : t("posKasirOffline.banner.offlineTitleNone")
        }
      >
        <p>{t("posKasirOffline.banner.offlineBody")}</p>
        {action}
      </Notice>
      <p className="text-sm font-bold text-warning">
        {t("posKasirOffline.banner.promo")}
      </p>
    </div>
  );
}
