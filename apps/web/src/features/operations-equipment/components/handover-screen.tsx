// /operasional/serah-terima — shift handover (PRD v1.7 §3 F41 "Serah Terima
// Shift"; OPS-05). A handover stays "menunggu konfirmasi" until the receiving
// shift confirms; "Tutup serah terima" is disabled before that. The contract has
// no close endpoint/state yet, so closing is a session-level archive action
// here (reported follow-up); acknowledgement itself goes through the contract
// machine, which also refuses a self-acknowledgement.
import * as React from "react";
import { ClipboardCheck, WifiOff } from "lucide-react";
import { useT } from "@/components/i18n";
import { ApiError } from "@/lib/api/errors";
import { Badge, StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { NumberDisplay } from "@/components/ui/money";
import { Skeleton } from "@/components/ui/skeleton";
import { StatStrip, StatTile } from "@/components/ui/stat-tile";
import { useToast } from "@/components/ui/toast";
import { useOnline } from "@/lib/use-online";
import { ActionRow, ActionStrip } from "./action-strip.tsx";
import { HandoverFormDialog } from "./handover-form-dialog.tsx";
import { HandoverStatusPill } from "./pills.tsx";
import { useAcknowledgeHandover, useHandovers, useOutlets } from "../hooks.ts";
import { EQUIPMENT_FALLBACK_OUTLET } from "../outlet.ts";
import {
  HANDOVER_NOTE_KEYS,
  HANDOVER_NOTE_LABEL_KEYS,
  formatDateTime,
} from "../lib.ts";
import { shiftTemplateOptions } from "../shift-templates.ts";
import type { ShiftHandover } from "@starter/shared/operations";

function HandoverCard({
  handover,
  fromName,
  toName,
  timeZone,
  closed,
  onCloseRequest,
}: {
  handover: ShiftHandover;
  fromName: string;
  toName: string;
  timeZone: string;
  closed: boolean;
  onCloseRequest: (handover: ShiftHandover) => void;
}) {
  const t = useT();
  const toast = useToast();
  const acknowledge = useAcknowledgeHandover();
  const [error, setError] = React.useState<string | null>(null);
  const hintId = `handover-close-hint-${handover.id}`;

  async function confirm() {
    setError(null);
    try {
      await acknowledge.mutateAsync({ handoverId: handover.id });
      toast({
        title: t("opsEquipment.handover.toasts.acknowledged"),
        tone: "success",
      });
    } catch (cause) {
      if (
        cause instanceof ApiError &&
        cause.code === "HANDOVER_SELF_ACKNOWLEDGEMENT"
      )
        setError(t("opsEquipment.handover.ackErrorSelf"));
      else if (
        cause instanceof ApiError &&
        cause.code === "HANDOVER_ALREADY_ACKNOWLEDGED"
      )
        setError(t("opsEquipment.handover.ackErrorAlready"));
      else setError(t("opsEquipment.handover.actionError"));
    }
  }

  return (
    <Card
      data-slot="handover-card"
      data-handover-id={handover.id}
      data-status={handover.status}
      data-closed={closed || undefined}
      className="gap-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid min-w-0 gap-1">
          <h3 className="type-title">
            {t("opsEquipment.handover.shiftPair", {
              from: fromName,
              to: toName,
            })}
          </h3>
          <p className="text-sm text-muted-foreground">
            {t("opsEquipment.handover.submittedAt", {
              date: formatDateTime(handover.submittedAt, timeZone),
            })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <HandoverStatusPill status={handover.status} />
          {closed && (
            <Badge tone="neutral">{t("opsEquipment.handover.closed")}</Badge>
          )}
        </div>
      </div>

      <dl className="grid gap-2 sm:grid-cols-2">
        {HANDOVER_NOTE_KEYS.map((key) => {
          const value = handover.notes[key];
          if (value === null) return null;
          return (
            <div key={key} className="grid gap-0.5" data-slot="handover-note">
              <dt className="type-eyebrow text-muted-foreground">
                {t(HANDOVER_NOTE_LABEL_KEYS[key])}
              </dt>
              <dd className="text-sm leading-5">{value}</dd>
            </div>
          );
        })}
      </dl>

      {handover.acknowledgedAt && (
        <p className="text-sm text-muted-foreground">
          {t("opsEquipment.handover.acknowledgedAt", {
            date: formatDateTime(handover.acknowledgedAt, timeZone),
          })}
        </p>
      )}

      {!closed && handover.status === "submitted" && (
        <div className="grid gap-2 border-t border-border pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              loading={acknowledge.isPending}
              onClick={() => void confirm()}
            >
              {t("opsEquipment.handover.confirm")}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled
              aria-describedby={hintId}
            >
              {t("opsEquipment.handover.close")}
            </Button>
          </div>
          <p id={hintId} className="text-sm leading-5 text-muted-foreground">
            {t("opsEquipment.handover.closeBlocked")}
          </p>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("opsEquipment.handover.confirmHint")}
          </p>
        </div>
      )}

      {!closed && handover.status === "acknowledged" && (
        <div className="border-t border-border pt-3">
          <Button
            type="button"
            variant="outline"
            onClick={() => onCloseRequest(handover)}
          >
            {t("opsEquipment.handover.close")}
          </Button>
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      )}
    </Card>
  );
}

export function HandoverScreen() {
  const t = useT();
  const toast = useToast();
  const online = useOnline();
  const outlets = useOutlets();
  // An outlet-less fixture run (mock-empty) must still show the honest empty
  // handover list: the query reads the documented fixture outlet instead of
  // failing the whole page.
  const outlet =
    outlets.data?.data.find((row) => row.status === "active") ??
    outlets.data?.data[0] ??
    EQUIPMENT_FALLBACK_OUTLET;
  const handovers = useHandovers(outlet.id);
  const [closedIds, setClosedIds] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [closeTarget, setCloseTarget] = React.useState<ShiftHandover | null>(
    null,
  );

  const timeZone = outlet?.timeZone ?? "Asia/Jakarta";
  // Stable so the create dialog's reset effect does not re-run every render.
  const shifts = React.useMemo(
    () => shiftTemplateOptions(outlet?.id),
    [outlet?.id],
  );
  const shiftName = (id: string) =>
    shifts?.find((shift) => shift.id === id)?.name ?? id;

  const loading =
    outlets.isPending || (outlet !== undefined && handovers.isPending);
  const failed = outlets.isError || handovers.isError;

  const rows = (handovers.data?.data ?? [])
    .slice()
    .sort(
      (left, right) =>
        Date.parse(right.submittedAt) - Date.parse(left.submittedAt),
    );
  const pending = rows.filter((row) => row.status === "submitted");
  const acknowledged = rows.filter((row) => row.status === "acknowledged");

  const heading = (
    <header className="grid gap-1">
      <h1 className="type-display">{t("opsEquipment.handover.pageTitle")}</h1>
      <p className="text-sm leading-5 text-muted-foreground">
        {t("opsEquipment.handover.pageHint")}
      </p>
      {outlet && (
        <p className="text-sm font-semibold">
          {t("opsEquipment.equipment.statsContext", { name: outlet.name })}
        </p>
      )}
    </header>
  );

  if (loading)
    return (
      <div
        className="mx-auto grid w-full max-w-5xl grid-cols-[minmax(0,1fr)] gap-4"
        aria-busy="true"
      >
        <span className="sr-only" role="status">
          {t("common.loading")}
        </span>
        {heading}
        <Skeleton className="h-32 w-full rounded-shell" />
        <Skeleton className="h-24 w-full rounded-shell" />
        <Skeleton className="h-48 w-full rounded-shell" />
        <Skeleton className="h-48 w-full rounded-shell" />
      </div>
    );

  if (failed)
    return (
      <div className="mx-auto grid w-full max-w-5xl grid-cols-[minmax(0,1fr)] gap-4">
        {heading}
        <ErrorState
          title={t("state.errorTitle")}
          description={t("state.errorHint")}
          onRetry={() => {
            void outlets.refetch();
            void handovers.refetch();
          }}
        />
      </div>
    );

  function confirmClose() {
    if (!closeTarget) return;
    setClosedIds((current) => new Set(current).add(closeTarget.id));
    setCloseTarget(null);
    toast({ title: t("opsEquipment.handover.closeToast"), tone: "success" });
  }

  return (
    <div className="mx-auto grid w-full max-w-5xl grid-cols-[minmax(0,1fr)] gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        {heading}
        <HandoverFormDialog
          outletId={outlet.id}
          shiftOptions={shifts}
          trigger={
            <Button type="button">
              <ClipboardCheck aria-hidden="true" />
              {t("opsEquipment.handover.newHandover")}
            </Button>
          }
        />
      </div>

      {!online && (
        <div className="flex items-start gap-2 rounded-lg bg-warning-subtle p-3 text-sm text-foreground">
          <WifiOff className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>
            <span className="font-semibold">
              {t("opsEquipment.offline.title")}
            </span>{" "}
            {t("opsEquipment.offline.hint")}
          </span>
        </div>
      )}

      <ActionStrip label={t("opsEquipment.handover.actionsLabel")}>
        {pending.length > 0 ? (
          <ActionRow
            title={t("opsEquipment.handover.pendingTitle")}
            hint={t("opsEquipment.handover.pendingHint")}
            pill={
              <StatusPill status="warning" solid>
                {pending.length}
              </StatusPill>
            }
          >
            <ul className="grid gap-1">
              {pending.map((handover) => (
                <li key={handover.id} className="text-sm font-semibold">
                  {t("opsEquipment.handover.pendingItem", {
                    from: shiftName(handover.fromShiftTemplateId),
                    to: shiftName(handover.toShiftTemplateId),
                    date: formatDateTime(handover.submittedAt, timeZone),
                  })}
                </li>
              ))}
            </ul>
          </ActionRow>
        ) : (
          <ActionRow
            title={t("opsEquipment.handover.clearTitle")}
            hint={t("opsEquipment.handover.clearHint")}
            pill={<StatusPill status="success">0</StatusPill>}
          />
        )}
      </ActionStrip>

      <StatStrip label={t("opsEquipment.handover.summaryLabel")} columns={3}>
        <StatTile
          label={t("opsEquipment.handover.stats.total")}
          value={<NumberDisplay value={rows.length} />}
          context={outlet.name}
        />
        <StatTile
          label={t("opsEquipment.handover.stats.pending")}
          value={<NumberDisplay value={pending.length} />}
          context={t("opsEquipment.handover.pendingHint")}
        />
        <StatTile
          label={t("opsEquipment.handover.stats.acknowledged")}
          value={<NumberDisplay value={acknowledged.length} />}
          context={outlet.name}
        />
      </StatStrip>

      <section
        aria-label={t("opsEquipment.handover.listTitle")}
        className="grid gap-3"
      >
        <div className="grid gap-1">
          <h2 className="type-title">{t("opsEquipment.handover.listTitle")}</h2>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("opsEquipment.handover.listHint")}
          </p>
        </div>
        {rows.length === 0 ? (
          <Card>
            <EmptyState
              icon={ClipboardCheck}
              title={t("opsEquipment.handover.emptyTitle")}
              description={t("opsEquipment.handover.emptyHint")}
            />
          </Card>
        ) : (
          <div className="grid gap-3">
            {rows.map((handover) => (
              <HandoverCard
                key={handover.id}
                handover={handover}
                fromName={shiftName(handover.fromShiftTemplateId)}
                toName={shiftName(handover.toShiftTemplateId)}
                timeZone={timeZone}
                closed={closedIds.has(handover.id)}
                onCloseRequest={setCloseTarget}
              />
            ))}
          </div>
        )}
      </section>

      <Dialog
        open={closeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setCloseTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("opsEquipment.handover.closeTitle")}</DialogTitle>
            <DialogDescription>
              {t("opsEquipment.handover.closeHint")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" onClick={confirmClose}>
              {t("opsEquipment.handover.closeConfirm")}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setCloseTarget(null)}
            >
              {t("common.cancel")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
