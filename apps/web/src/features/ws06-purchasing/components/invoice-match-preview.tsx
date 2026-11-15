// Pratinjau 3-way match setelah faktur supplier disimpan (bead legend-0xnm).
// Every amount and quantity here is what the API returned for the saved
// invoice; the web never recomputes totals, DPP, tax, payable or variance.
// Rows are stacked cards (no horizontal scroll) so 390px stays readable.
import { CircleAlert, CircleCheck } from "lucide-react";
import { useT } from "@/components/i18n";
import { StatusPill } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/feedback-state";
import { Money } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { formatQuantity } from "../../ws06-inventory/lib.ts";
import { formatIdrDecimalText } from "../invoice-entry-model.ts";
import { useInventoryItems, usePurchaseOrder, useUoms } from "../hooks.ts";
import { useSupplierInvoice } from "../receiving-hooks.ts";
import {
  MATCH_ISSUE_LABEL,
  formatQuantityWithUnit,
  itemNameOf,
  uomCodeOf,
} from "../receiving-lib.ts";
import { MatchStatusPill } from "./invoice-page.tsx";

const percentFormat = new Intl.NumberFormat("id-ID", {
  maximumFractionDigits: 2,
});

/** Basis points as a signed percent ("+1,5%"); the sign keeps over/under PO
 *  price readable without relying on color. */
function signedPercent(bp: number): string {
  if (bp === 0) return "0%";
  return `${bp > 0 ? "+" : "−"}${percentFormat.format(Math.abs(bp) / 100)}%`;
}

/** Unit prices keep their decimals (never rounded to whole rupiah). */
function UnitPrice({ value }: { value: string }) {
  return (
    <data value={value} className="tabular break-words">
      {formatIdrDecimalText(value)}
    </data>
  );
}

