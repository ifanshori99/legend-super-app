// "Tagihan": the session bill, split bill, pay my share and claim points
// (legend-woz; PRD §3 F10 "Split Bill", "Klaim Poin per Orang", "Kontrol Open
// Bill"; §4 flows A and B). Totals come from the server bill (ORD-03).
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { CircleCheck, ReceiptText, WifiOff } from "lucide-react";
import type { BillSplit, GuestPaymentTarget } from "@starter/shared/qr-order";
import { DEFAULT_TIME_ZONE } from "@starter/shared/core";
import { useT } from "@/components/i18n";
import { StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useOnline } from "@/lib/use-online";
import { canSplitBill, splitScope } from "../../domain.ts";
import { useTableJourney } from "../../context";
import { useSendServiceRequest, useSessionBill } from "../../hooks";
import { BillTotals, MinimumSpendStatus } from "./bill-totals";
import { ClaimCard } from "./claim-card";
import { PayDialog } from "./pay-dialog";
import { SplitList, liveSplits } from "./split-list";
import { SplitPanel } from "./split-panel";

function BillSkeleton() {
  const t = useT();
  return (
    <div aria-busy="true" className="grid gap-4">
      <span className="sr-only">{t("qrOrders.bill.loading")}</span>
      <Skeleton className="h-7 w-40" />
      <div className="grid gap-3 rounded-container border-(length:--border-w) bg-card p-card shadow-hairline">
        {[0, 1, 2, 3, 4].map((row) => (
          <div key={row} className="flex items-center justify-between gap-3">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-4 w-20" />
          </div>
        ))}
      </div>
      <Skeleton className="h-14 w-full rounded-control" />
    </div>
  );
}

