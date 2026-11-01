import { useT } from "@/components/i18n";

/**
 * Reserved place for the offline / degraded-connection banner (bead
 * legend-diq fills it). Empty slots take no space. Operations screens also
 * show the connection badge in the shell header.
 */
export function OfflineBannerSlot() {
  const t = useT();
  return (
    <div
      data-slot="offline-banner"
      role="status"
      aria-live="polite"
      aria-label={t("layout.offlineRegion")}
      className="empty:hidden"
    />
  );
}
