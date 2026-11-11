import type { ReactNode } from "react";
import { Link, type LinkProps } from "@tanstack/react-router";
import { CircleAlert, CircleCheck, ChevronLeft } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { useOrderingConnectivity } from "@/features/ws04-pos-order/hooks";

// The frame of every captain screen (PRD: POS and captain use Mode Kontras
// Tinggi): a 64 px header with the back link or brand, the connectivity badge,
// the content, and a bottom bar that stays in reach of the thumb. The badge is
// always icon plus text, never color alone.
export function CaptainShell({
  title,
  subtitle,
  backTo,
  bottomBar,
  children,
}: {
  title: string;
  /** Second header line, e.g. the outlet and zone or "Sesi QR aktif · 4 tamu". */
  subtitle?: string;
  /** Route the back arrow goes to. */
  backTo?: string;
  bottomBar?: ReactNode;
  children: ReactNode;
}) {
  const t = useT();
  const { mode } = useOrderingConnectivity();
  const online = mode === "online";

  const heading = (
    <>
      {backTo && <ChevronLeft className="size-6 shrink-0" aria-hidden="true" />}
      <span className="min-w-0">
        <span className="block truncate text-lg leading-6 font-bold">
          {title}
        </span>
        {subtitle && (
          <span className="block truncate text-xs leading-4 font-normal text-muted-foreground">
            {subtitle}
          </span>
        )}
      </span>
    </>
  );

  return (
    <div
      data-density="kontras"
      data-slot="captain-shell"
      className="flex min-h-dvh min-w-0 flex-col bg-background text-foreground"
    >
      <header className="flex h-16 shrink-0 items-center justify-between gap-3 border-b-2 border-border bg-card px-4">
        {backTo ? (
          <Link
            to={backTo as LinkProps["to"]}
            aria-label={`${t("posCaptainTables.shell.back")}: ${title}`}
            className="-ml-2 flex min-h-11 min-w-0 items-center gap-1 rounded-control px-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {heading}
          </Link>
        ) : (
          <div className="flex min-w-0 items-center gap-1">{heading}</div>
        )}
        <Badge
          tone={online ? "neutral" : "warning"}
          role="status"
          aria-label={t("posCaptainTables.shell.connectivityLabel")}
          className="px-3 py-1 text-sm"
        >
          {online ? (
            <CircleCheck aria-hidden="true" />
          ) : (
            <CircleAlert aria-hidden="true" />
          )}
          {online
            ? t("posCaptainTables.shell.online")
            : t("posCaptainTables.shell.offline")}
        </Badge>
      </header>
      <main className="mx-auto w-full max-w-3xl min-w-0 flex-1 p-card">
        {children}
      </main>
      {bottomBar && (
        <div
          data-slot="captain-bottom-bar"
          className="sticky bottom-0 z-10 border-t-2 border-border bg-card px-4 pt-3 pb-4"
        >
          <div className="mx-auto grid w-full max-w-3xl gap-2">{bottomBar}</div>
        </div>
      )}
    </div>
  );
}
