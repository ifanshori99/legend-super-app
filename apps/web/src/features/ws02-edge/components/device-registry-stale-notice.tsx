// Device registry freshness on a work-area screen (legend-2lgu). Soft stale is
// an info line; hard stale says the edge refuses new devices while running ones
// keep working. Mounted in EdgeStatusLayer, so it follows the edge status poll.
import { useT } from "@/components/i18n";
import { Notice } from "@/features/ws04-pos-kasir/components/shared/notice";
import { useEdgeStatus } from "../hooks.ts";
import { formatAlertTime } from "../logic.ts";
import { registryStaleView } from "../registry-stale.ts";
import { useNowMs } from "../use-now.ts";

export function DeviceRegistryStaleNotice() {
  const t = useT();
  const nowMs = useNowMs();
  const { data } = useEdgeStatus();

  // No clock before hydration: skip instead of guessing the age.
  if (nowMs === null) return null;
  const view = registryStaleView(data?.data.deviceRegistry, nowMs);
  if (!view) return null;

  if (view.kind === "hard")
    return (
      <Notice
        tone="warning"
        title={t("deviceRegistry.staleNotice.hardTitle", { hours: view.hours })}
        className="mb-4"
        data-device-registry="hard-stale"
      >
        <p>{t("deviceRegistry.staleNotice.hardHint")}</p>
      </Notice>
    );

  const since = formatAlertTime(view.since);
  return (
    <Notice
      tone="info"
      title={
        since
          ? t("deviceRegistry.staleNotice.softTitle", { time: since })
          : t("deviceRegistry.staleNotice.softNever")
      }
      className="mb-4"
      data-device-registry="stale"
    >
      <p>{t("deviceRegistry.staleNotice.softHint")}</p>
    </Notice>
  );
}
