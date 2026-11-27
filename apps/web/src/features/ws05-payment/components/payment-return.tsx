// `/bayar/kembali`: the single page Duitku sends every guest back to (C2b,
// legend-osqou.4; design/mockups/c2b-tamu-bayar "kembali-*").
//
// PAY-02: the phase comes from the server's answer only (./return-status.ts).
// `resultCode` on the URL is never read, and without an answer the page stays
// "Memeriksa". Which payment to ask about comes from the record the opening
// page stored in this browser; without one the link is "tidak dikenali". There
// is no back control: the browser history after the gateway cannot be trusted,
// so every way home is a button at the bottom.
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Check,
  ChevronRight,
  CircleX,
  Clock,
  Hourglass,
  Info,
  Link2Off,
  RefreshCw,
  TriangleAlert,
  Undo2,
} from "lucide-react";
import { cn } from "cn";
import { formatRupiah } from "@starter/shared/i18n";
import { getGuestPayment } from "@starter/shared/qr-order";
import type { PaymentStatus } from "@starter/shared/payment";
import { DEFAULT_TIME_ZONE } from "@starter/shared/core";
import {
  buildTenantThemeCss,
  type TenantThemeConfig,
} from "@starter/shared/theme";
import { useT } from "@/components/i18n";
import { ThemeScope } from "@/components/theme-scope";
import { Button } from "@/components/ui/button";
import { callEndpoint } from "@/lib/api/endpoint";
import { ApiError } from "@/lib/api/errors";
import { newIdempotencyKey } from "@/lib/idempotency";
import { TenantThemeStyle } from "@/lib/theme";
// Registers the table session's bearer credential for /api/table-sessions.
import "@/features/ws03-qr-order/session-store";
import { startPayment as startGuestPayment } from "@/features/ws03-qr-order/api";
import { fetchPaymentIntent, startPaymentIntent } from "../api";
import { FeeNoRefund } from "./fee-parts";
import { priceForRetry, type RetryPrice } from "../retry-price";
import {
  openPaymentUrl,
  readReturnRecordSnapshot,
  saveReturnRecord,
} from "../return-record";
import {
  canStartNewPayment,
  nextPollDelayMs,
  returnPhase,
  lateWatchStart,
  lateWatchedMs,
  shouldPollReturn,
  type ReturnRecord,
} from "../return-status";
import {
  AmountPaper,
  AmountPaperSkeleton,
  Callout,
  NumberedSteps,
  Spinner,
  StateHeader,
  StatusPill,
} from "./redirect-parts";

type Answer = {
  status: PaymentStatus;
  /** What the guest pays the gateway: the bill plus the service fee. */
  amountIdr: number;
  guestFeeIdr: number;
  paidAt: string | null;
};

async function askServer(
  record: ReturnRecord,
  signal: AbortSignal,
): Promise<Answer> {
  if (record.kind === "table") {
    const { data } = await callEndpoint(
      getGuestPayment,
      { params: { sessionId: record.sessionId, paymentId: record.paymentId } },
      { signal },
    );
    return {
      status: data.status,
      amountIdr: data.chargedIdr,
      guestFeeIdr: data.guestFeeIdr,
      paidAt: data.paidAt,
    };
  }
  const intent = await fetchPaymentIntent(
    record.linkToken,
    record.paymentId,
    signal,
  );
  return {
    status: intent.status,
    amountIdr: intent.chargedIdr,
    guestFeeIdr: intent.guestFeeIdr,
    paidAt: intent.paidAt,
  };
}

const noSubscribe = () => () => {};

/**
 * This browser's record of the payment: undefined on the server and while
 * hydrating, null when there is none. The snapshot is the stored string
 * (already checked), so it stays stable between renders.
 */
function useReturnRecord(): ReturnRecord | null | undefined {
  const raw = useSyncExternalStore(
    noSubscribe,
    readReturnRecordSnapshot,
    () => undefined,
  );
  return useMemo(
    () =>
      raw === undefined
        ? undefined
        : raw === ""
          ? null
          : (JSON.parse(raw) as ReturnRecord),
    [raw],
  );
}

