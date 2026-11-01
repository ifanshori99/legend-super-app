import { useT } from "@/components/i18n";
import { EdgeStatusLayer } from "@/features/ws02-edge/components/edge-status-layer";

/**
 * Mount point for the offline / connectivity kit (bead legend-diq): the
 * offline banner above every page's content and the training-mode watermark.
 * Empty slots take no space. Operations screens also show the connection
 * badge in the shell header.
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
    >
      <EdgeStatusLayer />
    </div>
  );
}
