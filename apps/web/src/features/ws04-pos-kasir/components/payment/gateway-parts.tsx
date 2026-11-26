import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { ArrowRight, Clock } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  isContractPending,
  useCheckPaymentStatus,
  usePaymentSession,
} from "../../hooks";
import type {
  PaymentAttempt,
  PaymentMethodCode,
  PaymentSession,
} from "../../types";
import { Notice, PosPanel, StateBlock, StatusPill } from "../shared";

// Pieces shared by the gateway panels (QRIS, VA, e-wallet, online card, failed;
// bead legend-mjmm, P2). Each panel owns its own states; this file only holds
// what two or more of them draw the same way.

/** The method's attempt on the bill, or null when the bill has none of it. */
export function useGatewayAttempt(orderId: string, method: PaymentMethodCode) {
  const session = usePaymentSession(orderId);
  const active = session.activeAttempt;
  return {
    attempt: active !== null && active.method === method ? active : null,
    bill: session.bill,
    isLoading: session.isLoading,
    error: session.error,
    refetch: session.refetch,
  };
}

/**
 * Run `start` once per bill when the panel opens with nothing to show yet (QRIS,
 * online card: no choice to make, so no extra click). The ref survives the
 * StrictMode effect replay and re-renders, so the payment is never made twice;
 * a retry after an error is the cashier's own click.
 */
export function useAutoStart(
  ready: boolean,
  orderId: string,
  start: () => void,
) {
  const startedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || startedFor.current === orderId) return;
    startedFor.current = orderId;
    start();
  }, [ready, orderId, start]);
}

/** The clock in ms, ticking every second while `active`; null before mount. */
export function useNow(active: boolean): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (!active) return;
    const tick = () => setNow(Date.now());
    const first = window.setTimeout(tick, 0);
    const id = window.setInterval(tick, 1000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, [active]);
  return now;
}

/** Ms until `expiresAt` (never below 0); null while the clock is not known. */
export function remainingMsOf(
  expiresAt: string | undefined,
  now: number | null,
): number | null {
  if (expiresAt === undefined || now === null) return null;
  return Math.max(0, Date.parse(expiresAt) - now);
}

/** An attempt that may still take the customer's money: never leave it. */
const LIVE_STATUSES: readonly PaymentAttempt["status"][] = [
  "waiting",
  "cancelling",
  "unknown",
  "confirmed",
];

/**
 * True when a fresh status read shows the old payment is over and not paid, so
 * the cashier may leave it for another method. A paid bill, a payment that may
 * still arrive, or a session that no longer holds this attempt means the screen
 * is about to change by itself: stay.
 */
export function safeToLeave(next: PaymentSession, attemptId: string): boolean {
  return (
    !next.bill.paid &&
    next.activeAttempt?.id === attemptId &&
    !LIVE_STATUSES.includes(next.activeAttempt.status)
  );
}