export function BillPage() {
  const t = useT();
  const online = useOnline();
  const { qrToken, menu, guest, sessionId, participantId, view, openJoin } =
    useTableJourney();
  const bill = useSessionBill(sessionId);
  const requestBill = useSendServiceRequest(sessionId ?? "none");
  const [changing, setChanging] = useState(false);
  const [pay, setPay] = useState<{
    target: GuestPaymentTarget;
    amountIdr: number;
  } | null>(null);

  const heading = (
    <h1 className="type-display-xl">{t("qrOrders.bill.title")}</h1>
  );

  if (guest === null || sessionId === null)
    return (
      <div className="grid gap-4">
        {heading}
        <EmptyState
          icon={ReceiptText}
          title={t("qrOrders.bill.joinTitle")}
          description={t("qrOrders.bill.joinHint")}
          action={
            <Button onClick={() => openJoin()}>
              {t("qrOrders.bill.joinAction")}
            </Button>
          }
        />
      </div>
    );

  if (bill.isPending)
    return (
      <div className="grid gap-4">
        {heading}
        <BillSkeleton />
      </div>
    );

  if (bill.isError)
    return (
      <div className="grid gap-4">
        {heading}
        <ErrorState
          title={t("qrOrders.bill.errorTitle")}
          description={t("qrOrders.bill.errorHint")}
          onRetry={() => void bill.refetch()}
        />
      </div>
    );

  const data = bill.data.data;
  if (data.orders.length === 0)
    return (
      <div className="grid gap-4">
        {heading}
        <EmptyState
          icon={ReceiptText}
          title={t("qrOrders.bill.emptyTitle")}
          description={t("qrOrders.bill.emptyHint")}
          action={
            <Button asChild>
              <Link to="/t/$token" params={{ token: qrToken }}>
                {t("qrOrders.bill.emptyAction")}
              </Link>
            </Button>
          }
        />
      </div>
    );

  const session = view?.session;
  const participants = session?.participants ?? [];
  const participantIds = participants.map((p) => p.id);
  const sessionStatus = session?.status ?? "open";
  const outstanding = data.totals.outstandingIdr;
  const splits = liveSplits(data);
  const hasPaidSplit = splits.some((split) => split.status === "paid");
  const closed = sessionStatus === "closed" || sessionStatus === "voided";
  const canSplit =
    canSplitBill({ sessionStatus, outstandingIdr: outstanding }) &&
    splitScope(data.orders, data.totals.paidIdr) !== null;
  const openBill =
    (menu?.zone.paymentMode ?? session?.paymentMode) === "open_bill";
  const settled = outstanding === 0;
  const showSplitPanel = canSplit && (splits.length === 0 || changing);

  const payShare = (split: BillSplit) =>
    setPay({
      target: { kind: "split", billSplitId: split.id },
      amountIdr: split.amountIdr,
    });

  return (
    <div className="grid gap-6">
      {heading}

      {!online && (
        <p
          role="status"
          className="flex items-start gap-2 rounded-container bg-warning-subtle p-3 text-sm text-warning"
        >
          <WifiOff className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {t("qrOrders.bill.offline")}
        </p>
      )}
      {closed && (
        <p role="status" className="rounded-container bg-surface-2 p-3 text-sm">
          {t("qrOrders.bill.sessionClosed")}
        </p>
      )}

      <BillTotals bill={data} />
      {openBill && (
        <MinimumSpendStatus
          requiredIdr={menu?.zone.minimumSpendIdr ?? 0}
          bill={data}
        />
      )}

      {openBill && !closed && !settled && (
        <div className="grid gap-2" aria-live="polite">
          {sessionStatus === "bill_requested" ? (
            <>
              <StatusPill status="success">
                {t("qrOrders.bill.billRequested")}
              </StatusPill>
              <p className="text-sm text-muted-foreground">
                {t("qrOrders.bill.billRequestedHint")}
              </p>
            </>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                loading={requestBill.isPending}
                onClick={() => requestBill.mutate({ type: "request_bill" })}
              >
                {t("qrOrders.bill.requestBill")}
              </Button>
              {requestBill.isError && (
                <p role="alert" className="text-sm font-medium text-danger">
                  {t("qrOrders.bill.requestBillFailed")}
                </p>
              )}
            </>
          )}
        </div>
      )}

      {settled ? (
        <Card className="grid gap-3">
          <div className="flex items-center gap-2">
            <CircleCheck className="size-5 text-success" aria-hidden="true" />
            <h2 className="type-title">{t("qrOrders.bill.settledTitle")}</h2>
          </div>
          <p className="text-sm text-muted-foreground">
            {t("qrOrders.bill.settledHint")}
          </p>
          <Button asChild variant="outline">
            <Link to="/t/$token/review" params={{ token: qrToken }}>
              {t("qrOrders.bill.reviewAction")}
            </Link>
          </Button>
        </Card>
      ) : (
        !closed && (
          <>
            {splits.length > 0 && (
              <SplitList
                bill={data}
                participantIds={participantIds}
                myParticipantId={participantId}
                onPay={payShare}
              />
            )}
            {splits.length > 0 && !changing && (
              <div className="grid gap-1">
                {hasPaidSplit ? (
                  <p className="text-sm text-muted-foreground">
                    {t("qrOrders.bill.changeSplitLocked")}
                  </p>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setChanging(true)}
                  >
                    {t("qrOrders.bill.changeSplit")}
                  </Button>
                )}
              </div>
            )}
            {showSplitPanel && (
              <SplitPanel
                sessionId={sessionId}
                bill={data}
                participants={participants}
                myParticipantId={participantId}
                onDone={() => setChanging(false)}
              />
            )}
            {splits.length === 0 && !showSplitPanel && (
              <section className="grid gap-2">
                <h2 className="sr-only">{t("qrOrders.bill.payTitle")}</h2>
                <Button
                  type="button"
                  size="lg"
                  onClick={() =>
                    setPay({ target: { kind: "bill" }, amountIdr: outstanding })
                  }
                >
                  {t("qrOrders.bill.payAll")}
                </Button>
                <p className="text-sm text-muted-foreground">
                  {t("qrOrders.bill.payAllHint")}
                </p>
              </section>
            )}
          </>
        )
      )}

      <ClaimCard
        sessionId={sessionId}
        timeZone={menu?.outlet.timeZone ?? DEFAULT_TIME_ZONE}
      />

      <PayDialog
        open={pay !== null}
        onOpenChange={(open) => !open && setPay(null)}
        qrToken={qrToken}
        sessionId={sessionId}
        target={pay?.target ?? null}
        amountIdr={pay?.amountIdr ?? 0}
      />
    </div>
  );
}
