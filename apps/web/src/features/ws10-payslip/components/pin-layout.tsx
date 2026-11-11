// Page shell for every payslip PIN screen (bead legend-ilzrj; mockups
// design/mockups/payslip-pin/*-mobile|desktop.png): back link, eyebrow, h1 and
// one sentence, then the task card with an info panel on its right once the
// container is at least 768px wide (@3xl), stacked under it otherwise. The back link is passed in by the page
// because each screen returns to a different place (as PageHeader does).
import type { ReactNode } from "react";
import { useT } from "@/components/i18n";
import { Card } from "@/components/ui/card";

type PinLayoutProps = {
  /** Card heading (h2). */
  title: string;
  /** One sentence under the card heading. */
  description?: ReactNode;
  /** Info panel text; the panel is omitted when empty. */
  side?: ReactNode;
  /** Back link element (a router Link), rendered above the page heading. */
  backLink?: ReactNode;
  /** Card body: form, notice, buttons or skeleton. */
  children: ReactNode;
  /** Marks the card as loading for assistive tech. */
  busy?: boolean;
};

function PinLayout({
  title,
  description,
  side,
  backLink,
  children,
  busy,
}: PinLayoutProps) {
  const t = useT();

  return (
    <div className="@container mx-auto grid w-full max-w-5xl gap-6">
      {backLink}
      <header className="grid gap-1">
        <p className="text-xs font-bold tracking-widest text-muted-foreground uppercase">
          {t("payslipPin.layout.eyebrow")}
        </p>
        <h1 className="font-brand type-display-xl">
          {t("payslipPin.layout.title")}
        </h1>
        <p className="text-base leading-6 text-muted-foreground md:text-sm md:leading-5">
          {t("payslipPin.layout.subtitle")}
        </p>
      </header>
      <div
        className={
          side
            ? "grid items-start gap-4 @3xl:grid-cols-[minmax(0,1fr)_20rem] @3xl:gap-7"
            : "grid items-start gap-4"
        }
      >
        <Card
          aria-busy={busy || undefined}
          className="gap-4 md:p-8"
        >
          <div className="grid gap-1">
            <h2 className="font-brand type-title">{title}</h2>
            {description && (
              <p className="text-base leading-6 text-muted-foreground md:text-sm md:leading-5">
                {description}
              </p>
            )}
          </div>
          {children}
        </Card>
        {side && (
          <aside className="grid gap-2 rounded-container bg-muted p-5">
            <h3 className="text-base font-bold">
              {t("payslipPin.layout.infoTitle")}
            </h3>
            <p className="text-base leading-6 text-muted-foreground md:text-sm md:leading-5">
              {side}
            </p>
          </aside>
        )}
      </div>
    </div>
  );
}

export { PinLayout };
export type { PinLayoutProps };
