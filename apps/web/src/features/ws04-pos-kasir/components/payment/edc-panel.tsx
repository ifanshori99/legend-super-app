import { useState } from "react";
import { useT } from "@/components/i18n";
import { ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
  isContractPending,
  useEdcTerminals,
  usePaymentSession,
} from "../../hooks";
import type { EdcMode, PaymentAttempt } from "../../types";
import { EdcDeclined } from "./edc-declined";
import { EdcSelect } from "./edc-select";
import { EdcStandalone } from "./edc-standalone";
import { EdcSuccess } from "./edc-success";
import { EdcUnknown } from "./edc-unknown";
import { EdcWaiting } from "./edc-waiting";
import type { PaymentPanelProps } from "./panel-types";

type EdcAttempt = PaymentAttempt & { edc: NonNullable<PaymentAttempt["edc"]> };

const isEdcAttempt = (attempt: PaymentAttempt | null): attempt is EdcAttempt =>
  attempt !== null && attempt.method === "edc" && attempt.edc !== undefined;

// The whole EDC screen (page heading, bill and work panel): the state comes from
// the payment session, never from a guess. No request yet (or a failed one):
// choose terminal and send. Waiting: locked, the result arrives by itself.
// Unknown: only "Cek status EDC". Confirmed: proof and receipt. Standalone is
// a separate form, offered only while no request is open.
export function EdcPanel({
  orderId,
  amountIdr,
  onChangeMethod,
}: PaymentPanelProps) {
  const t = useT();
  const session = usePaymentSession(orderId);
  const terminals = useEdcTerminals();
  const [mode, setMode] = useState<EdcMode>("card");
  const [terminalId, setTerminalId] = useState<string>();
  const [standalone, setStandalone] = useState(false);

  if (session.isLoading || !session.bill) {
    if (session.error)
      return (
        <ErrorState
          error={session.error}
          title={t("posKasirEdc.loadError")}
          description={
            isContractPending(session.error)
              ? t("posKasirEdc.contractPending")
              : t("posKasirEdc.loadErrorHint")
          }
          onRetry={() => void session.refetch()}
        />
      );
    return (
      <div className="grid gap-4" aria-busy="true">
        <span className="sr-only" role="status">
          {t("posKasirEdc.loading")}
        </span>
        <Skeleton className="h-16 w-2/3" />
        <div className="grid gap-4 md:grid-cols-[minmax(0,25rem)_minmax(0,1fr)]">
          <Skeleton className="h-96" />
          <Skeleton className="h-96" />
        </div>
      </div>
    );
  }

  const bill = session.bill;
  const attempt = isEdcAttempt(session.activeAttempt)
    ? session.activeAttempt
    : null;

  if (attempt?.status === "confirmed")
    return (
      <EdcSuccess
        orderId={orderId}
        bill={bill}
        attempt={attempt}
        receiptNo={session.receiptNo}
        completion={session.completion}
      />
    );
  if (attempt?.status === "declined")
    return (
      <EdcDeclined
        orderId={orderId}
        bill={bill}
        attempt={attempt}
        onChangeMethod={onChangeMethod}
      />
    );
  if (attempt?.status === "unknown")
    return <EdcUnknown orderId={orderId} bill={bill} attempt={attempt} />;
  if (attempt?.status === "waiting")
    return <EdcWaiting orderId={orderId} bill={bill} attempt={attempt} />;

  const list = terminals.data ?? [];
  const terminal =
    list.find((item) => item.id === terminalId) ??
    list.find((item) => item.status === "ready");

  if (standalone)
    return (
      <EdcStandalone
        orderId={orderId}
        bill={bill}
        terminal={terminal}
        mode={mode}
        onBack={() => setStandalone(false)}
      />
    );

  return (
    <EdcSelect
      orderId={orderId}
      bill={bill}
      amountIdr={amountIdr > 0 ? amountIdr : bill.remainingIdr}
      terminals={list}
      terminalsLoading={terminals.isLoading}
      terminal={terminal}
      mode={mode}
      onTerminalChange={setTerminalId}
      onModeChange={setMode}
      previousFailed={attempt?.status === "failed"}
      onBack={onChangeMethod}
      onStandalone={() => setStandalone(true)}
    />
  );
}
