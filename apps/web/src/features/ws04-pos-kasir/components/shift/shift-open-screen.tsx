import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { businessDateOf } from "@starter/shared/core";
import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useOutletClock } from "@/lib/tenant-context";
import { useOpenShift, useRegisteredTerminals } from "../../hooks";
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
                onClick={() => openShift.mutate({ openingFloatIdr: floatIdr })}
              >
                {openShift.isPending
                  ? t("posKasirShift.open.submitting")
                  : t("posKasirShift.open.submit", {
                      amount: formatRupiah(floatIdr),
                    })}
              </Button>
            </>
          }
        >
          <div className="grid max-w-xl content-start gap-4">
            <AmountKeypad
              value={floatIdr}
              onChange={setFloatIdr}
              label={t("posKasirShift.open.floatLabel")}
              hint={t("posKasirShift.open.floatHint")}
            />
            <Notice tone="warning" title={t("posKasirShift.open.checkTitle")}>
              {t("posKasirShift.open.checkBody")}
            </Notice>
            {openShift.isError && (
              <ActionError
                title={t("posKasirShift.open.errorTitle")}
                error={openShift.error}
              />
            )}
          </div>
        </PosPanel>
      </PosTwoPane>
    </div>
  );
}
