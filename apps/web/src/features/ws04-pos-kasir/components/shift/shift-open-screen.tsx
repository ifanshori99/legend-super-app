import { useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { businessDateOf } from "@starter/shared/core";
import { formatRupiah } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
export function ShiftOpenScreen({ returnTo }: { returnTo?: string }) {
  const t = useT();
  const { clock } = useOutletClock();
  const businessDate = businessDateOf(new Date(), clock);
  const terminals = useRegisteredTerminals();
  const navigate = useNavigate();
  const openShift = useOpenShift();
  const [floatIdr, setFloatIdr] = useState(0);
  // An empty drawer is valid: a zero float asks once, in a dialog, per try.
  const [zeroDialogOpen, setZeroDialogOpen] = useState(false);
  const recheckRef = useRef<HTMLButtonElement>(null);

  function send() {
    setZeroDialogOpen(false);
    openShift.mutate(
      { openingFloatIdr: floatIdr },
      {
        // Came from a bill that needed cash: back to it (path already checked
        // by the route's search schema).
        onSuccess: () => {
          if (returnTo) void navigate({ href: returnTo });
        },
      },
    );
  }

  function submit() {
    if (floatIdr === 0) {
      setZeroDialogOpen(true);
      return;
    }
    send();
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
              <Button loading={openShift.isPending} onClick={submit}>
                {openShift.isPending
                  ? t("posKasirShift.open.submitting")
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
                onRetry={submit}
              />
            )}
          </div>
        </PosPanel>
      </PosTwoPane>
      <Dialog open={zeroDialogOpen} onOpenChange={setZeroDialogOpen}>
        <DialogContent
          onOpenAutoFocus={(event) => {
            // Start on the safe button so Enter never opens with Rp0 by accident.
            event.preventDefault();
            recheckRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {t("posKasirShift.open.zeroDialog.title")}
            </DialogTitle>
            <DialogDescription>
              {t("posKasirShift.open.zeroDialog.description")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              ref={recheckRef}
              type="button"
              variant="outline"
              onClick={() => setZeroDialogOpen(false)}
            >
              {t("posKasirShift.open.zeroDialog.recheck")}
            </Button>
            <Button type="button" onClick={send}>
              {t("posKasirShift.open.zeroDialog.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
