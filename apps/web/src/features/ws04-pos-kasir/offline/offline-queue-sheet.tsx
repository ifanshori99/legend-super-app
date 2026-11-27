// O4 queue of offline sales on this tablet (bead legend-wasr7.8, mockup
// design/mockups/pos/offline "antrean"; Keputusan CTO O4 no. 3: a sheet on the
// cashier screen, so it opens offline without loading another page). Waiting
// sales, sales set aside after OFFLINE_EVENT_CONFLICT with their conflict
// report, the drawer cash still on the tablet, and "Coba kirim sekarang".
// Nothing here deletes a sale by itself. 1273 P2-1: a sale the cloud refuses
// for good gets "Laporkan ke kantor" (supervisor PIN); the queue drops it only
// once the cloud holds it.
import { useEffect, useRef, useState } from "react";
import { Ban, CircleAlert, Clock } from "lucide-react";
import type {
  OfflineSaleEvent,
  OfflineStuckReason,
  PosOfflineKit,
} from "@starter/shared/pos";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Money } from "@/components/ui/money";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useOutletClock } from "@/lib/tenant-context";
import {
  Notice,
  StatusPill,
} from "@/features/ws04-pos-kasir/components/shared";
import { formatShiftTime } from "../components/shift/shift-format";
import type { OfflineQueue, OfflineStuckSale } from "./queue";
import { cashOf, offlineReceiptNumber } from "./sale-view";
import { StuckReportDialog, stuckReasonKey } from "./stuck-report-dialog";

export type OfflineQueueRows = {
  waiting: OfflineSaleEvent[];
  parked: OfflineSaleEvent[];
  /** 1273 P2-1: waiting sales the cloud refuses for good, by eventId. */
  stuck?: ReadonlyMap<string, OfflineStuckReason>;
};

type SheetQueue = Pick<OfflineQueue, "pending" | "parked"> &
  Partial<Pick<OfflineQueue, "stuck" | "reportStuck">>;

async function readRows(queue: SheetQueue): Promise<OfflineQueueRows> {
  const [waiting, parked, stuck] = await Promise.all([
    queue.pending(),
    queue.parked().then((list) => list.map((row) => row.event)),
    queue.stuck ? queue.stuck() : Promise.resolve([]),
  ]);
  return {
    waiting,
    parked,
    stuck: new Map(stuck.map((row) => [row.event.eventId, row.stuck])),
  };
}

