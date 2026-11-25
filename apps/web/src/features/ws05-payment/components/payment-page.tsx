// Customer payment page for one payment link (PRD §3.13 F13, D24).
//
// PAY-02: the phase comes from the payment link and the polled intent only. A
// gateway redirect back with ?status=success is not read anywhere on this page,
// so a browser redirect can never make the screen look paid.
import { useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { useT } from "@/components/i18n";
import { Card } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/feedback-state";
import { useToast } from "@/components/ui/toast";
import { useOnline } from "@/lib/use-online";
import { isNotFoundError, isOfflineError, paymentErrorKey } from "../errors";
import {
  useAutoRefreshIntent,
  useCountdown,
  usePayAtCashier,
  usePaymentIntent,
  usePaymentLink,
  useSettledIntentSync,
  useStartPayment,
} from "../hooks";
import { pickerMethods, type PickerMethodCode } from "../labels";
import { canSubmit, clockSkewMs, paymentPhase } from "../status";
import { BillCard } from "./bill-card";
import { MethodPicker } from "./method-picker";
import { PaymentCode } from "./payment-code";
import {
  OfflineNotice,
  PaymentCashier,
  PaymentEmpty,
  PaymentOffline,
  PaymentPaid,
  PaymentRetry,
} from "./payment-result";
import { PaymentSkeleton } from "./payment-skeleton";
import { newIdempotencyKey } from "../../../lib/idempotency.ts";

export function PaymentPage({ token }: { token: string }) {
  const t = useT();
  const toast = useToast();
  const online = useOnline();

  const link = usePaymentLink(token);
  const view = link.data;

  const [selection, setSelection] = useState<{
    method: PickerMethodCode | null;
    channelCode: string | null;
  }>({ method: null, channelCode: null });
  const [switching, setSwitching] = useState(false);
  // One key per chosen method/channel: a double tap returns the first intent
  // instead of creating a second one (PAY-01 idempotency).
  const idempotency = useRef<{
    key: string;
    method: string | null;
    channel: string | null;
  }>({ key: "", method: null, channel: null });

  const start = useStartPayment(token);
  const payAtCashier = usePayAtCashier(token);

  const viewIntent = view?.activeIntent ?? null;
  const intentQuery = usePaymentIntent(token, viewIntent?.id ?? null);
  const intent = intentQuery.data ?? viewIntent ?? start.data ?? null;

  // The link's fetch timestamp is the local reference for the server clock;
  // never read the device clock during render.
  const skew =
    view && link.dataUpdatedAt
      ? clockSkewMs(view.serverTime, link.dataUpdatedAt)
      : 0;
  const remaining = useCountdown(intent?.expiresAt ?? null, skew);

  useSettledIntentSync(token, intent);
  const refresh = useAutoRefreshIntent(
    token,
    intent?.status === "pending" ? intent : null,
    remaining,
  );
  // Keep the success watermark when that mutation starts its next attempt.
  // The guarded update adjusts this component's own state without an effect.
  const [successfulMutationAt, setSuccessfulMutationAt] = useState(-1);
  const latestSuccessAt = Math.max(
    successfulMutationAt,
    start.isSuccess ? (start.submittedAt ?? 0) : -1,
    refresh.isSuccess ? (refresh.submittedAt ?? 0) : -1,
  );
  if (latestSuccessAt > successfulMutationAt)
    setSuccessfulMutationAt(latestSuccessAt);

  if (link.isPending) return <PaymentSkeleton />;

  if (link.isError)
    return !online || isOfflineError(link.error) ? (
      <PaymentOffline
        onRetry={() => void link.refetch()}
        retrying={link.isFetching}
      />
    ) : (
      <Card>
        <ErrorState
          title={
            isNotFoundError(link.error)
              ? t("payment.linkNotFound")
              : t("payment.loadFailedTitle")
          }
          description={
            isNotFoundError(link.error)
              ? t("payment.linkNotFoundHint")
              : t(paymentErrorKey(link.error))
          }
          onRetry={
            isNotFoundError(link.error) ? undefined : () => void link.refetch()
          }
        />
      </Card>
    );

  const data = link.data;
  const phase = paymentPhase(data, switching ? null : intent);
  const methods = pickerMethods(data.methods);
  const selectedMethod =
    selection.method ??
    methods.find((method) => method.enabled)?.method ??
    null;
  const selectedOption =
    methods.find((method) => method.method === selectedMethod) ?? null;
  const selectedChannel =
    selectedOption && selectedOption.method !== "qris"
      ? selection.channelCode
      : null;

  function submit() {
    if (!selectedMethod || !canSubmit(selectedMethod, selectedChannel)) return;
    if (
      idempotency.current.method !== selectedMethod ||
      idempotency.current.channel !== selectedChannel
    )
      idempotency.current = {
        key: newIdempotencyKey(),
        method: selectedMethod,
        channel: selectedChannel,
      };
    setSwitching(false);
    start.mutate({
      method: selectedMethod,
      channelCode: selectedChannel,
      idempotencyKey: idempotency.current.key,
    });
  }

  /** A fresh code for the same method after an expiry or a failure. */
  function retry() {
    const method = intent?.method ?? selectedMethod;
    if (!method) return;
    const channel = intent
      ? intent.instructions.method === "qris"
        ? null
        : intent.instructions.channelCode
      : selectedChannel;
    idempotency.current = {
      key: newIdempotencyKey(),
      method,
      channel,
    };
    start.mutate({
      method,
      channelCode: channel,
      idempotencyKey: idempotency.current.key,
    });
  }

  function notifyCashier() {
    payAtCashier.mutate(undefined, {
      onSuccess: () =>
        toast({
          title: t("payment.payAtCashier"),
          description: t("payment.payAtCashierDone", {
            reference: data.bill.reference,
          }),
          tone: "success",
        }),
    });
  }

  const checking = link.isFetching || intentQuery.isFetching;
  // A successful replacement resolves earlier refusals from either mutation.
  // Parked funds still take priority among errors after that success.
  const currentErrors = [start, refresh]
    .filter(
      (mutation) =>
        mutation.error && (mutation.submittedAt ?? 0) > latestSuccessAt,
    )
    .sort((a, b) => (b.submittedAt ?? 0) - (a.submittedAt ?? 0));
  const fundsError = currentErrors.find(
    (mutation) => paymentErrorKey(mutation.error) === "payment.fundsUnresolved",
  )?.error;
  const latestError = currentErrors[0]?.error;
  const codeError =
    phase === "paid" || phase === "empty" ? null : (fundsError ?? latestError);
  const errorKey = codeError ? paymentErrorKey(codeError) : null;
  const codeActive = errorKey === "payment.codeStillActive";
  const fundsUnresolved = errorKey === "payment.fundsUnresolved";
  const showPreviousCode =
    intent !== null &&
    (codeActive || fundsUnresolved) &&
    (phase === "expired" ||
      phase === "failed" ||
      (fundsUnresolved && phase === "choose"));

  return (
    <article className="grid gap-4">
      <header className="grid gap-2">
        {data.returnPath && (
          <a
            href={data.returnPath}
            className="inline-flex min-h-control-sm w-fit items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            {t("payment.back")}
          </a>
        )}
        <h1 className="type-display-xl">{t("payment.title")}</h1>
      </header>

      {!online && phase !== "paid" && (
        <OfflineNotice
          onCheck={() => {
            void link.refetch();
            void intentQuery.refetch();
          }}
          checking={checking}
        />
      )}

      <BillCard bill={data.bill} />

      {codeError && (
        <p role="alert" className="text-sm leading-5 text-danger">
          {t(paymentErrorKey(codeError))}
        </p>
      )}

      {phase === "choose" && !fundsUnresolved && (
        <MethodPicker
          methods={methods}
          method={selectedMethod}
          channelCode={selectedChannel}
          onMethod={(method) => setSelection({ method, channelCode: null })}
          onChannel={(channelCode) =>
            setSelection((current) => ({ ...current, channelCode }))
          }
          onSubmit={submit}
          submitting={start.isPending}
          error={null}
        />
      )}

      {(phase === "pending" || showPreviousCode) && intent && (
        <PaymentCode
          intent={intent}
          remaining={remaining}
          refreshing={refresh.isPending}
          onChangeMethod={() => setSwitching(true)}
          referenceOnly={fundsUnresolved}
        />
      )}

      {phase === "paid" && intent && (
        <PaymentPaid
          intent={intent}
          returnPath={data.returnPath}
          timeZone={data.timeZone}
        />
      )}

      {(phase === "expired" || phase === "failed") &&
        !showPreviousCode &&
        !fundsUnresolved && (
          <PaymentRetry
            kind={phase}
            onRetry={retry}
            retrying={start.isPending}
            error={null}
          />
        )}

      {phase === "unavailable" && (
        <PaymentCashier
          bill={data.bill}
          gatewayDown={data.gateway.status === "down"}
          onNotify={notifyCashier}
          notifying={payAtCashier.isPending}
          notified={payAtCashier.isSuccess}
          error={payAtCashier.error}
        />
      )}

      {phase === "empty" && <PaymentEmpty />}
    </article>
  );
}
