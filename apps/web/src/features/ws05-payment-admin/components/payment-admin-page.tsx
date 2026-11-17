// Payment back office (PRD §3 F13): gateway routing, EDC terminals and the
// cashier default tender, refunds with approval, unallocated funds (PAY-04)
// and settlement reconciliation cases (EDC-06). Each tab loads its own data,
// so opening the page never fires six requests at once (only the open-hold
// count for the tab badge loads up front).
import {
  Banknote,
  CreditCard,
  Route,
  Scale,
  ShieldAlert,
  Undo2,
} from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { API_MOCK } from "@/lib/api/mock-flag";
import { useRefundReconHolds } from "../hooks";
import { EdcPanel } from "./edc-panel";
import { ReconciliationPanel } from "./reconciliation-panel";
import { RefundHoldsPanel } from "./refund-holds-panel";
import { RefundsPanel } from "./refunds-panel";
import { RoutingPanel } from "./routing-panel";
import { UnallocatedPanel } from "./unallocated-panel";

export function PaymentAdminPage() {
  const t = useT();
  // Same query (and cache entry) the tab opens with, so the badge is free.
  const openHolds = useRefundReconHolds("open");
  const openHoldCount = openHolds.data?.data.length ?? 0;
  const moreHolds = Boolean(openHolds.data?.meta.nextCursor);
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

      <Tabs defaultValue="routing">
        <TabsList>
          <TabsTrigger value="routing">
            <Route aria-hidden="true" />
            {t("paymentAdmin.tabs.routing")}
          </TabsTrigger>
          <TabsTrigger value="edc">
            <CreditCard aria-hidden="true" />
            {t("paymentAdmin.tabs.edc")}
          </TabsTrigger>
          <TabsTrigger value="refunds">
            <Undo2 aria-hidden="true" />
            {t("paymentAdmin.tabs.refunds")}
          </TabsTrigger>
          <TabsTrigger value="unallocated">
            <Banknote aria-hidden="true" />
            {t("paymentAdmin.tabs.unallocated")}
          </TabsTrigger>
          <TabsTrigger value="reconciliation">
            <Scale aria-hidden="true" />
            {t("paymentAdmin.tabs.reconciliation")}
          </TabsTrigger>
          <TabsTrigger value="refund-holds">
            <ShieldAlert aria-hidden="true" />
            {t("paymentAdmin.tabs.refundHolds")}
            {openHoldCount > 0 && (
              <Badge tone="warning">
                {openHoldCount}
                {moreHolds ? "+" : ""}
                <span className="sr-only">
                  {" "}
                  {t("paymentAdmin.refundHolds.openCount")}
                </span>
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="routing">
          <RoutingPanel />
        </TabsContent>
        <TabsContent value="edc">
          <EdcPanel />
        </TabsContent>
        <TabsContent value="refunds">
          <RefundsPanel />
        </TabsContent>
        <TabsContent value="unallocated">
          <UnallocatedPanel />
        </TabsContent>
        <TabsContent value="reconciliation">
          <ReconciliationPanel />
        </TabsContent>
        <TabsContent value="refund-holds">
          <RefundHoldsPanel />
        </TabsContent>
      </Tabs>
    </section>
  );
}
