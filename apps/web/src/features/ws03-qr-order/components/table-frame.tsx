// The customer shell for a table journey (/t/$token/*), "final arah A +
// liquid glass" (legend-2re1, design/mockups/README.md, founder Q3–Q6).
// The whole journey runs in the QR theme scope (tokens.css
// [data-surface="qr"]): warm ivory canvas, coffee ink, one rust action.
// Light only: the approved palette and its glass contrast were verified on
// light, and photos read best on it (DESIGN.md "Tema QR pelanggan").
// The brand's active Tenant Theme (menu.theme) overrides the brand tokens, font
// and corners inside this scope; without one the QR theme stays as is.
//
// Phones get no global header or bottom nav: each page owns one floating
// glass bar on top (menu header or QrTopBar) and one at the bottom (cart bar
// or QrFooter), so a screen never stacks more than two blur regions. From lg
// up the frame shows one glass header with the table sections; pages then
// render plain titles.
import { useState, type ReactNode } from "react";
import { CircleHelp } from "lucide-react";
import { cn } from "cn";
import { useT } from "@/components/i18n";
import { RouterShellLink } from "@/components/layout/router-link";
import { ThemeScope } from "@/components/theme-scope";
import { TenantThemeStyle } from "@/lib/theme";
import type { TenantThemeConfig } from "@starter/shared/theme";
import { TableJourneyProvider, useTableJourney } from "../context";
import { QrPhotoBand, QrSampleBadge } from "./glass/qr-primitives";
import { CallWaiterSheet } from "./orders/call-waiter-sheet";

// Fixed scope id: the theme CSS is rendered inside this frame only, and the
// API sends no slug.
const QR_TENANT_ID = "qr-menu";

function DesktopHeader({ pathname }: { pathname: string }) {
  const t = useT();
  const { qrToken, menu, sessionId, ended } = useTableJourney();
  const [logoFailed, setLogoFailed] = useState(false);
  const base = `/t/${encodeURIComponent(qrToken)}`;
  const section = pathname.slice(base.length).split("/")[1] ?? "";
  const activeKey = ["orders", "issue", "pay", "kasir", "bayar"].includes(
    section,
  )
    ? "orders"
    : ["bill", "review"].includes(section)
      ? "bill"
      : ["", "cart", "checkout"].includes(section)
        ? ""
        : null;
  const items = [
    { key: "", label: t("qrGlass.table.nav.menu"), href: base },
    {
      key: "orders",
      label: t("qrGlass.table.nav.orders"),
      href: `${base}/orders`,
    },
    { key: "bill", label: t("qrGlass.table.nav.bill"), href: `${base}/bill` },
  ];
  return (
    <header className="sticky top-5 z-40 hidden px-8 lg:block">
      <div className="qr-glass mx-auto flex h-18 max-w-[86rem] items-center gap-6 rounded-qr-float px-6">
        <RouterShellLink
          href={base}
          className="min-w-0 truncate rounded-xs text-[1.75rem] leading-tight font-bold tracking-[-0.03em]"
        >
          {menu?.theme?.logoUrl && !logoFailed ? (
            <img
              src={menu.theme.logoUrl}
              alt={menu.brand.name}
              width={192}
              height={36}
              onError={() => setLogoFailed(true)}
              className="h-9 w-auto max-w-48 object-contain"
            />
          ) : (
            (menu?.brand.name ?? t("app.defaultBrand"))
          )}
        </RouterShellLink>
        <QrSampleBadge className="shrink-0" />
        <nav
          aria-label={t("qrGlass.table.nav.label")}
          className="ms-auto flex items-center gap-1"
        >
          {items.map((item) => {
            const current = item.key === activeKey;
            return (
              <RouterShellLink
                key={item.key}
                href={item.href}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "relative inline-flex h-11 items-center rounded-md px-4 text-[1.0625rem] font-medium text-qr-glass-muted hover:text-foreground",
                  current &&
                    "font-semibold text-foreground after:absolute after:inset-x-4 after:bottom-1 after:h-0.5 after:rounded-full after:bg-foreground",
                )}
              >
                {item.label}
              </RouterShellLink>
            );
          })}
        </nav>
        {sessionId && !ended && (
          <>
            <span aria-hidden="true" className="h-7 w-px bg-input/60" />
            <CallWaiterSheet
              sessionId={sessionId}
              disabled={false}
              variant="ghost"
              icon={CircleHelp}
            />
          </>
        )}
      </div>
    </header>
  );
}

function Frame({
  pathname,
  children,
}: {
  pathname: string;
  children: ReactNode;
}) {
  const { menu, qrToken } = useTableJourney();
  const bandPhoto = menu?.items.find((item) => item.photoUrl)?.photoUrl;
  // The band sits behind the top glass only: the tall menu header on the menu,
  // the slim page nav elsewhere, so no page text ever lands on the photo.
  const base = `/t/${encodeURIComponent(qrToken)}`;
  const onMenu = pathname.slice(base.length).replace(/\/$/, "") === "";
  const theme = menu?.theme;
  const tenantTheme: TenantThemeConfig | null =
    menu && theme
      ? {
          id: QR_TENANT_ID,
          name: menu.brand.name,
          colors: theme.tokens,
          font: theme.fontFamily,
          corners: theme.corners,
          logoUrl: theme.logoUrl,
        }
      : null;
  return (
    <ThemeScope
      density="hangat"
      mode="light"
      tenant={tenantTheme ? QR_TENANT_ID : undefined}
      data-surface="qr"
      className="relative isolate min-h-dvh bg-background"
    >
      {tenantTheme ? <TenantThemeStyle tenant={tenantTheme} /> : null}
      <QrPhotoBand src={bandPhoto} size={onMenu ? "menu" : "page"} />
      <DesktopHeader pathname={pathname} />
      <main className="mx-auto grid w-full max-w-[90rem] grid-cols-[minmax(0,1fr)] content-start gap-4 px-4 pt-3 pb-4 lg:px-14 lg:pt-8 lg:pb-8">
        {children}
      </main>
    </ThemeScope>
  );
}

export function TableCustomerFrame({
  qrToken,
  pathname,
  children,
}: {
  qrToken: string;
  pathname: string;
  /** Sign-in / sign-out control of the generic shells; the QR journey
   * invites sign-in where it pays off (points after payment) instead. */
  signedIn?: ReactNode;
  children: ReactNode;
}) {
  return (
    <TableJourneyProvider qrToken={qrToken}>
      <Frame pathname={pathname}>{children}</Frame>
    </TableJourneyProvider>
  );
}
