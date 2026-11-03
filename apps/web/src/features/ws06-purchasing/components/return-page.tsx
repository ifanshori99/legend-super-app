// Purchase returns (PRD v1.7 §3.18 "Retur Pembelian"): a return note created
// from a goods receipt, line by line, never exceeding the quantity accepted
// for that PO line (contract `assertPurchaseReturnWithinReceipt`). The PRD asks
// for no approval step on a return, so the form writes it straight away.
import * as React from "react";
import { Undo2 } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
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
import { parseDecimal4 } from "@starter/shared/core";
import type { Decimal4 } from "@starter/shared/core";
import {
  purchaseReturnReasonSchema,
  type GoodsReceipt,
  type PurchaseReturnReason,
} from "@starter/shared/inventory";
import { quantityFromInput } from "../../ws06-inventory/lib.ts";
import { INVENTORY_OUTLET_ID } from "../../ws06-inventory/outlet.ts";
import {
  useAttemptKey,
  useCreatePurchaseReturn,
  useGoodsReceipt,
  useGoodsReceipts,
  usePurchaseReturns,
} from "../receiving-hooks.ts";
import {
  RETURN_REASON_LABEL,
  acceptedOf,
  formatBusinessDate,
  formatQuantityWithUnit,
  itemNameOf,
  receivingErrorKey,
  supplierNameOf,
  todayBusinessDate,
  uomCodeOf,
} from "../receiving-lib.ts";
import { useInventoryItems, useSuppliers, useUoms } from "../hooks.ts";
import { ReceivingOfflineNote } from "./receiving-offline-note.tsx";

const RETURN_REASONS = purchaseReturnReasonSchema.options;

function ReturnFormDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const attempt = useAttemptKey();
  const receipts = useGoodsReceipts(INVENTORY_OUTLET_ID);
  const createReturn = useCreatePurchaseReturn();
  const suppliers = useSuppliers();
  const items = useInventoryItems();
  const uoms = useUoms();

  const receiptRows = receipts.data?.data ?? [];
  const [choice, setChoice] = React.useState("");
  const receiptId = choice || receiptRows[0]?.id || "";
  const detail = useGoodsReceipt(receiptId);
  const [reason, setReason] = React.useState<PurchaseReturnReason | "">("");
  const [quantities, setQuantities] = React.useState<Record<string, string>>(
    {},
  );
  const [note, setNote] = React.useState("");
  const [reasonError, setReasonError] = React.useState<string | undefined>();
  const [lineError, setLineError] = React.useState<string | undefined>();
  const [formError, setFormError] = React.useState<string | undefined>();

  function chooseReceipt(value: string) {
    setChoice(value);
    setQuantities({});
    setReasonError(undefined);
    setLineError(undefined);
    setFormError(undefined);
  }

  const receipt = detail.data?.data.receipt;
  const lines = detail.data?.data.lines ?? [];

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!receipt || !detail.data) {
      setFormError(t("inventoryReceiving.returns.errorReceipt"));
      return;
    }
    if (reason === "") {
      setReasonError(t("inventoryReceiving.returns.errorReason"));
      return;
    }
    setReasonError(undefined);
    const parsed: {
      purchaseOrderLineId: string;
      inventoryItemId: string;
      quantity: Decimal4;
      locationId: string;
      batchCode: string | null;
    }[] = [];
    for (const line of detail.data.data.lines) {
      const raw = quantities[line.id] ?? "";
      if (raw.trim() === "") continue;
      const quantity = quantityFromInput(raw);
      if (quantity === null) {
        setLineError(t("inventoryReceiving.returns.errorQuantity"));
        return;
      }
      if (parseDecimal4(quantity) > parseDecimal4(acceptedOf(line))) {
        setLineError(t("inventoryReceiving.returns.errorExceeds"));
        return;
      }
      parsed.push({
        purchaseOrderLineId: line.purchaseOrderLineId,
        inventoryItemId: line.inventoryItemId,
        quantity,
        locationId: line.locationId,
        batchCode: line.batchCode,
      });
    }
    if (parsed.length === 0) {
      setFormError(t("inventoryReceiving.returns.errorLines"));
      return;
    }
    setLineError(undefined);
    setFormError(undefined);
    const payload = {
      outletId: INVENTORY_OUTLET_ID,
      supplierId: receipt.supplierId,
      purchaseOrderId: receipt.purchaseOrderId,
      goodsReceiptId: receipt.id,
      returnedOn: todayBusinessDate(),
      reason,
      lines: parsed,
      note: note.trim() === "" ? null : note.trim(),
    };
    createReturn.mutate(
      { ...payload, idempotencyKey: attempt.keyFor(payload) },
      {
        onSuccess: () => {
          attempt.settle();
          toast({
            title: t("inventoryReceiving.returns.created"),
            tone: "success",
          });
          onClose();
        },
        onError: (error) =>
          setFormError(
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
    receipts.isPending ||
    suppliers.isPending ||
    items.isPending ||
    uoms.isPending ||
    (receiptId !== "" && detail.isPending);
  const failed =
    receipts.isError ||
    suppliers.isError ||
    items.isError ||
    uoms.isError ||
    detail.isError;

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("inventoryReceiving.returns.formTitle")}</DialogTitle>
          <DialogDescription>
            {t("inventoryReceiving.returns.formSubtitle")}
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <div aria-busy="true" className="grid gap-2">
            <span className="sr-only">{t("common.loading")}</span>
            <Skeleton className="h-row" />
            <Skeleton className="h-24" />
          </div>
        ) : failed ? (
          <ErrorState
            onRetry={() => {
              void receipts.refetch();
              void suppliers.refetch();
              void items.refetch();
              void uoms.refetch();
              void detail.refetch();
            }}
          />
        ) : receiptRows.length === 0 ? (
          <EmptyState
            icon={Undo2}
            title={t("inventoryReceiving.returns.noReceipts")}
            description={t("inventoryReceiving.returns.noReceiptsHint")}
          />
        ) : (
          <form className="grid min-w-0 gap-4" onSubmit={submit} noValidate>
            <FormField label={t("inventoryReceiving.returns.receipt")} required>
              <Select value={receiptId} onValueChange={chooseReceipt}>
                {/* FormField wraps a Radix Root, which cannot take the generated
                    id, so the trigger carries its own accessible name. */}
                <SelectTrigger
                  aria-label={t("inventoryReceiving.returns.receipt")}
                >
                  <SelectValue
                    placeholder={t("inventoryReceiving.returns.chooseReceipt")}
                  />
                </SelectTrigger>
                <SelectContent>
                  {receiptRows.map((row) => (
                    <SelectItem key={row.id} value={row.id}>
                      {`${row.number} · ${supplierNameOf(
                        suppliers.data?.data ?? [],
                        row.supplierId,
                      )} · ${formatBusinessDate(row.receivedOn)}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            {receipt && (
              <div className="grid gap-3 rounded-container bg-surface-2 p-card text-sm sm:grid-cols-3">
                <div>
                  <p className="type-eyebrow">
                    {t("inventoryReceiving.common.supplier")}
                  </p>
                  <p className="font-medium">
                    {supplierNameOf(
                      suppliers.data?.data ?? [],
                      receipt.supplierId,
                    )}
                  </p>
                </div>
                <div>
                  <p className="type-eyebrow">
                    {t("inventoryReceiving.common.date")}
                  </p>
                  <p>{formatBusinessDate(receipt.receivedOn)}</p>
                </div>
                <div>
                  <p className="type-eyebrow">
                    {t("inventoryReceiving.receiving.qcNotes")}
                  </p>
                  <p className="line-clamp-2">
                    {receipt.qcNotes ?? t("inventoryReceiving.qc.noNotes")}
                  </p>
                </div>
              </div>
            )}

            <FormField
              label={t("inventoryReceiving.returns.reason")}
              error={reasonError}
              required
            >
              <Select
                value={reason === "" ? undefined : reason}
                onValueChange={(value) => {
                  setReason(value as PurchaseReturnReason);
                  setReasonError(undefined);
                }}
              >
                <SelectTrigger
                  aria-label={t("inventoryReceiving.returns.reason")}
                >
                  <SelectValue
                    placeholder={t("inventoryReceiving.returns.reason")}
                  />
                </SelectTrigger>
                <SelectContent>
                  {RETURN_REASONS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {t(RETURN_REASON_LABEL[value])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            <div className="grid gap-3">
              <h3 className="text-base leading-6 font-semibold">
                {t("inventoryReceiving.returns.lineColumns.item")}
              </h3>
              {lines.map((line) => {
                const item = items.data?.data.find(
                  (row) => row.id === line.inventoryItemId,
                );
                const unit = uomCodeOf(
                  uoms.data?.data ?? [],
                  item?.baseUomId ?? "",
                );
                return (
                  <div
                    key={line.id}
                    className="grid gap-3 rounded-container border bg-card p-card"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="font-semibold">
                          {itemNameOf(
                            items.data?.data ?? [],
                            line.inventoryItemId,
                          )}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {t("inventoryReceiving.returns.lineColumns.batch")}:{" "}
                          {line.batchCode ??
                            t("inventoryReceiving.common.emptyValue")}
                        </p>
                      </div>
                      <Badge tone="info">
                        {t("inventoryReceiving.returns.lineColumns.accepted")}:{" "}
                        {formatQuantityWithUnit(acceptedOf(line), unit)}
                      </Badge>
                    </div>
                    <div className="grid gap-2 text-sm sm:grid-cols-3">
                      <div>
                        <p className="type-eyebrow">
                          {t("inventoryReceiving.returns.lineColumns.received")}
                        </p>
                        <p>
                          {formatQuantityWithUnit(line.quantityReceived, unit)}
                        </p>
                      </div>
                      <div>
                        <p className="type-eyebrow">
                          {t("inventoryReceiving.returns.lineColumns.rejected")}
                        </p>
                        <p>
                          {formatQuantityWithUnit(line.quantityRejected, unit)}
                        </p>
                      </div>
                      <FormField
                        label={t(
                          "inventoryReceiving.returns.lineColumns.returnQty",
                        )}
                      >
                        <Input
                          value={quantities[line.id] ?? ""}
                          onChange={(event) => {
                            setQuantities((current) => ({
                              ...current,
                              [line.id]: event.target.value,
                            }));
                            setLineError(undefined);
                            setFormError(undefined);
                          }}
                          inputMode="decimal"
                          autoComplete="off"
                          disabled={parseDecimal4(acceptedOf(line)) <= 0n}
                        />
                      </FormField>
                    </div>
                  </div>
                );
              })}
              {lineError && (
                <p role="alert" className="text-sm font-medium text-danger">
                  {lineError}
                </p>
              )}
            </div>

            <FormField label={t("inventoryReceiving.returns.note")}>
              <Textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                rows={2}
              />
            </FormField>

            {formError && (
              <p role="alert" className="text-sm font-medium text-danger">
                {formError}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>
                {t("inventoryReceiving.common.cancel")}
              </Button>
              <Button type="submit" loading={createReturn.isPending}>
                <Undo2 aria-hidden="true" />
                {t("inventoryReceiving.returns.submit")}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function ReturnListPage() {
  const t = useT();
  const returns = usePurchaseReturns(INVENTORY_OUTLET_ID);
  const receipts = useGoodsReceipts(INVENTORY_OUTLET_ID);
  const suppliers = useSuppliers();
  const [formOpen, setFormOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");

  const receiptById = React.useMemo(() => {
    const map = new Map<string, GoodsReceipt>();
    for (const receipt of receipts.data?.data ?? [])
      map.set(receipt.id, receipt);
    return map;
  }, [receipts.data]);

  const rows = React.useMemo(
    () =>
      (returns.data?.data ?? []).filter((row) => {
        const needle = search.trim().toLocaleLowerCase("id-ID");
        if (needle === "") return true;
        return [
          row.number,
          supplierNameOf(suppliers.data?.data ?? [], row.supplierId),
          row.goodsReceiptId
            ? (receiptById.get(row.goodsReceiptId)?.number ?? "")
            : "",
        ].some((value) => value.toLocaleLowerCase("id-ID").includes(needle));
      }),
    [returns.data, receiptById, search, suppliers.data],
  );

  const loading =
    returns.isPending || receipts.isPending || suppliers.isPending;
  const failed = returns.isError || receipts.isError || suppliers.isError;
  const state: DataState = loading
    ? "loading"
    : failed
      ? "error"
      : (returns.data?.data.length ?? 0) === 0
        ? "empty"
        : "ready";

  return (
    <div className="grid min-w-0 gap-4">
      <ReceivingOfflineNote />
      <DataTableShell
        title={t("inventoryReceiving.returns.listTitle")}
        description={t("inventoryReceiving.returns.listDescription")}
        state={state}
        onRetry={() => {
          void returns.refetch();
          void receipts.refetch();
          void suppliers.refetch();
        }}
        search={{
          value: search,
          onChange: setSearch,
          label: t("common.search"),
        }}
        actions={
          <Button onClick={() => setFormOpen(true)}>
            <Undo2 aria-hidden="true" />
            {t("inventoryReceiving.returns.newReturn")}
          </Button>
        }
        empty={{
          title: t("inventoryReceiving.returns.emptyTitle"),
          description: t("inventoryReceiving.returns.emptyHint"),
          action: (
            <Button variant="outline" onClick={() => setFormOpen(true)}>
              {t("inventoryReceiving.returns.newReturn")}
            </Button>
          ),
        }}
        noResults={rows.length === 0 && (returns.data?.data.length ?? 0) > 0}
        rowCount={rows.length}
      >
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  {t("inventoryReceiving.returns.columns.number")}
                </TableHead>
                <TableHead>
                  {t("inventoryReceiving.returns.columns.supplier")}
                </TableHead>
                <TableHead>
                  {t("inventoryReceiving.returns.columns.receipt")}
                </TableHead>
                <TableHead>
                  {t("inventoryReceiving.returns.columns.date")}
                </TableHead>
                <TableHead>
                  {t("inventoryReceiving.returns.columns.reason")}
                </TableHead>
                <TableHead numeric>
                  {t("inventoryReceiving.returns.columns.value")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-medium">{row.number}</TableCell>
                  <TableCell>
                    {supplierNameOf(suppliers.data?.data ?? [], row.supplierId)}
                  </TableCell>
                  <TableCell>
                    {row.goodsReceiptId
                      ? (receiptById.get(row.goodsReceiptId)?.number ?? "—")
                      : "—"}
                  </TableCell>
                  <TableCell>{formatBusinessDate(row.returnedOn)}</TableCell>
                  <TableCell>
                    <Badge tone="neutral">
                      {t(RETURN_REASON_LABEL[row.reason])}
                    </Badge>
                  </TableCell>
                  <TableCell numeric>
                    <Money amount={row.valueIdr} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </DataTableShell>
      {formOpen && <ReturnFormDialog onClose={() => setFormOpen(false)} />}
    </div>
  );
}
