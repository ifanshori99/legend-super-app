import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { businessDateOf } from "@starter/shared/core";
import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useOutletClock } from "@/lib/tenant-context";
import { useOpenShift, useRegisteredTerminals } from "../../shift-hooks";
import {
  AmountKeypad,
  Notice,
  PosPageHeading,
  PosPanel,
  PosTwoPane,
  StatusPill,
} from "../shared";
import { formatShiftDate } from "./shift-format";
import { ActionError, ContextBlock } from "./shift-parts";

// Open shift: the cashier counts the float in the drawer and enters it.
// Shown by the shift screen when the terminal has no active shift.
export function ShiftOpenScreen() {
  const t = useT();
  const { clock } = useOutletClock();
  const businessDate = businessDateOf(new Date(), clock);
  const terminals = useRegisteredTerminals();
  const openShift = useOpenShift();
  const [floatIdr, setFloatIdr] = useState(0);
  // An empty drawer is valid: a zero float needs one explicit confirmation.
  const [zeroArmed, setZeroArmed] = useState(false);
  const confirmingZero = floatIdr === 0 && zeroArmed;

  function submit() {
    if (floatIdr === 0 && !zeroArmed) {
      setZeroArmed(true);
      return;
    }
    openShift.mutate({ openingFloatIdr: floatIdr });
  }
  const terminal = terminals.data?.[0];

  return (
    <div className="grid gap-4">
      <PosPageHeading
        title={t("posKasirShift.open.title")}
        subtitle={t("posKasirShift.open.subtitle")}
        action={
          <StatusPill tone="neutral">{t("posKasirShift.pill.none")}</StatusPill>
        }
      />
      <PosTwoPane
        side={
          <PosPanel title={t("posKasirShift.open.sideTitle")}>
            <div className="flex h-full flex-col justify-between gap-6">
              <div className="grid gap-4">
                <ContextBlock label={t("posKasirShift.open.cashier")}>
                  {terminal ? (
                    terminal.cashierName
                  ) : (
                    <Skeleton className="h-6 w-32" />
                  )}
                </ContextBlock>
                <ContextBlock label={t("posKasirShift.open.device")}>
                  {terminal ? (
                    <>
                      <p>{terminal.label}</p>
                      <p className="font-normal text-muted-foreground">
                        {terminal.outletName}
                      </p>
                    </>
                  ) : (
                    <Skeleton className="h-6 w-40" />
                  )}
                </ContextBlock>
                <ContextBlock label={t("posKasirShift.open.date")}>
                  <span className="tabular">
                    {formatShiftDate(businessDate)}
                  </span>
                </ContextBlock>
              </div>
              <Notice tone="info" title={t("posKasirShift.open.noteTitle")}>
                {t("posKasirShift.open.noteBody")}
              </Notice>
            </div>
          </PosPanel>
        }
      >
        <PosPanel
          title={t("posKasirShift.open.floatTitle")}
          aside={
            <StatusPill tone="neutral">
              {t("posKasirShift.open.floatUnit")}
            </StatusPill>
          }
          footer={
            <>
              <Button variant="outline" asChild>
                <Link to="/pos">{t("posKasirShift.open.back")}</Link>
              </Button>
              <Button
                loading={openShift.isPending}
                aria-describedby={confirmingZero ? "open-zero-hint" : undefined}
                onClick={submit}
              >
                {openShift.isPending
                  ? t("posKasirShift.open.submitting")
                  : confirmingZero
                    ? t("posKasirShift.open.zeroSubmit")
                    : t("posKasirShift.open.submit", {
                        amount: formatRupiah(floatIdr),
                      })}
              </Button>
            </>
          }
        >
          {/* Two columns from md: the amount field, hint and notices on the
              left, the keypad on the right. The keypad component renders
              `contents`, so its field, keypad and hint become grid items of
              this wrapper. */}
          <div className="grid content-start gap-x-6 gap-y-4 md:grid-cols-[minmax(0,1fr)_17rem] md:[&_[data-slot=amount-keypad]>div:last-of-type]:col-start-2 md:[&_[data-slot=amount-keypad]>div:last-of-type]:row-span-5 md:[&_[data-slot=amount-keypad]>div:last-of-type]:row-start-1 md:[&>*:not([data-slot=amount-keypad])]:col-start-1">
            <AmountKeypad
              className="contents"
              value={floatIdr}
              onChange={(value) => {
                setZeroArmed(false);
                setFloatIdr(value);
              }}
              label={t("posKasirShift.open.floatLabel")}
              hint={t("posKasirShift.open.floatHint")}
            />
            {confirmingZero && (
              <p
                id="open-zero-hint"
                className="text-base text-muted-foreground"
              >
                {t("posKasirShift.open.zeroConfirm")}
              </p>
            )}
            <Notice tone="warning" title={t("posKasirShift.open.checkTitle")}>
              {t("posKasirShift.open.checkBody")}
            </Notice>
            {openShift.isError && (
              <ActionError
                title={t("posKasirShift.open.errorTitle")}
                error={openShift.error}
                onRetry={submit}
              />
            )}
          </div>
        </PosPanel>
      </PosTwoPane>
    </div>
  );
}
