// Flagged EDC transactions (bead legend-khi8n): a table on desktop that turns
// into labelled cards below md, so amount, outlet, cashier, status and age
// stay readable at 390px without horizontal scroll. Status is always icon +
// text. A sale that is not yet eligible (terminal still processing, or an
// unknown younger than 10 minutes) stays listed with the reason and when.
import { Check, CircleAlert, CircleX, Clock, Info } from "lucide-react";
import { useT } from "@/components/i18n";
import { StatusPill, type StatusKind } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { DEFAULT_TIME_ZONE } from "@starter/shared/core";
import type { MessageKey } from "@starter/shared/i18n";
import type { EdcReconciliationQueueItem } from "@starter/shared/payment/admin";
import { ageMinutes, displayId, reconciliationGate } from "../lib";

// Fixed outlet zone so the server render and the browser agree (PRD §6).
const clockFormat = new Intl.DateTimeFormat("id-ID", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: DEFAULT_TIME_ZONE,
});

function clock(ms: number): string {
  return clockFormat.format(new Date(ms));
}

const STATUS_KEYS: Record<
  EdcReconciliationQueueItem["transaction"]["status"],
  MessageKey
> = {
  unknown: "edcRecon.queue.status.unknown",
  approved: "edcRecon.queue.status.approved",
  declined: "edcRecon.queue.status.declined",
  pending: "edcRecon.queue.status.pending",
  cancelled: "edcRecon.queue.status.cancelled",
  failed: "edcRecon.queue.status.failed",
};

function statusVisual(
  status: EdcReconciliationQueueItem["transaction"]["status"],
): { kind: StatusKind; icon: typeof Clock } {
  switch (status) {
    case "unknown":
      return { kind: "warning", icon: CircleAlert };
    case "approved":
      return { kind: "success", icon: Check };
    case "declined":
    case "failed":
      return { kind: "danger", icon: CircleX };
    default:
      return { kind: "info", icon: Info };
  }
}

function StatusCell({
  item,
  nowMs,
}: {
  item: EdcReconciliationQueueItem;
  nowMs: number | null;
}) {
  const t = useT();
  const gate = nowMs === null ? null : reconciliationGate(item, nowMs);
  // Before the client clock exists, an unknown sale that may turn out "too
  // early" keeps room for its second line so the card does not grow later.
  const mayBeTooEarly =
    nowMs === null &&
    item.transaction.status === "unknown" &&
    item.transaction.dispatchedAt !== null &&
    item.saleWireOpenAt === null;
  if (gate?.kind === "wire-open") {
    return (
      <StatusPill status="warning" icon={Clock}>
        {t("edcRecon.queue.status.waiting")}
      </StatusPill>
    );
  }
  if (gate?.kind === "too-early") {
    return (
      <div className="grid justify-items-start gap-1">
        <StatusPill status="info" icon={Clock}>
          {t("edcRecon.queue.status.tooEarly")}
        </StatusPill>
        <span className="text-sm text-muted-foreground">
          {t("edcRecon.queue.tooEarlyAt", { time: clock(gate.eligibleAtMs) })}
        </span>
      </div>
    );
  }
  const { kind, icon } = statusVisual(item.transaction.status);
  const pill = (
    <StatusPill status={kind} icon={icon}>
      {t(STATUS_KEYS[item.transaction.status])}
    </StatusPill>
  );
  if (!mayBeTooEarly) return pill;
  return (
    <div className="grid justify-items-start gap-1">
      {pill}
      <span aria-hidden="true" className="invisible text-sm">
        {"\u00a0"}
      </span>
    </div>
  );
}

function AgeText({
  item,
  nowMs,
}: {
  item: EdcReconciliationQueueItem;
  nowMs: number | null;
}) {
  const t = useT();
  if (nowMs === null) return <span aria-hidden="true">–</span>;
  const total = ageMinutes(item, nowMs);
  if (total < 60)
    return <>{t("edcRecon.queue.ageMinutes", { minutes: total })}</>;
  return (
    <>
      {t("edcRecon.queue.ageHours", {
        hours: Math.floor(total / 60),
        minutes: total % 60,
      })}
    </>
  );
}

/**
 * Loading placeholder with the same box model as the cards below md (and a
 * plain row stack from md up), so the list does not jump when data arrives.
 */
