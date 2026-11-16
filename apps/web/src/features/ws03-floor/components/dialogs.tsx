// Dialogs behind the floor board action panel: confirm an open-bill session,
// close a table (ORD-10), move/merge sessions, move items, split the bill,
// reserve or deactivate a table. Each dialog owns its form state and calls the
// feature hooks; the panel stays open until an action succeeds.
import * as React from "react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Money } from "@/components/ui/money";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import type {
  FloorBoard,
  FloorZone,
  OrderItemId,
  TableLiveStatus,
  TableSessionId,
} from "@starter/shared/qr-order";
import {
  useCloseSession,
  useConfirmSession,
  useMergeTables,
  useMoveItems,
  useMoveSession,
  useSessionBill,
  useSplitBill,
  useTableStatus,
} from "../hooks";
import {
  floorActionErrorKey,
  moveTargets,
  otherSessionRows,
  paymentModeLabel,
} from "../lib";

type Common = {
  row: TableLiveStatus;
  board: FloorBoard;
  zones: readonly FloorZone[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful action, to close the whole action panel. */
  onDone: () => void;
};

function DialogError({ error }: { error: unknown }) {
  const t = useT();
  if (!error) return null;
  return (
    <p role="alert" className="text-sm font-semibold text-danger">
      {t(floorActionErrorKey(error))}
    </p>
  );
}

// ---- Confirm open-bill session -------------------------------------------

export function ConfirmSessionDialog({
  row,
  open,
  onOpenChange,
  onDone,
}: Omit<Common, "board" | "zones">) {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirmSession();
  const session = row.session;
  if (!session) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("floor.dialogs.confirmTitle")}</DialogTitle>
          <DialogDescription>
            {t("floor.dialogs.confirmHint")}
          </DialogDescription>
        </DialogHeader>
        <DialogError error={confirm.error} />
        <DialogFooter>
          <Button
            type="button"
            loading={confirm.isPending}
            onClick={() =>
              confirm.mutate(session.id, {
                onSuccess: () => {
                  toast({ title: t("floor.toast.sessionConfirmed") });
                  onOpenChange(false);
                  onDone();
                },
              })
            }
          >
            {t("floor.dialogs.confirmSubmit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- Close a table (ORD-10) ---------------------------------------------

export function CloseSessionDialog({
  row,
  open,
  onOpenChange,
  onDone,
}: Omit<Common, "board" | "zones">) {
  const t = useT();
  const toast = useToast();
  const close = useCloseSession();
  const session = row.session;
  const [cleaned, setCleaned] = React.useState(false);
  const [confirmed, setConfirmed] = React.useState(false);
  if (!session) return null;
  const outstanding = row.outstandingIdr > 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t("floor.dialogs.closeTitle", { code: row.table.code })}
          </DialogTitle>
          <DialogDescription>{t("floor.dialogs.closeHint")}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-2 rounded-lg border border-border bg-muted/40 p-3">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm text-muted-foreground">
              {t("floor.session.outstanding")}
            </span>
            <Money
              amount={row.outstandingIdr}
              size="lg"
              className={outstanding ? "text-danger" : "text-success"}
            />
          </div>
          <span className="text-sm text-muted-foreground">
            {paymentModeLabel(session.paymentMode, t)}
          </span>
        </div>

        <div className="grid gap-3">
          <label className="flex min-h-control items-center gap-3">
            <Checkbox
              checked={cleaned}
              onCheckedChange={(value) => setCleaned(value === true)}
            />
            <span>{t("floor.dialogs.tableCleaned")}</span>
          </label>
          <label className="flex min-h-control items-center gap-3">
            <Checkbox
              checked={confirmed}
              onCheckedChange={(value) => setConfirmed(value === true)}
            />
            <span>{t("floor.dialogs.waiterConfirmed")}</span>
          </label>
        </div>

        <DialogError error={close.error} />
        <DialogFooter>
          <Button
            type="button"
            loading={close.isPending}
            onClick={() =>
              close.mutate(
                {
                  sessionId: session.id,
                  tableCleaned: cleaned,
                  waiterConfirmedEmpty: confirmed,
                },
                {
                  onSuccess: () => {
                    toast({
                      title: t(
                        cleaned
                          ? "floor.toast.tableClosedClean"
                          : "floor.toast.tableClosedDirty",
                      ),
                    });
                    onOpenChange(false);
                    onDone();
                  },
                },
              )
            }
          >
            {t("floor.dialogs.closeSubmit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- Move a session ------------------------------------------------------

export function MoveSessionDialog({
  row,
  board,
  zones,
  open,
  onOpenChange,
  onDone,
}: Common) {
  const t = useT();
  const toast = useToast();
  const move = useMoveSession();
  const session = row.session;
  const [targetId, setTargetId] = React.useState("");
  if (!session) return null;
  const targets = moveTargets(board.tables, zones, row);
  const target = targets.find((item) => item.table.id === targetId);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("floor.dialogs.moveTitle")}</DialogTitle>
          <DialogDescription>{t("floor.dialogs.moveHint")}</DialogDescription>
        </DialogHeader>
        {targets.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("floor.dialogs.noTargets")}
          </p>
        ) : (
          <div className="grid gap-2">
            <Label htmlFor="move-session-target">
              {t("floor.dialogs.targetTable")}
            </Label>
            <Select value={targetId} onValueChange={setTargetId}>
              <SelectTrigger id="move-session-target">
                <SelectValue
                  placeholder={t("floor.dialogs.targetPlaceholder")}
                />
              </SelectTrigger>
              <SelectContent>
                {targets.map((item) => (
                  <SelectItem key={item.table.id} value={item.table.id}>
                    {item.table.code} ·{" "}
                    {t("floor.capacity", { count: item.table.capacity })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <DialogError error={move.error} />
        <DialogFooter>
          <Button
            type="button"
            loading={move.isPending}
            disabled={!target}
            onClick={() => {
              if (!target) return;
              move.mutate(
                { sessionId: session.id, toTableId: target.table.id },
                {
                  onSuccess: () => {
                    toast({
                      title: t("floor.toast.sessionMoved", {
                        code: target.table.code,
                      }),
                    });
                    onOpenChange(false);
                    onDone();
                  },
                },
              );
            }}
          >
            {t("floor.dialogs.moveSubmit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- Merge tables --------------------------------------------------------

export function MergeTablesDialog({
  row,
  board,
  open,
  onOpenChange,
  onDone,
}: Omit<Common, "zones">) {
  const t = useT();
  const toast = useToast();
  const merge = useMergeTables();
  const session = row.session;
  const [sourceId, setSourceId] = React.useState("");
  if (!session) return null;
  const sources = otherSessionRows(board.tables, session.id).filter(
    (entry) => entry.session.paymentMode === session.paymentMode,
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("floor.dialogs.mergeTitle")}</DialogTitle>
          <DialogDescription>{t("floor.dialogs.mergeHint")}</DialogDescription>
        </DialogHeader>
        {sources.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("floor.dialogs.noSources")}
          </p>
        ) : (
          <div className="grid gap-2">
            <Label htmlFor="merge-source">
              {t("floor.dialogs.sourceSession")}
            </Label>
            <Select value={sourceId} onValueChange={setSourceId}>
              <SelectTrigger id="merge-source">
                <SelectValue
                  placeholder={t("floor.dialogs.sourcePlaceholder")}
                />
              </SelectTrigger>
              <SelectContent>
                {sources.map((entry) => (
                  <SelectItem key={entry.session.id} value={entry.session.id}>
                    {entry.row.table.code} ·{" "}
                    {t("floor.pax", { count: entry.session.pax })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <DialogError error={merge.error} />
        <DialogFooter>
          <Button
            type="button"
            loading={merge.isPending}
            disabled={!sourceId}
            onClick={() =>
              merge.mutate(
                {
                  sessionId: session.id,
                  sourceSessionId: sourceId as TableSessionId,
                },
                {
                  onSuccess: () => {
                    toast({ title: t("floor.toast.tablesMerged") });
                    onOpenChange(false);
                    onDone();
                  },
                },
              )
            }
          >
            {t("floor.dialogs.mergeSubmit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- Move items ----------------------------------------------------------

export function MoveItemsDialog({
  row,
  board,
  open,
  onOpenChange,
  onDone,
}: Omit<Common, "zones">) {
  const t = useT();
  const toast = useToast();
  const session = row.session;
  const bill = useSessionBill(open ? session?.id : undefined);
  const move = useMoveItems();
  const [selected, setSelected] = React.useState<OrderItemId[]>([]);
  const [targetId, setTargetId] = React.useState("");
  if (!session) return null;
  const items =
    bill.data?.orders
      .filter((order) => order.status !== "voided")
      .flatMap((order) =>
        order.items
          .filter((item) => item.status !== "voided")
          .map((item) => ({ item, order })),
      ) ?? [];
  const activeItemIds = new Set(items.map(({ item }) => item.id));
  const selectedItemIds = selected.filter((id) => activeItemIds.has(id));
  const targets = otherSessionRows(board.tables, session.id);
  const toggle = (itemId: OrderItemId, checked: boolean) =>
    setSelected((current) =>
      checked
        ? [...current, itemId]
        : current.filter((value) => value !== itemId),
    );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("floor.dialogs.moveItemsTitle")}</DialogTitle>
          <DialogDescription>
            {t("floor.dialogs.moveItemsHint")}
          </DialogDescription>
        </DialogHeader>

        {bill.isPending ? (
          <p className="text-sm text-muted-foreground" role="status">
            {t("common.loading")}
          </p>
        ) : bill.error ? (
          <p role="alert" className="text-sm font-semibold text-danger">
            {t("floor.error.generic")}
          </p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("floor.dialogs.noItems")}
          </p>
        ) : (
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-semibold">
              {t("floor.dialogs.itemsLabel")}
            </legend>
            {items.map(({ item, order }) => (
              <label
                key={item.id}
                className="flex min-h-control items-center gap-3 rounded-lg border border-border p-2"
              >
                <Checkbox
                  checked={selected.includes(item.id)}
                  onCheckedChange={(value) => toggle(item.id, value === true)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold">
                    {item.quantity}× {item.name}
                  </span>
                  <span className="block text-sm text-muted-foreground tabular">
                    {order.number}
                  </span>
                </span>
                <Money amount={item.lineTotalIdr} size="sm" />
              </label>
            ))}
          </fieldset>
        )}

        {targets.length > 0 && (
          <div className="grid gap-2">
            <Label htmlFor="move-items-target">
              {t("floor.dialogs.targetTable")}
            </Label>
            <Select value={targetId} onValueChange={setTargetId}>
              <SelectTrigger id="move-items-target">
                <SelectValue
                  placeholder={t("floor.dialogs.targetPlaceholder")}
                />
              </SelectTrigger>
              <SelectContent>
                {targets.map((entry) => (
                  <SelectItem key={entry.session.id} value={entry.session.id}>
                    {entry.row.table.code} ·{" "}
                    {t("floor.pax", { count: entry.session.pax })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <DialogError error={move.error} />
        <DialogFooter>
          <Button
            type="button"
            loading={move.isPending}
            disabled={selectedItemIds.length === 0 || !targetId}
            onClick={() =>
              move.mutate(
                {
                  sessionId: session.id,
                  toSessionId: targetId as TableSessionId,
                  orderItemIds: selectedItemIds,
                },
                {
                  onSuccess: (result) => {
                    toast({
                      title: t("floor.toast.itemsMoved", {
                        count: result.movedItemCount,
                      }),
                    });
                    onOpenChange(false);
                    onDone();
                  },
                },
              )
            }
          >
            {t("floor.dialogs.moveSubmit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- Split bill ----------------------------------------------------------

export function SplitBillDialog({
  row,
  open,
  onOpenChange,
  onDone,
}: Omit<Common, "board" | "zones">) {
  const t = useT();
  const toast = useToast();
  const split = useSplitBill();
  const session = row.session;
  const [parts, setParts] = React.useState("2");
  if (!session) return null;
  const count = Number.parseInt(parts, 10);
  const valid = Number.isInteger(count) && count >= 2 && count <= 50;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("floor.dialogs.splitTitle")}</DialogTitle>
          <DialogDescription>{t("floor.dialogs.splitHint")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="split-parts">{t("floor.dialogs.parts")}</Label>
          <Input
            id="split-parts"
            type="number"
            inputMode="numeric"
            min={2}
            max={50}
            value={parts}
            aria-invalid={!valid}
            onChange={(event) => setParts(event.target.value)}
            className="max-w-32 tabular"
          />
        </div>
        <DialogError error={split.error} />
        <DialogFooter>
          <Button
            type="button"
            loading={split.isPending}
            disabled={!valid}
            onClick={() =>
              split.mutate(
                { sessionId: session.id, parts: count },
                {
                  onSuccess: () => {
                    toast({
                      title: t("floor.toast.billSplit", { count }),
                    });
                    onOpenChange(false);
                    onDone();
                  },
                },
              )
            }
          >
            {t("floor.dialogs.splitSubmit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- Reserve / release / clean / deactivate ------------------------------

/** Confirmation for the one-click table status actions. */
export function TableStatusDialog({
  row,
  action,
  title,
  hint,
  open,
  onOpenChange,
  onDone,
}: Omit<Common, "board" | "zones"> & {
  action:
    | "reserve"
    | "release_reservation"
    | "mark_available"
    | "deactivate"
    | "activate";
  title: string;
  hint: string;
}) {
  const t = useT();
  const toast = useToast();
  const status = useTableStatus();
  const toastKey = {
    reserve: "floor.toast.tableReserved",
    release_reservation: "floor.toast.reservationReleased",
    mark_available: "floor.toast.tableCleaned",
    deactivate: "floor.toast.tableDeactivated",
    activate: "floor.toast.tableActivated",
  } as const;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{hint}</DialogDescription>
        </DialogHeader>
        <DialogError error={status.error} />
        <DialogFooter>
          <Button
            type="button"
            loading={status.isPending}
            onClick={() =>
              status.mutate(
                { tableId: row.table.id, action },
                {
                  onSuccess: () => {
                    toast({ title: t(toastKey[action]) });
                    onOpenChange(false);
                    onDone();
                  },
                },
              )
            }
          >
            {title}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
