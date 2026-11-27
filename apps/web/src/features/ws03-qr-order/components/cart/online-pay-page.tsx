// Virtual Account screen of "Keranjang & bayar" (legend-3160). The bank list
// comes from the payment options (provider channels, never hard-coded); the
// guest picks a bank, the server opens a VA for the order and the page polls
// it. Success is shown only once the gateway confirms (ORD-02): the payment
// turns paid, or the order leaves awaiting_payment.
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  Check,
  ChevronLeft,
  Clock,
  Copy,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { RadioGroup } from "radix-ui";
import { cn } from "cn";
import type {
  GuestPaymentOption,
  OrderId,
  QrOrder,
} from "@starter/shared/qr-order";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Money } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api/errors";
import {
  FeeNoRefund,
  FeeQuote,
  hasGuestFee,
} from "@/features/ws05-payment/components/fee-parts";
import { useTableJourney } from "../../context";
import {
  useGuestPayment,
  useGuestPaymentOptions,
  useRefreshSession,
  useStartPayment,
} from "../../hooks";
import { idempotencyKey } from "../../lib/ids.ts";
import { Notice } from "../notice";
import {
  QrFooter,
  QrTopBar,
  qrRoundIcon,
  qrTextLink,
} from "../glass/qr-primitives";
import { SessionEnded } from "../session-states";
import { PaymentSuccess } from "./payment-success";

export type OnlinePayMethod = "va";

// One idempotency key per order and bank, kept for the tab (sessionStorage)
// before the request goes out, so a retry after a lost response, a repeat
// tap or a refresh returns the same VA; only a 4xx refusal drops it. Another bank, or "Buat VA baru", takes a new key; the server supersedes
// the older VA. `active`: the VA is on screen, so a refresh reopens it ("Ganti
// bank" clears it but keeps the key for the same bank).
type VaChoice = { bankCode: string; key: string; active: boolean };
const choiceStorageKey = (orderId: string) => `legend-qr-va:${orderId}`;
const memoryChoices = new Map<string, VaChoice>();

function readChoice(orderId: string): VaChoice | null {
  try {
    const raw = window.sessionStorage.getItem(choiceStorageKey(orderId));
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<VaChoice>;
      if (typeof parsed.bankCode === "string" && typeof parsed.key === "string")
        return {
          bankCode: parsed.bankCode,
          key: parsed.key,
          active: parsed.active === true,
        };
    }
  } catch {
    // Storage blocked (private mode, in-app browser): fall back to memory.
  }
  return memoryChoices.get(orderId) ?? null;
}

function writeChoice(orderId: string, choice: VaChoice | null) {
  if (choice) memoryChoices.set(orderId, choice);
  else memoryChoices.delete(orderId);
  try {
    if (choice)
      window.sessionStorage.setItem(
        choiceStorageKey(orderId),
        JSON.stringify(choice),
      );
    else window.sessionStorage.removeItem(choiceStorageKey(orderId));
  } catch {
    // Memory copy above still covers this visit.
  }
}

/** The saved key for the same bank, else a fresh one. */
function vaKey(orderId: string, bankCode: string, renew: boolean): string {
  const saved = readChoice(orderId);
  if (!renew && saved?.bankCode === bankCode) return saved.key;
  return idempotencyKey("va");
}

function setActive(orderId: string, active: boolean) {
  const saved = readChoice(orderId);
  if (saved) writeChoice(orderId, { ...saved, active });
}

const groupBy4 = (value: string) => value.match(/.{1,4}/g)?.join(" ") ?? value;

/**
 * "23:59:41" to `expiresAt` and whether it ran out; null until mounted so
 * server and browser markup agree.
 */
