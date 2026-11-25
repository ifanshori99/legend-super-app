import { useId, useState } from "react";
import { Armchair } from "lucide-react";
import { useT } from "@/components/i18n";
import { ApiError } from "@/lib/api/errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/features/ws04-pos-kasir/components/shared";
import {
  OPEN_INTENT_PENDING,
  SESSION_CLOSED,
} from "@/features/ws04-pos-order/captain-flow";
import {
  useOpenTable,
  usePendingOpen,
  useReservationHold,
} from "@/features/ws04-pos-order/hooks";
import { needsCashierClose } from "@/features/ws04-pos-order/order-flow";
import type { CaptainTable } from "@/features/ws04-pos-order/types";

const MAX_PAX = 30;

/** "14.30" in the device's clock. */
function clock(iso: string): string {
  return new Intl.DateTimeFormat("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(new Date(iso))
    .replace(":", ".");
}

// An empty table has no session, so it has no order. The captain seats the
// walk-in party first (keyed). A reservation that holds the table is shown
// before: the hold does not change the table, so the seat would be refused
// later for the reservation's guests.
export function SeatCard({
  tableId,
  table,
}: {
  tableId: string;
  table: CaptainTable;
}) {
  const t = useT();
  const paxId = useId();
  const open = useOpenTable(tableId);
  const unclear = usePendingOpen(tableId);
  const hold = useReservationHold(tableId, true);
  const [paxText, setPaxText] = useState("");
  const typed = Number.parseInt(paxText, 10);
  // An unclear seat is repeated with the same guest count (same bytes).
  const pax = unclear.pax ?? (Number.isFinite(typed) ? typed : 0);
  const valid = Number.isInteger(pax) && pax >= 1 && pax <= MAX_PAX;
  const error = open.error;
  const code = error instanceof ApiError ? error.code : null;
  const canClose =
    unclear.pax !== null &&
    (needsCashierClose(error) ||
      code === OPEN_INTENT_PENDING ||
      code === SESSION_CLOSED);

  return (
    <div
      data-slot="captain-seat"
      className="grid gap-3 rounded-container border-(length:--border-w) border-border bg-card p-card"
    >
      <h2 className="text-lg leading-6 font-bold">
        {t("posCaptainOrder.seat.title", { table: table.label })}
      </h2>
      <p className="text-base text-muted-foreground">
        {t("posCaptainOrder.seat.hint")}
      </p>

      {hold.data && (
        <Notice tone="warning" title={t("posCaptainOrder.seat.holdTitle")}>
          {t("posCaptainOrder.seat.holdBody", {
            name: hold.data.guestName,
            pax: hold.data.pax,
            time: clock(hold.data.reservedFor),
          })}
        </Notice>
      )}
      {hold.isError && (
        <Notice tone="info" title={t("posCaptainOrder.seat.holdUnknown")} />
      )}

      {unclear.pax !== null && !open.isPending && (
        <Notice tone="warning" title={t("posCaptainOrder.seat.pendingTitle")}>
          {t("posCaptainOrder.seat.pendingBody", { count: unclear.pax })}
        </Notice>
      )}

      <div className="grid gap-2">
        <Label htmlFor={paxId}>{t("posCaptainOrder.seat.pax")}</Label>
        <Input
          id={paxId}
          type="number"
          inputMode="numeric"
          min={1}
          max={MAX_PAX}
          value={unclear.pax !== null ? String(unclear.pax) : paxText}
          disabled={unclear.pax !== null}
          onChange={(event) => setPaxText(event.target.value)}
        />
      </div>

      {error && (
        <Notice tone="danger" title={t("posCaptainOrder.seat.failed")}>
          {error instanceof ApiError &&
            t("posCaptainOrder.review.submitFailedReason", {
              message: error.message,
            })}
        </Notice>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          className="flex-1"
          loading={open.isPending}
          disabled={!valid || hold.isPending}
          onClick={() => open.mutate({ pax })}
        >
          <Armchair aria-hidden="true" />
          {unclear.pax !== null
            ? t("posCaptainOrder.seat.resend")
            : hold.data
              ? t("posCaptainOrder.seat.confirmHold")
              : t("posCaptainOrder.seat.submit")}
        </Button>
        {canClose && (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              unclear.close();
              open.reset();
            }}
          >
            {t("posCaptainOrder.seat.close")}
          </Button>
        )}
      </div>
    </div>
  );
}