export function OfflineQueueSheet({
  open,
  onOpenChange,
  queue,
  kit,
  online,
  syncNow,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  queue: SheetQueue | null;
  kit: Pick<PosOfflineKit, "receiptRun"> | null;
  online: boolean;
  syncNow: () => Promise<boolean>;
}) {
  const t = useT();
  const [rows, setRows] = useState<OfflineQueueRows | null>(null);
  const [reporting, setReporting] = useState<OfflineStuckSale | null>(null);
  /** Announced after a stuck sale was reported (it left the list). */
  const [reported, setReported] = useState<string | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [failed, setFailed] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncFailed, setSyncFailed] = useState(false);

  useEffect(() => {
    if (!open || !queue) return;
    let alive = true;
    readRows(queue).then(
      (next) => {
        if (!alive) return;
        setRows(next);
        setFailed(false);
      },
      () => alive && setFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [open, queue]);

  async function send() {
    setSyncing(true);
    const ok = await syncNow();
    setSyncFailed(!ok);
    if (queue) await readRows(queue).then(setRows, () => setFailed(true));
    setSyncing(false);
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (next) setSyncFailed(false);
        setReported(null);
        onOpenChange(next);
      }}
    >
      <SheetContent
        side="right"
        className="w-[min(44rem,100%)] max-[700px]:w-full"
      >
        <SheetHeader>
          <SheetTitle ref={titleRef} tabIndex={-1}>
            {t("posKasirOffline.queue.title")}
          </SheetTitle>
          <SheetDescription>
            {t("posKasirOffline.queue.description")}
          </SheetDescription>
        </SheetHeader>
        <p role="status" className="sr-only">
          {reported ?? ""}
        </p>
        <OfflineQueueBody
          rows={rows}
          failed={failed}
          kit={kit}
          online={online}
          syncing={syncing}
          syncFailed={syncFailed}
          onSync={() => void send()}
          onReport={
            queue?.reportStuck && online
              ? (event, stuck) => setReporting({ event, stuck })
              : undefined
          }
          t={t}
        />
        {queue?.reportStuck && (
          <StuckReportDialog
            sale={reporting}
            receiptNumber={
              reporting
                ? offlineReceiptNumber(kit, reporting.event.sequenceNumber)
                : ""
            }
            queue={{ reportStuck: queue.reportStuck }}
            onOpenChange={(next) => {
              if (!next) setReporting(null);
            }}
            onReported={() => {
              const receipt = reporting
                ? offlineReceiptNumber(kit, reporting.event.sequenceNumber)
                : "";
              setReporting(null);
              setReported(t("posKasirOffline.stuck.reported", { receipt }));
              void readRows(queue).then(
                (next) => {
                  setRows(next);
                  // Its row and button are gone: focus lands on the title,
                  // not on the page behind the sheet.
                  requestAnimationFrame(() => titleRef.current?.focus());
                },
                () => setFailed(true),
              );
            }}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

/** The sheet's content, apart so tests render it without a portal. */
export function OfflineQueueBody({
  rows,
  failed,
  kit,
  online,
  syncing,
  syncFailed,
  onSync,
  onReport,
  t,
}: {
  rows: OfflineQueueRows | null;
  failed: boolean;
  kit: Pick<PosOfflineKit, "receiptRun"> | null;
  online: boolean;
  syncing: boolean;
  syncFailed: boolean;
  onSync: () => void;
  /** 1273 P2-1: "Laporkan ke kantor"; absent while offline. */
  onReport?: (event: OfflineSaleEvent, stuck: OfflineStuckReason) => void;
  t: ReturnType<typeof useT>;
}) {
  if (failed)
    return (
      <Notice tone="danger" title={t("posKasirOffline.queue.loadError")} />
    );
  if (!rows)
    return (
      <div aria-busy="true" className="grid gap-2">
        <span className="sr-only" role="status">
          {t("posKasirOffline.queue.loading")}
        </span>
        <Skeleton className="h-24 rounded-container" />
        <Skeleton className="h-40 rounded-container" />
      </div>
    );
  const all = [...rows.parked, ...rows.waiting];
  if (all.length === 0)
    return (
      <div className="grid gap-1 py-6 text-center">
        <p className="text-lg font-semibold">
          {t("posKasirOffline.queue.emptyTitle")}
        </p>
        <p className="text-muted-foreground">
          {t("posKasirOffline.queue.emptyBody")}
        </p>
      </div>
    );
  const sum = (events: OfflineSaleEvent[]) =>
    events.reduce((total, event) => total + event.totalIdr, 0);
  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-2 min-[701px]:grid-cols-3">
        <Tile
          label={t("posKasirOffline.queue.waiting")}
          count={rows.waiting.length}
          amount={sum(rows.waiting)}
        />
        <Tile
          label={t("posKasirOffline.queue.parked")}
          count={rows.parked.length}
          amount={sum(rows.parked)}
          danger={rows.parked.length > 0}
        />
        <div className="col-span-2 rounded-container border-(length:--border-w) border-border bg-card p-3 min-[701px]:col-span-1">
          <p className="text-sm text-muted-foreground">
            {t("posKasirOffline.queue.cash")}
          </p>
          <Money amount={cashOf(all)} size="lg" className="font-bold" />
          <p className="text-sm text-muted-foreground">
            {t("posKasirOffline.queue.cashHint")}
          </p>
        </div>
      </div>

      <ul
        aria-label={t("posKasirOffline.queue.listLabel")}
        className="grid rounded-container border-(length:--border-w) border-border bg-card"
      >
        {rows.parked.map((event) => (
          <SaleRow key={event.eventId} event={event} kit={kit} parked t={t} />
        ))}
        {rows.waiting.map((event) => (
          <SaleRow
            key={event.eventId}
            event={event}
            kit={kit}
            stuck={rows.stuck?.get(event.eventId)}
            onReport={onReport}
            t={t}
          />
        ))}
      </ul>

      <div className="grid gap-2">
        {/* Only the status messages are announced, not the button or the note. */}
        <div aria-live="polite" className="grid gap-2 empty:hidden">
          {!online && (
            <p className="text-sm text-muted-foreground">
              {t("posKasirOffline.queue.offlineNote")}
            </p>
          )}
          {syncFailed && (
            <Notice
              tone="warning"
              title={t("posKasirOffline.queue.syncFailed")}
            />
          )}
        </div>
        <Button
          type="button"
          size="lg"
          loading={syncing}
          aria-disabled={!online || syncing ? true : undefined}
          onClick={!online || syncing ? undefined : onSync}
          className="font-bold"
        >
          {t("posKasirOffline.queue.syncNow")}
        </Button>
        <p className="text-sm text-muted-foreground">
          {t("posKasirOffline.queue.foot")}
        </p>
      </div>
    </div>
  );
}

function Tile({
  label,
  count,
  amount,
  danger = false,
}: {
  label: string;
  count: number;
  amount: number;
  danger?: boolean;
}) {
  return (
    <div
      className={
        danger
          ? "rounded-container border-(length:--border-w) border-danger bg-card p-3"
          : "rounded-container border-(length:--border-w) border-border bg-card p-3"
      }
    >
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="text-2xl font-bold tabular">{count}</p>
      <Money amount={amount} className="text-sm text-muted-foreground" />
    </div>
  );
}

function SaleRow({
  event,
  kit,
  parked = false,
  stuck,
  onReport,
  t,
}: {
  event: OfflineSaleEvent;
  kit: Pick<PosOfflineKit, "receiptRun"> | null;
  parked?: boolean;
  stuck?: OfflineStuckReason;
  onReport?: (event: OfflineSaleEvent, stuck: OfflineStuckReason) => void;
  t: ReturnType<typeof useT>;
}) {
  const { timeZone } = useOutletClock();
  const items = event.lines
    .map((line) =>
      line.quantity > 1 ? `${line.name} ×${line.quantity}` : line.name,
    )
    .join(", ");
  const tender = event.tenders
    .map((row) =>
      row.method === "cash"
        ? t("posKasirOffline.queue.tenderCash")
        : t("posKasirOffline.queue.tenderEdc", { reference: row.reference }),
    )
    .join(" + ");
  return (
    <li
      data-slot="pos-offline-sale"
      data-parked={parked || undefined}
      data-stuck={stuck ?? undefined}
      className="grid gap-1 border-t border-border p-3 first:border-t-0"
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-bold tabular">
          {offlineReceiptNumber(kit, event.sequenceNumber)}
          <span className="ml-2 font-normal text-muted-foreground">
            {formatShiftTime(event.paidAt, timeZone)}
          </span>
        </span>
        <Money amount={event.totalIdr} className="font-bold" />
      </div>
      <p className="text-sm text-muted-foreground">
        {items} · {tender}
      </p>
      <div>
        {parked ? (
          <StatusPill tone="danger" icon={CircleAlert}>
            {t("posKasirOffline.queue.statusParked")}
          </StatusPill>
        ) : stuck ? (
          <StatusPill tone="danger" icon={Ban}>
            {t("posKasirOffline.stuck.status")}
          </StatusPill>
        ) : (
          <StatusPill tone="warning" icon={Clock}>
            {t("posKasirOffline.queue.statusWaiting")}
          </StatusPill>
        )}
      </div>
      {parked && (
        <Notice tone="danger" title={t("posKasirOffline.queue.parkedTitle")}>
          {t("posKasirOffline.queue.parkedBody")}
        </Notice>
      )}
      {stuck && (
        <Notice tone="danger" title={t(stuckReasonKey(stuck))}>
          {t("posKasirOffline.stuck.body")}
        </Notice>
      )}
      {stuck && !onReport && (
        <p className="text-sm text-muted-foreground">
          {t("posKasirOffline.stuck.needsInternet")}
        </p>
      )}
      {stuck && onReport && (
        <Button
          type="button"
          variant="outline"
          className="justify-self-start font-bold"
          onClick={() => onReport(event, stuck)}
        >
          {t("posKasirOffline.stuck.report")}
        </Button>
      )}
    </li>
  );
}