const answerKey = (record: ReturnRecord) =>
  ["payment-return", record.kind, record.paymentId] as const;

/** Statuses of a failed poll that will not change by asking again. */
const SETTLED_ERRORS = [400, 401, 403, 404, 422];

/**
 * Polls the server with backoff until its status is terminal, then keeps a
 * slow watch after failed or expired (a late payment may still settle).
 */
function useReturnAnswer(record: ReturnRecord | null | undefined) {
  // The 10-minute slow watch starts at the first failed or expired answer.
  const lateSince = useRef<number | null>(null);
  return useQuery({
    queryKey: record
      ? answerKey(record)
      : ["payment-return", undefined, undefined],
    queryFn: ({ signal }) => askServer(record!, signal),
    enabled: !!record,
    retry: false,
    refetchOnWindowFocus: true,
    // Only while the tab is shown: a hidden tab does not watch.
    refetchIntervalInBackground: false,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      const now = Date.now();
      lateSince.current = lateWatchStart(lateSince.current, status, now);
      if (!shouldPollReturn(status, lateWatchedMs(lateSince.current, now)))
        return false;
      // A "not found" or "no login" for this guest will not change.
      const error = query.state.error;
      if (
        !query.state.data &&
        error instanceof ApiError &&
        SETTLED_ERRORS.includes(error.status)
      )
        return false;
      const attempts =
        query.state.dataUpdateCount + query.state.errorUpdateCount;
      return nextPollDelayMs(Math.max(0, attempts - 1), status);
    },
  });
}

/**
 * Ticks once a second while `active`. The clock only feeds states that need a
 * server answer, which only the browser has, so server and browser markup
 * still agree.
 */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/** "Diterima" is the outlet's clock, not the guest's device. */
