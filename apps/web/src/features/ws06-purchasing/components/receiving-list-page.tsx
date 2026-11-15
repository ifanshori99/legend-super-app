// Goods receipt list (PRD v1.7 §3 F18, §16 "penerimaan di ponsel", INV-05).
// Every row carries the PO reference, the received date, the QC summary and
// the PO status; opening a row shows the per-line received/rejected/accepted
// quantities so the accepted-only stock value is auditable.
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { PackageCheck } from "lucide-react";
import { useT } from "@/components/i18n";
import { useTenantContext } from "@/lib/tenant-context";
import { StatusPill } from "@/components/ui/badge";
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
import { ErrorState } from "@/components/ui/feedback-state";
import { Money } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  goodsReceiptValueIdr,
  type PurchaseOrder,
  type PurchaseOrderStatus,
} from "@starter/shared/inventory";
import { useGoodsReceipt, useGoodsReceipts } from "../receiving-hooks.ts";
import {
  PO_STATUS_LABEL,
  acceptedOf,
  formatBusinessDate,
  formatQuantityWithUnit,
  itemNameOf,
  locationNameOf,
  orderNumberOf,
  poStatusTone,
  supplierNameOf,
  uomCodeOf,
} from "../receiving-lib.ts";
import {
  useInventoryItems,
  usePurchaseOrders,
  useStockLocations,
  useSuppliers,
  useUoms,
} from "../hooks.ts";
import { ReceivingOfflineNote } from "./receiving-offline-note.tsx";
import { StoragePhoto } from "../../ws06-inventory/components/photo-field.tsx";

function PoStatusPill({ value }: { value: PurchaseOrderStatus }) {
  const t = useT();
  return (
    <StatusPill status={poStatusTone(value)}>
      {t(PO_STATUS_LABEL[value])}
    </StatusPill>
  );
}

