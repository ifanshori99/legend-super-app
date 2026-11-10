// Internal stock transfers (PRD §16 "transfer antarlokasi"): the recent
// movements between storage locations of one outlet. Each row is the source
// document; the stock card holds the paired out/in ledger rows.
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useT } from "@/components/i18n";
import { useTenantContext } from "@/lib/tenant-context";
import { Button } from "@/components/ui/button";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  useInventoryItems,
  useStockLocations,
  useStockTransfers,
  useUnits,
} from "../hooks";
import { formatTransferTime, LIST_LIMIT, transferQuantity } from "../lib";

/** Keyed by outlet so the list state resets when the shell switches outlet. */
export function TransfersPage() {
  const { outlet } = useTenantContext();
  return <TransfersContent key={outlet?.id ?? "none"} />;
}

function TransfersContent() {
  const t = useT();
  const { outlet } = useTenantContext();
  const outletId = outlet?.id;
  const transfersQuery = useStockTransfers(outletId);
  const locationsQuery = useStockLocations(outletId);
  const itemsQuery = useInventoryItems({ limit: LIST_LIMIT });
  const unitsQuery = useUnits({ limit: LIST_LIMIT });

  const locations = locationsQuery.data?.data ?? [];
  const items = itemsQuery.data?.data ?? [];
  const units = unitsQuery.data?.data ?? [];
  const transfers = React.useMemo(
    () =>
      [...(transfersQuery.data?.data ?? [])].sort(
        (a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt),
      ),
    [transfersQuery.data],
  );

  const locationName = (id: string) =>
    locations.find((location) => location.id === id)?.name ?? "—";
  const itemName = (id: string) =>
    items.find((item) => item.id === id)?.name ?? "—";
  const unitOf = (itemId: string) => {
    const item = items.find((row) => row.id === itemId);
    return units.find((unit) => unit.id === item?.baseUomId)?.code ?? "—";
  };

  const state: DataState =
    transfersQuery.isPending ||
    locationsQuery.isPending ||
    itemsQuery.isPending ||
    unitsQuery.isPending
      ? "loading"
      : transfersQuery.isError ||
          locationsQuery.isError ||
          itemsQuery.isError ||
          unitsQuery.isError
        ? "error"
        : transfers.length === 0
          ? "empty"
          : "ready";

  return (
    <DataTableShell
      title={t("inventory.transfers.title")}
      description={t("inventory.transfers.description")}
      state={state}
      error={
        transfersQuery.error ??
        locationsQuery.error ??
        itemsQuery.error ??
        unitsQuery.error
      }
      onRetry={() => {
        void transfersQuery.refetch();
        void locationsQuery.refetch();
        void itemsQuery.refetch();
        void unitsQuery.refetch();
      }}
      actions={
        <Button asChild>
          <Link to="/kelola/inventori/transfer/baru">
            <Plus aria-hidden="true" />
            {t("inventory.transfers.add")}
          </Link>
        </Button>
      }
      rowCount={transfers.length}
      empty={{
        title: t("inventory.transfers.empty"),
        description: t("inventory.transfers.emptyHint"),
        action: (
          <Button asChild variant="outline">
            <Link to="/kelola/inventori/transfer/baru">
              <Plus aria-hidden="true" />
              {t("inventory.transfers.add")}
            </Link>
          </Button>
        ),
      }}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("inventory.transfers.columns.when")}</TableHead>
            <TableHead>{t("inventory.transfers.columns.from")}</TableHead>
            <TableHead>{t("inventory.transfers.columns.to")}</TableHead>
            <TableHead>{t("inventory.transfers.columns.lines")}</TableHead>
            <TableHead numeric>
              {t("inventory.transfers.columns.quantity")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {transfers.map((transfer) => (
            <TableRow key={transfer.id}>
              <TableCell className="tabular whitespace-nowrap">
                {formatTransferTime(transfer.occurredAt)}
              </TableCell>
              <TableCell>{locationName(transfer.fromLocationId)}</TableCell>
              <TableCell>{locationName(transfer.toLocationId)}</TableCell>
              <TableCell>
                <div className="grid min-w-48 gap-0.5">
                  <span>
                    {transfer.lines.length === 1
                      ? itemName(transfer.lines[0].inventoryItemId)
                      : t("inventory.transfers.linesCount", {
                          count: transfer.lines.length,
                        })}
                  </span>
                  {transfer.lines.length > 1 && (
                    <span className="line-clamp-1 text-xs leading-4 text-muted-foreground">
                      {transfer.lines
                        .map((line) => itemName(line.inventoryItemId))
                        .join(", ")}
                    </span>
                  )}
                </div>
              </TableCell>
              <TableCell numeric>
                {transferQuantity(transfer, unitOf)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </DataTableShell>
  );
}
