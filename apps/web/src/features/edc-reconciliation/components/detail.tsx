// Detail of one flagged EDC transaction (bead legend-khi8n): header, the
// evidence on the terminal receipt, and the resolve form beside it. The
// receipt is built only from the transaction's own fields; nothing here
// decides whether the charge happened. The form and the server do that.
import * as React from "react";
import { CircleAlert, CircleCheck, CircleHelp, Clock } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Money } from "@/components/ui/money";
import type { MessageKey } from "@starter/shared/i18n";
import type { EdcReconciliationQueueItem } from "@starter/shared/payment/admin";
import { ageMinutes, displayId, reconciliationGate } from "../lib";
import {
  formatMomentWib,
  ResolveForm,
  type ReconciliationGate,
} from "./resolve-form";

const P = "edcRecon.resolve";
const key = (suffix: string) => `${P}.${suffix}` as MessageKey;

/**
 * Re-reads the clock so the 10-minute window opens without a reload. Null on
 * the server render and until mounted, so hydration matches.
 */
function useNowMs(intervalMs = 15_000): number | null {
  const [now, setNow] = React.useState<number | null>(null);
  React.useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = window.setTimeout(tick, 0);
    const timer = window.setInterval(tick, intervalMs);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [intervalMs]);
  return now;
}

type Notice = { title: MessageKey; body: MessageKey };

function noticeFor(
  item: EdcReconciliationQueueItem,
  gate: ReconciliationGate,
): Notice | null {
  if (gate.kind === "wire-open")
    return {
      title: key("warning.waitingTitle"),
      body: key("warning.waitingBody"),
    };
  switch (item.transaction.status) {
    case "unknown":
      return {
        title: key("warning.unknownTitle"),
        body: key("warning.unknownBody"),
      };
    case "approved":
      return {
        title: key("warning.approvedTitle"),
        body: key("warning.approvedBody"),
      };
    case "declined":
      return {
        title: key("warning.declinedTitle"),
        body: key("warning.declinedBody"),
      };
    default:
      return null;
  }
}

function StatusBadge({
  item,
  gate,
}: {
  item: EdcReconciliationQueueItem;
  gate: ReconciliationGate;
}) {
  const t = useT();
  const status = item.transaction.status;
  if (gate.kind === "wire-open")
    return (
      <Badge tone="warning">
        <Clock aria-hidden="true" />
        {t(key("status.waiting"))}
      </Badge>
    );
  if (status === "approved")
    return (
      <Badge tone="success">
        <CircleCheck aria-hidden="true" />
        {t(key("status.approved"))}
      </Badge>
    );
  if (status === "declined")
    return (
      <Badge tone="danger">
        <CircleAlert aria-hidden="true" />
        {t(key("status.declined"))}
      </Badge>
    );
  return (
    <Badge tone={status === "unknown" ? "warning" : "neutral"}>
      <CircleHelp aria-hidden="true" />
      {t(key(`status.${status}`))}
    </Badge>
  );
}

function Fact({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-(length:--density-text) font-semibold break-words">
        {children}
      </dd>
    </div>
  );
}

function ReceiptRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-right font-mono text-sm font-medium tabular-nums break-all">
        {children}
      </dd>
    </div>
  );
}

