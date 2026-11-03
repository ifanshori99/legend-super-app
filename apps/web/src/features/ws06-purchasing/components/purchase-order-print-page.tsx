import { Printer } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Money, NumberDisplay } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useInventoryItems,
  usePurchaseOrder,
  useSuppliers,
  useUoms,
} from "../hooks";

// Hide the management shell when printing. The light palette for the sheet is
// selected only for print so a dark-mode preview remains legible on paper.
const PRINT_STYLE = `@media print {
  body { background: transparent !important; }
  body * { visibility: hidden; }
  .purchase-print-sheet, .purchase-print-sheet * { visibility: visible; }
  .purchase-print-sheet { position: absolute; inset: 0; width: 100%; max-width: none; margin: 0; padding: 12mm; }
  .dark .purchase-print-sheet { --foreground: var(--primary-foreground); --muted-foreground: var(--primary-foreground); --border: var(--primary-foreground); --background: transparent; color: var(--foreground); background: var(--background); }
  .purchase-print-sheet .print-controls { display: none; }
}`;

export function PurchaseOrderPrintPage({ id }: { id: string }) {
  const t = useT();
  const order = usePurchaseOrder(id);
  const items = useInventoryItems();
  const suppliers = useSuppliers();
  const uoms = useUoms();
  const queries = [order, items, suppliers, uoms];
  const loading = queries.some((query) => query.isPending);
  const failed = queries.some((query) => query.isError);
  return (
    <div className="purchase-print-sheet mx-auto grid w-full max-w-4xl gap-6 p-4 sm:p-6 [&_button]:min-h-11">
      <style>{PRINT_STYLE}</style>
      <div className="print-controls flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="type-display">{t("purchasing.printTitle")}</h1>
          <p className="text-muted-foreground">{t("purchasing.printHelp")}</p>
        </div>
        <Button onClick={() => window.print()} disabled={loading || failed}>
          <Printer aria-hidden="true" />
          {t("purchasing.printAction")}
        </Button>
      </div>
      {loading ? (
        <div aria-busy="true">
          <span className="sr-only">{t("common.loading")}</span>
          <Skeleton className="h-48" />
        </div>
      ) : failed || !order.data ? (
        <ErrorState
          description={
            typeof navigator !== "undefined" && !navigator.onLine
              ? t("purchasing.offline")
              : undefined
          }
          onRetry={() =>
            void Promise.all(queries.map((query) => query.refetch()))
          }
        />
      ) : (
        <article className="grid gap-6 bg-background text-foreground">
          <header className="grid gap-2 border-b pb-4">
            <p className="text-sm font-semibold text-muted-foreground">
              {t("purchasing.orders")}
            </p>
            <h2 className="type-display">
              {order.data.data.purchaseOrder.number}
            </h2>
            <dl className="grid gap-3 sm:grid-cols-2">
              <div>
                <dt className="text-sm text-muted-foreground">
                  {t("purchasing.supplier")}
                </dt>
                <dd>
                  {
                    suppliers.data?.data.find(
                      (supplier) =>
                        supplier.id ===
                        order.data.data.purchaseOrder.supplierId,
                    )?.name
                  }
                </dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">
                  {t("purchasing.expectedDate")}
                </dt>
                <dd className="tabular">
                  {order.data.data.purchaseOrder.expectedDate}
                </dd>
              </div>
            </dl>
          </header>
          {order.data.data.lines.length === 0 ? (
            <EmptyState title={t("purchasing.printEmpty")} />
          ) : (
            <ul className="divide-y border-b">
              {order.data.data.lines.map((line) => (
                <li
                  key={line.id}
                  className="grid gap-2 py-3 sm:grid-cols-[1fr_auto] sm:items-start"
                >
                  <div>
                    <p className="font-semibold">
                      {items.data?.data.find(
                        (item) => item.id === line.inventoryItemId,
                      )?.name ?? line.inventoryItemId}
                    </p>
                    <p className="text-sm text-muted-foreground tabular">
                      {line.quantity}{" "}
                      {
                        uoms.data?.data.find((uom) => uom.id === line.uomId)
                          ?.code
                      }{" "}
                      · {t("purchasing.unitPrice")}:{" "}
                      <NumberDisplay
                        value={Number(line.unitPriceIdr)}
                        fractionDigits={4}
                        size="sm"
                      />
                    </p>
                  </div>
                  <Money amount={line.lineTotalIdr} />
                </li>
              ))}
            </ul>
          )}
          <dl className="ml-auto grid w-full max-w-xs gap-2">
            <div className="flex justify-between gap-4">
              <dt>{t("purchasing.subtotal")}</dt>
              <dd>
                <Money amount={order.data.data.purchaseOrder.subtotalIdr} />
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt>{t("purchasing.tax")}</dt>
              <dd>
                <Money amount={order.data.data.purchaseOrder.taxIdr} />
              </dd>
            </div>
            <div className="flex justify-between gap-4 border-t pt-2 font-semibold">
              <dt>{t("purchasing.total")}</dt>
              <dd>
                <Money amount={order.data.data.purchaseOrder.totalIdr} />
              </dd>
            </div>
          </dl>
          {order.data.data.purchaseOrder.note && (
            <p>
              <strong>{t("purchasing.note")}: </strong>
              {order.data.data.purchaseOrder.note}
            </p>
          )}
        </article>
      )}
    </div>
  );
}
