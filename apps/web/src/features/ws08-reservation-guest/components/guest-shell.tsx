// Frame for the guest manage-reservation page (legend-g12il): the QR theme
// (warm paper, one rust action), one reading column, no site navigation. The
// link token never reaches this frame; it only prints the brand and two notes.
import * as React from "react";
import { useT } from "@/components/i18n";
import { ThemeScope } from "@/components/theme-scope";

export function GuestShell({
  brand,
  children,
}: {
  /** Brand name from the public site payload; null while it is unknown. */
  brand: string | null;
  children: React.ReactNode;
}) {
  const t = useT();
  return (
    <ThemeScope
      density="hangat"
      mode="light"
      data-surface="qr"
      className="min-h-dvh bg-background"
    >
      <div className="mx-auto flex min-h-dvh w-full max-w-[42.5rem] flex-col px-gutter pt-5 pb-10 sm:pt-12">
        {/* Fixed min height: the header does not shift when the brand arrives. */}
        <header className="flex min-h-12 items-center justify-between gap-4 border-b border-border pb-4">
          {brand ? (
            <span className="inline-flex items-center gap-2 text-xl font-bold">
              <span
                aria-hidden="true"
                className="size-2 shrink-0 rounded-full bg-primary"
              />
              {brand}
            </span>
          ) : (
            <span />
          )}
          <span className="text-sm text-muted-foreground">
            {t("reservationGuest.shell.section")}
          </span>
        </header>
        <main
          id="main-content"
          className="flex flex-1 flex-col gap-6 py-6 outline-none"
        >
          {children}
        </main>
        <footer className="grid gap-2 border-t border-border pt-5 text-sm text-muted-foreground">
          <p>{t("reservationGuest.shell.footerKeep")}</p>
          <p>{t("reservationGuest.shell.footerHelp")}</p>
        </footer>
      </div>
    </ThemeScope>
  );
}