export function EdcReconciliationDetail({
  item,
  onResolved,
}: {
  item: EdcReconciliationQueueItem;
  onResolved: (result: {
    id: string;
    outcome: "approved" | "declined";
  }) => void;
}) {
  const t = useT();
  const nowMs = useNowMs();
  const tx = item.transaction;
  // Before the clock is known the window is treated as not yet open (the
  // safe side); the form's own check keeps that from reading as a change.
  const gate = reconciliationGate(item, nowMs ?? 0);
  const notice = noticeFor(item, gate);
  const missing = t(key("receipt.missing"));
  const waiting = gate.kind === "wire-open";
  const titleId = `edc-recon-detail-${tx.id}`;
  const context = item.cashierName
    ? t(key("header.context"), {
        outlet: item.outletName,
        cashier: item.cashierName,
        time: formatMomentWib(tx.createdAt),
      })
    : t(key("header.contextNoCashier"), {
        outlet: item.outletName,
        time: formatMomentWib(tx.createdAt),
      });

  return (
    <article
      aria-labelledby={titleId}
      data-testid="edc-recon-detail"
      className="overflow-hidden rounded-container border-(length:--border-w) bg-card"
    >
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b-(length:--border-w) p-4 sm:p-5">
        <div className="grid min-w-0 gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id={titleId} className="type-title break-all">
              {displayId(tx)}
            </h3>
            <StatusBadge item={item} gate={gate} />
          </div>
          <p className="text-sm text-muted-foreground">{context}</p>
        </div>
        {nowMs !== null && (
          <p className="tabular text-sm text-muted-foreground">
            <span className="sr-only">{t(key("header.ageLabel"))}: </span>
            {t(key("header.age"), { minutes: ageMinutes(item, nowMs) })}
          </p>
        )}
      </header>

      <div className="grid lg:grid-cols-2">
        <section
          aria-labelledby={`${titleId}-evidence`}
          className="grid content-start gap-4 p-4 sm:p-5"
        >
          <h4 id={`${titleId}-evidence`} className="text-base font-semibold">
            {t(key("summary.title"))}
          </h4>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
            <Fact label={t(key("summary.requestedAmount"))}>
              <Money amount={tx.amountIdr} />
            </Fact>
            <Fact label={t(key("summary.remaining"))}>
              {item.remainingIdr === null ? (
                t(key("summary.none"))
              ) : (
                <Money amount={item.remainingIdr} />
              )}
            </Fact>
            <Fact label={t(key("summary.bill"))}>
              {item.billNumber ?? t(key("summary.none"))}
            </Fact>
            <Fact label={t(key("summary.terminal"))}>{item.terminalLabel}</Fact>
          </dl>

          {notice && (
            <div
              data-testid="edc-recon-notice"
              className="grid gap-0.5 rounded-container border-(length:--border-w) border-warning bg-warning-subtle p-3 text-sm text-foreground"
            >
              <p className="font-semibold">{t(notice.title)}</p>
              <p>{t(notice.body)}</p>
            </div>
          )}

          {waiting ? (
            <p className="text-sm text-muted-foreground">
              {t(key("receipt.noteWaiting"))}
            </p>
          ) : (
            <section
              aria-label={t(key("receipt.title"))}
              data-testid="edc-recon-receipt"
              className="rounded-container border-(length:--border-w) border-dashed bg-surface-2 p-4"
            >
              <div className="mb-2 flex items-baseline justify-between gap-3 border-b-(length:--border-w) border-dashed pb-2">
                <h5 className="text-sm font-semibold">
                  {t(key("receipt.title"))}
                </h5>
                <span className="text-xs text-muted-foreground">
                  {t(key("receipt.sample"))}
                </span>
              </div>
              <dl>
                <ReceiptRow label={t(key("receipt.amount"))}>
                  <Money amount={tx.amountIdr} size="sm" />
                </ReceiptRow>
                <ReceiptRow label={t(key("receipt.trace"))}>
                  {tx.trace || missing}
                </ReceiptRow>
                <ReceiptRow label={t(key("receipt.rrn"))}>
                  {tx.rrn ?? missing}
                </ReceiptRow>
                <ReceiptRow label={t(key("receipt.approvalCode"))}>
                  {tx.approvalCode ?? missing}
                </ReceiptRow>
                <ReceiptRow label={t(key("receipt.card"))}>
                  {tx.maskedPan ?? missing}
                </ReceiptRow>
                <ReceiptRow label={t(key("receipt.result"))}>
                  {t(key(`status.${tx.status}`))}
                </ReceiptRow>
              </dl>
              {tx.status === "unknown" && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {t(key("receipt.noteUnknown"))}
                </p>
              )}
            </section>
          )}

          <details
            data-testid="edc-recon-trace"
            className="text-sm [&_summary]:min-h-11 [&_summary]:cursor-pointer [&_summary]:py-2 [&_summary]:font-semibold [&_summary]:text-primary"
          >
            <summary>{t(key("trace.summary"))}</summary>
            <dl className="grid gap-1 pb-2">
              <ReceiptRow label={t(key("trace.status"))}>
                {t(key(`status.${tx.status}`))}
              </ReceiptRow>
              <ReceiptRow label={t(key("trace.responseCode"))}>
                {tx.responseCode ?? missing}
              </ReceiptRow>
              <ReceiptRow label={t(key("trace.message"))}>
                {tx.message ?? missing}
              </ReceiptRow>
              <ReceiptRow label={t(key("trace.inquiryCount"))}>
                {tx.inquiryCount}
              </ReceiptRow>
              <ReceiptRow label={t(key("trace.createdAt"))}>
                {formatMomentWib(tx.createdAt)}
              </ReceiptRow>
              <ReceiptRow label={t(key("trace.dispatchedAt"))}>
                {tx.dispatchedAt
                  ? formatMomentWib(tx.dispatchedAt)
                  : t(key("trace.never"))}
              </ReceiptRow>
            </dl>
          </details>
        </section>

        <div className="border-t-(length:--border-w) p-4 sm:p-5 lg:border-t-0 lg:border-l-(length:--border-w)">
          <ResolveForm
            key={tx.id}
            item={item}
            gate={gate}
            onResolved={onResolved}
          />
        </div>
      </div>
    </article>
  );
}
