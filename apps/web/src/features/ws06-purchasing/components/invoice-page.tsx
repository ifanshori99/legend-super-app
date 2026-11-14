// Supplier invoices and the three-way match (PRD v1.7 §3.18 "3-way match",
// §4 Alur I step 4, §3.7 approval): PO price × accepted receipt × invoice,
// per-line deltas with the discrepancy code, then match recording and the
// supplier payment request (approval happens on a different person, §3.7).
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { ReceiptText } from "lucide-react";
import { useT } from "@/components/i18n";
import { useTenantContext } from "@/lib/tenant-context";
import { StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ErrorState } from "@/components/ui/feedback-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Money } from "@/components/ui/money";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api/errors";
import { formatQuantity } from "../../ws06-inventory/lib.ts";
import {
  useAttemptKey,
  useCreateSupplierPayment,
  useRunSupplierInvoiceMatch,
  useSupplierInvoice,
  useSupplierInvoices,
  useSupplierPaymentsForInvoice,
  useTransitionSupplierPayment,
} from "../receiving-hooks.ts";
import {
  INVOICE_PAYMENT_LABEL,
  INVOICE_PAYMENT_TONE,
  MATCH_ISSUE_LABEL,
  MATCH_STATUS_LABEL,
  MATCH_STATUS_TONE,
  PAYMENT_METHOD_LABEL,
  PAYMENT_STATUS_LABEL,
  PAYMENT_STATUS_TONE,
  amountFromInput,
  formatBusinessDate,
  formatDateTime,
  formatIdrText,
  formatQuantityWithUnit,
  invoicePaymentStatus,
  itemNameOf,
  orderNumberOf,
  payableRemaining,
  receivingErrorKey,
  supplierNameOf,
  uomCodeOf,
} from "../receiving-lib.ts";
import {
  useInventoryItems,
  usePurchaseOrder,
  usePurchaseOrders,
  useSuppliers,
  useUoms,
} from "../hooks.ts";
import { ReceivingOfflineNote } from "./receiving-offline-note.tsx";
import type { SupplierPaymentMethod } from "@starter/shared/inventory";
import { newIdempotencyKey } from "../../../lib/idempotency.ts";

const PAYMENT_METHODS: readonly SupplierPaymentMethod[] = [
  "bank_transfer",
  "cash",
  "qris",
  "virtual_account",
];

export function MatchStatusPill({
  status,
}: {
  status: "pending" | "matched" | "discrepancy";
}) {
  const t = useT();
  return (
    <StatusPill status={MATCH_STATUS_TONE[status]}>
      {t(MATCH_STATUS_LABEL[status])}
    </StatusPill>
  );
}

