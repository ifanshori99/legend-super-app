import { useEffect, useEffectEvent, useRef, useState } from "react";
import { formatNumber, formatRupiah } from "@starter/shared/i18n";
import type {
  MemberOpenBill,
  MemberPointsQuote,
  MemberPointsRedeemStatus,
} from "@starter/shared/crm";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { QrCode } from "@/components/ui/qr-code";
import { formatCountdown, secondsLeft } from "@/features/ws08-member/qr-token";
import { BillCard } from "./bill-card";
import {
  BigAmount,
  Eyebrow,
  FlowGrid,
  Note,
  Panel,
  SummaryBox,
  SummaryRow,
} from "./flow-parts";

export type RedeemQrView = "active" | "expired" | "failed" | "consumed";

// Under this many seconds the QR also says, in words, that it is ending.
const WARN_SECONDS = 15;
const TITLE_ID = "redeem-qr-title";

// Redeem step 3 (legend-0ne0z): the QR for one bill and one amount of points,
// plus the three outcomes around it. Presentational: the page owns the token,
// the mint, and the status checks. The QR renders only while `view` is
// "active" and a server token is present, never from a guess.
export function RedeemQrPanel({
  bill,
  points,
  quote,
  view,
  token,
  expiresAt,
  status,
  onExpired,
  onCheckStatus,
  checking,
  onBack,
  onDone,
}: {
  bill: MemberOpenBill;
  points: number;
  quote: MemberPointsQuote;
  view: RedeemQrView;
  token: string | null;
  expiresAt: string | null;
  status: MemberPointsRedeemStatus | null;
  onExpired: () => void;
  onCheckStatus: () => void;
  checking: boolean;
  onBack: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const headingRef = useRef<HTMLHeadingElement>(null);
  // The panel swaps content in place; move focus to its title on each step.
  useEffect(() => {
    headingRef.current?.focus();
  }, [view]);

  const discountIdr = points * quote.pointValueIdr;
  const heading = (text: string) => (
    <h2
      id={TITLE_ID}
      ref={headingRef}
      tabIndex={-1}
      className="font-brand type-title outline-none"
    >
      {text}
    </h2>
  );

  if (view === "consumed") {
    const usedPoints = status?.points ?? points;
    const usedIdr = status?.discountIdr ?? discountIdr;
    const remaining = status?.remainingIdr ?? bill.remainingIdr - usedIdr;
    const balance = status?.balancePoints ?? quote.balancePoints - usedPoints;
    return (
      <FlowGrid
        context={
          <div className="grid content-start gap-3">
            <Eyebrow>{t("member.tukarPoin.qr.consumedContextEyebrow")}</Eyebrow>
            <h2 className="font-brand type-title">
              {t("member.tukarPoin.qr.consumedTitle", {
                points: formatNumber(usedPoints),
              })}
            </h2>
            <p className="text-muted-foreground">
              {t("member.tukarPoin.qr.consumedSub", {
                outlet: bill.outletName,
              })}
            </p>
            <SummaryBox>
              <p className="text-sm text-muted-foreground">
                {t("member.tukarPoin.qr.balanceLeft")}
              </p>
              <BigAmount>
                {t("member.tukarPoin.qr.pointsValue", {
                  points: formatNumber(balance),
                })}
              </BigAmount>
              <p className="text-sm text-muted-foreground">
                {t("member.tukarPoin.qr.balanceMath", {
                  before: formatNumber(balance + usedPoints),
                  points: formatNumber(usedPoints),
                })}
              </p>
            </SummaryBox>
          </div>
        }
        panel={
          <Panel labelledBy={TITLE_ID}>
            <div className="grid gap-1">
              <Eyebrow>{t("member.tukarPoin.qr.consumedEyebrow")}</Eyebrow>
              {heading(t("member.tukarPoin.qr.consumedPanelTitle"))}
            </div>
            <SummaryBox>
              <SummaryRow
                label={t("member.tukarPoin.qr.remainingBefore")}
                value={formatRupiah(remaining + usedIdr)}
              />
              <SummaryRow
                label={t("member.tukarPoin.qr.discountLine", {
                  points: formatNumber(usedPoints),
                })}
                value={formatRupiah(-usedIdr)}
              />
              <SummaryRow
                strong
                label={t("member.tukarPoin.qr.remainingBill")}
                value={formatRupiah(remaining)}
              />
            </SummaryBox>
            <p>
              {t("member.tukarPoin.qr.consumedNext", {
                amount: formatRupiah(remaining),
              })}
            </p>
            <Note tone="success">
              {t("member.tukarPoin.qr.consumedNote", {
                points: formatNumber(usedPoints),
              })}
            </Note>
            <Button className="min-h-11 w-full" onClick={onDone}>
              {t("member.tukarPoin.qr.backToPoints")}
            </Button>
          </Panel>
        }
      />
    );
  }

  // No token from the server yet: never draw a QR, say the status is unknown.
  const effective: RedeemQrView =
    view === "active" && (!token || !expiresAt) ? "failed" : view;

  if (effective === "expired") {
    return (
      <FlowGrid
        context={<BillCard bill={bill} />}
        panel={
          <Panel labelledBy={TITLE_ID}>
            <div className="grid gap-1">
              <Eyebrow>{t("member.tukarPoin.qr.expiredEyebrow")}</Eyebrow>
              {heading(t("member.tukarPoin.qr.expiredTitle"))}
            </div>
            <p>
              {t("member.tukarPoin.qr.expiredBody", {
                points: formatNumber(points),
              })}
            </p>
            <SummaryBox>
              <SummaryRow
                label={t("member.tukarPoin.qr.chosenPoints")}
                value={t("member.tukarPoin.qr.pointsValue", {
                  points: formatNumber(points),
                })}
              />
              <SummaryRow
                strong
                label={t("member.tukarPoin.qr.discountValue")}
                value={formatRupiah(discountIdr)}
              />
            </SummaryBox>
            <Note tone="warning">{t("member.tukarPoin.qr.expiredNote")}</Note>
            <Button
              className="min-h-11 w-full"
              loading={checking}
              onClick={onCheckStatus}
            >
              {t("member.tukarPoin.qr.checkStatus")}
            </Button>
          </Panel>
        }
      />
    );
  }

  if (effective === "failed") {
    return (
      <FlowGrid
        context={<BillCard bill={bill} />}
        panel={
          <Panel labelledBy={TITLE_ID}>
            <div className="grid gap-1">
              <Eyebrow>{t("member.tukarPoin.qr.failedEyebrow")}</Eyebrow>
              {heading(t("member.tukarPoin.qr.failedTitle"))}
            </div>
            <p>{t("member.tukarPoin.qr.failedBody")}</p>
            <Note tone="warning">{t("member.tukarPoin.qr.failedNote")}</Note>
            <SummaryBox>
              <SummaryRow
                strong
                label={t("member.tukarPoin.qr.requestedPoints")}
                value={t("member.tukarPoin.qr.pointsValue", {
                  points: formatNumber(points),
                })}
              />
              <p className="text-sm text-muted-foreground">
                {t("member.tukarPoin.qr.failedRecheck")}
              </p>
            </SummaryBox>
            <Button
              className="min-h-11 w-full"
              loading={checking}
              onClick={onCheckStatus}
            >
              {t("member.tukarPoin.qr.checkRedeemStatus")}
            </Button>
          </Panel>
        }
      />
    );
  }

  // Active: both are set here (narrowed by `effective`).
  const context = <ActiveContext bill={bill} points={points} quote={quote} />;
  return (
    <div className="grid gap-6">
      <FlowGrid
        context={<div className="hidden md:block">{context}</div>}
        panel={
          <Panel labelledBy={TITLE_ID}>
            <div className="grid gap-1">
              <Eyebrow>{t("member.tukarPoin.qr.activeEyebrow")}</Eyebrow>
              {heading(t("member.tukarPoin.qr.activeTitle"))}
              <p className="text-muted-foreground">
                {t("member.tukarPoin.qr.activeIntro", {
                  points: formatNumber(points),
                })}
              </p>
            </div>
            <CompactBill bill={bill} points={points} quote={quote} />
            <ActiveQr
              token={token as string}
              expiresAt={expiresAt as string}
              label={t("member.tukarPoin.qr.qrLabel", {
                points: formatNumber(points),
                bill: bill.billNumber,
              })}
              onExpired={onExpired}
            />
            <Note>{t("member.tukarPoin.qr.shareWarning")}</Note>
            <Button
              variant="outline"
              className="min-h-11 w-full"
              onClick={onBack}
            >
              {t("member.tukarPoin.qr.back")}
            </Button>
          </Panel>
        }
      />
      <details className="group border-t border-border pt-3 md:hidden">
        <summary className="flex min-h-11 cursor-pointer items-center font-semibold">
          {t("member.tukarPoin.qr.detailsToggle")}
        </summary>
        <div className="pt-3">{context}</div>
      </details>
    </div>
  );
}

function ActiveContext({
  bill,
  points,
  quote,
}: {
  bill: MemberOpenBill;
  points: number;
  quote: MemberPointsQuote;
}) {
  const t = useT();
  const discountIdr = points * quote.pointValueIdr;
  return (
    <div className="grid content-start gap-4">
      <div className="grid gap-1">
        <Eyebrow>{t("member.tukarPoin.qr.confirmEyebrow")}</Eyebrow>
        <h2 className="font-brand type-title">
          {t("member.tukarPoin.qr.confirmTitle", {
            points: formatNumber(points),
            value: formatRupiah(discountIdr),
          })}
        </h2>
        <p className="text-muted-foreground">
          {t("member.tukarPoin.qr.confirmSub")}
        </p>
      </div>
      <BillCard bill={bill} />
      <SummaryBox>
        <SummaryRow
          label={t("member.tukarPoin.qr.remainingNow")}
          value={formatRupiah(quote.remainingIdr)}
        />
        <SummaryRow
          label={t("member.tukarPoin.qr.remainingAfter")}
          value={formatRupiah(quote.remainingIdr - discountIdr)}
        />
        <SummaryRow
          strong
          label={t("member.tukarPoin.qr.balanceAfter")}
          value={t("member.tukarPoin.qr.pointsValue", {
            points: formatNumber(quote.balancePoints - points),
          })}
        />
      </SummaryBox>
      <Note>{t("member.tukarPoin.qr.notDeducted")}</Note>
    </div>
  );
}

// Phone only: the short bill line that sits above the QR; the full context is
// in the disclosure below the card.
function CompactBill({
  bill,
  points,
  quote,
}: {
  bill: MemberOpenBill;
  points: number;
  quote: MemberPointsQuote;
}) {
  const t = useT();
  const outlet = bill.outletArea
    ? t("member.tukarPoin.qr.outletArea", {
        outlet: bill.outletName,
        area: bill.outletArea,
      })
    : bill.outletName;
  const ref = bill.tableLabel
    ? t("member.tukarPoin.qr.billRefTable", {
        number: bill.billNumber,
        table: bill.tableLabel,
      })
    : t("member.tukarPoin.qr.billRef", { number: bill.billNumber });
  return (
    <div className="grid gap-1 border-y border-border py-3 md:hidden">
      <p className="font-semibold">{outlet}</p>
      <p>{ref}</p>
      <p className="flex items-baseline justify-between gap-3">
        <span>{t("member.tukarPoin.qr.remainingNow")}</span>
        <span className="font-semibold tabular">
          {formatRupiah(quote.remainingIdr)}
        </span>
      </p>
      <p className="font-semibold">
        {t("member.tukarPoin.qr.confirmTitle", {
          points: formatNumber(points),
          value: formatRupiah(points * quote.pointValueIdr),
        })}
      </p>
    </div>
  );
}

function ActiveQr({
  token,
  expiresAt,
  label,
  onExpired,
}: {
  token: string;
  expiresAt: string;
  label: string;
  onExpired: () => void;
}) {
  const t = useT();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const firedFor = useRef<string | null>(null);
  const fireExpired = useEffectEvent(onExpired);

  // Tick once a second. Timers are throttled in background tabs, so also
  // re-read the clock when the tab becomes visible or the window regains focus.
  useEffect(() => {
    const tick = () => setNowMs(Date.now());
    const onVisibility = () => {
      if (document.visibilityState === "visible") tick();
    };
    tick();
    const id = window.setInterval(tick, 1000);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", tick);
    };
  }, [expiresAt]);

  const remaining = secondsLeft(expiresAt, nowMs);
  useEffect(() => {
    if (remaining > 0 || firedFor.current === expiresAt) return;
    firedFor.current = expiresAt;
    fireExpired();
  }, [remaining, expiresAt]);

  const time = formatCountdown(remaining);
  const ending = remaining > 0 && remaining <= WARN_SECONDS;
  return (
    <div className="grid gap-4">
      <div className="flex min-h-56 items-center justify-center">
        {remaining > 0 && (
          <QrCode
            value={token}
            label={label}
            size={208}
            className="rounded-container border p-3"
          />
        )}
      </div>
      <SummaryBox>
        <div className="flex items-baseline justify-between gap-3">
          <span>{t("member.tukarPoin.qr.timerLabel")}</span>
          <span
            role="timer"
            aria-live="off"
            aria-label={t("member.tukarPoin.qr.timerSr", { time })}
            className="font-brand text-3xl font-bold tabular"
          >
            {time}
          </span>
        </div>
        <p className="text-sm text-muted-foreground">
          {t("member.tukarPoin.qr.onceHint")}
        </p>
      </SummaryBox>
      {/* The warning mounts only near the end, so it is announced once. */}
      <div role="status" aria-live="polite">
        {ending && (
          <p className="text-sm font-semibold">
            {t("member.tukarPoin.qr.endingSoon")}
          </p>
        )}
      </div>
    </div>
  );
}