export function EdcReconciliationQueueSkeleton({
  cards = 2,
  rows = 4,
}: {
  cards?: number;
  rows?: number;
}) {
  const t = useT();
  const field = (label: MessageKey) => (
    <div className="min-w-0">
      <dt className="text-sm text-muted-foreground">{t(label)}</dt>
      <dd className="font-semibold">
        <Skeleton className="w-20">
          <span className="invisible">{"\u00a0"}</span>
        </Skeleton>
      </dd>
    </div>
  );
  return (
    <>
      <div className="hidden md:block">
        <div className="h-row border-b" />
        {Array.from({ length: rows }, (_, i) => (
          <div
            key={i}
            className="flex h-row items-center border-b px-4 py-2.5 last:border-0"
          >
            <Skeleton className="w-full">
              <span className="invisible">{"\u00a0"}</span>
            </Skeleton>
          </div>
        ))}
      </div>
      <ul className="divide-y divide-border md:hidden">
        {Array.from({ length: cards }, (_, i) => (
          <li key={i} className="grid gap-3 p-card">
            <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
              <div className="min-w-0">
                <div className="font-semibold">
                  <Skeleton className="w-28">
                    <span className="invisible">{"\u00a0"}</span>
                  </Skeleton>
                </div>
                <div className="text-sm">
                  <Skeleton className="mt-0.5 w-24">
                    <span className="invisible">{"\u00a0"}</span>
                  </Skeleton>
                </div>
              </div>
              <Skeleton className="rounded-full">
                <span className="invisible">
                  <StatusPill status="warning" icon={Clock}>
                    {t("edcRecon.queue.status.unknown")}
                  </StatusPill>
                </span>
              </Skeleton>
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
              {field("edcRecon.queue.field.amount")}
              {field("edcRecon.queue.field.cashier")}
              {field("edcRecon.queue.field.time")}
              {field("edcRecon.queue.field.age")}
            </dl>
            <Skeleton className="h-control w-full" />
          </li>
        ))}
      </ul>
    </>
  );
}

export function EdcReconciliationQueueList({
  items,
  nowMs,
  selectedId,
  onSelect,
}: {
  items: readonly EdcReconciliationQueueItem[];
  /** Null until the client mounts, so server and browser render the same. */
  nowMs: number | null;
  selectedId: string | undefined;
  onSelect: (id: string) => void;
}) {
  const t = useT();
  return (
    <>
      <div className="hidden md:block">
        <Table aria-label={t("edcRecon.queue.table.label")}>
          <TableHeader>
            <TableRow>
              <TableHead>{t("edcRecon.queue.table.transaction")}</TableHead>
              <TableHead>{t("edcRecon.queue.table.cashier")}</TableHead>
              <TableHead numeric>{t("edcRecon.queue.table.amount")}</TableHead>
              <TableHead>{t("edcRecon.queue.table.time")}</TableHead>
              <TableHead>{t("edcRecon.queue.table.status")}</TableHead>
              <TableHead>{t("edcRecon.queue.table.age")}</TableHead>
              <TableHead>
                <span className="sr-only">
                  {t("edcRecon.queue.table.action")}
                </span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => {
              const tx = item.transaction;
              const selected = tx.id === selectedId;
              return (
                <TableRow
                  key={tx.id}
                  data-state={selected ? "selected" : undefined}
                >
                  <TableCell>
                    <p className="font-semibold tabular">{displayId(tx)}</p>
                    <p className="text-sm text-muted-foreground">
                      {item.outletName}
                    </p>
                  </TableCell>
                  <TableCell>
                    {item.cashierName ?? t("edcRecon.queue.noCashier")}
                  </TableCell>
                  <TableCell numeric>
                    <Money amount={tx.amountIdr} className="font-semibold" />
                  </TableCell>
                  <TableCell className="tabular">
                    {clock(Date.parse(tx.createdAt))}
                  </TableCell>
                  <TableCell>
                    <StatusCell item={item} nowMs={nowMs} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular">
                    <AgeText item={item} nowMs={nowMs} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-pressed={selected}
                      aria-label={t("edcRecon.queue.inspectFor", {
                        id: displayId(tx),
                      })}
                      onClick={() => onSelect(tx.id)}
                    >
                      {t("edcRecon.queue.inspect")}
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <ul className="divide-y divide-border md:hidden">
        {items.map((item) => {
          const tx = item.transaction;
          return (
            <li key={tx.id} className="grid gap-3 p-card">
              <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
                <div className="min-w-0">
                  <p className="font-semibold tabular">{displayId(tx)}</p>
                  <p className="text-sm text-muted-foreground">
                    {item.outletName}
                  </p>
                </div>
                <StatusCell item={item} nowMs={nowMs} />
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
                <div className="min-w-0">
                  <dt className="text-sm text-muted-foreground">
                    {t("edcRecon.queue.field.amount")}
                  </dt>
                  <dd className="font-semibold">
                    <Money amount={tx.amountIdr} />
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-sm text-muted-foreground">
                    {t("edcRecon.queue.field.cashier")}
                  </dt>
                  <dd className="font-semibold break-words">
                    {item.cashierName ?? t("edcRecon.queue.noCashier")}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-sm text-muted-foreground">
                    {t("edcRecon.queue.field.time")}
                  </dt>
                  <dd className="font-semibold tabular">
                    {clock(Date.parse(tx.createdAt))}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-sm text-muted-foreground">
                    {t("edcRecon.queue.field.age")}
                  </dt>
                  <dd className="font-semibold tabular">
                    <AgeText item={item} nowMs={nowMs} />
                  </dd>
                </div>
              </dl>
              <Button
                type="button"
                variant="outline"
                className="w-full"
                aria-label={t("edcRecon.queue.inspectFor", {
                  id: displayId(tx),
                })}
                onClick={() => onSelect(tx.id)}
              >
                {t("edcRecon.queue.inspectCard")}
              </Button>
            </li>
          );
        })}
      </ul>
    </>
  );
}
