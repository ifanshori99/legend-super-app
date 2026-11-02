// Operations shell (Kontras Tinggi): POS, captain order, KDS, expo, pickup,
// papan bilik. Full screen, no navigation chrome: a status bar with where
// you are, the connection state, and the time; the work area owns the rest.
// Kitchen screens pass mode="dark" (PRD: mode gelap untuk dapur).
// v3 (Metoric topbar): the status bar sits on the shell tone with a 21px
// bold screen title; the work area keeps the page tone.
import { useSyncExternalStore, type ReactNode } from "react";
import { cn } from "cn";
import { Wifi, WifiOff } from "lucide-react";
import type { ColorMode } from "@starter/shared/theme";
import { useT } from "@/components/i18n";
import { ThemeScope } from "@/components/theme-scope";
import { Badge } from "@/components/ui/badge";

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
  actions,
  embedded = false,
  children,
}: {
  /** Screen name, e.g. "POS Kasir" or "KDS · Bar kopi". */
  title: string;
  outlet: string;
  station?: string;
  staffName?: string;
  /** Cloud connection; operations keep working via the edge node offline. */
  online: boolean;
  /** Outlet IANA time zone, e.g. "Asia/Jakarta". */
  timeZone: string;
  mode?: ColorMode;
  actions?: ReactNode;
  embedded?: boolean;
  children: ReactNode;
}) {
  const t = useT();
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
      <header className="flex min-h-16 shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b-(length:--border-w) bg-shell px-4 py-2">
        <div className="min-w-0">
          <p className="truncate type-title">{title}</p>
          <p className="truncate text-sm leading-5 text-muted-foreground">
            {[outlet, station].filter(Boolean).join(" · ")}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-3">
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
          <LiveClock timeZone={timeZone} />
          {actions}
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