function useCountdown(
  expiresAt: string,
): { label: string; done: boolean } | null {
  const [remainingMs, setRemainingMs] = useState<number | null>(null);
  useEffect(() => {
    const endsAt = Date.parse(expiresAt);
    const tick = () => setRemainingMs(Math.max(0, endsAt - Date.now()));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [expiresAt]);
  if (remainingMs === null) return null;
  const total = Math.ceil(remainingMs / 1000);
  const part = (n: number) => String(n).padStart(2, "0");
  return {
    label: `${part(Math.floor(total / 3600))}:${part(Math.floor((total % 3600) / 60))}:${part(total % 60)}`,
    done: total === 0,
  };
}

function CopyButton({ value }: { value: string }) {
  const t = useT();
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  // A different number (another bank) has not been copied yet.
  const [copiedValue, setCopiedValue] = useState(value);
  if (copiedValue !== value) {
    setCopiedValue(value);
    setStatus("idle");
  }
  const copy = () => {
    // navigator.clipboard is missing on insecure origins and some in-app
    // browsers; writeText can also throw synchronously.
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      navigator.clipboard.writeText(value).then(
        () => setStatus("copied"),
        () => setStatus("failed"),
      );
    } catch {
      setStatus("failed");
    }
  };
  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="min-h-11 shrink-0"
        aria-label={t("qrGlass.pay.va.copyLabel")}
        onClick={copy}
      >
        {status === "copied" ? (
          <Check aria-hidden="true" />
        ) : (
          <Copy aria-hidden="true" />
        )}
        {t("qrGlass.pay.va.copy")}
      </Button>
      <p
        role="status"
        aria-live="polite"
        className={cn(
          "basis-full text-sm empty:hidden",
          status === "failed" && "text-danger",
        )}
      >
        {status === "copied"
          ? t("qrGlass.pay.va.copied")
          : status === "failed"
            ? t("qrGlass.pay.va.copyFailed")
            : null}
      </p>
    </>
  );
}

function PillHeader({
  pill,
  heading,
  saved,
}: {
  pill: string;
  heading: string;
  saved: string;
}) {
  return (
    <header className="grid justify-items-start gap-3">
      <p className="inline-flex items-center gap-2 rounded-full bg-warning-subtle px-3 py-1.5 text-sm font-semibold">
        <Clock className="size-4 shrink-0" aria-hidden="true" />
        {pill}
      </p>
      <h2 className="type-display-xl max-w-[14ch]">{heading}</h2>
      <p className="text-lg leading-7 text-muted-foreground">{saved}</p>
    </header>
  );
}

function startErrorText(t: ReturnType<typeof useT>, error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 409) return t("qrGlass.pay.va.errorConflict");
    if (error.status === 422) return t("qrGlass.pay.va.errorBank");
  }
  return t("qrGlass.pay.va.errorNetwork");
}

function unavailableText(
  t: ReturnType<typeof useT>,
  option: GuestPaymentOption | undefined,
) {
  switch (option?.unavailableReason) {
    case "gateway_down":
      return t("qrGlass.pay.va.unavailableGatewayDown");
    case "no_channels":
      return t("qrGlass.pay.va.unavailableNoChannels");
    default:
      return t("qrGlass.pay.va.unavailableRoutingDisabled");
  }
}

function ToCheckoutLink({ qrToken }: { qrToken: string }) {
  const t = useT();
  return (
    <Link
      to="/t/$token/checkout"
      params={{ token: qrToken }}
      className={`${qrTextLink} min-h-11 justify-self-center`}
    >
      {t("qrGlass.pay.va.changeMethod")}
    </Link>
  );
}

const steps = [
  "qrGlass.pay.va.step1",
  "qrGlass.pay.va.step2",
  "qrGlass.pay.va.step3",
  "qrGlass.pay.va.step4",
  "qrGlass.pay.va.step5",
] as const;

