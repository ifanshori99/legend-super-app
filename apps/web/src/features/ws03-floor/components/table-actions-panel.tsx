// The action panel behind a table card: the session summary plus every staff
// operation the contract supports. The ORD-10 guard is shown as a live hint and
// every button leads to a dialog that shows the server's refusal next to the
// action.
import * as React from "react";
import {
  ArrowRightLeft,
  CalendarClock,
  CheckCheck,
  DoorClosed,
  HandCoins,
  Merge,
  MoveRight,
  Power,
  PowerOff,
  QrCode,
  Split,
  ShieldQuestion,
  type LucideIcon,
} from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Money } from "@/components/ui/money";
import { useToast } from "@/components/ui/toast";
import type {
  FloorBoard,
  FloorZone,
  TableLiveStatus,
} from "@starter/shared/qr-order";
import { ConvertOpenBillDialog } from "../../open-bill/components/convert-open-bill-dialog";
import { useIssueTableQr } from "../hooks";
import {
  paymentModeLabel,
  rowActions,
  seatDurationOf,
  tableBoardStatus,
  zoneById,
} from "../lib";
import { BoardStatusBadge } from "./board-status";
import {
  CloseSessionDialog,
  ConfirmSessionDialog,
  MergeTablesDialog,
  MoveItemsDialog,
  MoveSessionDialog,
  SplitBillDialog,
  TableStatusDialog,
} from "./dialogs";

type DialogKind =
  | "confirm"
  | "close"
  | "move"
  | "merge"
  | "items"
  | "split"
  | "reserve"
  | "release"
  | "clean"
  | "deactivate"
  | "activate"
  | "openBill";

function MenuButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="lg"
      className="justify-start"
      onClick={onClick}
    >
      <Icon aria-hidden="true" />
      {label}
    </Button>
  );
}

