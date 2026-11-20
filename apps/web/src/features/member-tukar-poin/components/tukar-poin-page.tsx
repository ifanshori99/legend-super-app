import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
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
import { memberKeys } from "@/features/ws08-member/queries";
import {
  formatCountdown,
  localExpiry,
  secondsLeft,
} from "@/features/ws08-member/qr-token";
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
  const queryClient = useQueryClient();
  const online = useOnlineStatus();
  const overviewQuery = useMemberOverview();
  const billsQuery = useMemberOpenBills();
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [step, setStep] = useState<Step>({ name: "bill" });
  const [lastPoints, setLastPoints] = useState<number | undefined>();
  const [outstanding, setOutstanding] = useState<Issued | null>(null);
  const [mintInFlight, setMintInFlight] = useState(false);
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

  // Consumed at the till: balance, bills and quotes all changed. Invalidated
  // here, at the transition itself, because once `outstanding` is cleared the
  // status query's own data is gone and its hook never sees the result.
  useEffect(() => {
    if (step.name === "consumed")
      void queryClient.invalidateQueries({ queryKey: memberKeys.all });
  }, [step, queryClient]);

  // Countdown for the picker's "still valid" note.
  const hasOutstanding = outstanding !== null;
  useEffect(() => {
    if (!hasOutstanding) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [hasOutstanding]);

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
      // Ask about the live token wherever the member is: it may have been
      // minted late (after a failed view) or be left over from the QR step.
      if (outstanding) {
        const result = await check.mutateAsync({
          orderId: outstanding.bill.orderId,
          token: outstanding.token,
        });
        if (result.state === "consumed") {
          setStep(consumedFrom(outstanding, result));
          setOutstanding(null);
          return;
        }
        if (result.state === "invalid") {
          setOutstanding(null);
          if (step.name === "qr") {
            setStep({
              name: "failed",
              points: step.points,
              bill: step.bill,
              quote: step.quote,
            });
            return;
          }
        } else if (result.state === "expired") {
          setOutstanding(null);
          // The server ended it before the local timer did.
          if (step.name === "qr" && !step.expired) {
            setStep({ ...step, expired: true });
            return;
          }
        } else if (step.name === "failed") {
          // Still pending: the late QR is valid, show it with what is left.
          setStep({ name: "qr", expired: false, ...outstanding });
          return;
        }
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
      // The server answered and no token is known: a mint that never came back
      // may start over. A late answer still lands as `outstanding` and blocks.
      if (!outstanding && !mint.isPending) setMintInFlight(false);
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
    if (!bill || !quote || outstanding || mintInFlight) return;
    const attempt = ++mintAttempt.current;
    const snapshot: Snapshot = { bill, quote };
    const startedAt = Date.now();
    setLastPoints(points);
    setCheckFailed(false);
    setMintInFlight(true);
    const fail = () => {
      // A stale attempt must not cancel the newer attempt's timer.
      if (mintAttempt.current !== attempt) return;
      window.clearTimeout(mintTimer.current);
      mintAttempt.current += 1;
      mint.reset();
      setStep({ name: "failed", points, ...snapshot });
    };
    window.clearTimeout(mintTimer.current);
    mintTimer.current = window.setTimeout(fail, MINT_TIMEOUT_MS);
    // mutateAsync, not mutate callbacks: after the timeout the mutation is
    // reset, and an answer that still arrives must not be lost.
    mint.mutateAsync({ orderId: bill.orderId, points }).then(
      (result) => {
        // A newer attempt may already be in flight: leave its flag alone.
        if (mintAttempt.current <= attempt + 1) setMintInFlight(false);
        const onTime = mintAttempt.current === attempt;
        if (onTime) window.clearTimeout(mintTimer.current);
        // A late token is real and may be scanned: keep it as outstanding (it
        // blocks a new mint and is polled) but leave the view on "failed" until
        // the member checks. Its clock runs from the request, not the answer.
        const issued: Issued = {
          points,
          token: result.token,
          expiresAt: onTime ? result.expiresAt : localExpiry(startedAt),
          ...snapshot,
        };
        setNowMs(Date.now());
        // An on-time answer is the QR on screen, so it always becomes the token
        // that is polled; a late one only fills an empty slot.
        setOutstanding(onTime ? issued : (current) => current ?? issued);
        if (onTime) setStep({ name: "qr", expired: false, ...issued });
      },
      () => {
        if (mintAttempt.current <= attempt + 1) setMintInFlight(false);
        fail();
      },
    );
  }

  function refreshBills() {
    setCheckFailed(false);
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

  // While a minted token may still be scanned (or a mint is unanswered), the
  // picker cannot mint another. With a known token the member can ask the server
  // what became of it.
  const outstandingSeconds = outstanding
    ? secondsLeft(outstanding.expiresAt, nowMs)
    : 0;
  // A mint that never answered leaves no token to ask about: the check then
  // re-reads the bill, and only a clean answer frees the picker.
  const mintHung = mintInFlight && !mint.isPending;
  const counting = outstanding !== null && outstandingSeconds > 0;
  const blockedText = counting
    ? t("member.tukarPoin.page.outstandingBlocked", {
        time: formatCountdown(outstandingSeconds),
      })
    : outstanding || mintHung
      ? t("member.tukarPoin.page.outstandingChecking")
      : null;
  const blockedReason =
    blockedText === null ? undefined : (
      <span className="grid gap-2">
        {counting ? (
          <>
            {/* The ticking time stays out of the live region: screen readers get
                a static sentence, sighted members the countdown. */}
            <span className="sr-only">
              {t("member.tukarPoin.page.outstandingBlockedSr")}
            </span>
            <span aria-hidden="true">{blockedText}</span>
          </>
        ) : (
          <span>{blockedText}</span>
        )}
        {(outstanding || mintHung) && step.name !== "qr" ? (
          <Button
            type="button"
            variant="outline"
            className="min-h-11 w-fit"
            disabled={checking}
            onClick={() => void verify()}
          >
            {checking
              ? t("member.tukarPoin.page.outstandingCheckBusy")
              : t("member.tukarPoin.page.outstandingCheckAction")}
          </Button>
        ) : null}
        {checkFailed ? (
          <span role="alert">{t("member.tukarPoin.page.checkFailed")}</span>
        ) : null}
      </span>
    );

  // The view that renders, keyed so focus can follow it; `inlineCheck` marks a
  // view that shows a failed status check next to its own button.
  function view(key: string, node: ReactNode, inlineCheck = false) {
    return { key, node, inlineCheck };
  }

  function renderBody() {
    const pointsUncertain = outstanding !== null || mintHung;
    if (step.name === "consumed") {
      return view(
        "consumed",
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
        />,
      );
    }

    const offline =
      !online ||
      isNetworkError(billsQuery.error) ||
      isNetworkError(quoteQuery.error);
    if (offline) {
      return view(
        "offline",
        <StatusView
          variant="offline"
          memberName={memberName}
          balancePoints={balanceKnown}
          onAction={() => void verify()}
          actionBusy={checking}
          checkFailed={checkFailed}
        />,
        true,
      );
    }

    const reading = step.name === "bill" || step.name === "pick";
    if (
      reading &&
      (billsQuery.isPending || (step.name === "pick" && pickSyncing))
    ) {
      return view(
        "loading",
        <StatusView
          variant="loading"
          memberName={memberName}
          balancePoints={null}
        />,
      );
    }
    // A failed overview read does not block: the quote carries the balance.
    const readFailed =
      billsQuery.isError || (bill !== undefined && quoteQuery.isError);
    if (reading && (readFailed || bills === undefined)) {
      return view(
        "error",
        <StatusView
          variant="error"
          memberName={memberName}
          balancePoints={balanceKnown}
          pointsUncertain={pointsUncertain}
          onAction={refreshBills}
        />,
      );
    }

    if (step.name === "qr" || step.name === "failed") {
      const expired = step.name === "qr" && step.expired;
      return view(
        `${step.name}:${expired ? "expired" : "active"}`,
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
          checkFailed={checkFailed}
          onBack={() =>
            step.name === "qr" && expired
              ? setStep({ name: "bill" })
              : enterPick()
          }
          onDone={leave}
        />,
        expired || step.name === "failed",
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
        return view(
          "points-after-loading",
          <StatusView
            variant="loading"
            memberName={memberName}
            balancePoints={null}
          />,
        );
      }
      return view(
        "points-after",
        <>
          <PointsAfterView bill={bill} balancePoints={quote.balancePoints} />
          {otherBill}
        </>,
      );
    }

    if (
      step.name === "pick" &&
      bill !== undefined &&
      quote !== undefined &&
      quote.refusal === null
    ) {
      return view(
        "picker",
        <PointsPicker
          bill={bill}
          quote={quote}
          initialPoints={lastPoints}
          blockedReason={blockedReason}
          submitting={mint.isPending}
          onSubmit={submitPoints}
          onBack={() => setStep({ name: "bill" })}
        />,
        blockedReason !== undefined,
      );
    }

    return view(
      "bill",
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
      </>,
    );
  }

  const body = renderBody();

  // Focus follows the view that renders (loading, offline, picker, qr, ...),
  // not just the step. The first render keeps the page's own focus order.
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
  }, [body.key]);

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
        {body.node}
        {checkFailed && !body.inlineCheck && (
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