/** Bank list from the payment options; the guest picks one, then creates the VA. */
function BankPicker({
  sessionId,
  orderId,
  qrToken,
  bank,
  onBank,
  onCreate,
  creating,
  error,
}: {
  sessionId: string;
  orderId: OrderId;
  qrToken: string;
  bank: string | null;
  onBank: (bankCode: string) => void;
  onCreate: () => void;
  creating: boolean;
  error: unknown;
}) {
  const t = useT();
  // 1272 K3: priced for this order, the same one the create call names.
  const options = useGuestPaymentOptions(sessionId, { orderId });

  if (options.isError)
    return (
      <ErrorState
        title={t("qrGlass.pay.va.optionsErrorTitle")}
        description={t("qrGlass.pay.va.optionsErrorHint")}
        onRetry={() => void options.refetch()}
      />
    );
  // The older list kept while this order's priced one loads has no fees: wait.
  if (!options.data || options.isPlaceholderData)
    return (
      <div aria-busy="true" className="grid gap-4">
        <span className="sr-only">{t("qrGlass.pay.va.loading")}</span>
        <Skeleton className="h-9 w-48 rounded-full" />
        <Skeleton className="h-16 w-3/4" />
        <Skeleton className="h-56 w-full rounded-qr-media" />
      </div>
    );

  const va = options.data.data.methods.find((item) => item.method === "va");
  if (!va?.enabled || va.banks.length === 0)
    return (
      <EmptyState
        icon={TriangleAlert}
        title={t("qrGlass.pay.va.unavailableTitle")}
        description={unavailableText(t, va)}
        action={
          <Button asChild>
            <Link to="/t/$token/checkout" params={{ token: qrToken }}>
              {t("qrGlass.pay.va.toCheckout")}
            </Link>
          </Button>
        }
      />
    );

  return (
    <>
      <PillHeader
        pill={t("qrGlass.pay.va.pill")}
        heading={t("qrGlass.pay.va.heading")}
        saved={t("qrGlass.pay.va.saved")}
      />

      <section className="grid gap-3 rounded-qr-media bg-card p-5 shadow-raised">
        <fieldset className="grid min-w-0 gap-2">
          <legend id="va-bank-legend" className="mb-1 text-sm font-semibold">
            {t("qrGlass.pay.va.bankLegend")}
          </legend>
          <p className="text-sm text-muted-foreground">
            {t("qrGlass.pay.va.bankHint")}
          </p>
          <RadioGroup.Root
            value={bank ?? ""}
            onValueChange={onBank}
            disabled={creating}
            aria-labelledby="va-bank-legend"
            className="grid gap-2"
          >
            {va.banks.map((item) => (
              <RadioGroup.Item
                key={item.code}
                value={item.code}
                className={cn(
                  "group flex min-h-12 items-center gap-3 rounded-xl border border-border bg-card px-4 text-left font-semibold pressable",
                  "hover:bg-qr-selection focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                  "data-[state=checked]:border-primary data-[state=checked]:bg-qr-selection data-[state=checked]:ring-1 data-[state=checked]:ring-primary",
                  "disabled:opacity-60",
                )}
              >
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span>{item.name}</span>
                  <FeeQuote
                    feeIdr={item.guestFeeIdr}
                    chargedIdr={item.chargedIdr}
                  />
                </span>
                <span
                  aria-hidden="true"
                  className="grid size-6 shrink-0 place-items-center rounded-full border-2 border-input group-data-[state=checked]:border-primary"
                >
                  <RadioGroup.Indicator className="size-3 rounded-full bg-primary" />
                </span>
              </RadioGroup.Item>
            ))}
          </RadioGroup.Root>
        </fieldset>
        <FeeNoRefund
          feeIdr={va.banks.find((item) => item.code === bank)?.guestFeeIdr}
        />
      </section>

      {error ? <Notice tone="danger" title={startErrorText(t, error)} /> : null}

      <QrFooter>
        <p
          role="status"
          aria-live="polite"
          className="text-center text-sm empty:hidden"
        >
          {creating ? t("qrGlass.pay.va.creating") : null}
        </p>
        <Button
          type="button"
          disabled={bank === null}
          loading={creating}
          onClick={onCreate}
        >
          {t("qrGlass.pay.va.create")}
        </Button>
        <ToCheckoutLink qrToken={qrToken} />
      </QrFooter>
    </>
  );
}