export function TableActionsPanel({
  row,
  board,
  zones,
  now,
  open,
  canManage,
  onOpenChange,
}: {
  row: TableLiveStatus | null;
  board: FloorBoard;
  zones: readonly FloorZone[];
  now: Date;
  open: boolean;
  canManage: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const toast = useToast();
  const issueQr = useIssueTableQr();
  const [dialog, setDialog] = React.useState<DialogKind | null>(null);
  if (!row) return null;

  const session = row.session;
  const status = tableBoardStatus(row);
  const actions = rowActions(row);
  const zone = zoneById(zones, row.table.zoneId);
  const duration = seatDurationOf(row, now, t);
  const done = () => {
    setDialog(null);
    onOpenChange(false);
  };
  const closeDialog = (next: boolean) => {
    if (!next) setDialog(null);
  };
  const openedAt = session
    ? new Intl.DateTimeFormat("id-ID", {
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(session.openedAt))
    : null;

  return (
    <>
      <Dialog
        open={open && dialog === null}
        onOpenChange={(next) => {
          if (!next) setDialog(null);
          onOpenChange(next);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("floor.actions.title", { code: row.table.code })}
            </DialogTitle>
            <DialogDescription>
              {t("floor.actions.description", {
                zone: zone?.name ?? t("terms.zone"),
                capacity: row.table.capacity,
              })}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-wrap items-center gap-2">
            <BoardStatusBadge status={status} className="text-sm" />
            {session && (
              <span className="text-sm text-muted-foreground">
                {paymentModeLabel(session.paymentMode, t)}
              </span>
            )}
            {row.openServiceRequestCount > 0 && (
              <span className="text-sm font-semibold text-danger">
                {t("floor.waiterCalls", {
                  count: row.openServiceRequestCount,
                })}
              </span>
            )}
          </div>

          {session ? (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-border bg-muted/40 p-3">
              <div className="min-w-0">
                <dt className="text-sm text-muted-foreground">
                  {t("floor.session.pax")}
                </dt>
                <dd className="font-semibold tabular">{session.pax}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-sm text-muted-foreground">
                  {t("floor.session.duration")}
                </dt>
                <dd className="font-semibold tabular">{duration ?? "—"}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-sm text-muted-foreground">
                  {t("floor.session.bill")}
                </dt>
                <dd>
                  <Money amount={session.billTotalIdr} size="sm" />
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-sm text-muted-foreground">
                  {t("floor.session.outstanding")}
                </dt>
                <dd>
                  <Money
                    amount={row.outstandingIdr}
                    size="sm"
                    className={
                      row.outstandingIdr > 0 ? "text-danger" : "text-success"
                    }
                  />
                </dd>
              </div>
              {openedAt && (
                <div className="col-span-2 min-w-0 text-sm text-muted-foreground">
                  {t("floor.session.opened", { time: openedAt })}
                </div>
              )}
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("floor.actions.noSession")}
            </p>
          )}

          {status === "awaiting_confirmation" && (
            <p className="flex items-start gap-2 rounded-lg bg-warning-subtle p-3 text-sm text-foreground">
              <ShieldQuestion
                className="mt-0.5 size-4 shrink-0"
                aria-hidden="true"
              />
              {t("floor.actions.openBillGuard")}
            </p>
          )}

          {/* Outside the manage gate: the supervisor on duty may not hold
              floor.table.manage; the server checks the PIN. */}
          {actions.convertOpenBill && (
            <MenuButton
              icon={HandCoins}
              label={t("openBillConvert.action")}
              onClick={() => setDialog("openBill")}
            />
          )}

          {!canManage ? (
            <p className="text-sm text-muted-foreground">
              {t("floor.actions.readOnly")}
            </p>
          ) : (
            <div className="grid gap-3">
              <div className="grid gap-2">
                {actions.confirmSession && (
                  <Button
                    type="button"
                    size="lg"
                    onClick={() => setDialog("confirm")}
                  >
                    <CheckCheck aria-hidden="true" />
                    {t("floor.actions.confirmSession")}
                  </Button>
                )}
                {actions.closeSession && (
                  <Button
                    type="button"
                    size="lg"
                    onClick={() => setDialog("close")}
                  >
                    <DoorClosed aria-hidden="true" />
                    {t("floor.actions.closeTable")}
                  </Button>
                )}
                {actions.markClean && (
                  <Button
                    type="button"
                    size="lg"
                    onClick={() => setDialog("clean")}
                  >
                    <CheckCheck aria-hidden="true" />
                    {t("floor.actions.markClean")}
                  </Button>
                )}
                {actions.activate && (
                  <Button
                    type="button"
                    size="lg"
                    onClick={() => setDialog("activate")}
                  >
                    <Power aria-hidden="true" />
                    {t("floor.actions.activate")}
                  </Button>
                )}
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                {actions.moveSession && (
                  <MenuButton
                    icon={MoveRight}
                    label={t("floor.actions.moveSession")}
                    onClick={() => setDialog("move")}
                  />
                )}
                {actions.mergeTables && (
                  <MenuButton
                    icon={Merge}
                    label={t("floor.actions.mergeTables")}
                    onClick={() => setDialog("merge")}
                  />
                )}
                {actions.moveItems && (
                  <MenuButton
                    icon={ArrowRightLeft}
                    label={t("floor.actions.moveItems")}
                    onClick={() => setDialog("items")}
                  />
                )}
                {actions.splitBill && (
                  <MenuButton
                    icon={Split}
                    label={t("floor.actions.splitBill")}
                    onClick={() => setDialog("split")}
                  />
                )}
                {actions.reserve && (
                  <MenuButton
                    icon={CalendarClock}
                    label={t("floor.actions.reserve")}
                    onClick={() => setDialog("reserve")}
                  />
                )}
                {actions.releaseReservation && (
                  <MenuButton
                    icon={CalendarClock}
                    label={t("floor.actions.releaseReservation")}
                    onClick={() => setDialog("release")}
                  />
                )}
                <MenuButton
                  icon={QrCode}
                  label={t("floor.actions.reprintQr")}
                  onClick={() =>
                    issueQr.mutate(row.table.id, {
                      onSuccess: () =>
                        toast({ title: t("floor.toast.qrIssued") }),
                    })
                  }
                />
                {actions.deactivate && (
                  <MenuButton
                    icon={PowerOff}
                    label={t("floor.actions.deactivate")}
                    onClick={() => setDialog("deactivate")}
                  />
                )}
              </div>
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              onClick={() => onOpenChange(false)}
            >
              {t("common.close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Mounted only while open: each dialog starts from its defaults. */}
      {dialog === "confirm" && (
        <ConfirmSessionDialog
          row={row}
          open
          onOpenChange={closeDialog}
          onDone={done}
        />
      )}
      {dialog === "close" && (
        <CloseSessionDialog
          row={row}
          open
          onOpenChange={closeDialog}
          onDone={done}
        />
      )}
      {dialog === "move" && (
        <MoveSessionDialog
          row={row}
          board={board}
          zones={zones}
          open
          onOpenChange={closeDialog}
          onDone={done}
        />
      )}
      {dialog === "merge" && (
        <MergeTablesDialog
          row={row}
          board={board}
          open
          onOpenChange={closeDialog}
          onDone={done}
        />
      )}
      {dialog === "items" && (
        <MoveItemsDialog
          row={row}
          board={board}
          open
          onOpenChange={closeDialog}
          onDone={done}
        />
      )}
      {dialog === "split" && (
        <SplitBillDialog
          row={row}
          open
          onOpenChange={closeDialog}
          onDone={done}
        />
      )}
      {dialog === "reserve" && (
        <TableStatusDialog
          row={row}
          action="reserve"
          title={t("floor.actions.reserve")}
          hint={t("floor.dialogs.reserveHint")}
          open
          onOpenChange={closeDialog}
          onDone={done}
        />
      )}
      {dialog === "release" && (
        <TableStatusDialog
          row={row}
          action="release_reservation"
          title={t("floor.actions.releaseReservation")}
          hint={t("floor.dialogs.releaseHint")}
          open
          onOpenChange={closeDialog}
          onDone={done}
        />
      )}
      {dialog === "clean" && (
        <TableStatusDialog
          row={row}
          action="mark_available"
          title={t("floor.actions.markClean")}
          hint={t("floor.dialogs.cleanHint")}
          open
          onOpenChange={closeDialog}
          onDone={done}
        />
      )}
      {dialog === "activate" && (
        <TableStatusDialog
          row={row}
          action="activate"
          title={t("floor.actions.activate")}
          hint={t("floor.dialogs.activateHint")}
          open
          onOpenChange={closeDialog}
          onDone={done}
        />
      )}
      {dialog === "openBill" && (
        <ConvertOpenBillDialog
          row={row}
          outletId={board.outletId}
          open
          onOpenChange={closeDialog}
          onDone={done}
        />
      )}
      {dialog === "deactivate" && (
        <TableStatusDialog
          row={row}
          action="deactivate"
          title={t("floor.dialogs.deactivateTitle", { code: row.table.code })}
          hint={t("floor.dialogs.deactivateHint")}
          open
          onOpenChange={closeDialog}
          onDone={done}
        />
      )}
    </>
  );
}