export function InvoiceMatchPreview({ invoiceId }: { invoiceId: string }) {
  const t = useT();
  const detail = useSupplierInvoice(invoiceId);
  const invoice = detail.data?.data.invoice;
  const lines = detail.data?.data.lines ?? [];
  const match = detail.data?.data.match ?? null;
  const order = usePurchaseOrder(invoice?.purchaseOrderId ?? "");
  const items = useInventoryItems();
  const uoms = useUoms();

  const loading =
    detail.isPending ||
    (Boolean(invoice) &&
      (order.isPending || items.isPending || uoms.isPending));
  const failed =
    detail.isError || order.isError || items.isError || uoms.isError;

  return (
    <section className="grid min-w-0 gap-4" aria-labelledby="match-preview">
      <div className="grid gap-1">
        <h2 id="match-preview" className="text-lg leading-6 font-semibold">
          {t("invoiceMatchPreview.title")}
        </h2>
        <p className="text-sm leading-5 text-muted-foreground">
          {t("invoiceMatchPreview.description")}
        </p>
      </div>

      {loading ? (
        <div aria-busy="true" className="grid gap-2">
          <span className="sr-only">{t("common.loading")}</span>
          <Skeleton className="h-row" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      ) : failed || !invoice ? (
        <ErrorState
          description={t("invoiceMatchPreview.loadError")}
          onRetry={() => {
            void detail.refetch();
            void order.refetch();
            void items.refetch();
            void uoms.refetch();
          }}
        />
      ) : (
        <>
          <Card className="gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-base leading-6 font-semibold">
                {t("invoiceMatchPreview.totalsTitle")}
              </h3>
              <MatchStatusPill status={match ? match.status : "pending"} />
            </div>
            <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
              <div>
                <dt className="type-eyebrow">
                  {t("inventoryReceiving.invoices.totals.invoicedGoods")}
                </dt>
                <dd>
                  <Money amount={invoice.goodsIdr} />
                </dd>
              </div>
              <div>
                <dt className="type-eyebrow">
                  {t("inventoryReceiving.invoices.totals.priceVariance")}
                </dt>
                <dd>
                  <Money amount={invoice.priceVarianceIdr} />
                </dd>
              </div>
              <div>
                <dt className="type-eyebrow">
                  {t("inventoryReceiving.invoices.totals.invoicedServices")}
                </dt>
                <dd>
                  <Money amount={invoice.servicesIdr} />
                </dd>
              </div>
              <div>
                <dt className="type-eyebrow">
                  {t("inventoryReceiving.invoices.totals.ppn")}
                </dt>
                <dd>
                  <Money amount={invoice.ppnIdr} />
                </dd>
              </div>
              <div>
                <dt className="type-eyebrow">
                  {t("inventoryReceiving.invoices.totals.total")}
                </dt>
                <dd className="font-semibold">
                  <Money amount={invoice.totalIdr} />
                </dd>
              </div>
              <div>
                <dt className="type-eyebrow">
                  {t("inventoryReceiving.invoices.totals.pph23")}
                </dt>
                <dd>
                  <Money amount={invoice.pph23Idr} />
                </dd>
              </div>
              <div className="col-span-2 sm:col-span-3">
                <dt className="type-eyebrow">
                  {t("inventoryReceiving.invoices.totals.payable")}
                </dt>
                <dd className="font-semibold">
                  <Money amount={invoice.payableIdr} size="lg" />
                </dd>
              </div>
            </dl>
            <p className="text-sm leading-5 text-muted-foreground">
              {match
                ? t("invoiceMatchPreview.toleranceHint", {
                    percent: `${percentFormat.format(match.toleranceBp / 100)}%`,
                  })
                : t("invoiceMatchPreview.pendingHint")}
            </p>
            {match && (
              <p
                className={
                  match.status === "matched"
                    ? "flex items-start gap-2 text-sm leading-5 text-success"
                    : "flex items-start gap-2 text-sm leading-5 font-medium text-danger"
                }
              >
                {match.status === "matched" ? (
                  <CircleCheck
                    aria-hidden="true"
                    className="mt-0.5 size-4 shrink-0"
                  />
                ) : (
                  <CircleAlert
                    aria-hidden="true"
                    className="mt-0.5 size-4 shrink-0"
                  />
                )}
                <span className="min-w-0">
                  {match.status === "matched"
                    ? t("invoiceMatchPreview.matchedHint")
                    : t("invoiceMatchPreview.discrepancyHint")}
                </span>
              </p>
            )}
          </Card>

          {match && match.headerIssues.length > 0 && (
            <div
              role="alert"
              className="grid gap-2 rounded-container border border-danger/40 bg-danger-subtle p-card"
            >
              <p className="flex items-start gap-2 text-sm font-semibold text-danger">
                <CircleAlert
                  aria-hidden="true"
                  className="mt-0.5 size-4 shrink-0"
                />
                <span className="min-w-0">
                  {t("inventoryReceiving.invoices.headerIssues")}
                </span>
              </p>
              <div className="flex flex-wrap gap-2">
                {match.headerIssues.map((issue) => (
                  <StatusPill key={issue} status="danger">
                    {t(MATCH_ISSUE_LABEL[issue])}
                  </StatusPill>
                ))}
              </div>
            </div>
          )}

          {match && match.rows.length > 0 && (
            <div className="grid gap-3">
              <h3 className="text-base leading-6 font-semibold">
                {t("invoiceMatchPreview.rowsTitle")}
              </h3>
              <ul className="grid gap-3" data-testid="match-rows">
                {match.rows.map((row, index) => {
                  const invoiceLine = lines.find(
                    (line) => line.id === row.invoiceLineId,
                  );
                  const orderLine = order.data?.data.lines.find(
                    (line) => line.id === row.purchaseOrderLineId,
                  );
                  const unit = orderLine
                    ? uomCodeOf(uoms.data?.data ?? [], orderLine.uomId)
                    : "";
                  const qty = (value: string) =>
                    unit === ""
                      ? formatQuantity(value)
                      : formatQuantityWithUnit(value, unit);
                  const empty = t("invoiceMatchPreview.empty");
                  const flagged = row.issues.length > 0;
                  return (
                    <li
                      key={row.invoiceLineId}
                      data-testid="match-row"
                      data-flagged={flagged ? "true" : "false"}
                      className={
                        flagged
                          ? "grid gap-3 rounded-container border border-danger/40 bg-danger-subtle p-card"
                          : "grid gap-3 rounded-container border bg-card p-card"
                      }
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="type-eyebrow">
                            {t("invoiceMatchPreview.rowTitle", {
                              index: index + 1,
                            })}
                          </p>
                          <p className="font-medium break-words">
                            {invoiceLine?.description ?? empty}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {row.kind === "service"
                              ? t("invoiceMatchPreview.serviceLine")
                              : orderLine
                                ? itemNameOf(
                                    items.data?.data ?? [],
                                    orderLine.inventoryItemId,
                                  )
                                : t("invoiceMatchPreview.noOrderLine")}
                          </p>
                        </div>
                        {flagged ? (
                          <div className="flex min-w-0 max-w-full flex-wrap gap-2">
                            {row.issues.map((issue) => (
                              <StatusPill
                                key={issue}
                                status="danger"
                                className="max-w-full text-left whitespace-normal"
                              >
                                <span className="min-w-0 break-words">
                                  {issue === "quantity_exceeds_receipt" &&
                                  row.remainingInvoiceableQty !== null
                                    ? t(
                                        "inventoryReceiving.invoices.issue.quantity_exceeds_receipt_remaining",
                                        {
                                          quantity: qty(
                                            row.remainingInvoiceableQty,
                                          ),
                                        },
                                      )
                                    : t(MATCH_ISSUE_LABEL[issue])}
                                </span>
                              </StatusPill>
                            ))}
                          </div>
                        ) : (
                          <StatusPill status="success">
                            {t("invoiceMatchPreview.rowOk")}
                          </StatusPill>
                        )}
                      </div>
                      <dl className="grid grid-cols-2 gap-3 text-sm">
                        <div className="min-w-0">
                          <dt className="type-eyebrow">
                            {t("invoiceMatchPreview.orderedLabel")}
                          </dt>
                          <dd>
                            {row.orderedQty === null
                              ? empty
                              : qty(row.orderedQty)}
                          </dd>
                        </div>
                        <div className="min-w-0">
                          <dt className="type-eyebrow">
                            {t("invoiceMatchPreview.acceptedLabel")}
                          </dt>
                          <dd>
                            {row.acceptedQty === null
                              ? empty
                              : qty(row.acceptedQty)}
                          </dd>
                        </div>
                        <div className="min-w-0">
                          <dt className="type-eyebrow">
                            {t("invoiceMatchPreview.invoicedLabel")}
                          </dt>
                          <dd>{qty(row.invoicedQty)}</dd>
                        </div>
                        <div className="min-w-0">
                          <dt className="type-eyebrow">
                            {t("invoiceMatchPreview.orderedPrice")}
                          </dt>
                          <dd>
                            {row.orderedUnitPriceIdr === null ? (
                              empty
                            ) : (
                              <UnitPrice value={row.orderedUnitPriceIdr} />
                            )}
                          </dd>
                        </div>
                        <div className="min-w-0">
                          <dt className="type-eyebrow">
                            {t("invoiceMatchPreview.invoicedPrice")}
                          </dt>
                          <dd>
                            <UnitPrice value={row.invoicedUnitPriceIdr} />
                          </dd>
                        </div>
                        <div
                          data-testid="match-row-variance"
                          className="min-w-0"
                        >
                          <dt className="type-eyebrow">
                            {t("invoiceMatchPreview.varianceLabel")}
                          </dt>
                          <dd>
                            <span className="block whitespace-nowrap">
                              {row.priceVarianceBp === null
                                ? empty
                                : signedPercent(row.priceVarianceBp)}
                            </span>
                            <Money amount={row.priceVarianceIdr} />
                          </dd>
                        </div>
                      </dl>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}
