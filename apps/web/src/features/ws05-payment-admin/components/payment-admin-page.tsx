// Payment back office (PRD §3 F13): gateway routing, EDC terminals and the
// cashier default tender, refunds with approval, unallocated funds (PAY-04)
// and settlement reconciliation cases (EDC-06). Each tab loads its own data,
// so opening the page never fires six requests at once.
import { useEffect, useRef, useState } from "react";
import {
  Banknote,
  CreditCard,
  KeyRound,
  Route,
  Scale,
  Undo2,
} from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRouteContext } from "@tanstack/react-router";
import { cn } from "cn";
import { API_MOCK } from "@/lib/api/mock-flag";
import { ANONYMOUS_ACCESS, type AreaAccess } from "@/lib/areas/access";
import { visiblePaymentAdminTabs, type PaymentAdminTab } from "../lib";
import { DuitkuCredentialsPanel } from "./duitku-credentials-panel";
import { EdcPanel } from "./edc-panel";
import { ReconciliationPanel } from "./reconciliation-panel";
import { RefundsPanel } from "./refunds-panel";
import { RoutingPanel } from "./routing-panel";
import { UnallocatedPanel } from "./unallocated-panel";

/**
 * The tab to show for the `?tab=` value: the requested one when this account
 * may see it, otherwise the first visible tab (unknown ids, a tab the
 * permissions hide, or no `tab` at all). Undefined when no tab is visible.
 */
export function resolvePaymentAdminTab(
  requested: string | undefined,
  visible: readonly PaymentAdminTab[],
): PaymentAdminTab | undefined {
  return visible.find((tab) => tab === requested) ?? visible[0];
}

// The strip is wider than a 390px phone: fade the edge that still has tabs
// behind it, and keep the active tab in view. Fades are decoration only.
function useTabStrip(active: string | undefined) {
  const listRef = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState({ start: false, end: false });

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => {
      const start = list.scrollLeft > 1;
      const end = list.scrollLeft + list.clientWidth < list.scrollWidth - 1;
      setMore((prev) =>
        prev.start === start && prev.end === end ? prev : { start, end },
      );
    };
    measure();
    list.addEventListener("scroll", measure, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure);
    observer?.observe(list);
    return () => {
      list.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, []);

  useEffect(() => {
    const tab = listRef.current?.querySelector<HTMLElement>(
      '[role="tab"][data-state="active"]',
    );
    const reduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    tab?.scrollIntoView?.({
      block: "nearest",
      inline: "nearest",
      behavior: reduced ? "auto" : "smooth",
    });
  }, [active]);

  return { listRef, more };
}

const fadeClass =
  "pointer-events-none absolute inset-y-px z-10 w-8 from-surface-2 to-transparent transition-opacity duration-(--duration-fast) motion-reduce:transition-none";

export function PaymentAdminPage({
  tab,
  onTabChange,
}: {
  /** Requested tab from the URL (`?tab=`); unknown or hidden ids fall back. */
  tab?: string;
  onTabChange?: (tab: PaymentAdminTab) => void;
}) {
  const t = useT();
  // Each tab shows only for the permission its API needs (routing:
  // org.settings.manage, sub-302 D14; Duitku: org.integration.manage, D15-D16;
  // see PAYMENT_ADMIN_TABS). Presentation only; the API re-checks.
  const { access } = useRouteContext({ strict: false }) as {
    access?: AreaAccess;
  };
  const tabs = visiblePaymentAdminTabs(
    (access ?? ANONYMOUS_ACCESS).permissions,
  );
  const show = (id: PaymentAdminTab) => tabs.includes(id);
  const active = resolvePaymentAdminTab(tab, tabs);
  const { listRef, more } = useTabStrip(active);
  return (
    <section
      aria-labelledby="payment-admin-title"
      className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <h2 id="payment-admin-title" className="sr-only">
            {t("paymentAdmin.title")}
          </h2>
          <p className="max-w-3xl text-sm leading-5 text-muted-foreground">
            {t("paymentAdmin.subtitle")}
          </p>
        </div>
        {API_MOCK && <Badge tone="neutral">{t("common.sampleData")}</Badge>}
      </div>

      <Tabs
        value={active}
        onValueChange={(next) => {
          const id = tabs.find((entry) => entry === next);
          if (id) onTabChange?.(id);
        }}
      >
        <div className="relative w-fit max-w-full">
          <TabsList ref={listRef} className="max-w-full">
            {show("routing") && (
              <TabsTrigger value="routing">
                <Route aria-hidden="true" />
                {t("paymentAdmin.tabs.routing")}
              </TabsTrigger>
            )}
            {show("duitku") && (
              <TabsTrigger value="duitku">
                <KeyRound aria-hidden="true" />
                {t("paymentAdmin.tabs.duitku")}
              </TabsTrigger>
            )}
            {show("edc") && (
              <TabsTrigger value="edc">
                <CreditCard aria-hidden="true" />
                {t("paymentAdmin.tabs.edc")}
              </TabsTrigger>
            )}
            {show("refunds") && (
              <TabsTrigger value="refunds">
                <Undo2 aria-hidden="true" />
                {t("paymentAdmin.tabs.refunds")}
              </TabsTrigger>
            )}
            {show("unallocated") && (
              <TabsTrigger value="unallocated">
                <Banknote aria-hidden="true" />
                {t("paymentAdmin.tabs.unallocated")}
              </TabsTrigger>
            )}
            {show("reconciliation") && (
              <TabsTrigger value="reconciliation">
                <Scale aria-hidden="true" />
                {t("paymentAdmin.tabs.reconciliation")}
              </TabsTrigger>
            )}
          </TabsList>
          <div
            aria-hidden="true"
            className={cn(
              fadeClass,
              "left-px rounded-l-control bg-linear-to-r",
              more.start ? "opacity-100" : "opacity-0",
            )}
          />
          <div
            aria-hidden="true"
            className={cn(
              fadeClass,
              "right-px rounded-r-control bg-linear-to-l",
              more.end ? "opacity-100" : "opacity-0",
            )}
          />
        </div>
        {show("routing") && (
          <TabsContent value="routing">
            <RoutingPanel
              onOpenTab={show("duitku") ? onTabChange : undefined}
            />
          </TabsContent>
        )}
        {show("duitku") && (
          <TabsContent value="duitku">
            <DuitkuCredentialsPanel />
          </TabsContent>
        )}
        {show("edc") && (
          <TabsContent value="edc">
            <EdcPanel />
          </TabsContent>
        )}
        {show("refunds") && (
          <TabsContent value="refunds">
            <RefundsPanel />
          </TabsContent>
        )}
        {show("unallocated") && (
          <TabsContent value="unallocated">
            <UnallocatedPanel />
          </TabsContent>
        )}
        {show("reconciliation") && (
          <TabsContent value="reconciliation">
            <ReconciliationPanel />
          </TabsContent>
        )}
      </Tabs>
    </section>
  );
}
