// Payment back office (PRD §3 F13): gateway routing, EDC terminals and the
// cashier default tender, refunds with approval, unallocated funds (PAY-04)
// and settlement reconciliation cases (EDC-06). Each tab loads its own data,
// so opening the page never fires six requests at once.
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
import { API_MOCK } from "@/lib/api/mock-flag";
import { ANONYMOUS_ACCESS, type AreaAccess } from "@/lib/areas/access";
import { visiblePaymentAdminTabs, type PaymentAdminTab } from "../lib";
import { DuitkuCredentialsPanel } from "./duitku-credentials-panel";
import { EdcPanel } from "./edc-panel";
import { ReconciliationPanel } from "./reconciliation-panel";
import { RefundsPanel } from "./refunds-panel";
import { RoutingPanel } from "./routing-panel";
import { UnallocatedPanel } from "./unallocated-panel";

export function PaymentAdminPage() {
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
  const show = (tab: PaymentAdminTab) => tabs.includes(tab);
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

      <Tabs defaultValue={tabs[0]}>
        <TabsList>
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
        {show("routing") && (
          <TabsContent value="routing">
            <RoutingPanel />
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
