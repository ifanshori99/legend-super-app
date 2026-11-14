// Operations shell (Kontras Tinggi): POS, captain order, KDS, expo, pickup,
// papan bilik. Full screen, no navigation chrome: a status bar with where
// you are, the connection state, and the time; the work area owns the rest.
// Kitchen screens pass mode="dark" (PRD: mode gelap untuk dapur).
// v3 (Metoric topbar): the status bar sits on the shell tone with a 21px
// bold screen title; the work area keeps the page tone.
// Outlet name, station and the clock zone come from the tenant context
// (lib/tenant-context.tsx, bead legend-ri1p); the props only override it for
// previews. No outlet configured keeps the neutral "Outlet belum dipilih".
import { useSyncExternalStore, type ReactNode } from "react";
import { cn } from "cn";
import { Wifi, WifiOff } from "lucide-react";
import type { ColorMode } from "@starter/shared/theme";
import { useT } from "@/components/i18n";
import { ThemeScope } from "@/components/theme-scope";
import { Badge } from "@/components/ui/badge";
import { useOutletClock, useTenantContext } from "@/lib/tenant-context";

function subscribeMinute(onChange: () => void) {
  const id = window.setInterval(onChange, 15_000);
  return () => window.clearInterval(id);
}

/**
 * Outlet wall clock. Renders after hydration only (the server cannot know
 * the client's minute), in the outlet's own time zone from its config.
 */
export function LiveClock({
  timeZone,
  className,
}: {
  timeZone: string;
  className?: string;
}) {
  const now = useSyncExternalStore(
    subscribeMinute,
    () => Math.floor(Date.now() / 60_000),
    () => null,
  );
  const date = now === null ? null : new Date(now * 60_000);
  return (
    <time
      dateTime={date?.toISOString()}
      className={cn("min-w-[5ch] text-xl font-bold tabular", className)}
    >
      {date
        ? new Intl.DateTimeFormat("id-ID", {
            hour: "2-digit",
            minute: "2-digit",
            timeZone,
          }).format(date)
        : " "}
    </time>
  );
}

export function OperationsShell({
  title,
  outlet,
  station,
  staffName,
  online,
  timeZone,
  mode,
  outletControl,
  actions,
  embedded = false,
  children,
}: {
  /** Screen name, e.g. "POS Kasir" or "KDS · Bar kopi". */
  title: string;
  /** Override the configured outlet name (previews); default from context. */
  outlet?: string;
  /** Override the configured station name (previews); default from context. */
  station?: string;
  staffName?: string;
  /** Cloud connection; operations keep working via the edge node offline. */
  online: boolean;
  /** Override the outlet IANA zone (previews); default from context. */
  timeZone?: string;
  mode?: ColorMode;
  /**
   * Outlet picker. Replaces the outlet name in the subtitle (the picker shows
   * it) and shares one row with `actions` below `sm`.
   */
  outletControl?: ReactNode;
  actions?: ReactNode;
  embedded?: boolean;
  children: ReactNode;
}) {
  const t = useT();
  const tenant = useTenantContext();
  const outletClock = useOutletClock();
  // No outlet configured (SSR/no-config) keeps the neutral copy; the clock
  // falls back to the documented default clock until an outlet is known.
  const outletName = outlet ?? tenant.outlet?.name ?? t("area.ops.outletUnset");
  const stationName = station ?? tenant.station?.name;
  const subtitle = [outletControl ? undefined : outletName, stationName]
    .filter(Boolean)
    .join(" · ");
  const zone = timeZone ?? outletClock.timeZone;
  const Main = embedded ? "div" : "main";
  return (
    <ThemeScope
      density="kontras"
      mode={mode}
      className={cn(
        "flex flex-col bg-background",
        embedded ? "h-full" : "h-dvh",
      )}
    >
      <header
        data-outlet-time-zone={zone}
        data-business-day-cutoff={outletClock.businessDayCutoff}
        className="flex min-h-16 shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b-(length:--border-w) bg-shell px-4 py-2"
      >
        <div className="min-w-0">
          <p className="truncate type-title">{title}</p>
          {subtitle && (
            <p className="truncate text-sm leading-5 text-muted-foreground">
              {subtitle}
            </p>
          )}
        </div>
        <div
          className={cn(
            "ml-auto flex min-w-0 flex-wrap items-center gap-3",
            outletControl && "max-sm:w-full",
          )}
        >
          <Badge
            tone={online ? "success" : "warning"}
            className="rounded-full px-3 py-1 text-sm whitespace-normal [&_svg]:size-4"
            role="status"
          >
            {online ? (
              <Wifi aria-hidden="true" />
            ) : (
              <WifiOff aria-hidden="true" />
            )}
            {online ? t("connection.online") : t("connection.offline")}
          </Badge>
          {staffName && (
            <span className="text-sm font-semibold">{staffName}</span>
          )}
          <LiveClock timeZone={zone} />
          {outletControl || actions ? (
            <div className="flex min-w-0 flex-wrap items-center gap-2 max-sm:w-full">
              {outletControl ? (
                <div className="min-w-0 max-sm:flex-1 sm:max-w-72">
                  {outletControl}
                </div>
              ) : null}
              {actions}
            </div>
          ) : null}
        </div>
      </header>
      <Main
        id={embedded ? undefined : "main-content"}
        className="min-h-0 flex-1 overflow-hidden"
      >
        {children}
      </Main>
    </ThemeScope>
  );
}