function formatOutletTime(iso: string, timeZone: string | null): string {
  const options: Intl.DateTimeFormatOptions = {
    hour: "2-digit",
    minute: "2-digit",
  };
  try {
    return new Intl.DateTimeFormat("id-ID", {
      ...options,
      timeZone: timeZone ?? DEFAULT_TIME_ZONE,
    }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat("id-ID", {
      ...options,
      timeZone: DEFAULT_TIME_ZONE,
    }).format(new Date(iso));
  }
}

/** The QR menu's tenant id: tokens.css derives the QR chrome from it. */
const QR_TENANT_ID = "qr-menu";

/** The table's brand colours, when they pass the contrast check. */
function tenantConfig(record: ReturnRecord | null | undefined) {
  if (!record?.theme || !record.placeName) return null;
  const config: TenantThemeConfig = {
    id: QR_TENANT_ID,
    name: record.placeName,
    colors: record.theme.tokens,
    font: record.theme.fontFamily,
    corners: record.theme.corners,
    logoUrl: record.theme.logoUrl,
  };
  return buildTenantThemeCss(config).ok ? config : null;
}

function TopBar({ title, context }: { title: string; context: string | null }) {
  return (
    <header
      className={cn(
        "sticky top-3 z-30 -mx-1 flex min-h-14 items-center justify-center gap-4 rounded-qr-float px-4 py-1.5 qr-glass",
        "lg:static lg:mx-0 lg:min-h-18 lg:justify-between lg:px-6",
      )}
    >
      <p className="min-w-0 truncate text-center type-heading font-bold tracking-[-0.019em] lg:text-left lg:text-[1.75rem] lg:leading-tight">
        {title}
      </p>
      {context && (
        <p className="hidden text-[1.0625rem] font-medium text-qr-glass-muted lg:block">
          {context}
        </p>
      )}
    </header>
  );
}

function Footer({ children }: { children: ReactNode }) {
  return (
    <div
      className={cn(
        "grid gap-3 lg:col-start-1",
        "max-lg:mt-auto max-lg:qr-glass max-lg:sticky max-lg:bottom-3 max-lg:z-30 max-lg:-mx-1 max-lg:rounded-qr-float max-lg:p-3 max-lg:pb-[max(0.75rem,env(safe-area-inset-bottom))]",
        "lg:max-w-sm",
      )}
    >
      {children}
    </div>
  );
}

const textLink =
  "inline-flex min-h-11 items-center justify-self-center rounded-xs font-semibold underline decoration-1 underline-offset-4 hover:decoration-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring lg:justify-self-start";

export function PaymentReturnPage() {
  const t = useT();
  // undefined: not read yet (server render and first browser render agree).
  const record = useReturnRecord();
  const [startedAt] = useState(() => Date.now());
  const answer = useReturnAnswer(record);
  const status = answer.data?.status;
  const terminal = status !== undefined && !shouldPollReturn(status, 0);
  const now = useNow(!terminal);
  const waitedMs = now - startedAt;
  const errorStatus = answer.error
    ? answer.error instanceof ApiError
      ? answer.error.status
      : null
    : undefined;
  const phase = returnPhase({
    hasRecord: record === undefined ? undefined : record !== null,
    recordKind: record?.kind,
    status,
    errorStatus,
    waitedMs,
  });

  // "Coba lagi dengan DANA": a new payment for the same order or link, then
  // straight back to the gateway page. A refusal shows a plain message.
  const queryClient = useQueryClient();
  // 1272 K3: a retry whose method carries a service fee waits for the guest's
  // confirmation of the fresh fee and total before the new payment is made.
  const [retryConfirm, setRetryConfirm] = useState<RetryPrice | null>(null);
  const retry = useMutation({
    mutationFn: async ({
      record: current,
      confirmedChargedIdr,
    }: {
      record: ReturnRecord;
      confirmedChargedIdr?: number;
    }): Promise<{ confirm: RetryPrice } | undefined> => {
      // Ask the server first (round-trip, never the page's older answer): a
      // payment that settled late must not be paid a second time. Anything
      // but a fresh failed or expired answer, including no answer, stops here.
      const fresh = await askServer(current, new AbortController().signal);
      queryClient.setQueryData(answerKey(current), fresh);
      if (!canStartNewPayment(fresh.status)) return;
      // Fresh price first: a method that left the list stops here (the guest
      // picks another), and a fee the guest has not confirmed asks first.
      const price = await priceForRetry(current);
      if (!price) throw new Error("Method is no longer offered");
      if (price.feeIdr > 0 && price.chargedIdr !== confirmedChargedIdr)
        return { confirm: price };
      let next: {
        id: string;
        amountIdr: number;
        guestFeeIdr: number;
        url: string | null;
      };
      if (current.kind === "table") {
        if (!current.orderId) throw new Error("No order to pay");
        const { data } = await startGuestPayment(current.sessionId, {
          target: { kind: "order", orderId: current.orderId as never },
          method: current.method,
          ...(current.method === "ewallet" && current.channelCode
            ? { bankCode: current.channelCode }
            : {}),
          idempotencyKey: newIdempotencyKey(),
        });
        next = {
          id: data.id,
          amountIdr: data.chargedIdr,
          guestFeeIdr: data.guestFeeIdr,
          url: data.redirectUrl,
        };
      } else {
        const intent = await startPaymentIntent(current.linkToken, {
          method: current.method,
          channelCode: current.method === "card" ? null : current.channelCode,
          idempotencyKey: newIdempotencyKey(),
        });
        const instructions = intent.instructions;
        next = {
          id: intent.id,
          amountIdr: intent.chargedIdr,
          guestFeeIdr: intent.guestFeeIdr,
          url:
            instructions.method === "ewallet" || instructions.method === "card"
              ? instructions.paymentUrl
              : null,
        };
      }
      if (!next.url) throw new Error("No payment page");
      saveReturnRecord({
        ...current,
        paymentId: next.id,
        amountIdr: next.amountIdr,
        guestFeeIdr: next.guestFeeIdr,
      });
      if (!openPaymentUrl(next.url)) throw new Error("Payment page refused");
    },
    onSuccess: (result) => setRetryConfirm(result?.confirm ?? null),
  });

  const methodName = !record
    ? ""
    : record.method === "card"
      ? t("payment.redirect.cardName")
      : (record.channelName ?? t("payment.redirect.method.ewallet"));
  const methodRow = !record
    ? ""
    : record.method === "card"
      ? t("payment.redirect.method.card")
      : (record.channelName ?? t("payment.redirect.method.ewallet"));
  const table = record?.kind === "table" ? record.tableCode : null;
  const orderNumber = record?.kind === "table" ? record.orderNumber : null;
  const place = record?.placeName ?? null;
  const placeValue =
    place && table
      ? t("payment.redirect.back.placeTable", { place, table })
      : (place ??
        (table ? t("payment.redirect.back.tableOnly", { table }) : null));
  const amountIdr = answer.data?.amountIdr ?? record?.amountIdr ?? 0;
  const guestFeeIdr = answer.data?.guestFeeIdr ?? record?.guestFeeIdr ?? 0;
  const baseRows = [
    { label: t("payment.redirect.back.rowMethod"), value: methodRow },
    ...(orderNumber
      ? [{ label: t("payment.redirect.back.rowOrder"), value: orderNumber }]
      : []),
    ...(placeValue
      ? [{ label: t("payment.redirect.back.rowPlace"), value: placeValue }]
      : []),
  ];
  // The fee rows of the payment on record sit right under the method.
  const rows = [
    baseRows[0]!,
    ...(guestFeeIdr > 0 && guestFeeIdr < amountIdr
      ? [
          {
            label: t("payment.redirect.fee.billRow"),
            value: formatRupiah(amountIdr - guestFeeIdr),
          },
          {
            label: t("payment.redirect.fee.label"),
            value: formatRupiah(guestFeeIdr),
          },
        ]
      : []),
    ...baseRows.slice(1),
  ];
  const isTable = record?.kind === "table";

  let pill: ReactNode;
  let title: string;
  let lead: string;
  let paper: ReactNode = (
    <AmountPaper
      label={t("payment.redirect.back.totalLabel")}
      amountIdr={amountIdr}
      rows={rows}
    />
  );
  let extras: ReactNode = null;
  let footer: ReactNode = null;
  let live: "polite" | "alert" = "polite";

  const checkNow = (primary: boolean, label: string) => (
    <Button
      type="button"
      variant={primary ? "default" : "outline"}
      loading={answer.isFetching}
      onClick={() => void answer.refetch()}
    >
      <RefreshCw aria-hidden="true" />
      {label}
    </Button>
  );

  const noRepay = (
    <Callout
      tone="warn"
      icon={<TriangleAlert aria-hidden="true" />}
      title={t("payment.redirect.back.noRepayTitle")}
    >
      {orderNumber
        ? t("payment.redirect.back.noRepayOrder", { number: orderNumber })
        : t("payment.redirect.back.noRepay")}
    </Callout>
  );
  const homeLink = (primary: boolean) => {
    const label =
      record?.kind === "table"
        ? t("payment.redirect.back.toOrders")
        : t("payment.redirect.back.toBill");
    const to =
      record?.kind === "table"
        ? { to: "/t/$token/orders" as const, params: { token: record.qrToken } }
        : record?.kind === "link"
          ? {
              to: "/bayar/$token" as const,
              params: { token: record.linkToken },
            }
          : null;
    if (!to) return null;
    return primary ? (
      <Button asChild>
        <Link {...to}>
          {label}
          <ChevronRight aria-hidden="true" />
        </Link>
      </Button>
    ) : (
      <Link {...to} className={textLink}>
        {label}
      </Link>
    );
  };

  switch (phase) {
    case "checking":
      pill = (
        <StatusPill tone="neutral" icon={<Clock />}>
          {t("payment.redirect.back.checkingPill")}
        </StatusPill>
      );
      title = t("payment.redirect.back.checkingTitle");
      lead = t("payment.redirect.back.checkingLead");
      paper = <AmountPaperSkeleton />;
      break;
    case "unreachable":
      live = "alert";
      pill = (
        <StatusPill tone="wait" icon={<TriangleAlert />}>
          {t("payment.redirect.back.unreachablePill")}
        </StatusPill>
      );
      title = t("payment.redirect.back.unreachableTitle");
      lead = isTable
        ? t("payment.redirect.back.unreachableLeadOrder")
        : t("payment.redirect.back.unreachableLeadLink");
      extras = noRepay;
      footer = (
        <>
          {checkNow(true, t("payment.redirect.back.checkAgain"))}
          {homeLink(false)}
        </>
      );
      break;
    case "orders":
      live = "alert";
      pill = (
        <StatusPill tone="neutral" icon={<Link2Off />}>
          {t("payment.redirect.back.ordersPill")}
        </StatusPill>
      );
      title = t("payment.redirect.back.ordersTitle");
      lead = t("payment.redirect.back.ordersLead");
      extras = noRepay;
      footer = homeLink(true);
      break;
    case "waiting": {
      pill = (
        <StatusPill tone="wait" icon={<Clock />}>
          {t("payment.redirect.back.waitingPill")}
        </StatusPill>
      );
      title = t("payment.redirect.back.waitingTitle");
      lead =
        record?.method === "card"
          ? t("payment.redirect.back.waitingLeadCard")
          : t("payment.redirect.back.waitingLeadWallet", {
              wallet: methodName,
            });
      const seconds = answer.dataUpdatedAt
        ? Math.max(0, Math.round((now - answer.dataUpdatedAt) / 1000))
        : null;
      extras = (
        <p className="flex flex-wrap items-center gap-x-2 text-sm leading-5 font-semibold">
          <Spinner className="size-4.5 border-2" />
          {t("payment.redirect.back.autoCheck")}
          {seconds !== null && (
            <>
              <span aria-hidden="true" className="text-muted-foreground">
                ·
              </span>
              <span className="font-normal text-muted-foreground">
                {seconds < 3
                  ? t("payment.redirect.back.lastCheckedNow")
                  : t("payment.redirect.back.lastChecked", { seconds })}
              </span>
            </>
          )}
        </p>
      );
      footer = checkNow(false, t("payment.redirect.back.checkAgain"));
      break;
    }
    case "slow":
      pill = (
        <StatusPill tone="wait" icon={<Hourglass />}>
          {t("payment.redirect.back.slowPill")}
        </StatusPill>
      );
      title = t("payment.redirect.back.slowTitle");
      lead = isTable
        ? t("payment.redirect.back.slowLeadOrder")
        : t("payment.redirect.back.slowLeadLink");
      extras = noRepay;
      footer = (
        <>
          {checkNow(true, t("payment.redirect.back.checkAgain"))}
          {homeLink(false)}
        </>
      );
      break;
    case "paid": {
      pill = (
        <StatusPill tone="ok" icon={<Check />}>
          {t("payment.redirect.back.paidPill")}
        </StatusPill>
      );
      title = t("payment.redirect.back.paidTitle");
      lead = isTable
        ? t("payment.redirect.back.paidLeadOrder")
        : t("payment.redirect.back.paidLeadLink");
      const paidAt = answer.data?.paidAt;
      paper = (
        <AmountPaper
          label={t("payment.redirect.back.paidLabel")}
          amountIdr={amountIdr}
          rows={[
            ...rows,
            ...(paidAt
              ? [
                  {
                    label: t("payment.redirect.back.rowReceived"),
                    value: (
                      <span className="tabular">
                        {formatOutletTime(paidAt, record?.timeZone ?? null)}
                      </span>
                    ),
                  },
                ]
              : []),
          ]}
        />
      );
      if (isTable)
        extras = (
          <Callout
            icon={<Clock aria-hidden="true" />}
            title={t("payment.redirect.back.paidNoteTitle")}
          >
            {t("payment.redirect.back.paidNote")}
          </Callout>
        );
      footer =
        record?.kind === "table" ? (
          <Button asChild>
            <Link to="/t/$token/orders" params={{ token: record.qrToken }}>
              {t("payment.redirect.back.toOrders")}
              <ChevronRight aria-hidden="true" />
            </Link>
          </Button>
        ) : record?.kind === "link" ? (
          <Button asChild>
            <Link to="/bayar/$token" params={{ token: record.linkToken }}>
              {t("payment.redirect.back.toBill")}
              <ChevronRight aria-hidden="true" />
            </Link>
          </Button>
        ) : null;
      break;
    }
    case "refunded":
      pill = (
        <StatusPill tone="neutral" icon={<Undo2 />}>
          {t("payment.redirect.back.refundedPill")}
        </StatusPill>
      );
      title = t("payment.redirect.back.refundedTitle");
      lead = t("payment.redirect.back.refundedLead");
      paper = (
        <AmountPaper
          label={t("payment.redirect.back.refundedLabel")}
          amountIdr={amountIdr}
          rows={rows}
        />
      );
      footer = homeLink(true);
      break;
    case "failed":
    case "expired": {
      live = "alert";
      const failed = phase === "failed";
      pill = failed ? (
        <StatusPill tone="bad" icon={<CircleX />}>
          {t("payment.redirect.back.failedPill")}
        </StatusPill>
      ) : (
        <StatusPill tone="neutral" icon={<Hourglass />}>
          {t("payment.redirect.back.expiredPill")}
        </StatusPill>
      );
      title = failed
        ? t("payment.redirect.back.failedTitle")
        : t("payment.redirect.back.expiredTitle");
      lead = failed
        ? isTable
          ? t("payment.redirect.back.failedLeadOrder", { method: methodName })
          : t("payment.redirect.back.failedLeadLink", { method: methodName })
        : isTable
          ? t("payment.redirect.back.expiredLeadOrder")
          : t("payment.redirect.back.expiredLeadLink");
      paper = (
        <AmountPaper
          label={t("payment.redirect.back.unpaidLabel")}
          amountIdr={amountIdr}
          rows={[]}
          muted
        />
      );
      if (failed && isTable)
        extras = (
          <Callout
            icon={<Check aria-hidden="true" />}
            title={t("payment.redirect.back.cartKeptTitle")}
          >
            {t("payment.redirect.back.cartKept")}
          </Callout>
        );
      const primaryLabel = failed
        ? t("payment.redirect.back.chooseOther")
        : t("payment.redirect.back.newPayment");
      const canRetry =
        failed &&
        record !== null &&
        record !== undefined &&
        (record.kind === "link" || record.orderId !== null);
      footer = (
        <>
          {retry.isError && (
            <p role="alert" className="text-sm leading-5 text-danger">
              {t("payment.redirect.back.retryFailed")}
            </p>
          )}
          {record?.kind === "table" ? (
            <Button asChild>
              <Link to="/t/$token/checkout" params={{ token: record.qrToken }}>
                {primaryLabel}
                <ChevronRight aria-hidden="true" />
              </Link>
            </Button>
          ) : record?.kind === "link" ? (
            <Button asChild>
              <Link to="/bayar/$token" params={{ token: record.linkToken }}>
                {primaryLabel}
                <ChevronRight aria-hidden="true" />
              </Link>
            </Button>
          ) : null}
          {canRetry && record ? (
            <button
              type="button"
              className={textLink}
              disabled={retry.isPending || retry.isSuccess}
              aria-busy={retry.isPending}
              onClick={() => retry.mutate({ record })}
            >
              {retry.isPending || retry.isSuccess
                ? t("payment.redirect.back.retrying")
                : t("payment.redirect.back.retryWith", { method: methodName })}
            </button>
          ) : !failed && record?.kind === "table" ? (
            <Link
              to="/t/$token/cart"
              params={{ token: record.qrToken }}
              className={textLink}
            >
              {t("payment.redirect.back.toCart")}
            </Link>
          ) : null}
        </>
      );
      break;
    }
    default:
      live = "alert";
      pill = (
        <StatusPill tone="neutral" icon={<Link2Off />}>
          {t("payment.redirect.back.invalidPill")}
        </StatusPill>
      );
      title = t("payment.redirect.back.invalidTitle");
      lead = t("payment.redirect.back.invalidLead");
      paper = null;
      extras = (
        <NumberedSteps
          steps={[
            {
              title: t("payment.redirect.back.invalidStep1"),
              hint: t("payment.redirect.back.invalidStep1Hint"),
            },
            {
              title: t("payment.redirect.back.invalidStep2"),
              hint: t("payment.redirect.back.invalidStep2Hint"),
            },
            {
              title: t("payment.redirect.back.invalidStep3"),
              hint: t("payment.redirect.back.invalidStep3Hint"),
            },
          ]}
        />
      );
      footer = (
        <Button
          type="button"
          variant="outline"
          onClick={() => window.location.reload()}
        >
          <RefreshCw aria-hidden="true" />
          {t("payment.redirect.back.reopen")}
        </Button>
      );
  }

  // 1272 K3: the fresh fee of a retry, shown before the new payment is made.
  if (retryConfirm && record) {
    pill = (
      <StatusPill tone="neutral" icon={<Info aria-hidden="true" />}>
        {t("payment.redirect.fee.confirmPill")}
      </StatusPill>
    );
    title = t("payment.redirect.fee.confirmTitle");
    lead = t("payment.redirect.fee.confirmLead", { method: methodName });
    paper = (
      <AmountPaper
        label={t("payment.redirect.fee.totalLabel")}
        amountIdr={retryConfirm.chargedIdr}
        rows={[
          ...baseRows,
          {
            label: t("payment.redirect.fee.billRow"),
            value: formatRupiah(retryConfirm.amountIdr),
          },
          {
            label: t("payment.redirect.fee.label"),
            value: formatRupiah(retryConfirm.feeIdr),
          },
        ]}
      />
    );
    extras = null;
    footer = (
      <>
        {retry.isError && (
          <p role="alert" className="text-sm leading-5 text-danger">
            {t("payment.redirect.back.retryFailed")}
          </p>
        )}
        <FeeNoRefund feeIdr={retryConfirm.feeIdr} />
        <Button
          type="button"
          loading={retry.isPending}
          onClick={() =>
            retry.mutate({
              record,
              confirmedChargedIdr: retryConfirm.chargedIdr,
            })
          }
        >
          {t("payment.redirect.fee.confirmPay", {
            total: formatRupiah(retryConfirm.chargedIdr),
          })}
        </Button>
        <button
          type="button"
          className={textLink}
          disabled={retry.isPending}
          onClick={() => {
            setRetryConfirm(null);
            retry.reset();
          }}
        >
          {t("payment.redirect.opening.otherMethod")}
        </button>
      </>
    );
  }

  const invalid = phase === "invalid";
  const busy = phase === "checking" || phase === "waiting";
  // The brand colours of the table the guest left, so the page they come back
  // to looks like the one they paid from (null: the base theme).
  const theme = tenantConfig(record);
  return (
    <ThemeScope
      density="hangat"
      mode="light"
      tenant={theme ? QR_TENANT_ID : undefined}
      data-surface="qr"
      className="relative isolate min-h-dvh bg-background"
    >
      {theme ? <TenantThemeStyle tenant={theme} /> : null}
      <main className="mx-auto grid w-full max-w-[90rem] grid-cols-[minmax(0,1fr)] gap-5 px-4 pt-3 pb-4 max-lg:min-h-dvh max-lg:grid-rows-[auto_minmax(0,1fr)] lg:content-start lg:px-14 lg:pt-5 lg:pb-8">
        <TopBar
          title={invalid || !place ? t("payment.redirect.back.title") : place}
          context={
            table && !invalid
              ? t("payment.redirect.back.deskContext", { table })
              : null
          }
        />
        <div
          className={cn(
            "flex flex-col gap-5 lg:mx-auto lg:grid lg:w-full lg:max-w-5xl lg:content-start lg:gap-x-12 lg:pt-6",
            paper && "lg:grid-cols-[minmax(0,1fr)_24rem]",
          )}
        >
          <section
            role={live === "alert" ? "alert" : "status"}
            aria-live={live === "alert" ? undefined : "polite"}
            aria-busy={busy}
            className="grid content-start gap-5 lg:col-start-1"
          >
            <StateHeader level={1} pill={pill} title={title} lead={lead} />
          </section>
          {paper && (
            <div className="lg:col-start-2 lg:row-span-3 lg:row-start-1">
              {paper}
            </div>
          )}
          {extras && <div className="lg:col-start-1">{extras}</div>}
          {footer && <Footer>{footer}</Footer>}
        </div>
      </main>
    </ThemeScope>
  );
}
