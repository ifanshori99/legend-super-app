import type { ReactNode } from "react";
import { cn } from "cn";
import { Link, type LinkProps } from "@tanstack/react-router";
import { CircleAlert, CircleCheck, ChevronLeft } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { useOrderingConnectivity } from "@/features/ws04-pos-order/hooks";
import { SampleBadge } from "./captain-order-parts";

// The frame of every captain screen (PRD: POS and captain use Mode Kontras
// Tinggi): a small 64 px bar with the back link, the context ("Captain" or the
// table code) and the connectivity badge; then the screen's only `<h1>` at 24 px
// with the "Contoh data" chip on its right and the subtitle below; then the
// content, and a bottom bar as wide as the content column that stays in reach
// of the thumb. The badge is always icon plus text, never color alone.
export function CaptainShell({
  context,
  contextSub,
  title,
  subtitle,
  backTo,
  bottomBar,
  children,
}: {
  /** Bar title: "Captain" or the table code. */
  context: string;
  /** Bar second line, e.g. the outlet and zone or "Sesi QR aktif · 4 tamu". */
  contextSub?: string;
  /** The screen's `<h1>`. */
  title: string;
  /** What the screen is for, under the `<h1>`. */
  subtitle?: string;
  /** Route the back arrow goes to. */
  backTo?: string;
  bottomBar?: ReactNode;
  children: ReactNode;
}) {
  const t = useT();
  const { mode } = useOrderingConnectivity();
  const online = mode === "online";

  return (
    <div
      data-density="kontras"
      data-slot="captain-shell"
      className="flex min-h-dvh min-w-0 flex-col bg-background text-foreground"
    >
      <header className="flex h-16 shrink-0 items-center justify-between gap-3 border-b-2 border-border bg-card px-4">
        <div className="flex min-w-0 items-center gap-1">
          {backTo && (
            <Link
              to={backTo as LinkProps["to"]}
              aria-label={t("posCaptainTables.shell.back")}
              className="-ml-2 grid min-h-11 min-w-11 shrink-0 place-items-center rounded-control focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <ChevronLeft className="size-6" aria-hidden="true" />
            </Link>
          )}
          <div className="min-w-0">
            <p className="truncate text-lg leading-6 font-extrabold">
              {context}
            </p>
            {contextSub && (
              <p className="truncate text-xs leading-4 font-normal text-muted-foreground">
                {contextSub}
              </p>
            )}
          </div>
        </div>
        <Badge
          tone={online ? "neutral" : "warning"}
          role="status"
          aria-label={t("posCaptainTables.shell.connectivityLabel")}
          className="shrink-0 px-3 py-1 text-sm"
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
      <main
        className={cn(
          "mx-auto w-full max-w-3xl min-w-0 flex-1 p-card",
          // Room under the list so the sticky bottom bar never covers its end.
          bottomBar && "pb-32",
        )}
      >
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
          <div
            data-slot="captain-intro"
            className="flex items-start justify-between gap-3"
          >
            <div className="min-w-0">
              <h1 className="text-2xl leading-8 font-extrabold">{title}</h1>
              {subtitle && (
                <p className="text-(length:--density-text) text-muted-foreground">
                  {subtitle}
                </p>
              )}
            </div>
            <div className="shrink-0 empty:hidden">
              <SampleBadge />
            </div>
          </div>
          {children}
        </div>
      </main>
      {bottomBar && (
        // The area frame pads the page by 16 px, and a sticky bar stops at the
        // padding edge: pull it down and out so it sits flush on the viewport.
        <div className="sticky -bottom-4 z-10 -mx-4 border-t-2 border-border bg-card">
          <div
            data-slot="captain-bottom-bar"
            className="mx-auto grid w-full max-w-3xl gap-2 px-card pt-3 pb-[max(2rem,calc(1rem+env(safe-area-inset-bottom)))]"
          >
            {bottomBar}
          </div>
        </div>
      )}
    </div>
  );
}