/** 522000 ms -> "08:42". */
export function formatCountdown(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** "Pembayaran 01": the position of the payment on the bill. */
export function paymentNo(sequence: number): string {
  return String(sequence).padStart(2, "0");
}

/** Status changes are announced politely; the ticking countdown is not. */
export function LiveRegion({ children }: { children: ReactNode }) {
  return (
    <div aria-live="polite" className="h-full">
      {children}
    </div>
  );
}

export function CountdownPill({ remainingMs }: { remainingMs: number | null }) {
  const t = useT();
  if (remainingMs === null) return null;
  return (
    <span aria-live="off">
      <StatusPill tone="neutral" icon={Clock} className="tabular">
        {t("posKasirGateway.common.validFor", {
          time: formatCountdown(remainingMs),
        })}
      </StatusPill>
    </span>
  );
}

/** The error of a call, in words: no contract is a different message. */
export function ErrorNotice({
  error,
  title,
  className,
}: {
  error: unknown;
  title: string;
  className?: string;
}) {
  const t = useT();
  if (isContractPending(error))
    return (
      <Notice
        tone="warning"
        title={t("posKasirGateway.common.contractPending")}
        className={className}
      >
        {t("posKasirGateway.common.contractPendingHint")}
      </Notice>
    );
  return (
    <Notice tone="danger" title={title} className={className}>
      {error instanceof Error ? error.message : null}
    </Notice>
  );
}

/** A notice that sits under a state block, as wide as the mockup shows it. */
export function BlockNotice({ children }: { children: ReactNode }) {
  return <div className="mt-2 w-full max-w-3xl text-left">{children}</div>;
}

export function LoadingPanel({ title }: { title: string }) {
  const t = useT();
  return (
    <PosPanel title={title}>
      <div
        role="status"
        aria-busy="true"
        className="flex flex-col items-center gap-4 py-8"
      >
        <span className="sr-only">{t("posKasirGateway.common.loading")}</span>
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-5 w-96 max-w-full" />
        <Skeleton className="h-14 w-56" />
        <Skeleton className="h-24 w-full max-w-3xl" />
      </div>
    </PosPanel>
  );
}

/** The session could not be read: what went wrong and how to recover. */
export function ProblemPanel({
  title,
  error,
  onRetry,
  onChangeMethod,
}: {
  title: string;
  error: unknown;
  onRetry: () => void;
  onChangeMethod: () => void;
}) {
  const t = useT();
  const pending = isContractPending(error);
  return (
    <PosPanel
      title={title}
      footer={
        <>
          {!pending && (
            <Button variant="outline" onClick={onRetry}>
              {t("posKasirGateway.common.retry")}
            </Button>
          )}
          <Button onClick={onChangeMethod}>
            {t("posKasirGateway.common.otherMethod")}
          </Button>
        </>
      }
    >
      <div className="mx-auto max-w-3xl py-8">
        {pending ? (
          <ErrorNotice error={error} title="" />
        ) : (
          <Notice tone="danger" title={t("posKasirGateway.common.loadError")}>
            {t("posKasirGateway.common.loadErrorHint")}
          </Notice>
        )}
      </div>
    </PosPanel>
  );
}

/** One choice out of a short list (bank, wallet): picked with ink, not accent. */
export function ChoiceGroup({
  legend,
  name,
  options,
  value,
  onChange,
}: {
  legend: string;
  name: string;
  options: ReadonlyArray<{ code: string; label: string }>;
  value: string | null;
  onChange: (code: string) => void;
}) {
  return (
    <fieldset className="w-full max-w-3xl">
      <legend className="sr-only">{legend}</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        {options.map((option) => (
          <label
            key={option.code}
            className={cn(
              "flex min-h-control cursor-pointer items-center rounded-control border-(length:--border-w) border-border bg-card px-4 text-(length:--density-text) font-semibold",
              "has-checked:border-2 has-checked:border-foreground has-checked:bg-muted",
              "has-focus-visible:shadow-focus",
            )}
          >
            <input
              type="radio"
              name={name}
              value={option.code}
              checked={value === option.code}
              onChange={() => onChange(option.code)}
              className="sr-only"
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Before the payment exists: an optional choice, then one start button. */
export function StartPanel({
  title,
  heading,
  body,
  amountIdr,
  children,
  startLabel,
  startingLabel,
  starting,
  startDisabled,
  onStart,
  error,
  onChangeMethod,
}: {
  title: string;
  heading: string;
  body: string;
  amountIdr: number;
  children?: ReactNode;
  startLabel: string;
  startingLabel: string;
  starting: boolean;
  startDisabled?: boolean;
  onStart: () => void;
  error: unknown;
  onChangeMethod: () => void;
}) {
  const t = useT();
  return (
    <PosPanel
      title={title}
      footer={
        <>
          <Button
            variant="outline"
            disabled={starting}
            onClick={onChangeMethod}
          >
            {t("posKasirGateway.common.otherMethod")}
          </Button>
          <Button onClick={onStart} loading={starting} disabled={startDisabled}>
            {starting ? startingLabel : startLabel}
          </Button>
        </>
      }
    >
      <StateBlock
        title={heading}
        description={body}
        amountIdr={amountIdr}
        className="py-4"
      >
        {children}
        {error != null && (
          <BlockNotice>
            <ErrorNotice
              error={error}
              title={t("posKasirGateway.common.startError")}
            />
          </BlockNotice>
        )}
      </StateBlock>
    </PosPanel>
  );
}

/** The payment is out and the customer has not finished: check or watch. */
export function WaitingPanel({
  orderId,
  attempt,
  title,
  statusLabel,
  heading,
  description,
  remainingMs,
  noticeTitle,
  noticeBody,
  action,
  children,
}: {
  orderId: string;
  attempt: PaymentAttempt;
  title: string;
  statusLabel: string;
  heading: string;
  description: string;
  /** Shown as "Berlaku mm:ss lagi" when the payment has a deadline. */
  remainingMs?: number | null;
  noticeTitle: string;
  noticeBody: string;
  /** One more footer button (cancel the QRIS). */
  action?: ReactNode;
  /** Extra content between the amount and the notice (the VA number). */
  children?: ReactNode;
}) {
  const t = useT();
  const check = useCheckPaymentStatus();
  return (
    <PosPanel
      title={title}
      aside={<StatusPill tone="warning">{statusLabel}</StatusPill>}
      footer={
        <>
          {action}
          <Button
            variant="outline"
            loading={check.isPending}
            onClick={() => check.mutate({ orderId, attemptId: attempt.id })}
            className="w-full sm:w-auto"
          >
            {check.isPending
              ? t("posKasirGateway.common.checking")
              : t("posKasirGateway.common.checkStatus")}
          </Button>
          <Button asChild className="w-full sm:w-auto">
            <Link to="/pos/customer-display">
              {t("posKasirGateway.common.viewDisplay")}
              <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
        </>
      }
    >
      <StateBlock
        title={heading}
        description={description}
        amountIdr={attempt.amountIdr}
        className="py-4"
      >
        {remainingMs !== undefined && (
          <CountdownPill remainingMs={remainingMs} />
        )}
        {children}
        <BlockNotice>
          <Notice tone="info" title={noticeTitle}>
            {noticeBody}
          </Notice>
        </BlockNotice>
        {check.error != null && (
          <BlockNotice>
            <ErrorNotice
              error={check.error}
              title={t("posKasirGateway.common.statusCheckError")}
            />
          </BlockNotice>
        )}
      </StateBlock>
    </PosPanel>
  );
}

/** The deadline passed: no old payment is shown as usable. */
export function ExpiredPanel({
  orderId,
  attempt,
  title,
  heading,
  description,
  noticeBody,
  onChangeMethod,
  showCheck,
  action,
  children,
}: {
  orderId: string;
  attempt: PaymentAttempt;
  title: string;
  heading: string;
  description: string;
  noticeBody: string;
  onChangeMethod: () => void;
  /** Offer a manual status check (the QRIS panel checks before a new code). */
  showCheck: boolean;
  /** One more footer button (make a new QRIS). */
  action?: ReactNode;
  /** Progress or error lines under the notice. */
  children?: ReactNode;
}) {
  const t = useT();
  const { mutateAsync: checkStatus, ...check } = useCheckPaymentStatus();
  // Another method only after the old payment's status is re-read: a customer
  // may have paid just as the deadline passed, and a second charge is worse
  // than a second of waiting.
  const switchMethod = () =>
    void checkStatus({ orderId, attemptId: attempt.id })
      .then((next) => {
        if (safeToLeave(next, attempt.id)) onChangeMethod();
      })
      .catch(() => undefined); // The mutation state shows the error below.
  return (
    <PosPanel
      title={title}
      aside={
        <StatusPill tone="warning">
          {t("posKasirGateway.common.statusExpired")}
        </StatusPill>
      }
      footer={
        <>
          {showCheck && (
            <Button
              variant="outline"
              loading={check.isPending}
              onClick={() =>
                void checkStatus({ orderId, attemptId: attempt.id }).catch(
                  () => undefined,
                )
              }
            >
              {check.isPending
                ? t("posKasirGateway.common.checking")
                : t("posKasirGateway.common.checkStatus")}
            </Button>
          )}
          {action}
          <Button onClick={switchMethod} disabled={check.isPending}>
            {t("posKasirGateway.common.otherMethod")}
          </Button>
        </>
      }
    >
      <StateBlock
        title={heading}
        description={description}
        amountIdr={attempt.amountIdr}
        className="py-4"
      >
        <BlockNotice>
          <Notice
            tone="warning"
            title={t("posKasirGateway.common.unpaidTitle")}
          >
            {noticeBody}
          </Notice>
        </BlockNotice>
        {check.error != null && (
          <BlockNotice>
            <ErrorNotice
              error={check.error}
              title={t("posKasirGateway.common.statusCheckError")}
            />
          </BlockNotice>
        )}
        {children}
      </StateBlock>
    </PosPanel>
  );
}
