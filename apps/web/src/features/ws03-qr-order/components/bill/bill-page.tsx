// "Tagihan": the session bill, split bill, pay my share and claim points
// (legend-woz; PRD §3 F10 "Split Bill", "Klaim Poin per Orang", "Kontrol Open
// Bill"; §4 flows A and B). Totals come from the server bill (ORD-03).
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { CircleAlert, CircleCheck, ReceiptText } from "lucide-react";
import type { BillSplit, GuestPaymentTarget } from "@starter/shared/qr-order";
import { DEFAULT_TIME_ZONE } from "@starter/shared/core";
import { useT } from "@/components/i18n";
import { StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useOnline } from "@/lib/use-online";
import { QrFooter } from "../glass/qr-primitives";
import { Notice } from "../notice";
import { QrSubPage } from "../session-states";
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
      <div className="qr-paper grid gap-3 p-4">
        {[0, 1, 2, 3, 4].map((row) => (
          <div key={row} className="flex items-center justify-between gap-3">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-4 w-20" />
          </div>
        ))}
      </div>
      <Skeleton className="h-14 w-full rounded-qr-float" />
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

  const title = t("qrOrders.bill.title");

  if (guest === null || sessionId === null)
    return (
      <QrSubPage title={title}>
        <EmptyState
          icon={ReceiptText}
          className="qr-paper"
          title={t("qrOrders.bill.joinTitle")}
          description={t("qrOrders.bill.joinHint")}
          action={
            <Button onClick={() => openJoin()}>
              {t("qrOrders.bill.joinAction")}
            </Button>
          }
        />
      </QrSubPage>
    );

  if (bill.isPending)
    return (
      <QrSubPage title={title}>
        <BillSkeleton />
      </QrSubPage>
    );

  if (bill.isError)
    return (
      <QrSubPage title={title}>
        <ErrorState
          className="qr-paper"
          title={t("qrOrders.bill.errorTitle")}
          description={t("qrOrders.bill.errorHint")}
          onRetry={() => void bill.refetch()}
        />
      </QrSubPage>
    );

  const data = bill.data.data;
  if (data.orders.length === 0)
    return (
      <QrSubPage title={title}>
        <EmptyState
          icon={ReceiptText}
          className="qr-paper"
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
      </QrSubPage>
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
  // The one main action of the screen: pay the whole bill, in the footer.
  const showPayAll =
    !settled && !closed && splits.length === 0 && !showSplitPanel;

  const payShare = (split: BillSplit) =>
    setPay({
      target: { kind: "split", billSplitId: split.id },
      amountIdr: split.amountIdr,
    });

  return (
    <QrSubPage title={title} className="gap-5">
      {!online && <Notice tone="warning" title={t("qrOrders.bill.offline")} />}
      {closed && (
        <Notice tone="info" title={t("qrOrders.bill.sessionClosed")} />
      )}

      <BillTotals bill={data} />
      {openBill && (
        <MinimumSpendStatus
          requiredIdr={menu?.zone.minimumSpendIdr ?? 0}
          bill={data}
        />
      )}

      {openBill && !closed && !settled && (
        <div className="qr-paper grid gap-2 p-4" aria-live="polite">
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
                <p
                  role="alert"
                  className="flex items-start gap-2 rounded-qr-media border-l-[3px] border-danger bg-danger-subtle p-3 text-sm font-medium text-foreground"
                >
                  <CircleAlert
                    className="mt-0.5 size-4 shrink-0 text-danger"
                    aria-hidden="true"
                  />
                  {t("qrOrders.bill.requestBillFailed")}
                </p>
              )}
            </>
          )}
        </div>
      )}

      {settled ? (
        <section
          aria-labelledby="bill-settled"
          className="qr-paper grid gap-3 p-4"
        >
          <div className="flex items-center gap-2">
            <CircleCheck className="size-5 text-success" aria-hidden="true" />
            <h2 id="bill-settled" className="type-title">
              {t("qrOrders.bill.settledTitle")}
            </h2>
          </div>
          <p className="text-sm text-muted-foreground">
            {t("qrOrders.bill.settledHint")}
          </p>
          <Button asChild>
            <Link to="/t/$token/review" params={{ token: qrToken }}>
              {t("qrOrders.bill.reviewAction")}
            </Link>
          </Button>
        </section>
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

      {showPayAll && (
        <QrFooter>
          <section aria-labelledby="bill-pay" className="grid gap-2">
            <h2 id="bill-pay" className="sr-only">
              {t("qrOrders.bill.payTitle")}
            </h2>
            <Button
              type="button"
              size="lg"
              onClick={() =>
                setPay({ target: { kind: "bill" }, amountIdr: outstanding })
              }
            >
              {t("qrOrders.bill.payAll")}
            </Button>
            <p className="text-center text-sm text-muted-foreground">
              {t("qrOrders.bill.payAllHint")}
            </p>
          </section>
        </QrFooter>
      )}
    </QrSubPage>
  );
}
