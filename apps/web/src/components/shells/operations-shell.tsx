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
import { Store, Wifi, WifiOff } from "lucide-react";
import type { ColorMode } from "@starter/shared/theme";
import { useT } from "@/components/i18n";
import { ThemeScope } from "@/components/theme-scope";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
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
  outletSheetControl,
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
  /**
   * Outlet choice list for the phone sheet (below `sm`, where `outletControl`
   * is hidden). Absent with a single outlet: the sheet shows details only.
   */
  outletSheetControl?: ReactNode;
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
  // Desktop: the picker shows the outlet name, so the subtitle drops it. The
  // phone bar has no picker, so its subtitle always names the outlet.
  const subtitle = [outletControl ? undefined : outletName, stationName]
    .filter(Boolean)
    .join(" · ");
  const phoneSubtitle = [outletName, stationName].filter(Boolean).join(" · ");
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
        className="flex shrink-0 items-center gap-x-4 gap-y-2 border-b-(length:--border-w) bg-shell px-4 max-sm:h-14 max-sm:gap-2 max-sm:py-1 sm:min-h-16 sm:flex-wrap sm:py-2"
      >
        <div className="min-w-0 max-sm:flex-1">
          <p className="truncate type-title max-sm:leading-6">{title}</p>
          {subtitle && (
            <p className="truncate text-sm leading-5 text-muted-foreground max-sm:hidden">
              {subtitle}
            </p>
          )}
          {phoneSubtitle && (
            <p className="truncate text-sm leading-4 text-muted-foreground sm:hidden">
              {phoneSubtitle}
            </p>
          )}
        </div>
        <div className="ml-auto flex items-center gap-3 max-sm:shrink-0 max-sm:gap-1.5 sm:min-w-0 sm:flex-wrap">
          <Badge
            tone={online ? "success" : "warning"}
            className="rounded-full px-3 py-1 text-sm whitespace-normal max-sm:px-1.5 [&_svg]:size-4"
            role="status"
          >
            {online ? (
              <Wifi aria-hidden="true" />
            ) : (
              <WifiOff aria-hidden="true" />
            )}
            <span className="max-sm:sr-only">
              {online ? t("connection.online") : t("connection.offline")}
            </span>
          </Badge>
          {staffName && (
            <span className="text-sm font-semibold max-sm:hidden">
              {staffName}
            </span>
          )}
          <LiveClock timeZone={zone} className="max-sm:text-sm" />
          <Sheet>
            <SheetTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className="border-input max-sm:size-11 max-sm:px-0 sm:hidden"
                aria-label={t("area.ops.outletButton", { name: outletName })}
              >
                <Store aria-hidden="true" />
              </Button>
            </SheetTrigger>
            <SheetContent side="bottom">
              <SheetHeader>
                <SheetTitle>{t("area.ops.sheetTitle")}</SheetTitle>
                <SheetDescription>
                  {t("area.ops.sheetDescription")}
                </SheetDescription>
              </SheetHeader>
              <dl className="grid gap-3">
                <div>
                  <dt className="text-sm text-muted-foreground">
                    {t("area.ops.sheetOutlet")}
                  </dt>
                  <dd className="font-semibold break-words">{outletName}</dd>
                </div>
                {stationName ? (
                  <div>
                    <dt className="text-sm text-muted-foreground">
                      {t("area.ops.sheetStation")}
                    </dt>
                    <dd className="font-semibold break-words">{stationName}</dd>
                  </div>
                ) : null}
                {staffName ? (
                  <div>
                    <dt className="text-sm text-muted-foreground">
                      {t("area.ops.sheetStaff")}
                    </dt>
                    <dd className="font-semibold break-words">{staffName}</dd>
                  </div>
                ) : null}
              </dl>
              {outletSheetControl}
            </SheetContent>
          </Sheet>
          {outletControl || actions ? (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {outletControl ? (
                <div className="min-w-0 max-sm:hidden sm:max-w-72">
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
