// The customer shell for a table journey (/t/$token/*): tenant brand in the
// header, "Meja A03 · 4 tamu" as context, and the four-item bottom nav
// (Menu, Keranjang, Pesanan, Tagihan) with the live cart count. Rendered by
// AreaFrame in place of the generic customer nav (PRD §5, area "customer").
import type { ReactNode } from "react";
import {
  ClipboardList,
  Receipt,
  ShoppingBasket,
  UtensilsCrossed,
} from "lucide-react";
import { useT } from "@/components/i18n";
import { OfflineBannerSlot } from "@/components/layout/offline-banner-slot";
import { RouterShellLink } from "@/components/layout/router-link";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { CustomerShell } from "@/components/shells/customer-shell";
import type { ShellNavItem } from "@/components/shells/nav";
import { IssuePrompt } from "./recovery";
import { JoinDialog } from "./join-dialog";
import { TableJourneyProvider, useTableJourney } from "../context";

function Frame({
  pathname,
  signedIn,
  children,
}: {
  pathname: string;
  signedIn: ReactNode;
  children: ReactNode;
}) {
  const t = useT();
  const { qrToken, menu, cartCount } = useTableJourney();
  const base = `/t/${encodeURIComponent(qrToken)}`;
  const section = pathname.slice(base.length).split("/")[1] ?? "";
  const items: Array<ShellNavItem & { key: string }> = [
    { key: "", label: t("qrMenu.nav.menu"), href: base, icon: UtensilsCrossed },
    {
      key: "cart",
      label: t("qrMenu.nav.cart"),
      href: `${base}/cart`,
      icon: ShoppingBasket,
      count: cartCount,
    },
    {
      key: "orders",
      label: t("qrMenu.nav.orders"),
      href: `${base}/orders`,
      icon: ClipboardList,
    },
    {
      key: "bill",
      label: t("qrMenu.nav.bill"),
      href: `${base}/bill`,
      icon: Receipt,
    },
  ];
  const activeKey = ["cart", "checkout"].includes(section)
    ? "cart"
    : ["orders", "issue", "pay"].includes(section)
      ? "orders"
      : ["bill", "review"].includes(section)
        ? "bill"
        : "";
  const nav: ShellNavItem[] = items.map(({ key, ...item }) => ({
    ...item,
    current: key === activeKey,
  }));
  const context = menu
    ? t("qrMenu.tableOnly", { table: menu.table.code })
    : undefined;

  return (
    <CustomerShell
      brandName={menu?.brand.name ?? t("app.defaultBrand")}
      context={context}
      nav={nav}
      LinkComponent={RouterShellLink}
      actions={
        <>
          <ThemeToggle />
          {signedIn}
        </>
      }
    >
      <OfflineBannerSlot />
      <div className="grid gap-4">
        <IssuePrompt />
        {children}
      </div>
      <JoinDialog />
    </CustomerShell>
  );
}

export function TableCustomerFrame({
  qrToken,
  pathname,
  signedIn,
  children,
}: {
  qrToken: string;
  pathname: string;
  signedIn: ReactNode;
  children: ReactNode;
}) {
  return (
    <TableJourneyProvider qrToken={qrToken}>
      <Frame pathname={pathname} signedIn={signedIn}>
        {children}
      </Frame>
    </TableJourneyProvider>
  );
}
