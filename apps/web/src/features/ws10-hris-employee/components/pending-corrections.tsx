// "Pengajuan berjalan" on the Beranda (PRD §3 Kelompok D 33 Beranda,
// F25 "Koreksi Absensi"): the corrections this employee is still waiting on.
// Queued offline corrections show first: waiting ones as a pill, ones the
// server refused with its reason and Coba lagi / Ubah / Buang (legend-nvc7).
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Inbox } from "lucide-react";
import { useT } from "@/components/i18n";
import { StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  useDiscardCorrection,
  useMyEmployeeId,
  usePendingCorrections,
  useQueuedCorrections,
  useRetryCorrection,
} from "../hooks.ts";
import { canActOnQueued } from "../identity.ts";
import type { QueuedCorrection } from "../queue.ts";
import {
  correctionStatusKey,
  correctionStatusTone,
  formatTime,
  typeLabelKey,
} from "../state.ts";
import {
  InlineEmpty,
  SectionError,
  SectionSkeleton,
} from "./section-states.tsx";
import { CorrectionDialog } from "./correction-dialog.tsx";

function QueuedRow({
  row,
  timeZone,
  busy,
  retrying,
  onRetry,
  onEdit,
  onDiscard,
}: {
  row: QueuedCorrection;
  timeZone: string;
  /** Another retry is in flight: this row's actions wait their turn. */
  busy: boolean;
  retrying: boolean;
  onRetry: () => void;
  onEdit: () => void;
  onDiscard: () => void;
}) {
  const t = useT();
  const detailId = `queued-correction-${row.key}`;
  const refused = row.refused;

  return (
    <li className="grid gap-2 py-3">
      <div className="flex items-start justify-between gap-3">
        <div id={detailId} className="grid min-w-0 gap-0.5">
          <p className="font-medium tabular">
            {t("hris.history.requestedType", {
              type: t(typeLabelKey(row.body.requestedType)),
              time: formatTime(row.body.requestedOccurredAt, timeZone),
            })}
          </p>
          <p className="line-clamp-2 text-sm leading-5 text-muted-foreground">
            {row.body.reason}
          </p>
          {refused !== undefined && (
            <p className="text-sm leading-5 font-medium text-danger">
              {refused.reason.trim() === ""
                ? t("hris.correction.refusedNoReason")
                : t("hris.correction.refusedReason", {
                    reason: refused.reason,
                  })}
            </p>
          )}
        </div>
        {refused !== undefined ? (
          <StatusPill status="danger">
            {t("hris.correction.refused")}
          </StatusPill>
        ) : (
          <StatusPill status="info">
            {t("hris.correction.queuedTitle")}
          </StatusPill>
        )}
      </div>
      {refused !== undefined && (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            loading={retrying}
            disabled={busy}
            aria-describedby={detailId}
            onClick={onRetry}
          >
            {t("hris.correction.retry")}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            aria-describedby={detailId}
            onClick={onEdit}
          >
            {t("hris.correction.edit")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            aria-describedby={detailId}
            onClick={onDiscard}
          >
            {t("hris.correction.discard")}
          </Button>
        </div>
      )}
    </li>
  );
}

export function PendingCorrections({ timeZone }: { timeZone: string }) {
  const t = useT();
  const pending = usePendingCorrections();
  const queued = useQueuedCorrections();
  const retry = useRetryCorrection();
  const discard = useDiscardCorrection();
  // The row being edited stays set while the dialog closes, so its title does
  // not flip back to the new-request wording mid-animation.
  const [editing, setEditing] = useState<QueuedCorrection | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const employeeId = useMyEmployeeId();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-brand type-title">
          {t("hris.home.ongoingTitle")}
        </CardTitle>
        <CardDescription>{t("hris.home.ongoingHint")}</CardDescription>
      </CardHeader>
      {queued.length > 0 && (
        <ul className="divide-y divide-border">
          {queued.map((row) => (
            <QueuedRow
              key={row.key}
              row={row}
              timeZone={timeZone}
              busy={retry.isPending}
              retrying={retry.isPending && retry.variables?.key === row.key}
              onRetry={() => retry.mutate(row)}
              onEdit={() => {
                setEditing(row);
                setEditOpen(true);
              }}
              onDiscard={() => discard.mutate(row)}
            />
          ))}
        </ul>
      )}
      {pending.isPending ? (
        <SectionSkeleton rows={1} />
      ) : pending.isError ? (
        <SectionError
          title={t("hris.state.correctionsError")}
          description={t("hris.state.retryHint")}
          onRetry={() => void pending.refetch()}
        />
      ) : pending.data.data.length === 0 ? (
        queued.length === 0 && (
          <InlineEmpty icon={Inbox} title={t("hris.home.ongoingEmpty")} />
        )
      ) : (
        <ul className="divide-y divide-border">
          {pending.data.data.map((correction) => (
            <li
              key={correction.id}
              className="flex items-start justify-between gap-3 py-3"
            >
              <div className="grid min-w-0 gap-0.5">
                <p className="font-medium tabular">
                  {t("hris.history.requestedType", {
                    type: t(typeLabelKey(correction.requestedType)),
                    time: formatTime(correction.requestedOccurredAt, timeZone),
                  })}
                </p>
                <p className="line-clamp-2 text-sm leading-5 text-muted-foreground">
                  {correction.reason}
                </p>
              </div>
              <StatusPill status={correctionStatusTone(correction.status)}>
                {t(correctionStatusKey(correction.status))}
              </StatusPill>
            </li>
          ))}
        </ul>
      )}
      <Button asChild variant="ghost" className="w-full">
        <Link to="/karyawan/absensi/riwayat" search={{ tab: "corrections" }}>
          {t("hris.home.seeAll")}
        </Link>
      </Button>
      {editing !== null && canActOnQueued(editing, employeeId) && (
        <CorrectionDialog
          open={editOpen}
          onOpenChange={setEditOpen}
          log={null}
          outletId={editing.body.outletId}
          timeZone={timeZone}
          editing={editing}
        />
      )}
    </Card>
  );
}
