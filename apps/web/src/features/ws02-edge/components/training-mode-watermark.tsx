// Training mode watermark (PRD v1.7 §3 F5 "Mode Latihan"): a device switched
// to training runs sandbox data that never enters reports, so every screen on
// that device must say so. The pattern is decorative; one screen-reader line
// carries the same fact, and nothing here blocks interaction.
import { useLocation } from "@tanstack/react-router";
import { useT } from "@/components/i18n";
import { useEdgeStatus } from "../hooks.ts";
import { isGuestPath } from "../logic.ts";
import { useHydrated } from "../use-now.ts";

const WATERMARK_ROWS = 9;

export function TrainingModeWatermark() {
  const t = useT();
  const hydrated = useHydrated();
  // Guest screens run on customers' phones, never a training device: no poll.
  const { pathname } = useLocation();
  const { data } = useEdgeStatus({ enabled: !isGuestPath(pathname) });
  const trainingMode = data?.data.thisDevice?.trainingMode === true;

  if (!hydrated || !trainingMode) return null;

  return (
    <>
      <div
        aria-hidden="true"
        data-edge-training-watermark=""
        className="pointer-events-none fixed inset-0 z-40 overflow-hidden select-none"
      >
        <div className="absolute inset-0 grid -rotate-12 scale-125 content-around gap-8 opacity-10">
          {Array.from({ length: WATERMARK_ROWS }, (_, index) => (
            <p
              key={index}
              className="text-center text-2xl font-bold tracking-[0.2em] whitespace-nowrap uppercase text-warning"
            >
              {t("edge.training.watermark")}
            </p>
          ))}
        </div>
      </div>
      <p className="sr-only">{t("edge.training.watermarkStatus")}</p>
    </>
  );
}
