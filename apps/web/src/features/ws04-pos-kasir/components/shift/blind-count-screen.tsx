import { useState } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { IDR_CASH_DENOMINATIONS } from "@starter/shared/pos";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Money } from "@/components/ui/money";
import { ApiError } from "@/lib/api/errors";
import { useActiveShift, useSubmitBlindCount } from "../../shift-hooks";
import { closeScreenMode } from "../../offline/close-gate";
import { CloseNeedsInternet } from "../../offline/close-needs-internet";
import { usePosOffline } from "../../offline/hooks";
import { OfflineCloseBlock } from "../../offline/offline-close-block";
import { SHIFT_COUNT_LIMIT_CODE } from "../../shift-extra-types";
import type { ActiveShift } from "../../types";
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
import {
  requestShiftStatusView,
  ShiftCountLimit,
  ShiftWaiting,
} from "./shift-waiting";

function CountForm({ shift }: { shift: ActiveShift }) {
  const t = useT();
  const submit = useSubmitBlindCount();
  const router = useRouter();
  const [quantities, setQuantities] = useState<Record<number, number>>({});
  // An empty drawer is valid: a zero count needs one explicit confirmation.
  const [zeroArmed, setZeroArmed] = useState(false);

  const lines = IDR_CASH_DENOMINATIONS.map((denominationIdr) => ({
    denominationIdr,
    quantity: quantities[denominationIdr] ?? 0,
  }));
  const counted = denominationTotal(lines, 0);
  const confirmingZero = counted === 0 && zeroArmed;

  function send() {
    if (counted === 0 && !zeroArmed) {
      setZeroArmed(true);
      return;
    }
    submit.mutate({
      shiftId: shift.id,
      counts: lines,
      otherAmountIdr: 0,
    });
  }

  // All recounts used (409): only a supervisor can close the shift now.
  if (
    submit.error instanceof ApiError &&
    submit.error.code === SHIFT_COUNT_LIMIT_CODE
  )
    return (
      <ShiftCountLimit
        shift={shift}
        countedIdr={null}
        onStatus={() => {
          requestShiftStatusView();
          void router.navigate({ to: "/pos/shift" });
        }}
      />
    );

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
                    onRetry={send}
                  />
                )}
                {counted === 0 && (
                  <p
                    id="count-empty-hint"
                    className="text-base text-muted-foreground"
                  >
                    {confirmingZero
                      ? t("posKasirShift.count.zeroConfirm")
                      : t("posKasirShift.count.emptyHint")}
                  </p>
                )}
                <Button
                  className="w-full"
                  loading={submit.isPending}
                  aria-describedby={
                    counted === 0 ? "count-empty-hint" : undefined
                  }
                  onClick={send}
                >
                  {submit.isPending
                    ? t("posKasirShift.count.submitting")
                    : confirmingZero
                      ? t("posKasirShift.count.zeroSubmit")
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
              denominations={IDR_CASH_DENOMINATIONS}
              quantities={quantities}
              onQuantityChange={(denominationIdr, quantity) => {
                setZeroArmed(false);
                setQuantities((current) => ({
                  ...current,
                  [denominationIdr]: quantity,
                }));
              }}
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
  // Review O3 P3: the queue keeps sending while the cashier counts the drawer.
  // O4: while offline sales are on this tablet, the drawer is not counted.
  const offline = usePosOffline();
  // O5 (CTO 27 Nov, 6 b and c): without internet the count is not started, and
  // a shift read lost at the network does not become a loading error.
  if (
    closeScreenMode({
      online: offline.online,
      shiftError: shift.error,
      kit: offline.kit,
    }) === "needs_internet"
  )
    return <CloseNeedsInternet pending={offline.pending} />;
  if (shift.isPending)
    return <ShiftScreenSkeleton label={t("posKasirShift.loading")} />;
  if (shift.isError)
    return (
      <ErrorState
        error={shift.error}
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
  const block =
    shift.data.status === "open" && offline.pending > 0 ? (
      <OfflineCloseBlock
        shiftId={shift.data.id}
        pending={offline.pending}
        parked={offline.parked}
        queue={offline.queue}
        kit={offline.kit}
        online={offline.online}
        syncNow={offline.syncNow}
      />
    ) : null;
  if (shift.data.status !== "open" || shift.data.countSubmitted)
    return (
      <div className="grid gap-4">
        {block}
        <ShiftWaiting shift={shift.data} />
      </div>
    );
  if (block)
    return (
      <div className="grid gap-4">
        <PosPageHeading title={t("posKasirShift.count.title")} />
        {block}
      </div>
    );
  return <CountForm shift={shift.data} />;
}
