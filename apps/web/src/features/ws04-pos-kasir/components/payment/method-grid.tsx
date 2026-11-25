import { cn } from "cn";
import {
  ArrowRight,
  Banknote,
  CreditCard,
  Landmark,
  QrCode,
  Smartphone,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Notice, PosPanel, StatusPill } from "../shared";
import {
  isContractPending,
  usePaymentMethods,
  usePaymentSession,
} from "../../hooks";
import type { PaymentMethodCode } from "../../types";
import { confirmedAllocations } from "./payment-helpers";

const ICONS: Record<PaymentMethodCode, LucideIcon> = {
  qris: QrCode,
  va: Landmark,
  ewallet: Wallet,
  card: CreditCard,
  cash: Banknote,
  edc: Smartphone,
};

export type MethodGridProps = {
  orderId: string;
  selected: PaymentMethodCode | null;
  onSelect: (method: PaymentMethodCode) => void;
  /** Take the whole remaining balance with the selected method. */
  onContinue: (method: PaymentMethodCode) => void;
  /** Open the amount step to pay only part of the balance. */
  onPartial: (method: PaymentMethodCode) => void;
  /** False: every method settles the whole balance, so no amount step. */
  partialAllowed: boolean;
};

// The method choice. The active methods come from data (`usePaymentMethods`),
// never from a fixed list here. A method is picked with ink (border + fill),
// never with the accent color.
export function MethodGrid({
  orderId,
  selected,
  onSelect,
  onContinue,
  onPartial,
  partialAllowed,
}: MethodGridProps) {
  const t = useT();
  const methods = usePaymentMethods(orderId);
  const { bill } = usePaymentSession(orderId);
  const options = methods.data ?? [];
  const current = options.find((m) => m.code === selected && m.enabled);
  const paymentCount = bill ? confirmedAllocations(bill).length + 1 : 1;
  return (
    <PosPanel
      title={t("posKasirPayment.methods.title")}
      aside={
        <StatusPill tone="neutral">
          {t("posKasirPayment.methods.count", { count: paymentCount })}
        </StatusPill>
      }
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            disabled={!current || !partialAllowed}
            onClick={() => current && onPartial(current.code)}
          >
            {t("posKasirPayment.methods.partial")}
          </Button>
          <Button
            type="button"
            disabled={!current}
            onClick={() => current && onContinue(current.code)}
          >
            {current
              ? t("posKasirPayment.methods.continue", { method: current.label })
              : t("posKasirPayment.methods.choose")}
            <ArrowRight aria-hidden="true" />
          </Button>
        </>
      }
    >
      <p className="text-base text-muted-foreground">
        {t(
          partialAllowed
            ? "posKasirPayment.methods.hint"
            : "posKasirPayment.methods.hintFull",
        )}
      </p>
      {methods.isLoading ? (
        <div
          aria-busy="true"
          className="mt-4 grid gap-3 sm:grid-cols-2"
          role="status"
        >
          <span className="sr-only">{t("posKasirPayment.screen.loading")}</span>
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} className="h-24 rounded-control" />
          ))}
        </div>
      ) : methods.isError ? (
        <div className="mt-4 grid justify-items-start gap-3">
          {isContractPending(methods.error) ? (
            <Notice
              tone="warning"
              title={t("posKasirGateway.common.contractPending")}
            >
              {t("posKasirGateway.common.contractPendingHint")}
            </Notice>
          ) : (
            <>
              <Notice tone="danger" title={t("posKasirGateway.grid.loadError")}>
                {t("posKasirGateway.grid.loadErrorHint")}
              </Notice>
              <Button
                type="button"
                variant="outline"
                onClick={() => void methods.refetch()}
              >
                {t("posKasirGateway.common.retry")}
              </Button>
            </>
          )}
        </div>
      ) : options.length === 0 ? (
        <p className="mt-4 rounded-control bg-muted p-4 text-(length:--density-text)">
          {t("posKasirPayment.methods.empty")}
        </p>
      ) : (
        <div
          role="group"
          aria-label={t("posKasirPayment.methods.groupLabel")}
          className="mt-4 grid gap-3 sm:grid-cols-2"
        >
          {options.map((method) => {
            const Icon = ICONS[method.code];
            const isSelected = method.code === current?.code;
            return (
              <button
                key={method.code}
                type="button"
                aria-pressed={isSelected}
                disabled={!method.enabled}
                onClick={() => onSelect(method.code)}
                className={cn(
                  "flex min-h-24 items-center gap-4 rounded-control border-(length:--border-w) border-border bg-card p-4 text-left shadow-hairline pressable hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50",
                  isSelected &&
                    "border-foreground bg-surface-2 ring-2 ring-foreground",
                )}
              >
                <Icon className="size-6 shrink-0" aria-hidden="true" />
                <span className="grid min-w-0 gap-0.5">
                  <span className="text-(length:--density-text) leading-6 font-bold">
                    {method.label}
                    {isSelected && <span aria-hidden="true"> ✓</span>}
                    {isSelected && (
                      <span className="sr-only">
                        {" "}
                        {t("posKasirPayment.methods.selected")}
                      </span>
                    )}
                  </span>
                  <span className="text-base text-muted-foreground">
                    {method.unavailableReason
                      ? t(
                          `posKasirGateway.grid.locked.${method.unavailableReason}`,
                        )
                      : method.hint ||
                        t(`posKasirGateway.grid.hint.${method.code}`)}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </PosPanel>
  );
}
