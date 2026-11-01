// Mount point for the connectivity kit. AreaFrame's OfflineBannerSlot renders
// this on every area: the offline banner above the page content and the
// training-mode watermark over it (PRD v1.7 §4 Alur F, §3 F5 Mode Latihan).
import { ConnectivityBanner } from "./connectivity-banner.tsx";
import { TrainingModeWatermark } from "./training-mode-watermark.tsx";

export function EdgeStatusLayer() {
  return (
    <>
      <ConnectivityBanner />
      <TrainingModeWatermark />
    </>
  );
}
