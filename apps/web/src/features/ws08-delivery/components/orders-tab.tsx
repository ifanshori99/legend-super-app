// Tab Pesanan masuk (PRD v1.7 §4 Alur G step 1-4, §3.23 "Injeksi Pesanan"):
// the newest platform orders first, a status/platform filter, and the D12
// "Catat pesanan manual" form for a platform whose integration is not active
// yet. The detail Sheet owns the fulfilment actions.
import * as React from "react";
import { Plus } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { CardShell, CardShellBody } from "@/components/ui/card";
import {
  DataTableShell,
  type DataState,
} from "@/components/ui/data-table-shell";
import { ErrorState } from "@/components/ui/feedback-state";
import { Money } from "@/components/ui/money";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DELIVERY_ORDER_STATUSES,
  DELIVERY_PLATFORMS,
} from "@starter/shared/delivery";
import type {
  DeliveryOrderStatus,
  DeliveryPlatform,
} from "@starter/shared/delivery";
import { useDeliveryOrders } from "../hooks";
import {
  formatClock,
  formatDayShort,
  orderStatusKey,
  platformKey,
} from "../lib";
import {
  OrderStatusPill,
  PlatformSyncBadge,
  SourceBadge,
} from "./delivery-badges";
import { ManualOrderSheet } from "./manual-order-sheet";
import { OrderDetailSheet } from "./order-detail-sheet";

const ALL = "all";

export function OrdersTab({
  outletId,
  timeZone,
  canHandle,
  online,
}: {
  outletId: string;
  timeZone: string;
  canHandle: boolean;
  online: boolean;
}) {
  const t = useT();
  const [platform, setPlatform] = React.useState<DeliveryPlatform | typeof ALL>(
    ALL,
  );
  const [status, setStatus] = React.useState<DeliveryOrderStatus | typeof ALL>(
    ALL,
  );
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [manualOpen, setManualOpen] = React.useState(false);
  const [attentionOnly, setAttentionOnly] = React.useState(false);

  const orders = useDeliveryOrders(outletId, {
    platform: platform === ALL ? undefined : platform,
    status: status === ALL ? undefined : status,
    attention: attentionOnly ? "true" : undefined,
  });
  const rows = orders.data?.pages.flatMap((page) => page.data) ?? [];
  const state: DataState = orders.isPending
    ? "loading"
    : rows.length === 0
      ? "empty"
      : "ready";

  return (
    <>
      {orders.isError ? (
        <CardShell>
          <CardShellBody>
            <ErrorState
              title={t("deliveryOps.pesanan.errorTitle")}
              description={t("deliveryOps.pesanan.errorHint")}
              error={orders.error}
              onRetry={() => void orders.refetch()}
            />
          </CardShellBody>
        </CardShell>
      ) : (
        <DataTableShell
          title={t("deliveryOps.pesanan.tableTitle")}
          description={t("deliveryOps.pesanan.tableDescription")}
          state={state}
          error={orders.error}
          onRetry={() => void orders.refetch()}
          empty={{
            title: t("deliveryOps.pesanan.emptyTitle"),
            description: t("deliveryOps.pesanan.emptyHint"),
          }}
          rowCount={rows.length}
          actions={
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Select
                value={platform}
                onValueChange={(value) => {
                  setPlatform(value as DeliveryPlatform | typeof ALL);
                }}
              >
                <SelectTrigger
                  aria-label={t("deliveryOps.pesanan.filterPlatform")}
                  className="h-control-sm w-full sm:w-44"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>
                    {t("deliveryOps.pesanan.allPlatforms")}
                  </SelectItem>
                  {DELIVERY_PLATFORMS.map((entry) => (
                    <SelectItem key={entry} value={entry}>
                      {t(platformKey(entry))}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={status}
                onValueChange={(value) => {
                  setStatus(value as DeliveryOrderStatus | typeof ALL);
                }}
              >
                <SelectTrigger
                  aria-label={t("deliveryOps.pesanan.filterStatus")}
                  className="h-control-sm w-full sm:w-44"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>
                    {t("deliveryOps.pesanan.allStatuses")}
                  </SelectItem>
                  {DELIVERY_ORDER_STATUSES.map((entry) => (
                    <SelectItem key={entry} value={entry}>
                      {t(orderStatusKey(entry))}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                size="sm"
                variant={attentionOnly ? "default" : "outline"}
                aria-pressed={attentionOnly}
                onClick={() => {
                  setAttentionOnly((value) => !value);
                }}
              >
                {t("deliveryOps.pesanan.filterAttention")}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={!canHandle || !online}
                onClick={() => setManualOpen(true)}
              >
                <Plus aria-hidden="true" />
                {t("deliveryOps.pesanan.manualButton")}
              </Button>
              {!canHandle && (
                <p className="max-w-56 text-xs leading-4 text-muted-foreground">
                  {t("deliveryOps.pesanan.handleOnly")}
                </p>
              )}
            </div>
          }
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  {t("deliveryOps.pesanan.column.platform")}
                </TableHead>
                <TableHead>{t("deliveryOps.pesanan.column.status")}</TableHead>
                <TableHead numeric>
                  {t("deliveryOps.pesanan.column.gross")}
                </TableHead>
                <TableHead numeric>
                  {t("deliveryOps.pesanan.column.commission")}
                </TableHead>
                <TableHead>
                  {t("deliveryOps.pesanan.column.received")}
                </TableHead>
                <TableHead>{t("deliveryOps.pesanan.column.source")}</TableHead>
                <TableHead>
                  <span className="sr-only">
                    {t("deliveryOps.pesanan.column.action")}
                  </span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((order) => (
                <TableRow key={order.id}>
                  <TableCell>
                    <span className="grid gap-0.5">
                      <span className="font-medium">
                        {t(platformKey(order.platform))}
                      </span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {order.externalOrderId}
                      </span>
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="grid justify-items-start gap-1">
                      <OrderStatusPill status={order.status} />
                      <PlatformSyncBadge sync={order.platformSync} />
                    </span>
                  </TableCell>
                  <TableCell numeric>
                    <Money amount={order.grossIdr} />
                  </TableCell>
                  <TableCell numeric>
                    <Money amount={order.commissionIdr} />
                  </TableCell>
                  <TableCell>
                    <span className="tabular">
                      {formatDayShort(order.receivedAt, timeZone)}
                      {" · "}
                      {formatClock(order.receivedAt, timeZone)}
                    </span>
                  </TableCell>
                  <TableCell>
                    <SourceBadge source={order.source} />
                  </TableCell>
                  <TableCell>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setSelectedId(order.id)}
                      aria-label={t("deliveryOps.pesanan.viewOrder", {
                        id: order.externalOrderId,
                      })}
                    >
                      {t("deliveryOps.pesanan.view")}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {orders.hasNextPage && (
            <div className="border-t px-card py-2.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                loading={orders.isFetchingNextPage}
                onClick={() => void orders.fetchNextPage()}
              >
                {t("deliveryOps.pesanan.loadMore")}
              </Button>
            </div>
          )}
        </DataTableShell>
      )}

      <OrderDetailSheet
        open={selectedId !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
        outletId={outletId}
        timeZone={timeZone}
        deliveryOrderId={selectedId}
        canHandle={canHandle}
        online={online}
      />

      <ManualOrderSheet
        open={manualOpen}
        onOpenChange={setManualOpen}
        outletId={outletId}
        online={online}
      />
    </>
  );
}