function InvoiceDetailDialog({
  invoiceId,
  canPay,
  onClose,
}: {
  invoiceId: string;
  canPay: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const attempt = useAttemptKey();
  const detail = useSupplierInvoice(invoiceId);
  const invoice = detail.data?.data.invoice;
  const match = detail.data?.data.match ?? null;
  const order = usePurchaseOrder(invoice?.purchaseOrderId ?? "");
  const paymentsQuery = useSupplierPaymentsForInvoice(invoiceId);
  const items = useInventoryItems();
  const uoms = useUoms();
  const runMatch = useRunSupplierInvoiceMatch();
  const createPayment = useCreateSupplierPayment();
  const transitionPayment = useTransitionSupplierPayment();

  const [matchNote, setMatchNote] = React.useState("");
  const [matchError, setMatchError] = React.useState<string | undefined>();
  const [payError, setPayError] = React.useState<string | undefined>();
  const [actionError, setActionError] = React.useState<string | undefined>();
  const [amountDraft, setAmountDraft] = React.useState<string | null>(null);
  const [method, setMethod] =
    React.useState<SupplierPaymentMethod>("bank_transfer");
  const [reference, setReference] = React.useState("");
  const [payNote, setPayNote] = React.useState("");
  const matchKey = React.useRef<string | null>(null);

  React.useEffect(() => {
    matchKey.current = null;
  }, [matchNote]);

  const payments = paymentsQuery.data?.data ?? [];
  const remaining = invoice ? payableRemaining(invoice, payments) : 0;
  // Untouched: show what is still payable once the open requests are known.
  const amount = amountDraft ?? String(remaining);

  function submitMatch() {
    if (!match || runMatch.isPending) return;
    if (match.status === "discrepancy" && matchNote.trim() === "") {
      setMatchError(t("inventoryReceiving.invoices.matchNoteRequired"));
      return;
    }
    matchKey.current ??= newIdempotencyKey();
    setMatchError(undefined);
    runMatch.mutate(
      {
        id: invoiceId,
        body: {
          note: matchNote.trim() === "" ? null : matchNote.trim(),
          idempotencyKey: matchKey.current,
        },
      },
      {
        onSuccess: () => {
          matchKey.current = null;
          setMatchNote("");
          toast({
            title: t("inventoryReceiving.invoices.matchDone"),
            tone: "success",
          });
        },
        onError: (error) =>
          setMatchError(
            t(
              receivingErrorKey(
                error instanceof ApiError ? error.code : undefined,
              ),
            ),
          ),
      },
    );
  }

  function submitPayment(event: React.FormEvent) {
    event.preventDefault();
    if (!invoice) return;
    const parsedAmount = amountFromInput(amount);
    if (parsedAmount === null) {
      setPayError(t("inventoryReceiving.invoices.errorAmount"));
      return;
    }
    if (parsedAmount > remaining) {
      setPayError(
        t("inventoryReceiving.invoices.errorAmountOver", {
          amount: formatIdrText(remaining),
        }),
      );
      return;
    }
    const payload = {
      supplierInvoiceId: invoiceId,
      amountIdr: parsedAmount,
      method,
      reference: reference.trim() === "" ? null : reference.trim(),
      note: payNote.trim() === "" ? null : payNote.trim(),
    };
    setPayError(undefined);
    createPayment.mutate(
      { ...payload, idempotencyKey: attempt.keyFor(payload) },
      {
        onSuccess: () => {
          attempt.settle();
          setAmountDraft(null);
          setReference("");
          setPayNote("");
          toast({
            title: t("inventoryReceiving.invoices.paymentCreated"),
            tone: "success",
          });
        },
        onError: (error) =>
          setPayError(
            t(
              receivingErrorKey(
                error instanceof ApiError ? error.code : undefined,
              ),
            ),
          ),
      },
    );
  }

  function approvePayment(paymentId: string) {
    setActionError(undefined);
    transitionPayment.mutate(
      {
        id: paymentId,
        body: {
          action: "approve",
          idempotencyKey: newIdempotencyKey(),
        },
      },
      {
        onSuccess: () =>
          toast({
            title: t("inventoryReceiving.invoices.paymentApproved"),
            tone: "success",
          }),
        onError: (error) =>
          setActionError(
            t(
              receivingErrorKey(
                error instanceof ApiError ? error.code : undefined,
              ),
            ),
          ),
      },
    );
  }

  const loading =
    detail.isPending ||
    (Boolean(invoice) &&
      (order.isPending ||
        paymentsQuery.isPending ||
        items.isPending ||
        uoms.isPending));
  const failed =
    detail.isError ||
    order.isError ||
    paymentsQuery.isError ||
    items.isError ||
    uoms.isError;

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="min-w-0 sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>
            {invoice
              ? t("inventoryReceiving.invoices.detailTitle", {
                  number: invoice.number,
                })
              : t("inventoryReceiving.invoices.detailTitle", { number: "…" })}
          </DialogTitle>
          <DialogDescription>
            {t("inventoryReceiving.invoices.detailDescription")}
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <div aria-busy="true" className="grid gap-2">
            <span className="sr-only">{t("common.loading")}</span>
            <Skeleton className="h-row" />
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
          </div>
        ) : failed ? (
          <ErrorState
            onRetry={() => {
              void detail.refetch();
              void order.refetch();
              void paymentsQuery.refetch();
              void items.refetch();
              void uoms.refetch();
            }}
          />
        ) : invoice ? (
          <div className="grid min-w-0 gap-5">
            <Card className="gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-base leading-6 font-semibold">
                  {t("inventoryReceiving.invoices.matchTitle")}
                </h3>
                <div className="flex flex-wrap items-center gap-2">
                  <MatchStatusPill status={invoice.matchStatus} />
                  <StatusPill
                    status={INVOICE_PAYMENT_TONE[invoicePaymentStatus(invoice)]}
                  >
                    {t(INVOICE_PAYMENT_LABEL[invoicePaymentStatus(invoice)])}
                  </StatusPill>
                </div>
              </div>
              <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
                <div>
                  <dt className="type-eyebrow">
                    {t("inventoryReceiving.invoices.totals.orderedValue")}
                  </dt>
                  <dd>
                    <Money amount={match?.orderedValueIdr ?? 0} />
                  </dd>
                </div>
                <div>
                  <dt className="type-eyebrow">
                    {t("inventoryReceiving.invoices.totals.receivedValue")}
                  </dt>
                  <dd>
                    <Money amount={match?.receivedValueIdr ?? 0} />
                  </dd>
                </div>
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
                    {t("inventoryReceiving.invoices.totals.invoicedServices")}
                  </dt>
                  <dd>
                    <Money amount={invoice.servicesIdr} />
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
                    {t("inventoryReceiving.invoices.totals.ppn")}
                  </dt>
                  <dd>
                    <Money amount={invoice.ppnIdr} />
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
                    {t("inventoryReceiving.invoices.totals.payable")}
                  </dt>
                  <dd>
                    <Money amount={invoice.payableIdr} />
                  </dd>
                </div>
                <div>
                  <dt className="type-eyebrow">
                    {t("inventoryReceiving.invoices.totals.paid")}
                  </dt>
                  <dd>
                    <Money amount={invoice.paidIdr} />
                  </dd>
                </div>
                <div>
                  <dt className="type-eyebrow">
                    {t("inventoryReceiving.invoices.totals.outstanding")}
                  </dt>
                  <dd className="font-semibold">
                    <Money amount={invoice.outstandingIdr} />
                  </dd>
                </div>
                <div>
                  <dt className="type-eyebrow">
                    {t("inventoryReceiving.invoices.totals.tolerance")}
                  </dt>
                  <dd>
                    {match
                      ? t("inventoryReceiving.invoices.totals.toleranceValue", {
                          bp: match.toleranceBp,
                        })
                      : "—"}
                  </dd>
                </div>
              </dl>
              <p className="text-sm leading-5 text-muted-foreground">
                {match
                  ? t("inventoryReceiving.invoices.matchHint", {
                      bp: match.toleranceBp,
                    })
                  : t("inventoryReceiving.invoices.pendingHint")}
              </p>
            </Card>

            {match && match.headerIssues.length > 0 && (
              <div className="grid gap-2 rounded-container border border-danger/40 bg-danger-subtle p-card">
                <p className="text-sm font-semibold text-danger">
                  {t("inventoryReceiving.invoices.headerIssues")}
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

            {match && (
              <div className="overflow-x-auto rounded-container border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>
                        {t("inventoryReceiving.invoices.matchColumns.line")}
                      </TableHead>
                      <TableHead>
                        {t("inventoryReceiving.invoices.matchColumns.ordered")}
                      </TableHead>
                      <TableHead numeric>
                        {t("inventoryReceiving.invoices.matchColumns.accepted")}
                      </TableHead>
                      <TableHead>
                        {t("inventoryReceiving.invoices.matchColumns.invoiced")}
                      </TableHead>
                      <TableHead>
                        {t("inventoryReceiving.invoices.matchColumns.variance")}
                      </TableHead>
                      <TableHead>
                        {t("inventoryReceiving.invoices.matchColumns.issue")}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {match.rows.map((row) => {
                      const invoiceLine = detail.data?.data.lines.find(
                        (line) => line.id === row.invoiceLineId,
                      );
                      const orderLine = order.data?.data.lines.find(
                        (line) => line.id === row.purchaseOrderLineId,
                      );
                      const unit = orderLine
                        ? uomCodeOf(uoms.data?.data ?? [], orderLine.uomId)
                        : "";
                      return (
                        <TableRow key={row.invoiceLineId}>
                          <TableCell className="min-w-52">
                            <span className="font-medium">
                              {invoiceLine?.description ?? "—"}
                            </span>
                            <span className="block text-xs text-muted-foreground">
                              {orderLine
                                ? itemNameOf(
                                    items.data?.data ?? [],
                                    orderLine.inventoryItemId,
                                  )
                                : t("inventoryReceiving.common.emptyValue")}
                            </span>
                          </TableCell>
                          <TableCell>
                            {orderLine ? (
                              <span className="whitespace-nowrap">
                                {formatQuantityWithUnit(
                                  orderLine.quantity,
                                  unit,
                                )}{" "}
                                ×{" "}
                                <Money
                                  amount={Number(orderLine.unitPriceIdr)}
                                />
                              </span>
                            ) : (
                              "—"
                            )}
                          </TableCell>
                          <TableCell numeric>
                            {row.acceptedQty === null
                              ? "—"
                              : unit === ""
                                ? formatQuantity(row.acceptedQty)
                                : formatQuantityWithUnit(row.acceptedQty, unit)}
                          </TableCell>
                          <TableCell>
                            <span className="whitespace-nowrap">
                              {unit === ""
                                ? formatQuantity(row.invoicedQty)
                                : formatQuantityWithUnit(
                                    row.invoicedQty,
                                    unit,
                                  )}{" "}
                              ×{" "}
                              <Money
                                amount={Number(row.invoicedUnitPriceIdr)}
                              />
                            </span>
                          </TableCell>
                          <TableCell>
                            <span className="block whitespace-nowrap">
                              {row.priceVarianceBp === null
                                ? "—"
                                : t("inventoryReceiving.invoices.varianceBp", {
                                    // Explicit sign: over/under PO price must
                                    // read without relying on color.
                                    bp:
                                      row.priceVarianceBp > 0
                                        ? `+${row.priceVarianceBp}`
                                        : row.priceVarianceBp < 0
                                          ? `−${-row.priceVarianceBp}`
                                          : "0",
                                  })}
                            </span>
                            <Money amount={row.priceVarianceIdr} />
                          </TableCell>
                          <TableCell>
                            {row.issues.length === 0 ? (
                              <StatusPill status="success">
                                {t("inventoryReceiving.status.matched")}
                              </StatusPill>
                            ) : (
                              <StatusPill status="danger">
                                {row.issues
                                  .map((issue) =>
                                    issue === "quantity_exceeds_receipt" &&
                                    row.remainingInvoiceableQty !== null
                                      ? t(
                                          "inventoryReceiving.invoices.issue.quantity_exceeds_receipt_remaining",
                                          {
                                            quantity:
                                              unit === ""
                                                ? formatQuantity(
                                                    row.remainingInvoiceableQty,
                                                  )
                                                : formatQuantityWithUnit(
                                                    row.remainingInvoiceableQty,
                                                    unit,
                                                  ),
                                          },
                                        )
                                      : t(MATCH_ISSUE_LABEL[issue]),
                                  )
                                  .join(" · ")}
                              </StatusPill>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}

            <section className="grid gap-3">
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                <FormField
                  label={t("inventoryReceiving.invoices.matchNote")}
                  hint={t("inventoryReceiving.invoices.matchNoteHint")}
                  error={matchError}
                >
                  <Textarea
                    value={matchNote}
                    onChange={(event) => setMatchNote(event.target.value)}
                    rows={2}
                  />
                </FormField>
                <Button
                  variant="outline"
                  onClick={submitMatch}
                  loading={runMatch.isPending}
                  disabled={!match || invoice.matchStatus === "matched"}
                >
                  {t("inventoryReceiving.invoices.runMatch")}
                </Button>
              </div>
              <p className="text-sm leading-5 text-muted-foreground">
                {invoice.matchStatus === "matched"
                  ? t("inventoryReceiving.invoices.matchedHint")
                  : invoice.matchStatus === "discrepancy"
                    ? t("inventoryReceiving.invoices.discrepancyHint")
                    : t("inventoryReceiving.invoices.pendingHint")}
              </p>
              {invoice.matchNote && (
                <p className="text-sm leading-5">
                  <span className="font-semibold">
                    {t("inventoryReceiving.invoices.matchNote")}:
                  </span>{" "}
                  {invoice.matchNote}
                </p>
              )}
            </section>

            <section className="grid gap-3 border-t pt-4">
              <h3 className="text-base leading-6 font-semibold">
                {t("inventoryReceiving.invoices.paymentsTitle")}
              </h3>
              {actionError && (
                <p role="alert" className="text-sm font-medium text-danger">
                  {actionError}
                </p>
              )}
              {payments.length === 0 ? (
                <p className="text-sm leading-5 text-muted-foreground">
                  {t("inventoryReceiving.invoices.paymentsEmpty")}
                </p>
              ) : (
                <div className="overflow-x-auto rounded-container border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>
                          {t(
                            "inventoryReceiving.invoices.paymentColumns.method",
                          )}
                        </TableHead>
                        <TableHead numeric>
                          {t(
                            "inventoryReceiving.invoices.paymentColumns.amount",
                          )}
                        </TableHead>
                        <TableHead>
                          {t(
                            "inventoryReceiving.invoices.paymentColumns.status",
                          )}
                        </TableHead>
                        <TableHead>
                          {t(
                            "inventoryReceiving.invoices.paymentColumns.requestedAt",
                          )}
                        </TableHead>
                        <TableHead className="text-right">
                          {t("inventoryReceiving.common.actions")}
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {payments.map((payment) => (
                        <TableRow key={payment.id}>
                          <TableCell>
                            {t(PAYMENT_METHOD_LABEL[payment.method])}
                            <span className="block text-xs text-muted-foreground">
                              {payment.reference ??
                                t("inventoryReceiving.common.emptyValue")}
                            </span>
                          </TableCell>
                          <TableCell numeric>
                            <Money amount={payment.amountIdr} />
                          </TableCell>
                          <TableCell>
                            <StatusPill
                              status={PAYMENT_STATUS_TONE[payment.status]}
                            >
                              {t(PAYMENT_STATUS_LABEL[payment.status])}
                            </StatusPill>
                          </TableCell>
                          <TableCell>
                            {formatDateTime(payment.requestedAt)}
                          </TableCell>
                          <TableCell className="text-right">
                            {canPay && payment.status === "pending_approval" ? (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => approvePayment(payment.id)}
                                loading={
                                  transitionPayment.isPending &&
                                  transitionPayment.variables?.id === payment.id
                                }
                              >
                                {t(
                                  "inventoryReceiving.invoices.approvePayment",
                                )}
                              </Button>
                            ) : null}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
              <p className="text-sm leading-5 text-muted-foreground">
                {t("inventoryReceiving.invoices.approveHint")}
              </p>

              {!canPay ? (
                <p className="text-sm leading-5 text-muted-foreground">
                  {t("inventoryReceiving.invoices.noPayPermission")}
                </p>
              ) : invoice.matchStatus !== "matched" || remaining <= 0 ? (
                <p className="text-sm leading-5 text-muted-foreground">
                  {t("inventoryReceiving.invoices.notPayable")}
                </p>
              ) : (
                <form
                  className="grid gap-3 rounded-container bg-surface-2 p-card"
                  onSubmit={submitPayment}
                  noValidate
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span>
                      {t("inventoryReceiving.invoices.payableRemaining")}:{" "}
                      <Money amount={remaining} />
                    </span>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <FormField
                      label={t("inventoryReceiving.invoices.amount")}
                      error={payError}
                      required
                    >
                      <Input
                        value={amount}
                        onChange={(event) => {
                          setAmountDraft(event.target.value);
                          setPayError(undefined);
                        }}
                        inputMode="numeric"
                        autoComplete="off"
                      />
                    </FormField>
                    <FormField
                      label={t("inventoryReceiving.invoices.methodLabel")}
                      required
                    >
                      <Select
                        value={method}
                        onValueChange={(value) =>
                          setMethod(value as SupplierPaymentMethod)
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {PAYMENT_METHODS.map((value) => (
                            <SelectItem key={value} value={value}>
                              {t(PAYMENT_METHOD_LABEL[value])}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormField>
                  </div>
                  <FormField label={t("inventoryReceiving.invoices.reference")}>
                    <Input
                      value={reference}
                      onChange={(event) => setReference(event.target.value)}
                      autoComplete="off"
                    />
                  </FormField>
                  <FormField
                    label={t("inventoryReceiving.invoices.paymentNote")}
                  >
                    <Textarea
                      value={payNote}
                      onChange={(event) => setPayNote(event.target.value)}
                      rows={2}
                    />
                  </FormField>
                  <Button type="submit" loading={createPayment.isPending}>
                    <ReceiptText aria-hidden="true" />
                    {t("inventoryReceiving.invoices.sendPayment")}
                  </Button>
                </form>
              )}
            </section>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Keyed by outlet: switching outlet in the shell starts a fresh list, so a
 * selected invoice or search of the previous outlet cannot leak.
 */
export function InvoiceListPage({ canPay }: { canPay: boolean }) {
  const { outlet } = useTenantContext();
  return <InvoiceListContent key={outlet?.id ?? "none"} canPay={canPay} />;
}

function InvoiceListContent({ canPay }: { canPay: boolean }) {
  const t = useT();
  // The outlet the shell selected from the session's assigned outlets.
  const { outlet } = useTenantContext();
  const outletId = outlet?.id ?? "";
  const invoices = useSupplierInvoices({
    outletId,
    limit: 100,
  });
  const orders = usePurchaseOrders(outletId);
  const suppliers = useSuppliers();
  const [selected, setSelected] = React.useState("");
  const [search, setSearch] = React.useState("");

  const rows = React.useMemo(
    () =>
      (invoices.data?.data ?? []).filter((invoice) => {
        const needle = search.trim().toLocaleLowerCase("id-ID");
        if (needle === "") return true;
        return [
          invoice.number,
          supplierNameOf(suppliers.data?.data ?? [], invoice.supplierId),
          orderNumberOf(orders.data?.data ?? [], invoice.purchaseOrderId),
        ].some((value) => value.toLocaleLowerCase("id-ID").includes(needle));
      }),
    [invoices.data, orders.data, search, suppliers.data],
  );

  const loading =
    Boolean(outletId) &&
    (invoices.isPending || orders.isPending || suppliers.isPending);
  const failed = invoices.isError || orders.isError || suppliers.isError;
  const state: DataState = loading
    ? "loading"
    : failed
      ? "error"
      : (invoices.data?.data.length ?? 0) === 0
        ? "empty"
        : "ready";

  return (
    <div className="grid min-w-0 gap-4">
      <ReceivingOfflineNote />
      <DataTableShell
        title={t("inventoryReceiving.invoices.listTitle")}
        description={t("inventoryReceiving.invoices.listDescription")}
        state={state}
        error={invoices.error ?? orders.error ?? suppliers.error}
        onRetry={() => {
          void invoices.refetch();
          void orders.refetch();
          void suppliers.refetch();
        }}
        search={{
          value: search,
          onChange: setSearch,
          label: t("common.search"),
        }}
        actions={
          <Button asChild>
            <Link to="/kelola/pengadaan/faktur/baru">
              <ReceiptText aria-hidden="true" />
              {t("inventoryInvoiceEntry.newInvoice")}
            </Link>
          </Button>
        }
        empty={{
          title: t("inventoryReceiving.invoices.emptyTitle"),
          description: t("inventoryReceiving.invoices.emptyHint"),
          action: (
            <Button asChild variant="outline">
              <Link to="/kelola/pengadaan/penerimaan">
                {t("inventoryReceiving.receiving.newReceipt")}
              </Link>
            </Button>
          ),
        }}
        noResults={rows.length === 0 && (invoices.data?.data.length ?? 0) > 0}
        rowCount={rows.length}
      >
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  {t("inventoryReceiving.invoices.columns.number")}
                </TableHead>
                <TableHead>
                  {t("inventoryReceiving.invoices.columns.supplier")}
                </TableHead>
                <TableHead>
                  {t("inventoryReceiving.invoices.columns.order")}
                </TableHead>
                <TableHead>
                  {t("inventoryReceiving.invoices.columns.invoiceDate")}
                </TableHead>
                <TableHead>
                  {t("inventoryReceiving.invoices.columns.dueDate")}
                </TableHead>
                <TableHead numeric>
                  {t("inventoryReceiving.invoices.columns.total")}
                </TableHead>
                <TableHead>
                  {t("inventoryReceiving.invoices.columns.match")}
                </TableHead>
                <TableHead>
                  {t("inventoryReceiving.invoices.columns.payment")}
                </TableHead>
                <TableHead numeric>
                  {t("inventoryReceiving.invoices.columns.outstanding")}
                </TableHead>
                <TableHead className="text-right">
                  {t("inventoryReceiving.common.actions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((invoice) => (
                <TableRow key={invoice.id}>
                  <TableCell className="font-medium">
                    {invoice.number}
                  </TableCell>
                  <TableCell>
                    {supplierNameOf(
                      suppliers.data?.data ?? [],
                      invoice.supplierId,
                    )}
                  </TableCell>
                  <TableCell>
                    {orderNumberOf(
                      orders.data?.data ?? [],
                      invoice.purchaseOrderId,
                    )}
                  </TableCell>
                  <TableCell>
                    {formatBusinessDate(invoice.invoiceDate)}
                  </TableCell>
                  <TableCell>{formatBusinessDate(invoice.dueDate)}</TableCell>
                  <TableCell numeric>
                    <Money amount={invoice.totalIdr} />
                  </TableCell>
                  <TableCell>
                    <MatchStatusPill status={invoice.matchStatus} />
                  </TableCell>
                  <TableCell>
                    <StatusPill
                      status={
                        INVOICE_PAYMENT_TONE[invoicePaymentStatus(invoice)]
                      }
                    >
                      {t(INVOICE_PAYMENT_LABEL[invoicePaymentStatus(invoice)])}
                    </StatusPill>
                  </TableCell>
                  <TableCell numeric>
                    <Money amount={invoice.outstandingIdr} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setSelected(invoice.id)}
                    >
                      {t("inventoryReceiving.common.view")}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </DataTableShell>
      {selected !== "" && (
        <InvoiceDetailDialog
          invoiceId={selected}
          canPay={canPay}
          onClose={() => setSelected("")}
        />
      )}
    </div>
  );
}
