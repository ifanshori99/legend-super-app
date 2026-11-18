// Mount point for the connectivity kit. AreaFrame's OfflineBannerSlot renders
// this on every area: the offline banner above the page content and the
// training-mode watermark over it (PRD v1.7 §4 Alur F, §3 F5 Mode Latihan).
import { CatalogSalesNotice } from "./catalog-sales-notice.tsx";
import { ConnectivityBanner } from "./connectivity-banner.tsx";
import { DeviceRegistryStaleNotice } from "./device-registry-stale-notice.tsx";
import { TrainingModeWatermark } from "./training-mode-watermark.tsx";

export function EdgeStatusLayer() {
  return (
    <>
      <ConnectivityBanner />
      <CatalogSalesNotice />
      <DeviceRegistryStaleNotice />
      <TrainingModeWatermark />
    </>
  );
}
