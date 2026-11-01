// Scan & join (PRD §3 F10 "Scan & Sesi Meja"): the first guest fills in the
// guest count and opens the table session; the next scan of the same QR joins
// it. No login, no install (ORD-01). Dismissible: the menu stays browsable.
import { useState } from "react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useTableJourney } from "../context";
import { useJoinTable } from "../hooks";
import { Notice } from "./notice";
import { Stepper } from "./stepper";

export function JoinDialog() {
  const t = useT();
  const { qrToken, menu, joinOpen, closeJoin, guest } = useTableJourney();
  const join = useJoinTable(qrToken);
  const [pax, setPax] = useState(2);
  if (!menu) return null;
  const open = joinOpen && guest === null;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && closeJoin()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="text-xl leading-7">
            {t("qrMenu.join.title", { brand: menu.brand.name })}
          </DialogTitle>
          <DialogDescription>
            {t("qrMenu.join.subtitle", {
              table: menu.table.code,
              zone: menu.zone.name,
            })}
          </DialogDescription>
        </DialogHeader>

        {menu.orderingOpen ? (
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              join.mutate(pax, { onSuccess: () => closeJoin() });
            }}
          >
            <div className="flex flex-col items-start gap-3 rounded-xl border p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <div className="min-w-0">
                <p id="pax-label" className="font-semibold">
                  {t("qrMenu.join.paxLabel")}
                </p>
                <p className="text-sm text-muted-foreground">
                  {t("qrMenu.join.paxHint")}
                </p>
              </div>
              <Stepper
                value={pax}
                min={1}
                max={30}
                onChange={setPax}
                decreaseLabel={t("qrMenu.join.paxDecrease")}
                increaseLabel={t("qrMenu.join.paxIncrease")}
                valueLabel={t("qrMenu.join.paxValue", { count: pax })}
              />
            </div>
            <div className="rounded-xl bg-muted p-3 text-sm leading-5">
              <p className="font-semibold">
                {menu.zone.paymentMode === "pay_first"
                  ? t("qrMenu.mode.payFirst")
                  : t("qrMenu.mode.openBill")}
              </p>
              <p className="text-muted-foreground">
                {menu.zone.paymentMode === "pay_first"
                  ? t("qrMenu.mode.payFirstHint")
                  : t("qrMenu.mode.openBillHint")}
              </p>
            </div>
            {join.isError && (
              <Notice tone="danger" title={t("qrMenu.join.error")} />
            )}
            <div className="grid gap-2">
              <Button type="submit" size="lg" loading={join.isPending}>
                {t("qrMenu.join.start")}
              </Button>
              <Button type="button" variant="ghost" onClick={closeJoin}>
                {t("qrMenu.join.later")}
              </Button>
            </div>
          </form>
        ) : (
          <div className="grid gap-3">
            <Notice tone="warning" title={t("qrMenu.closedNow.title")}>
              {t("qrMenu.join.closedHint")}
            </Notice>
            <Button type="button" variant="outline" onClick={closeJoin}>
              {t("qrMenu.join.later")}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
