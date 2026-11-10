import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, RotateCw } from "lucide-react";
import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import { BillPanel, Notice, PosPageHeading, PosTwoPane } from "../shared";
import {
  isContractPending,
  usePaymentMethods,
  usePaymentSession,
} from "../../hooks";
import type { PaymentAttempt, PaymentMethodCode } from "../../types";
import { CardOnlinePanel } from "./card-online-panel";
import { CashPanel } from "./cash-panel";
import { EdcPanel } from "./edc-panel";
import { EwalletPanel } from "./ewallet-panel";
import { FailedPanel } from "./failed-panel";
import { MethodGrid } from "./method-grid";
import type { PaymentPanelProps } from "./panel-types";
import { QrisPanel } from "./qris-panel";
import { SplitPanel } from "./split-panel";
import { SuccessPanel } from "./success-panel";
import { VaPanel } from "./va-panel";

// What the cashier is doing before a payment attempt exists. Once the server
// has an attempt (QRIS waiting, EDC sent, ...) its status decides the panel,
// not this step.
type Step =
  | { kind: "methods"; selected: PaymentMethodCode | null }
  | { kind: "split"; method: PaymentMethodCode; amountIdr: number }
  | { kind: "pay"; method: PaymentMethodCode; amountIdr: number };

const GATEWAY_PANELS: Record<
  Exclude<PaymentMethodCode, "cash" | "edc">,
  (props: PaymentPanelProps) => ReactNode
> = {
  qris: QrisPanel,
  va: VaPanel,
  ewallet: EwalletPanel,
  card: CardOnlinePanel,
};

function headingKeys(
  attempt: PaymentAttempt | null,
  step: Step,
): readonly [string, string] {
  if (attempt?.status === "failed") return ["failed", "failedHint"] as const;
  if (attempt) {
    if (attempt.method === "qris")
      return [
        "qris",
        attempt.status === "expired" ? "qrisExpiredHint" : "qrisHint",
      ] as const;
    if (attempt.method === "va") return ["va", "vaHint"] as const;
    if (attempt.method === "ewallet")
      return ["ewallet", "ewalletHint"] as const;
    if (attempt.method === "card") return ["card", "cardHint"] as const;
  }
  if (step.kind === "split") return ["split", "splitHint"] as const;
  if (step.kind === "pay") {
    if (step.method === "cash") return ["cash", "cashHint"] as const;
    if (step.method === "qris") return ["qris", "qrisHint"] as const;
    if (step.method === "va") return ["va", "vaHint"] as const;
    if (step.method === "ewallet") return ["ewallet", "ewalletHint"] as const;
    if (step.method === "card") return ["card", "cardHint"] as const;
  }
  return ["methods", "methodsHint"] as const;
}

function LoadingShape() {
  const t = useT();
  return (
    <div aria-busy="true" role="status" className="grid gap-4">
      <span className="sr-only">{t("posKasirPayment.screen.loading")}</span>
      <Skeleton className="h-16 w-80 max-w-full" />
      <div className="grid gap-4 md:grid-cols-[minmax(0,25rem)_minmax(0,1fr)]">
        <Skeleton className="h-[34rem] rounded-container" />
        <Skeleton className="h-[34rem] rounded-container" />
      </div>
    </div>
  );
}