function ReceiptDetailDialog({
  receiptId,
  onClose,
}: {
  receiptId: string;
  onClose: () => void;
}) {
  const t = useT();
  const { outlet } = useTenantContext();
  const detail = useGoodsReceipt(receiptId);
  const items = useInventoryItems();
  const uoms = useUoms();
  const locations = useStockLocations(outlet?.id ?? "");
  const body = detail.data?.data;
  const value = body ? goodsReceiptValueIdr(body.lines, "half_up") : 0;
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {body
              ? t("inventoryReceiving.receiving.detailTitle", {
                  number: body.receipt.number,
                })
              : t("inventoryReceiving.receiving.detailTitle", { number: "…" })}
          </DialogTitle>
          <DialogDescription>
            {body
              ? `${t("inventoryReceiving.common.supplier")} · ${formatBusinessDate(
                  body.receipt.receivedOn,
                )}`
              : t("common.loading")}
          </DialogDescription>
        </DialogHeader>
        {detail.isPending ? (
          <div aria-busy="true" className="grid gap-2">
            <span className="sr-only">{t("common.loading")}</span>
            <Skeleton className="h-row" />
            <Skeleton className="h-row" />
            <Skeleton className="h-row" />
          </div>
        ) : detail.isError ? (
          <ErrorState onRetry={() => void detail.refetch()} />
        ) : body ? (
          <>
            <div className="grid gap-3 rounded-container border bg-surface-2 p-card sm:grid-cols-2">
              <div>
                <p className="type-eyebrow">
                  {t("inventoryReceiving.receiving.value")}
                </p>
                <Money amount={value} size="lg" />
              </div>
              <div>
                <p className="type-eyebrow">
                  {t("inventoryReceiving.receiving.qcNotes")}
                </p>
                <p className="text-sm leading-5">
                  {body.receipt.qcNotes ?? t("inventoryReceiving.qc.noNotes")}
                </p>
              </div>
            </div>
            {body.receipt.mediaIds.length > 0 && (
              <div className="flex flex-wrap gap-3">
                {body.receipt.mediaIds.map((mediaId) => (
                  <StoragePhoto
                    key={mediaId}
                    mediaId={mediaId}
                    alt={t("inventoryReceiving.receiving.form.photoSection")}
                  />
                ))}
              </div>
            )}
            <div className="overflow-x-auto rounded-container border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>
                      {t("inventoryReceiving.receiving.lineColumns.item")}
                    </TableHead>
                    <TableHead numeric>
                      {t("inventoryReceiving.receiving.lineColumns.received")}
                    </TableHead>
                    <TableHead numeric>
                      {t("inventoryReceiving.receiving.lineColumns.rejected")}
                    </TableHead>
                    <TableHead numeric>
                      {t("inventoryReceiving.receiving.lineColumns.accepted")}
                    </TableHead>
                    <TableHead>
                      {t("inventoryReceiving.receiving.lineColumns.batch")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {body.lines.map((line) => {
                    const item = items.data?.data.find(
                      (row) => row.id === line.inventoryItemId,
                    );
                    return (
                      <TableRow key={line.id}>
                        <TableCell className="font-medium">
                          {itemNameOf(
                            items.data?.data ?? [],
                            line.inventoryItemId,
                          )}
                          <span className="block text-xs text-muted-foreground">
                            {locationNameOf(
                              locations.data?.data ?? [],
                              line.locationId,
                            )}
                          </span>
                        </TableCell>
                        <TableCell numeric>
                          {formatQuantityWithUnit(
                            line.quantityReceived,
                            uomCodeOf(
                              uoms.data?.data ?? [],
                              item?.baseUomId ?? "",
                            ),
                          )}
                        </TableCell>
                        <TableCell numeric>
                          {formatQuantityWithUnit(
                            line.quantityRejected,
                            uomCodeOf(
                              uoms.data?.data ?? [],
                              item?.baseUomId ?? "",
                            ),
                          )}
                        </TableCell>
                        <TableCell numeric>
                          {formatQuantityWithUnit(
                            acceptedOf(line),
                            uomCodeOf(
                              uoms.data?.data ?? [],
                              item?.baseUomId ?? "",
                            ),
                          )}
                        </TableCell>
                        <TableCell>{line.batchCode ?? "—"}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            <p className="text-sm leading-5 text-muted-foreground">
              {body.receipt.note ?? t("inventoryReceiving.common.emptyValue")}
            </p>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Keyed by outlet: switching outlet in the shell starts a fresh list, so a
 * selected receipt or search of the previous outlet cannot leak.
 */
export function ReceivingListPage({ canReceive }: { canReceive: boolean }) {
  const { outlet } = useTenantContext();
  return (
    <ReceivingListContent key={outlet?.id ?? "none"} canReceive={canReceive} />
  );
}

function ReceivingListContent({ canReceive }: { canReceive: boolean }) {
  const t = useT();
  // The outlet the shell selected from the session's assigned outlets.
  const { outlet } = useTenantContext();
  const outletId = outlet?.id ?? "";
  const receipts = useGoodsReceipts(outletId);
  const orders = usePurchaseOrders(outletId);
  const suppliers = useSuppliers();
  const [selected, setSelected] = React.useState("");
  const [search, setSearch] = React.useState("");

  const orderById = React.useMemo(() => {
    const map = new Map<string, PurchaseOrder>();
    for (const order of orders.data?.data ?? []) map.set(order.id, order);
    return map;
  }, [orders.data]);

  const rows = React.useMemo(
    () =>
      (receipts.data?.data ?? []).filter((receipt) => {
        const needle = search.trim().toLocaleLowerCase("id-ID");
        if (needle === "") return true;
        const order = orderById.get(receipt.purchaseOrderId);
        const supplierName = supplierNameOf(
          suppliers.data?.data ?? [],
          receipt.supplierId,
        );
        return [receipt.number, supplierName, order?.number ?? ""].some(
          (value) => value.toLocaleLowerCase("id-ID").includes(needle),
        );
      }),
    [receipts.data, orderById, search, suppliers.data],
  );

  const loading =
    Boolean(outletId) &&
    (receipts.isPending || orders.isPending || suppliers.isPending);
  const failed = receipts.isError || orders.isError || suppliers.isError;
  const state: DataState = loading
    ? "loading"
    : failed
      ? "error"
      : (receipts.data?.data.length ?? 0) === 0
        ? "empty"
        : "ready";

  const retry = () => {
    void receipts.refetch();
    void orders.refetch();
    void suppliers.refetch();
  };

  return (
    <div className="grid min-w-0 gap-4">
      <ReceivingOfflineNote />
      <DataTableShell
        title={t("inventoryReceiving.receiving.listTitle")}
        description={t("inventoryReceiving.receiving.listDescription")}
        state={state}
        onRetry={retry}
        search={{
          value: search,
          onChange: setSearch,
          label: t("common.search"),
        }}
        actions={
          canReceive ? (
            <Button asChild>
              <Link to="/kelola/pengadaan/penerimaan/baru">
                <PackageCheck aria-hidden="true" />
                {t("inventoryReceiving.receiving.newReceipt")}
              </Link>
            </Button>
          ) : null
        }
        empty={{
          title: t("inventoryReceiving.receiving.emptyTitle"),
          description: t("inventoryReceiving.receiving.emptyHint"),
          action: canReceive ? (
            <Button asChild variant="outline">
              <Link to="/kelola/pengadaan/penerimaan/baru">
                {t("inventoryReceiving.receiving.newReceipt")}
              </Link>
            </Button>
          ) : null,
        }}
        noResults={rows.length === 0 && (receipts.data?.data.length ?? 0) > 0}
        rowCount={rows.length}
      >
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  {t("inventoryReceiving.receiving.columns.number")}
                </TableHead>
                <TableHead>
                  {t("inventoryReceiving.receiving.columns.supplier")}
                </TableHead>
                <TableHead>
                  {t("inventoryReceiving.receiving.columns.order")}
                </TableHead>
                <TableHead>
                  {t("inventoryReceiving.receiving.columns.receivedOn")}
                </TableHead>
                <TableHead>
                  {t("inventoryReceiving.receiving.columns.qc")}
                </TableHead>
                <TableHead>{t("inventoryReceiving.common.status")}</TableHead>
                <TableHead className="text-right">
                  {t("inventoryReceiving.common.actions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((receipt) => {
                const order = orderById.get(receipt.purchaseOrderId);
                return (
                  <TableRow key={receipt.id}>
                    <TableCell className="font-medium">
                      {receipt.number}
                      <span className="block text-xs text-muted-foreground">
                        {receipt.mediaIds.length > 0
                          ? t("inventoryReceiving.receiving.media", {
                              count: receipt.mediaIds.length,
                            })
                          : t("inventoryReceiving.receiving.noMedia")}
                      </span>
                    </TableCell>
                    <TableCell>
                      {supplierNameOf(
                        suppliers.data?.data ?? [],
                        receipt.supplierId,
                      )}
                    </TableCell>
                    <TableCell>
                      {orderNumberOf(
                        orders.data?.data ?? [],
                        receipt.purchaseOrderId,
                      )}
                    </TableCell>
                    <TableCell>
                      {formatBusinessDate(receipt.receivedOn)}
                    </TableCell>
                    <TableCell className="max-w-56">
                      <span className="line-clamp-2 text-sm">
                        {receipt.qcNotes ?? t("inventoryReceiving.qc.noNotes")}
                      </span>
                    </TableCell>
                    <TableCell>
                      {order ? (
                        <PoStatusPill value={order.status} />
                      ) : (
                        t("inventoryReceiving.common.emptyValue")
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setSelected(receipt.id)}
                      >
                        {t("inventoryReceiving.common.view")}
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </DataTableShell>
      {selected !== "" && (
        <ReceiptDetailDialog
          receiptId={selected}
          onClose={() => setSelected("")}
        />
      )}
    </div>
  );
}