/** The live VA: number, bank, amount, deadline; polls until it settles. */
function VaDetails({
  qrToken,
  payment,
  statusFailed,
  onRetryStatus,
  onRenew,
  renewing,
  renewError,
  onChangeBank,
}: {
  qrToken: string;
  payment: {
    status: string;
    amountIdr: number;
    guestFeeIdr: number;
    chargedIdr: number;
    vaNumber: string | null;
    bankName: string | null;
    expiresAt: string;
  };
  statusFailed: boolean;
  onRetryStatus: () => void;
  onRenew: () => void;
  renewing: boolean;
  renewError: unknown;
  onChangeBank: () => void;
}) {
  const t = useT();
  const countdown = useCountdown(payment.expiresAt);
  const vaNumber = payment.vaNumber ?? "";
  // Only the server says a VA expired; the device clock may be off. At
  // 00:00:00 the page asks again and shows that it is checking.
  const expired = payment.status === "expired";
  const failed = payment.status === "failed";
  const checking = countdown?.done === true && payment.status === "pending";
  // A pending VA without a number cannot be paid: offer a new one.
  const missing = !expired && !failed && payment.vaNumber === null;
  useEffect(() => {
    if (checking) onRetryStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checking]);

  const changeBank = (
    <Button
      type="button"
      variant="outline"
      disabled={renewing}
      onClick={onChangeBank}
    >
      {t("qrGlass.pay.va.changeBank")}
    </Button>
  );

  if (expired || failed || missing)
    return (
      <>
        <Notice
          tone={missing ? "danger" : "warning"}
          title={
            expired
              ? t("qrGlass.pay.va.expiredTitle")
              : failed
                ? t("qrGlass.pay.va.failedTitle")
                : t("qrGlass.pay.va.missingTitle")
          }
        >
          {expired
            ? t("qrGlass.pay.va.expiredHint")
            : failed
              ? t("qrGlass.pay.va.failedHint")
              : t("qrGlass.pay.va.missingHint")}
        </Notice>
        {renewError ? (
          <Notice tone="danger" title={startErrorText(t, renewError)} />
        ) : null}
        <QrFooter>
          <Button type="button" loading={renewing} onClick={onRenew}>
            {t("qrGlass.pay.va.renew")}
            <RefreshCw aria-hidden="true" />
          </Button>
          {changeBank}
          <ToCheckoutLink qrToken={qrToken} />
        </QrFooter>
      </>
    );

  return (
    <>
      <PillHeader
        pill={t("qrGlass.pay.va.pill")}
        heading={t("qrGlass.pay.va.heading")}
        saved={t("qrGlass.pay.va.saved")}
      />

      <section className="grid gap-4 rounded-qr-media bg-card p-5 shadow-raised">
        <div className="grid gap-1">
          <p className="text-sm text-muted-foreground">
            {payment.bankName ? `${payment.bankName} · ` : null}
            {t("qrGlass.pay.va.numberLabel")}
          </p>
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <p className="text-[clamp(1.375rem,6.4vw,1.75rem)] leading-8 font-bold tracking-wide tabular">
              {groupBy4(vaNumber)}
            </p>
            <CopyButton value={vaNumber} />
          </div>
        </div>

        <hr className="border-t border-dashed border-input" />

        {hasGuestFee(payment.guestFeeIdr) && (
          <dl className="grid gap-1 text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-muted-foreground">
                {t("payment.redirect.fee.billRow")}
              </dt>
              <dd>
                <Money amount={payment.amountIdr} size="sm" />
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-muted-foreground">
                {t("payment.redirect.fee.label")}
              </dt>
              <dd>
                <Money amount={payment.guestFeeIdr} size="sm" />
              </dd>
            </div>
          </dl>
        )}
        <div className="flex items-baseline justify-between gap-3">
          <span>{t("qrGlass.pay.va.amountLabel")}</span>
          <Money
            amount={payment.chargedIdr}
            size="xl"
            className="text-2xl font-bold"
          />
        </div>
        <FeeNoRefund feeIdr={payment.guestFeeIdr} />

        <div className="grid justify-items-start gap-1">
          {/* Reserves the pill's height so the page does not jump on mount. */}
          <div className="min-h-8">
            {countdown && (
              <p className="inline-flex items-center gap-2 rounded-full bg-qr-selection px-3 py-1.5 text-sm">
                <Clock className="size-4 shrink-0" aria-hidden="true" />
                <span className="font-medium tabular">
                  {t("qrGlass.pay.va.timeLeft", { time: countdown.label })}
                </span>
              </p>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            {t("qrGlass.pay.va.timeNote")}
          </p>
        </div>
      </section>

      {checking ? (
        <Notice tone="warning" title={t("qrGlass.pay.va.checkingTitle")}>
          {t("qrGlass.pay.va.checkingHint")}
        </Notice>
      ) : (
        <ol
          aria-label={t("qrGlass.pay.va.stepsLabel")}
          className="grid gap-3 px-1"
        >
          {steps.map((step, index) => (
            <li key={step} className="flex items-start gap-3">
              <span
                aria-hidden="true"
                className="mt-0.5 inline-grid size-7 shrink-0 place-items-center rounded-full bg-qr-selection text-sm font-semibold tabular"
              >
                {index + 1}
              </span>
              <p className="text-lg leading-7">{t(step)}</p>
            </li>
          ))}
        </ol>
      )}

      <QrFooter>
        <p
          role="status"
          aria-live="polite"
          className={cn(
            "text-center text-sm",
            statusFailed ? "text-danger" : "text-muted-foreground",
          )}
        >
          {statusFailed
            ? t("qrGlass.pay.va.statusFailed")
            : t("qrGlass.pay.va.autoUpdate")}
        </p>
        {statusFailed && (
          <Button type="button" onClick={onRetryStatus}>
            {t("qrGlass.pay.va.statusRetry")}
            <RefreshCw aria-hidden="true" />
          </Button>
        )}
        {changeBank}
        <ToCheckoutLink qrToken={qrToken} />
      </QrFooter>
    </>
  );
}

/**
 * Bank list, then the VA it opens. Watches only the payment this page just
 * created: after a bank switch the old id reads `expired`.
 */
function VaFlow({
  order,
  qrToken,
  sessionId,
  method,
  shell,
}: {
  order: QrOrder;
  qrToken: string;
  sessionId: string;
  method: OnlinePayMethod;
  shell: (children: ReactNode) => ReactNode;
}) {
  const t = useT();
  const refresh = useRefreshSession(sessionId);
  const start = useStartPayment(sessionId);
  const options = useGuestPaymentOptions(sessionId, { orderId: order.id });
  // Read once: the page only renders in the browser (the guest session
  // lives in browser storage), so this never differs from the server markup.
  const [initial] = useState(() =>
    typeof window === "undefined" ? null : readChoice(order.id),
  );
  const [bank, setBank] = useState<string | null>(initial?.bankCode ?? null);
  const [reopening, setReopening] = useState(initial?.active === true);
  const [paymentId, setPaymentId] = useState<string | null>(null);
  const polled = useGuestPayment(sessionId, paymentId);
  const created = start.data?.data;
  const payment =
    polled.data?.data ?? (created?.id === paymentId ? created : undefined);
  const status = payment?.status;

  const create = (bankCode: string, renew = false) => {
    const key = vaKey(order.id, bankCode, renew);
    const saved = readChoice(order.id);
    if (saved?.key !== key)
      writeChoice(order.id, { bankCode, key, active: false });
    start.mutate(
      {
        target: { kind: "order", orderId: order.id },
        method: "va",
        bankCode,
        idempotencyKey: key,
      },
      {
        onSuccess: (result) => {
          setActive(order.id, true);
          setBank(bankCode);
          setPaymentId(result.data.id);
        },
        onError: (error) => {
          if (!(error instanceof ApiError) || error.status >= 500) return;
          // A refused key must not come back on the next tap or refresh.
          writeChoice(order.id, null);
          // 409: the order is no longer waiting (paid elsewhere, voided):
          // reload so the page shows where it went.
          if (error.status === 409) void refresh();
          // 422: the bank left the provider list; show the fresh list.
          if (error.status === 422) {
            setBank(null);
            void options.refetch();
          }
        },
        onSettled: () => setReopening(false),
      },
    );
  };

  // A refresh or a return visit reopens the VA on screen before (same key, same VA).
  useEffect(() => {
    if (initial?.active) create(initial.bankCode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Once paid, the order/bill/claim screens must show the new state.
  useEffect(() => {
    if (status !== "paid") return;
    writeChoice(order.id, null);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  if (payment?.status === "paid")
    return (
      <PaymentSuccess
        order={order}
        amountIdr={payment.amountIdr}
        feeIdr={payment.guestFeeIdr}
        method="va"
        returnTo={`/t/${encodeURIComponent(qrToken)}/bayar/${encodeURIComponent(order.id)}?metode=${method}`}
      />
    );

  if (payment)
    return shell(
      <VaDetails
        qrToken={qrToken}
        payment={payment}
        statusFailed={polled.isError}
        onRetryStatus={() => void polled.refetch()}
        onRenew={() => create(payment.bankCode ?? bank ?? "", true)}
        renewing={start.isPending}
        renewError={start.error}
        onChangeBank={() => {
          // An ended VA must not be replayed when the same bank is picked again.
          if (payment.status === "expired" || payment.status === "failed")
            writeChoice(order.id, null);
          else setActive(order.id, false);
          start.reset();
          setPaymentId(null);
        }}
      />,
    );

  if (reopening)
    return shell(
      <div aria-busy="true" className="grid gap-4">
        <span className="sr-only">{t("qrGlass.pay.va.creating")}</span>
        <Skeleton className="h-9 w-48 rounded-full" />
        <Skeleton className="h-16 w-3/4" />
        <Skeleton className="h-64 w-full rounded-qr-media" />
        <Skeleton className="h-32 w-full" />
      </div>,
    );

  return shell(
    <BankPicker
      sessionId={sessionId}
      orderId={order.id}
      qrToken={qrToken}
      bank={bank}
      onBank={setBank}
      onCreate={() => {
        if (bank !== null) create(bank);
      }}
      creating={start.isPending}
      error={start.error}
    />,
  );
}

export function OnlinePayPage({
  orderId,
  method,
}: {
  orderId: string;
  method: OnlinePayMethod;
}) {
  const t = useT();
  const { qrToken, guest, sessionId, view, viewError, ended, openJoin } =
    useTableJourney();
  const refresh = useRefreshSession(sessionId);

  const title = t("qrGlass.pay.va.title");
  const back = (
    <Link
      to="/t/$token/checkout"
      params={{ token: qrToken }}
      className={qrRoundIcon}
    >
      <ChevronLeft aria-hidden="true" />
      <span className="sr-only">{t("qrGlass.pay.va.back")}</span>
    </Link>
  );

  // Every state sits under the same top bar, so none is a dead end.
  const shell = (children: ReactNode) => (
    <div className="grid gap-4 lg:mx-auto lg:w-full lg:max-w-xl">
      <QrTopBar title={title} leading={back} />
      {children}
    </div>
  );

  if (ended) return <SessionEnded />;
  if (!guest || sessionId === null)
    return shell(
      <EmptyState
        icon={TriangleAlert}
        title={t("qrGlass.pay.cashier.noSessionTitle")}
        description={t("qrGlass.pay.cashier.noSessionHint")}
        action={
          <Button type="button" onClick={() => openJoin()}>
            {t("qrCart.cart.noSessionAction")}
          </Button>
        }
      />,
    );
  if (viewError)
    return shell(
      <ErrorState
        title={t("qrGlass.pay.cashier.errorTitle")}
        description={t("qrGlass.pay.cashier.errorHint")}
        onRetry={() => void refresh()}
      />,
    );
  if (!view)
    return (
      <div
        aria-busy="true"
        className="grid gap-4 lg:mx-auto lg:w-full lg:max-w-xl"
      >
        <QrTopBar title={title} leading={back} />
        <span className="sr-only">{t("qrGlass.pay.cashier.loading")}</span>
        <Skeleton className="h-9 w-48 rounded-full" />
        <Skeleton className="h-16 w-3/4" />
        <Skeleton className="h-64 w-full rounded-qr-media" />
        <Skeleton className="h-32 w-full" />
      </div>
    );

  const order = view.orders.find((item) => item.id === orderId);
  if (!order)
    return shell(
      <EmptyState
        icon={TriangleAlert}
        title={t("qrGlass.pay.cashier.notFoundTitle")}
        description={t("qrGlass.pay.cashier.notFoundHint")}
        action={
          <Button asChild>
            <Link to="/t/$token/orders" params={{ token: qrToken }}>
              {t("qrGlass.pay.cashier.toOrders")}
            </Link>
          </Button>
        }
      />,
    );
  if (order.status === "voided")
    return shell(
      <EmptyState
        icon={TriangleAlert}
        title={t("qrGlass.pay.cashier.voidedTitle")}
        description={t("qrGlass.pay.cashier.voidedHint")}
        action={
          <Button asChild>
            <Link to="/t/$token" params={{ token: qrToken }}>
              {t("qrGlass.pay.cashier.toMenu")}
            </Link>
          </Button>
        }
      />,
    );
  if (order.status !== "awaiting_payment")
    return (
      <PaymentSuccess
        order={order}
        amountIdr={order.totalIdr}
        method="va"
        returnTo={`/t/${encodeURIComponent(qrToken)}/bayar/${encodeURIComponent(orderId)}?metode=${method}`}
      />
    );

  return (
    <VaFlow
      order={order}
      qrToken={qrToken}
      sessionId={sessionId}
      method={method}
      shell={shell}
    />
  );
}