// /pos/bayar/$orderId: take payment for one bill. This screen only decides
// which panel shows: paid -> success, an attempt on the server -> that
// method's panel by its status, otherwise the cashier's current step
// (methods -> split -> the method's panel). Data comes from hooks only.
export function PaymentScreen({ orderId }: { orderId: string }) {
  const t = useT();
  const session = usePaymentSession(orderId);
  const methods = usePaymentMethods(orderId);
  const [step, setStep] = useState<Step>({ kind: "methods", selected: null });
  // "Pilih metode lain" on an expired or failed attempt: hide that attempt
  // until a new one is created (a new attempt has a new id).
  const [dismissedAttemptId, setDismissedAttemptId] = useState<string | null>(
    null,
  );

  const { bill, activeAttempt } = session;

  // A payment was just confirmed but the bill is not settled: the old step
  // (its method and amount) is stale and would charge again. Back to the
  // method choice; set during render so no stale panel paints first.
  const confirmedIdr = bill
    ? bill.allocations
        .filter((a) => a.status === "confirmed")
        .reduce((sum, a) => sum + a.amountIdr, 0)
    : 0;
  const [seenConfirmedIdr, setSeenConfirmedIdr] = useState(confirmedIdr);
  if (confirmedIdr !== seenConfirmedIdr) {
    setSeenConfirmedIdr(confirmedIdr);
    if (confirmedIdr > seenConfirmedIdr && bill && !bill.paid)
      setStep({ kind: "methods", selected: null });
  }

  if (session.isLoading) return <LoadingShape />;

  if (session.error) {
    const pending = isContractPending(session.error);
    return (
      <ErrorState
        error={session.error}
        title={t(
          pending
            ? "posKasirPayment.screen.pendingTitle"
            : "posKasirPayment.screen.errorTitle",
        )}
        description={t(
          pending
            ? "posKasirPayment.screen.pendingHint"
            : "posKasirPayment.screen.errorHint",
        )}
        action={
          <div className="flex flex-wrap gap-3">
            {!pending && (
              <Button onClick={() => void session.refetch()}>
                <RotateCw aria-hidden="true" />
                {t("common.retry")}
              </Button>
            )}
            <BackLink />
          </div>
        }
      />
    );
  }

  if (!bill) {
    return (
      <EmptyState
        title={t("posKasirPayment.screen.emptyTitle")}
        description={t("posKasirPayment.screen.emptyHint")}
        action={<BackLink />}
      />
    );
  }

  const attempt =
    activeAttempt && activeAttempt.id !== dismissedAttemptId
      ? activeAttempt
      : null;

  const toMethods = () => {
    if (activeAttempt) setDismissedAttemptId(activeAttempt.id);
    setStep({ kind: "methods", selected: null });
  };

  // EDC brings its own page layout (terminal, locked amount, reference lines),
  // so the whole screen is handed to it, from the first step to the result.
  const edcStep = step.kind === "pay" && step.method === "edc" ? step : null;
  if (!bill.paid && (attempt?.method === "edc" || (!attempt && edcStep))) {
    return (
      <EdcPanel
        orderId={orderId}
        amountIdr={
          attempt?.amountIdr ??
          Math.min(edcStep?.amountIdr ?? bill.remainingIdr, bill.remainingIdr)
        }
        onChangeMethod={toMethods}
      />
    );
  }
  if (bill.paid && attempt?.method === "edc") {
    return (
      <EdcPanel
        orderId={orderId}
        amountIdr={attempt.amountIdr}
        onChangeMethod={toMethods}
      />
    );
  }

  const cashEnabled = methods.data?.some((m) => m.code === "cash" && m.enabled);
  const methodLabel = (code: PaymentMethodCode) =>
    methods.data?.find((m) => m.code === code)?.label ?? code;

  const attemptProps: PaymentPanelProps = {
    orderId,
    amountIdr: attempt?.amountIdr ?? bill.remainingIdr,
    onChangeMethod: toMethods,
  };

  let panel: ReactNode = null;
  let keys = headingKeys(attempt, step);
  if (bill.paid) {
    keys = ["paid", "paidHint"];
    panel = <SuccessPanel {...attemptProps} amountIdr={bill.totalIdr} />;
  } else if (attempt && attempt.method !== "cash" && attempt.method !== "edc") {
    const Gateway =
      attempt.status === "failed"
        ? FailedPanel
        : GATEWAY_PANELS[attempt.method];
    panel = <Gateway {...attemptProps} />;
  } else if (step.kind === "methods") {
    panel = (
      <MethodGrid
        orderId={orderId}
        selected={step.selected ?? (cashEnabled ? "cash" : null)}
        onSelect={(method) => setStep({ kind: "methods", selected: method })}
        onContinue={(method) =>
          // With payments already taken, show the combined view first.
          setStep({
            kind: bill.allocations.some((a) => a.status === "confirmed")
              ? "split"
              : "pay",
            method,
            amountIdr: bill.remainingIdr,
          })
        }
        onPartial={(method) =>
          setStep({ kind: "split", method, amountIdr: bill.remainingIdr })
        }
      />
    );
  } else if (step.kind === "split") {
    panel = (
      <SplitPanel
        orderId={orderId}
        amountIdr={step.amountIdr}
        method={step.method}
        methodLabel={methodLabel(step.method)}
        onChangeMethod={toMethods}
        onContinue={(amountIdr) =>
          setStep({ kind: "pay", method: step.method, amountIdr })
        }
      />
    );
  } else {
    const props = {
      ...attemptProps,
      amountIdr: Math.min(step.amountIdr, bill.remainingIdr),
    };
    if (step.method === "cash") panel = <CashPanel {...props} />;
    else if (step.method !== "edc") {
      const Gateway = GATEWAY_PANELS[step.method];
      panel = <Gateway {...props} />;
    }
  }

  const heading = (key: string) =>
    t(`posKasirPayment.heading.${key}` as "posKasirPayment.heading.methods");

  return (
    <div className="grid gap-4">
      <PosPageHeading
        title={heading(keys[0])}
        subtitle={heading(keys[1])}
        action={<BackLink />}
      />
      <PosTwoPane
        side={
          <div className="grid h-full content-start gap-4">
            <BillPanel
              tableLabel={bill.tableLabel}
              orderNo={bill.orderNo}
              itemCount={bill.itemCount}
              guestCount={bill.guestCount}
              subtotalIdr={bill.subtotalIdr}
              serviceIdr={bill.serviceIdr}
              taxIdr={bill.taxIdr}
              totalIdr={bill.totalIdr}
              deposit={bill.deposit}
              allocations={bill.allocations}
              remainingIdr={bill.remainingIdr}
              paid={bill.paid}
            />
            {bill.depositSurplusIdr > 0 && (
              <Notice
                tone="info"
                title={t("posKasirPayment.screen.surplus", {
                  amount: formatRupiah(bill.depositSurplusIdr),
                })}
              >
                {t("posKasirPayment.screen.surplusHint")}
              </Notice>
            )}
          </div>
        }
      >
        {panel}
      </PosTwoPane>
    </div>
  );
}

function BackLink() {
  const t = useT();
  return (
    <Button asChild variant="outline">
      <Link to="/pos/meja">
        <ArrowLeft aria-hidden="true" />
        {t("posKasirPayment.screen.back")}
      </Link>
    </Button>
  );
}
