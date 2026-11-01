// Waiter actions: "Panggil waiter", "Minta tagihan", the open requests and the
// path to the bill (PRD §3 F10 "Panggil Waiter & Minta Tagihan", ORD-07; a
// closed or voided session cannot send, ORD-04).
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { Check, Clock, Receipt } from "lucide-react";
import type {
  ServiceRequest,
  TableSessionStatus,
} from "@starter/shared/qr-order";
import type { MessageKey } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CallWaiterSheet } from "./call-waiter-sheet";
import { RequestBillDialog } from "./request-bill-dialog";

const REASON_LABEL = {
  add_order: "qrOrders.status.waiter.kind.addOrder",
  utensils: "qrOrders.status.waiter.kind.utensils",
  complaint: "qrOrders.status.waiter.kind.complaint",
  other: "qrOrders.status.waiter.kind.other",
} as const satisfies Record<string, MessageKey>;

function requestKind(request: ServiceRequest): MessageKey {
  if (request.type === "request_bill")
    return "qrOrders.status.waiter.kind.requestBill";
  if (request.type === "complaint")
    return "qrOrders.status.waiter.kind.complaint";
  return REASON_LABEL[request.reason ?? "other"];
}

function RequestRow({ request }: { request: ServiceRequest }) {
  const t = useT();
  const acknowledged = request.status === "acknowledged";
  return (
    <li className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
      <span className="text-sm leading-5 font-medium">
        {t(requestKind(request))}
      </span>
      <Badge tone={acknowledged ? "success" : "warning"}>
        {acknowledged ? (
          <Check aria-hidden="true" />
        ) : (
          <Clock aria-hidden="true" />
        )}
        {acknowledged
          ? t("qrOrders.status.waiter.acknowledged")
          : t("qrOrders.status.waiter.pending")}
      </Badge>
    </li>
  );
}

export function WaiterActions({
  sessionId,
  qrToken,
  sessionStatus,
  openServiceRequests,
}: {
  sessionId: string;
  qrToken: string;
  sessionStatus: TableSessionStatus;
  openServiceRequests: readonly ServiceRequest[];
}) {
  const t = useT();
  const [billSent, setBillSent] = React.useState(false);
  const closed = sessionStatus === "closed" || sessionStatus === "voided";
  const requests = openServiceRequests.filter(
    (request) =>
      request.status === "pending" || request.status === "acknowledged",
  );
  const billRequested =
    billSent ||
    sessionStatus === "bill_requested" ||
    requests.some((request) => request.type === "request_bill");

  return (
    <section
      aria-labelledby="waiter-actions-heading"
      className="grid gap-3 rounded-xl border bg-card p-card"
    >
      <h2
        id="waiter-actions-heading"
        className="text-lg leading-7 font-semibold"
      >
        {t("qrOrders.status.waiter.heading")}
      </h2>
      <div className="grid gap-2 sm:grid-cols-2">
        <CallWaiterSheet sessionId={sessionId} disabled={closed} />
        {billRequested ? (
          <Button variant="outline" disabled>
            <Receipt aria-hidden="true" />
            {t("qrOrders.status.waiter.billRequestedButton")}
          </Button>
        ) : (
          <RequestBillDialog
            sessionId={sessionId}
            disabled={closed}
            onRequested={() => setBillSent(true)}
          />
        )}
      </div>
      {billRequested && !closed && (
        <Button asChild variant="link" className="w-fit">
          <Link to="/t/$token/bill" params={{ token: qrToken }}>
            {t("qrOrders.status.waiter.viewBill")}
          </Link>
        </Button>
      )}
      {closed && (
        <p className="text-sm leading-5 text-muted-foreground">
          {t("qrOrders.status.waiter.closedNote")}
        </p>
      )}
      {requests.length > 0 && (
        <ul
          aria-label={t("qrOrders.status.waiter.requestsLabel")}
          className="divide-y border-t pt-3"
        >
          {requests.map((request) => (
            <RequestRow key={request.id} request={request} />
          ))}
        </ul>
      )}
    </section>
  );
}
