import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import type {
  MemberOpenBill,
  MemberPointsQuote,
  MemberPointsRedeemStatus,
} from "@starter/shared/crm";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api/errors";
import { useOnlineStatus } from "@/features/ws06-inventory/hpp-hooks";
import { useMemberOverview } from "@/features/ws08-member/hooks";
import { QrTokenDialog } from "@/features/ws08-member/components/qr-token-dialog";
import { formatCountdown, secondsLeft } from "@/features/ws08-member/qr-token";
import {
  useCheckRedeemStatus,
  useMemberOpenBills,
  useMemberPointsQuote,
  useMintRedeemQr,
  useRedeemStatus,
} from "../hooks";
import { OpenBillView, PointsAfterView } from "./open-bill-view";
import { PointsPicker } from "./points-picker";
import { RedeemQrPanel } from "./redeem-qr-panel";
import { StatusView } from "./status-view";

// A mint that gets no answer in this long counts as failed: the member must
// never wait on a spinner while the cashier waits on a QR.
const MINT_TIMEOUT_MS = 15_000;

// The QR step carries a snapshot of the bill and quote it was minted for: the
// server may settle the bill or change the quote the moment the cashier scans,
// and the screens after the scan still describe what the member chose.
type Snapshot = { bill: MemberOpenBill; quote: MemberPointsQuote };
// A minted token. The page keeps the latest one as `outstanding` until the
// server settles it, even after the member leaves the QR step: a live token
// may still be scanned, so no second one is minted meanwhile.
type Issued = {
  points: number;
  token: string;
  expiresAt: string;
} & Snapshot;
type Step =
  | { name: "bill" }
  | { name: "pick" }
  | ({ name: "qr"; expired: boolean } & Issued)
  | ({ name: "failed"; points: number } & Snapshot)
  | ({
      name: "consumed";
      points: number;
      status: MemberPointsRedeemStatus;
    } & Snapshot);

function consumedFrom(current: Issued, result: MemberPointsRedeemStatus): Step {
  return {
    name: "consumed",
    points: result.points ?? current.points,
    status: result,
    bill: current.bill,
    quote: current.quote,
  };
}

function isNetworkError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 0;
}

