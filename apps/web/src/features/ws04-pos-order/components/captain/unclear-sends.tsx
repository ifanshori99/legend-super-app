import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Notice } from "@/features/ws04-pos-kasir/components/shared";
import { useUnclearSends } from "@/features/ws04-pos-order/hooks";
import { needsCashierClose } from "@/features/ws04-pos-order/order-flow";
import type { CaptainTable } from "@/features/ws04-pos-order/types";

// Sends of this captain whose answer is not known, shown on the table list so
// a table whose session has closed cannot hide an order that may have gone
// through (the per-table notices need an open session to be found).
export function UnclearSends({
  tables,
}: {
  tables: CaptainTable[] | undefined;
}) {
  const t = useT();
  const sends = useUnclearSends();
  const { resend } = sends;
  const label = (tableId: string) =>
    tables?.find((table) => table.id === tableId)?.label ?? "?";
  const rows = [
    ...sends.orders.map((entry) => ({
      id: `order:${entry.draftKey}`,
      text: t("posCaptainOrder.unclear.order", {
        table: entry.snapshot.meta.tableLabel ?? "?",
        count: entry.snapshot.lines.length,
      }),
      resend: () => resend.mutate({ kind: "order", draftKey: entry.draftKey }),
      close: () => sends.closeOrder(entry.draftKey),
    })),
    ...sends.seats.map((entry) => ({
      id: `seat:${entry.tableId}`,
      text: t("posCaptainOrder.unclear.seat", {
        table: label(entry.tableId),
        count: entry.pax,
      }),
      resend: () =>
        resend.mutate({ kind: "seat", tableId: entry.tableId, pax: entry.pax }),
      close: () => sends.closeSeat(entry.tableId),
    })),
    ...sends.fires.map((entry) => ({
      id: `fire:${entry.orderId}`,
      text: t("posCaptainOrder.unclear.fire", { count: entry.itemIds.length }),
      resend: () => resend.mutate({ kind: "fire", orderId: entry.orderId }),
      close: () => sends.closeFire(entry.orderId),
    })),
  ];
  if (rows.length === 0) return null;
  const refused = resend.isError && needsCashierClose(resend.error);
  return (
    <Notice tone="warning" title={t("posCaptainOrder.unclear.title")}>
      <div className="grid gap-3">
        <p>{t("posCaptainOrder.unclear.body")}</p>
        {resend.isError && (
          <p role="alert">
            {refused
              ? t("posCaptainOrder.unclear.refused")
              : t("posCaptainOrder.unclear.failed")}
          </p>
        )}
        <ul className="grid gap-2">
          {rows.map((row) => (
            <li key={row.id} className="grid gap-2">
              <span>{row.text}</span>
              <span className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  loading={resend.isPending}
                  onClick={row.resend}
                >
                  {t("posCaptainOrder.unclear.resend")}
                </Button>
                <Button type="button" variant="outline" onClick={row.close}>
                  {t("posCaptainOrder.unclear.close")}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Notice>
  );
}
