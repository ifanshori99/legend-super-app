// Page shell for every payslip PIN screen (bead legend-ilzrj; mockups
// design/mockups/payslip-pin/*-mobile|desktop.png): back link, eyebrow, h1 and
// one sentence, then the task card with an info panel on its right at desktop
// width, stacked under it on mobile. The back link is passed in by the page
// because each screen returns to a different place (as PageHeader does).
import type { ReactNode } from "react";
import { useT } from "@/components/i18n";
import { Card } from "@/components/ui/card";

type PinLayoutProps = {
  /** Card heading (h2). */
  title: string;
  /** One sentence under the card heading. */
  description?: string;
  /** Info panel text; the panel is omitted when empty. */
  side?: ReactNode;
  /** "hr" swaps the page heading to the HR reset wording. */
  variant?: "employee" | "hr";
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
  variant = "employee",
  backLink,
  children,
  busy,
}: PinLayoutProps) {
  const t = useT();
  const hr = variant === "hr";

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6">
      {backLink}
      <header className="grid gap-1">
        <p className="text-xs font-bold tracking-widest text-muted-foreground uppercase">
          {t(hr ? "payslipPin.layout.hrEyebrow" : "payslipPin.layout.eyebrow")}
        </p>
        <h1 className="font-brand type-display-xl">
          {t(hr ? "payslipPin.layout.hrTitle" : "payslipPin.layout.title")}
        </h1>
        <p className="text-sm leading-5 text-muted-foreground">
          {t(
            hr ? "payslipPin.layout.hrSubtitle" : "payslipPin.layout.subtitle",
          )}
        </p>
      </header>
      <div className="grid items-start gap-4 md:grid-cols-[minmax(0,1fr)_20rem] md:gap-7">
        <Card aria-busy={busy || undefined} className="gap-4 md:p-8">
          <div className="grid gap-1">
            <h2 className="font-brand type-title">{title}</h2>
            {description && (
              <p className="text-sm leading-5 text-muted-foreground">
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
            <p className="text-sm leading-5 text-muted-foreground">{side}</p>
          </aside>
        )}
      </div>
    </div>
  );
}

export { PinLayout };
export type { PinLayoutProps };