// Redeem points at the till (brief 1165, flow A): bill -> pick -> qr, with the
// outcomes around it. This is the only component in the flow that reads data;
// the views below only render what it hands them.
export function TukarPoinPage() {
  const t = useT();
  const navigate = useNavigate();
  const online = useOnlineStatus();
  const overviewQuery = useMemberOverview();
  const billsQuery = useMemberOpenBills();
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [step, setStep] = useState<Step>({ name: "bill" });
  const [lastPoints, setLastPoints] = useState<number | undefined>();
  const [outstanding, setOutstanding] = useState<Issued | null>(null);
  const [pickSyncing, setPickSyncing] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [checking, setChecking] = useState(false);
  const [checkFailed, setCheckFailed] = useState(false);
  const [memberQrOpen, setMemberQrOpen] = useState(false);
  const memberQrOpener = useRef<HTMLElement | null>(null);

  const bills = billsQuery.data;
  const activeOrderId =
    bills === undefined
      ? null
      : bills.some((candidate) => candidate.orderId === selectedOrderId)
        ? selectedOrderId
        : bills.length === 1
          ? bills[0].orderId
          : null;
  const bill = bills?.find((candidate) => candidate.orderId === activeOrderId);
  const quoteQuery = useMemberPointsQuote(activeOrderId);
  const quote = quoteQuery.data;

  const mint = useMintRedeemQr();
  const check = useCheckRedeemStatus();
  const mintAttempt = useRef(0);
  const mintTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(mintTimer.current), []);

  const qrStep = step.name === "qr" ? step : null;
  // Polls the outstanding token on every step until the server says it is
  // consumed, expired, or invalid.
  const statusQuery = useRedeemStatus(
    outstanding
      ? { orderId: outstanding.bill.orderId, token: outstanding.token }
      : null,
    { poll: outstanding !== null && online },
  );
  const status = statusQuery.data;
  // Settled by the server: move the step on while rendering (state derived
  // from the poll result, not synced from an effect).
  if (status && outstanding) {
    if (status.state === "consumed") {
      setStep(consumedFrom(outstanding, status));
      setOutstanding(null);
    } else if (status.state === "invalid") {
      const { points, bill: issuedBill, quote: issuedQuote } = outstanding;
      setStep((current) =>
        current.name === "qr"
          ? {
              name: "failed",
              points,
              bill: issuedBill,
              quote: issuedQuote,
            }
          : current,
      );
      setOutstanding(null);
    } else if (status.state === "expired") {
      setStep((current) =>
        current.name === "qr" ? { ...current, expired: true } : current,
      );
      setOutstanding(null);
    }
  }

  // Countdown for the picker's "still valid" note.
  const hasOutstanding = outstanding !== null;
  useEffect(() => {
    if (!hasOutstanding) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [hasOutstanding]);

  // Focus follows the step. The first settled view keeps the page's own
  // focus order; later changes land on the new panel's title.
  const viewKey = `${step.name}:${qrStep?.expired ?? ""}`;
  const regionRef = useRef<HTMLDivElement>(null);
  const settled = useRef(false);
  useEffect(() => {
    if (!settled.current) {
      settled.current = true;
      return;
    }
    const section = regionRef.current?.querySelector(
      "section[aria-labelledby]",
    );
    const titleId = section?.getAttribute("aria-labelledby");
    if (titleId) document.getElementById(titleId)?.focus();
  }, [viewKey]);

  // The quote is the freshest balance; the overview only fills in before it.
  const balanceKnown =
    quote?.balancePoints ?? overviewQuery.data?.profile.pointsBalance ?? null;
  const memberName = overviewQuery.data?.profile.name;

  function leave() {
    void navigate({ to: "/member/poin" });
  }

  // One check for the three "is it settled?" buttons: ask the server about the
  // token when there is one, then re-read the bill, quote and balance.
  async function verify() {
    setChecking(true);
    setCheckFailed(false);
    try {
      if (step.name === "qr") {
        const result = await check.mutateAsync({
          orderId: step.bill.orderId,
          token: step.token,
        });
        if (result.state === "consumed") {
          setStep(consumedFrom(step, result));
          setOutstanding(null);
          return;
        }
        if (result.state === "invalid") {
          setOutstanding(null);
          setStep({
            name: "failed",
            points: step.points,
            bill: step.bill,
            quote: step.quote,
          });
          return;
        }
        if (result.state === "expired") setOutstanding(null);
      }
      // The overview is read too but never blocks the flow: the quote carries
      // the balance.
      const [billsRead, quoteRead] = await Promise.all([
        billsQuery.refetch(),
        activeOrderId === null ? undefined : quoteQuery.refetch(),
        overviewQuery.refetch(),
      ]);
      if (billsRead.isError || quoteRead?.isError) {
        setCheckFailed(true);
        return;
      }
      // A failed or expired attempt is over once the server has answered; a
      // live QR or an open picker stays where it is.
      setStep((current) =>
        current.name === "failed" || (current.name === "qr" && current.expired)
          ? { name: "bill" }
          : current,
      );
    } catch {
      setCheckFailed(true);
    } finally {
      setChecking(false);
    }
  }

  function enterPick() {
    // The quote may be stale (balance, remaining amount): ask again before the
    // member types a number against it.
    setPickSyncing(true);
    setStep({ name: "pick" });
    void quoteQuery.refetch().finally(() => setPickSyncing(false));
  }

  function submitPoints(points: number) {
    if (!bill || !quote || outstanding) return;
    const attempt = ++mintAttempt.current;
    const snapshot: Snapshot = { bill, quote };
    setLastPoints(points);
    setCheckFailed(false);
    const fail = () => {
      window.clearTimeout(mintTimer.current);
      if (mintAttempt.current !== attempt) return;
      mintAttempt.current += 1;
      mint.reset();
      setStep({ name: "failed", points, ...snapshot });
    };
    window.clearTimeout(mintTimer.current);
    mintTimer.current = window.setTimeout(fail, MINT_TIMEOUT_MS);
    mint.mutate(
      { orderId: bill.orderId, points },
      {
        onSuccess: (result) => {
          window.clearTimeout(mintTimer.current);
          if (mintAttempt.current !== attempt) return;
          const issued: Issued = {
            points,
            token: result.token,
            expiresAt: result.expiresAt,
            ...snapshot,
          };
          setNowMs(Date.now());
          setOutstanding(issued);
          setStep({ name: "qr", expired: false, ...issued });
        },
        onError: fail,
      },
    );
  }

  function refreshBills() {
    void billsQuery.refetch();
    if (activeOrderId !== null) void quoteQuery.refetch();
    void overviewQuery.refetch();
  }

  function showMemberQr() {
    memberQrOpener.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setMemberQrOpen(true);
  }

  // While a minted token may still be scanned, the picker cannot mint another.
  const blockedReason = outstanding
    ? secondsLeft(outstanding.expiresAt, nowMs) > 0
      ? t("member.tukarPoin.page.outstandingBlocked", {
          time: formatCountdown(secondsLeft(outstanding.expiresAt, nowMs)),
        })
      : t("member.tukarPoin.page.outstandingChecking")
    : undefined;

  function renderBody() {
    if (step.name === "consumed") {
      return (
        <RedeemQrPanel
          bill={step.bill}
          points={step.points}
          quote={step.quote}
          view="consumed"
          token={null}
          expiresAt={null}
          status={step.status}
          onExpired={() => undefined}
          onCheckStatus={() => undefined}
          checking={false}
          onBack={leave}
          onDone={leave}
        />
      );
    }

    const offline =
      !online ||
      isNetworkError(billsQuery.error) ||
      isNetworkError(quoteQuery.error);
    if (offline) {
      return (
        <StatusView
          variant="offline"
          memberName={memberName}
          balancePoints={balanceKnown}
          onAction={() => void verify()}
          actionBusy={checking}
        />
      );
    }

    const reading = step.name === "bill" || step.name === "pick";
    if (
      reading &&
      (billsQuery.isPending || (step.name === "pick" && pickSyncing))
    ) {
      return (
        <StatusView
          variant="loading"
          memberName={memberName}
          balancePoints={null}
        />
      );
    }
    // A failed overview read does not block: the quote carries the balance.
    const readFailed =
      billsQuery.isError || (bill !== undefined && quoteQuery.isError);
    if (reading && (readFailed || bills === undefined)) {
      return (
        <StatusView
          variant="error"
          memberName={memberName}
          balancePoints={balanceKnown}
          onAction={refreshBills}
        />
      );
    }

    if (step.name === "qr" || step.name === "failed") {
      const expired = step.name === "qr" && step.expired;
      return (
        <RedeemQrPanel
          bill={step.bill}
          points={step.points}
          quote={step.quote}
          view={
            step.name === "failed" ? "failed" : expired ? "expired" : "active"
          }
          token={step.name === "qr" ? step.token : null}
          expiresAt={step.name === "qr" ? step.expiresAt : null}
          status={null}
          onExpired={() =>
            setStep((current) =>
              current.name === "qr" ? { ...current, expired: true } : current,
            )
          }
          onCheckStatus={() => void verify()}
          checking={checking}
          onBack={() =>
            step.name === "qr" && expired
              ? setStep({ name: "bill" })
              : enterPick()
          }
          onDone={leave}
        />
      );
    }

    const otherBill =
      bills !== undefined && bills.length > 1 && activeOrderId !== null ? (
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setSelectedOrderId(null);
            setLastPoints(undefined);
          }}
        >
          {t("member.tukarPoin.page.chooseOtherBill")}
        </Button>
      ) : null;

    if (bill !== undefined && bill.pointsRedeemed !== null) {
      // Balance after the redemption comes from the fresh quote, never from the
      // overview (stale) or a made-up 0: wait for it.
      if (quote === undefined) {
        return (
          <StatusView
            variant="loading"
            memberName={memberName}
            balancePoints={null}
          />
        );
      }
      return (
        <>
          <PointsAfterView bill={bill} balancePoints={quote.balancePoints} />
          {otherBill}
        </>
      );
    }

    if (
      step.name === "pick" &&
      bill !== undefined &&
      quote !== undefined &&
      quote.refusal === null
    ) {
      return (
        <PointsPicker
          bill={bill}
          quote={quote}
          initialPoints={lastPoints}
          blockedReason={blockedReason}
          submitting={mint.isPending}
          onSubmit={submitPoints}
          onBack={() => setStep({ name: "bill" })}
        />
      );
    }

    return (
      <>
        <OpenBillView
          bills={bills ?? []}
          selectedOrderId={activeOrderId}
          quote={quote ?? null}
          balancePoints={overviewQuery.data?.profile.pointsBalance}
          pointValueIdr={overviewQuery.data?.program.pointValueIdr}
          memberName={memberName}
          onSelect={setSelectedOrderId}
          onChoosePoints={enterPick}
          onShowMemberQr={showMemberQr}
          onRefresh={refreshBills}
          refreshing={billsQuery.isFetching || quoteQuery.isFetching}
        />
        {otherBill}
      </>
    );
  }

  return (
    <div className="grid gap-6">
      <header className="grid gap-2">
        <Link
          to="/member/poin"
          className="-ml-2 inline-flex min-h-11 w-fit items-center gap-1 rounded-control px-2 text-sm leading-5 font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
          {t("member.tukarPoin.page.back")}
        </Link>
        <h1 className="font-brand type-display-xl">
          {t("member.tukarPoin.page.title")}
        </h1>
        <p className="max-w-prose text-sm leading-5 text-muted-foreground">
          {t("member.tukarPoin.page.subtitle")}
        </p>
      </header>

      <div ref={regionRef} className="grid gap-4">
        {renderBody()}
        {checkFailed && (
          <p role="alert" className="text-sm leading-5 text-danger">
            {t("member.tukarPoin.page.checkFailed")}
          </p>
        )}
      </div>

      {/* The identity QR (mockup qr-member) opens from the bill screens; the
          dialog is the one 1150 built, with an empty body (no order, no points). */}
      <QrTokenDialog
        open={memberQrOpen}
        onOpenChange={(open) => {
          setMemberQrOpen(open);
          if (!open) {
            const opener = memberQrOpener.current;
            window.setTimeout(() => opener?.focus(), 0);
          }
        }}
        trigger={
          <button type="button" hidden tabIndex={-1} aria-hidden="true" />
        }
      />
    </div>
  );
}
