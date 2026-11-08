import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Money } from "@/components/ui/money";
import { useActiveShift, useSubmitBlindCount } from "../../hooks";
import { CASH_DENOMINATIONS_IDR, type ActiveShift } from "../../types";
import {
  DenominationCounter,
  Notice,
  PosPageHeading,
  PosPanel,
  PosTwoPane,
  StatusPill,
  denominationTotal,
} from "../shared";
import { ActionError, ShiftScreenSkeleton } from "./shift-parts";
import { ShiftWaiting } from "./shift-waiting";

function CountForm({ shift }: { shift: ActiveShift }) {
  const t = useT();
  const submit = useSubmitBlindCount();
  const [quantities, setQuantities] = useState<Record<number, number>>({});
  const [otherIdr, setOtherIdr] = useState(0);

  const lines = CASH_DENOMINATIONS_IDR.map((denominationIdr) => ({
    denominationIdr,
    quantity: quantities[denominationIdr] ?? 0,
  }));
  const counted = denominationTotal(lines, otherIdr);

  return (
    <div className="grid gap-4">
      <PosPageHeading
        title={t("posKasirShift.count.title")}
        subtitle={t("posKasirShift.count.subtitle")}
        action={
          <StatusPill tone="neutral">
            {t("posKasirShift.count.shiftPill", {
              cashier: shift.cashierName,
              terminal: shift.terminalLabel,
            })}
          </StatusPill>
        }
      />
      <PosTwoPane
        sidePosition="end"
        side={
          <PosPanel title={t("posKasirShift.count.summaryTitle")}>
            <div className="flex h-full flex-col justify-between gap-6">
              <div className="grid gap-4">
                <div className="grid gap-2 border-t-(length:--border-w) border-border pt-4">
                  <span className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
                    {t("posKasirShift.count.summaryLabel")}
                  </span>
                  <Money amount={counted} size="hero" aria-live="polite" />
                  <p className="text-base text-muted-foreground">
                    {t("posKasirShift.count.summaryNote")}
                  </p>
                </div>
                <Notice
                  tone="warning"
                  title={t("posKasirShift.count.recheckTitle")}
                >
                  {t("posKasirShift.count.recheckBody")}
                </Notice>
              </div>
              <div className="grid gap-3">
                {submit.isError && (
                  <ActionError
                    title={t("posKasirShift.count.errorTitle")}
                    error={submit.error}
                  />
                )}
                {counted === 0 && (
                  <p
                    id="count-empty-hint"
                    className="text-base text-muted-foreground"
                  >
                    {t("posKasirShift.count.emptyHint")}
                  </p>
                )}
                <Button
                  className="w-full"
                  loading={submit.isPending}
                  disabled={counted === 0}
                  aria-describedby={
                    counted === 0 ? "count-empty-hint" : undefined
                  }
                  onClick={() =>
                    submit.mutate({
                      shiftId: shift.id,
                      counts: lines,
                      otherAmountIdr: otherIdr,
                    })
                  }
                >
                  {submit.isPending
                    ? t("posKasirShift.count.submitting")
                    : t("posKasirShift.count.submit")}
                </Button>
                <Button variant="outline" className="w-full" asChild>
                  <Link to="/pos/shift">{t("posKasirShift.count.back")}</Link>
                </Button>
              </div>
            </div>
          </PosPanel>
        }
      >
        <PosPanel title={t("posKasirShift.count.panelTitle")}>
          <div className="grid gap-4">
            <p className="text-base text-muted-foreground">
              {t("posKasirShift.count.panelHint")}
            </p>
            <DenominationCounter
              denominations={CASH_DENOMINATIONS_IDR}
              quantities={quantities}
              onQuantityChange={(denominationIdr, quantity) =>
                setQuantities((current) => ({
                  ...current,
                  [denominationIdr]: quantity,
                }))
              }
              otherIdr={otherIdr}
              onOtherChange={setOtherIdr}
            />
            <Notice tone="info" title={t("posKasirShift.count.hiddenTitle")}>
              {t("posKasirShift.count.hiddenBody")}
            </Notice>
          </div>
        </PosPanel>
      </PosTwoPane>
    </div>
  );
}

// /pos/shift/tutup: step 1 of closing, the blind count per denomination. The
// cashier never sees the system balance or the variance; after sending, the
// shift waits for a supervisor.
export function BlindCountScreen() {
  const t = useT();
  const shift = useActiveShift();
  if (shift.isPending)
    return <ShiftScreenSkeleton label={t("posKasirShift.loading")} />;
  if (shift.isError)
    return (
      <ErrorState
        title={t("posKasirShift.error.title")}
        description={t("posKasirShift.error.hint")}
        onRetry={() => void shift.refetch()}
      />
    );
  if (shift.data === null)
    return (
      <EmptyState
        title={t("posKasirShift.noShift.title")}
        description={t("posKasirShift.noShift.description")}
        action={
          <Button asChild>
            <Link to="/pos/shift">{t("posKasirShift.noShift.action")}</Link>
          </Button>
        }
      />
    );
  if (shift.data.status !== "open" || shift.data.countSubmitted)
    return <ShiftWaiting shift={shift.data} />;
  return <CountForm shift={shift.data} />;
}
