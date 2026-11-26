// The offline banner that fills OfflineBannerSlot on every work-area screen
// (PRD v1.7 §4 Alur F step 1: the edge node detects the lost cloud link and
// shows offline status on all staff devices). Guest screens keep their own
// "Silakan pesan melalui waiter" notice.
import { Link } from "@tanstack/react-router";
import { useLocation } from "@tanstack/react-router";
import { cn } from "cn";
import {
  CloudOff,
  RefreshCw,
  TriangleAlert,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { useOnline } from "@/lib/use-online";
import { useEdgeStatus } from "../hooks.ts";
import {
  deriveConnectivity,
  edgeProbeFailed,
  formatClock,
  isCashierPath,
  isGuestPath,
  isOperationsPath,
  type ConnectivityState,
} from "../logic.ts";
import { useHydrated } from "../use-now.ts";

const VIEWS: Record<
  Exclude<ConnectivityState["kind"], "online">,
  {
    readonly tone: string;
    readonly iconTone: string;
    readonly Icon: LucideIcon;
    readonly titleKey:
      | "edge.banner.deviceOfflineTitle"
      | "edge.banner.cloudDownTitle"
      | "edge.banner.syncingTitle"
      | "edge.banner.unknownTitle";
    readonly hintKey:
      | "edge.banner.deviceOfflineHint"
      | "edge.banner.cloudDownHint"
      | "edge.banner.syncingHint"
      | "edge.banner.unknownHint";
  }
> = {
  device_offline: {
    tone: "border-danger bg-danger-subtle",
    iconTone: "text-danger",
    Icon: WifiOff,
    titleKey: "edge.banner.deviceOfflineTitle",
    hintKey: "edge.banner.deviceOfflineHint",
  },
  cloud_down: {
    tone: "border-warning bg-warning-subtle",
    iconTone: "text-warning",
    Icon: CloudOff,
    titleKey: "edge.banner.cloudDownTitle",
    hintKey: "edge.banner.cloudDownHint",
  },
  syncing: {
    tone: "border-info bg-info-subtle",
    iconTone: "text-info",
    Icon: RefreshCw,
    titleKey: "edge.banner.syncingTitle",
    hintKey: "edge.banner.syncingHint",
  },
  unknown: {
    tone: "border-warning bg-warning-subtle",
    iconTone: "text-warning",
    Icon: TriangleAlert,
    titleKey: "edge.banner.unknownTitle",
    hintKey: "edge.banner.unknownHint",
  },
};

export function ConnectivityBanner() {
  const t = useT();
  const hydrated = useHydrated();
  const browserOnline = useOnline();
  const { pathname } = useLocation();
  const guest = isGuestPath(pathname);
  // Guest screens never poll the edge node (they render their own notice).
  const { data, isError, error } = useEdgeStatus({ enabled: !guest });

  if (!hydrated || guest) return null;

  const status = data?.data;
  const state = deriveConnectivity({
    browserOnline,
    cloudLink: status?.cloudLink ?? null,
    pendingEventCount: status?.pendingEventCount ?? 0,
    statusFailed: edgeProbeFailed(isError, error),
  });
  if (state.kind === "online") return null;
  // The cashier's O4 banner already says the tablet is offline.
  if (state.kind === "device_offline" && isCashierPath(pathname)) return null;

  const view = VIEWS[state.kind];
  const Icon = view.Icon;
  const lastSynced = formatClock(status?.lastSyncedAt ?? null);
  const pending =
    state.kind === "cloud_down" || state.kind === "syncing"
      ? state.pendingEventCount
      : 0;
  const pendingLine =
    pending > 0 ? t("edge.banner.pending", { count: pending }) : null;
  const detail =
    state.kind === "cloud_down" && lastSynced
      ? t("edge.banner.lastSynced", { time: lastSynced })
      : null;

  return (
    <div
      data-edge-banner={state.kind}
      className={cn(
        "mb-4 flex flex-col gap-3 rounded-container border-(length:--border-w) p-3 text-foreground sm:flex-row sm:items-start sm:gap-4",
        view.tone,
      )}
    >
      <Icon
        className={cn("mt-0.5 size-5 shrink-0", view.iconTone)}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{t(view.titleKey, { count: pending })}</p>
        <p className="text-sm leading-5 text-muted-foreground">
          {t(view.hintKey)}
        </p>
        {(pendingLine || detail) && (
          <p className="mt-1 text-sm tabular text-muted-foreground">
            {[pendingLine, detail].filter(Boolean).join(" · ")}
          </p>
        )}
      </div>
      {isOperationsPath(pathname) && (
        <Button
          asChild
          variant="outline"
          size="sm"
          className="self-start bg-background sm:ml-auto"
        >
          <Link to="/operasional/koneksi">{t("edge.banner.details")}</Link>
        </Button>
      )}
    </div>
  );
}
