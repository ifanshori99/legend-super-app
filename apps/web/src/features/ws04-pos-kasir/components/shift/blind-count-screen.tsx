import { useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Money } from "@/components/ui/money";
import { useActiveShift, useSubmitBlindCount } from "../../hooks";
import {
  CASH_DENOMINATIONS_IDR,
  CASH_NOTE_DENOMINATIONS_IDR,
  CASH_SMALL_DENOMINATIONS_IDR,
  type ActiveShift,
} from "../../types";
import {
  DenominationCounter,
  Notice,
  PosPageHeading,
  PosPanel,
  PosTwoPane,
  StatusPill,
  denominationTotal,
} from "../shared";
import {
  ActionError,
  ShiftScreenSkeleton,
  useFocusHeading,
} from "./shift-parts";
import { ShiftWaiting } from "./shift-waiting";

function CountForm({
  shift,
  recounting,
  focusHeading,
  onSend,
  onCancelRecount,
}: {
  shift: ActiveShift;
  recounting: boolean;
  focusHeading: boolean;
  /** The cashier pressed send; the waiting screen follows from the shift data. */
  onSend: () => void;
  onCancelRecount: () => void;
}) {
  const t = useT();
  const rootRef = useFocusHeading(focusHeading);
  const submit = useSubmitBlindCount();
  const [quantities, setQuantities] = useState<Record<number, number>>({});
  // An empty drawer is valid: a zero count asks once, in a dialog, per try.
  const [zeroDialogOpen, setZeroDialogOpen] = useState(false);
  const recheckRef = useRef<HTMLButtonElement>(null);

  const lines = CASH_DENOMINATIONS_IDR.map((denominationIdr) => ({
    denominationIdr,
    quantity: quantities[denominationIdr] ?? 0,
  }));
  const counted = denominationTotal(lines);

  function sendNow() {
    setZeroDialogOpen(false);
    onSend();
    // Only filled denominations go out; an all-zero count sends one zero row.
    const filled = lines.filter((line) => line.quantity > 0);
    submit.mutate({
      shiftId: shift.id,
      counts: filled.length > 0 ? filled : [lines[0]],
    });
  }

  function send() {
    if (counted === 0) {
      setZeroDialogOpen(true);
      return;
    }
    sendNow();
  }

  return (
    <div ref={rootRef} className="grid gap-4">
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
          <PosPanel
            title={t("posKasirShift.count.summaryTitle")}
            className="md:sticky md:top-4 md:h-auto md:self-start"
          >
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
                    {t("posKasirShift.count.emptyHint")}
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
                    : t("posKasirShift.count.submit")}
                </Button>
                {recounting ? (
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={onCancelRecount}
                  >
                    {t("posKasirShift.count.keepPrevious")}
                  </Button>
                ) : (
                  <Button variant="outline" className="w-full" asChild>
                    <Link to="/pos/shift">{t("posKasirShift.count.back")}</Link>
                  </Button>
                )}
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
            {recounting && (
              <Notice
                tone="warning"
                title={t("posKasirShift.count.recountTitle")}
              >
                {t("posKasirShift.count.recountBanner")}
              </Notice>
            )}
            {[
              {
                key: "notes",
                label: t("posKasirShift.count.notesGroup"),
                denominations: CASH_NOTE_DENOMINATIONS_IDR,
              },
              {
                key: "small",
                label: t("posKasirShift.count.smallGroup"),
                denominations: CASH_SMALL_DENOMINATIONS_IDR,
              },
            ].map((group) => (
              <fieldset key={group.key} className="min-w-0">
                <legend className="mb-3 text-sm font-semibold tracking-wide text-muted-foreground uppercase">
                  {group.label}
                </legend>
                <DenominationCounter
                  denominations={group.denominations}
                  quantities={quantities}
                  unitLabel={(denominationIdr) =>
                    denominationIdr >= 1_000
                      ? t("posKasirShift.count.unitSheet")
                      : t("posKasirShift.count.unitPiece")
                  }
                  onQuantityChange={(denominationIdr, quantity) =>
                    setQuantities((current) => ({
                      ...current,
                      [denominationIdr]: quantity,
                    }))
                  }
                />
              </fieldset>
            ))}
            <Notice tone="info" title={t("posKasirShift.count.hiddenTitle")}>
              {t("posKasirShift.count.hiddenBody")}
            </Notice>
          </div>
        </PosPanel>
      </PosTwoPane>
      <Dialog open={zeroDialogOpen} onOpenChange={setZeroDialogOpen}>
        <DialogContent
          onOpenAutoFocus={(event) => {
            // Start on the safe button so Enter never sends Rp0 by accident.
            event.preventDefault();
            recheckRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {t("posKasirShift.count.zeroDialog.title")}
            </DialogTitle>
            <DialogDescription>
              {t("posKasirShift.count.zeroDialog.description")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              ref={recheckRef}
              type="button"
              variant="outline"
              onClick={() => setZeroDialogOpen(false)}
            >
              {t("posKasirShift.count.zeroDialog.recheck")}
            </Button>
            <Button type="button" onClick={sendNow}>
              {t("posKasirShift.count.zeroDialog.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// /pos/shift/tutup: step 1 of closing, the blind count per denomination. The
// cashier never sees the system balance or the variance; after sending, the
// shift waits for a supervisor.
export function BlindCountScreen({
  recountFrom,
}: {
  /** Count sequence to replace when arriving from "Hitung ulang" elsewhere. */
  recountFrom?: number;
} = {}) {
  const t = useT();
  const shift = useActiveShift();
  // Recounting goes back to the form. It remembers which count it replaces
  // (`from`): once the shift carries a newer count sequence the form ends by
  // itself, so no mutate callback has to survive an unmount. The count number
  // on the waiting screen comes from the active shift too, so it survives a
  // reload.
  const [recount, setRecount] = useState<{ from: number | null } | null>(
    recountFrom === undefined ? null : { from: recountFrom },
  );
  // Set once the cashier acted, so the next screen takes focus on its heading.
  const [moved, setMoved] = useState(false);
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
  const data = shift.data;
  // After a count the shift is `awaiting_approval` and the count can still be
  // replaced; only a closed shift is final.
  if (data.status === "closed") return <ShiftWaiting shift={data} />;
  const recounting =
    data.countSubmitted &&
    recount !== null &&
    recount.from === data.countSequence;
  if (data.countSubmitted && !recounting)
    return (
      <ShiftWaiting
        shift={data}
        focusHeading={moved}
        onRecount={() => {
          setMoved(true);
          setRecount({ from: data.countSequence });
        }}
      />
    );
  if (data.status !== "open" && !data.countSubmitted)
    return <ShiftWaiting shift={data} />;
  return (
    <CountForm
      shift={data}
      recounting={recounting}
      focusHeading={moved}
      onSend={() => setMoved(true)}
      onCancelRecount={() => {
        setMoved(true);
        setRecount(null);
      }}
    />
  );
}
