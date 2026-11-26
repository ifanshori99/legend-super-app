import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import type {
  KitchenTicketDetail,
  StationConfig,
} from "@starter/shared/kitchen";
import { canTransitionKitchenTicket } from "@starter/shared/kitchen";
import type { MessageKey } from "@starter/shared/i18n";
import {
  Ban,
  CircleAlert,
  CircleCheck,
  Clock,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { useT } from "@/components/i18n";
import { useOperationsScreen } from "@/components/shells/operations-screen";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBand, type StatusBandTone } from "@/components/ui/status-band";
import { useToast } from "@/components/ui/toast";
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
import { ApiError } from "@/lib/api/errors.ts";
import { useTenantContext } from "@/lib/tenant-context";
import type { AreaAccess } from "@/lib/areas/access";
import { fetchStationSnapshot } from "../api.ts";
import { kdsKeys } from "../queries.ts";
import { useKdsRealtime } from "../use-kds-realtime.ts";
import type { KdsRealtimeStatus } from "../kds-realtime.ts";
import {
  useBoard,
  useKdsActions,
  ticketPrintLoader,
  useKdsHeartbeat,
  useScannerStatus,
  useStationLabels,
  useStationSummary,
  useStations,
} from "../hooks.ts";
import { isOpenTicket, ticketScanCode } from "../scan-code.ts";
import { CloudPrintButton } from "../../ws04-pos-kasir/print/cloud-print-button.tsx";
import { ScannerPanel } from "./scanner-panel.tsx";
import {
  formatElapsedSeconds,
  kdsTimerStatus,
  type KdsTimerStatus,
} from "../timer.ts";

type StationId = StationConfig["stationId"];

// Advance the synthetic service clock from the fixture snapshot.
const mockStartedAt = Date.now();

function subscribeClock(update: () => void) {
  const timer = window.setInterval(update, 1000);
  return () => window.clearInterval(timer);
}
function clockSnapshot() {
  return Math.floor(Date.now() / 1000) * 1000;
}
function serverClockSnapshot() {
  return 0;
}

// The band each timer state gets (DESIGN.md §5 Operations, owner Q26: a late
// ticket is a full red header, near is the warning tint, on track the raised
// neutral). The band is the state, so a board of tickets spends no accent.
const TIMER_BAND = {
  onTrack: { tone: "neutral", icon: Clock, labelKey: "timer.onTrack" },
  near: { tone: "warning", icon: TriangleAlert, labelKey: "timer.near" },
  late: { tone: "danger", icon: CircleAlert, labelKey: "timer.late" },
} as const satisfies Record<
  KdsTimerStatus,
  { tone: StatusBandTone; icon: LucideIcon; labelKey: MessageKey }
>;

/**
 * Keyed by outlet: switching outlet in the shell starts a fresh board, so a
 * selected station of the previous outlet cannot carry over.
 */
export function KdsPage() {
  const { outlet } = useTenantContext();
  return <KdsContent key={outlet?.id ?? "none"} />;
}

function KdsContent() {
  const t = useT();
  useOperationsScreen({ title: t("kds.title") });
  // The outlet the shell selected; null when the session has none, in which
  // case the queries stay off and the empty state shows.
  const { outlet } = useTenantContext();
  const outletId = outlet?.id;
  const { access } = useRouteContext({ strict: false }) as {
    access: AreaAccess;
  };
  const stations = useStations(outletId);
  const names = useStationLabels(outletId);
  const summary = useStationSummary(outletId);
  const [selected, setSelected] = useState<StationId | null>(null);
  // Station authorization (legend-fsb7): a station-scoped account only polls
  // and shows the stations in its reach. The API denies the rest with 403, so
  // asking for them would be a wasted request on every cycle.
  const permitted = new Set<string>(access.stations);
  const active = (stations.data ?? [])
    .filter((station) => station.isActive && permitted.has(station.stationId))
    .sort((a, b) => a.displayOrder - b.displayOrder);
  const stationId =
    selected !== null && permitted.has(selected)
      ? selected
      : active[0]?.stationId;
  const station = names.data?.find((row) => row.stationId === stationId);
  // One lightweight summary supplies every tab count; full board polling is
  // reserved for the selected station.
  const stationName = (id: StationId) =>
    names.data?.find((row) => row.stationId === id)?.name ?? id;
  // No count until the summary is read: undefined renders no chip, never a fake 0.
  const stationCount = (id: StationId) =>
    summary.data?.stations.find((row) => row.stationId === id)?.openTickets;
  const failure = stations.error ?? names.error;
  const offline =
    failure instanceof ApiError && failure.code === "NETWORK_ERROR";
  return (
    <div className="flex w-full flex-col gap-5">
      <header className="flex flex-col gap-1">
        {/* The shell status bar carries the visible screen name. */}
        <h1 className="sr-only">{t("kds.title")}</h1>
        <p className="max-w-prose text-sm leading-5 text-muted-foreground">
          {t("kds.intro")}
        </p>
        {import.meta.env.VITE_API_MOCK === "true" && (
          <p className="text-sm leading-5 text-muted-foreground">
            {t("kds.sample")}
          </p>
        )}
      </header>
      {outletId && (stations.isPending || names.isPending) ? (
        <div aria-busy="true">
          <span className="sr-only">{t("kds.loading")}</span>
          <Skeleton className="h-28 w-full" />
        </div>
      ) : failure ? (
        <ErrorState
          error={failure}
          title={t(offline ? "kds.offlineTitle" : "kds.errorTitle")}
          description={t(offline ? "kds.offlineHint" : "kds.errorHint")}
          onRetry={() => {
            void stations.refetch();
            void names.refetch();
          }}
        />
      ) : (
        <>
          {stationId && outletId ? (
            <>
              {/* Stations are a neutral segmented control: selecting one is a
                  filter, not the screen's one accent action (DESIGN.md §2). */}
              <SegmentedControl
                value={stationId}
                onValueChange={setSelected}
                label={t("kds.stations")}
                selection="ink"
                options={active.map((item) => ({
                  value: item.stationId,
                  label: stationName(item.stationId),
                  count: stationCount(item.stationId),
                }))}
              />
              <StationBoard
                key={stationId}
                outletId={outletId}
                stationId={stationId}
                targetSeconds={station?.targetSeconds ?? null}
              />
            </>
          ) : (
            <EmptyState
              title={t("kds.emptyTitle")}
              description={t("kds.emptyHint")}
            />
          )}
        </>
      )}
    </div>
  );
}

/**
 * Live connection chip of the board. Icon plus text, never color alone; the
 * denied state tells the cashier what to do and offers the manual reconnect.
 */
function RealtimeStatus({
  status,
  onReconnect,
}: {
  status: KdsRealtimeStatus;
  onReconnect: () => void;
}) {
  const t = useT();
  // The live region stays mounted so screen readers announce later changes.
  return (
    <div
      role="status"
      aria-live="polite"
      data-slot="kds-realtime-status"
      className="flex flex-wrap items-center gap-2"
    >
      {status === "stopped" ? null : status === "open" ? (
        <Badge tone="success">
          <CircleCheck aria-hidden="true" />
          {t("kds.realtime.open")}
        </Badge>
      ) : status === "denied" ? (
        <>
          <Badge tone="danger" className="whitespace-normal">
            <CircleAlert aria-hidden="true" />
            {t("kds.realtime.denied")}
          </Badge>
          <Button variant="outline" size="sm" onClick={onReconnect}>
            {t("kds.realtime.reconnect")}
          </Button>
        </>
      ) : (
        <Badge tone="warning">
          <TriangleAlert aria-hidden="true" />
          {t("kds.realtime.connecting")}
        </Badge>
      )}
    </div>
  );
}

function StationBoard({
  outletId,
  stationId,
  targetSeconds,
}: {
  outletId: string;
  stationId: StationId;
  targetSeconds: number | null;
}) {
  const t = useT();
  const board = useBoard(outletId, stationId);
  useKdsHeartbeat(outletId, stationId);
  const queryClient = useQueryClient();
  const resumeRef = useRef<((after: number) => void) | null>(null);
  const reconnectRef = useRef<(() => void) | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The 2s board poll stays as the backup: a ticket frame only makes the
  // refresh immediate. No cursor is known before the socket's `hello`.
  const realtime = useKdsRealtime({
    outletId,
    stationId,
    after: null,
    onTicket: () => {
      void queryClient.invalidateQueries({
        queryKey: kdsKeys.board(outletId, stationId),
      });
      void queryClient.invalidateQueries({
        queryKey: kdsKeys.stationSummary(outletId),
      });
    },
    onResync: () => {
      void (async () => {
        try {
          await queryClient.invalidateQueries({
            queryKey: kdsKeys.board(outletId, stationId),
          });
          const snapshot = await fetchStationSnapshot(outletId, stationId);
          resumeRef.current?.(snapshot.sequence);
        } catch {
          // The client stays paused until resumed: polling keeps the board
          // current, and after 5s a reconnect restarts from the cursor (it
          // triggers another resync if the server still asks for one).
          if (retryTimer.current) clearTimeout(retryTimer.current);
          retryTimer.current = setTimeout(() => {
            retryTimer.current = null;
            reconnectRef.current?.();
          }, 5000);
        }
      })();
    },
  });
  const { resume, reconnect } = realtime;
  useEffect(() => {
    resumeRef.current = resume;
    reconnectRef.current = reconnect;
  }, [resume, reconnect]);
  useEffect(
    () => () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
    },
    [],
  );
  const action = useKdsActions(outletId);
  const scanner = useScannerStatus(outletId);
  const toast = useToast();
  const [recall, setRecall] = useState<KitchenTicketDetail | null>(null);
  // Set only when the scanner opened the dialog: tells it how the dialog ended.
  const recallDone = useRef<((recalled: boolean) => void) | null>(null);
  const closeRecall = (recalled: boolean) => {
    setRecall(null);
    recallDone.current?.(recalled);
    recallDone.current = null;
  };
  const [reason, setReason] = useState("");
  const now = useSyncExternalStore(
    subscribeClock,
    clockSnapshot,
    serverClockSnapshot,
  );
  const offline =
    board.error instanceof ApiError && board.error.code === "NETWORK_ERROR";
  if (board.isPending)
    return (
      <div aria-busy="true" className="grid gap-3 sm:grid-cols-2">
        <span className="sr-only">{t("kds.loading")}</span>
        <Skeleton className="h-64" />
        <Skeleton className="h-64" />
      </div>
    );
  if (board.isError)
    return (
      <ErrorState
        error={board.error}
        title={t(offline ? "kds.offlineTitle" : "kds.errorTitle")}
        description={t(offline ? "kds.offlineHint" : "kds.errorHint")}
        onRetry={() => void board.refetch()}
      />
    );
  const data = board.data;
  if (!data) return null;
  const run = action.mutate;
  return (
    <div className="grid items-start gap-5 min-[1001px]:grid-cols-[minmax(0,1fr)_360px]">
      <div className="flex min-w-0 flex-col gap-5">
        <RealtimeStatus
          status={realtime.status}
          onReconnect={realtime.reconnect}
        />
        {action.isError && (
          <p
            role="alert"
            className="rounded-md bg-danger-subtle p-3 text-danger"
          >
            {t("kds.actionError")}
          </p>
        )}
        <section
          aria-labelledby="kds-all-day"
          className="border-y-(length:--border-w) py-4"
        >
          <h2 id="kds-all-day" className="type-title">
            {t("kds.queue")}
          </h2>
          {data.allDay.rows.length ? (
            <ul className="mt-3 flex flex-wrap gap-2">
              {data.allDay.rows.map((row) => (
                <li
                  key={`${row.menuItemId}-${row.variantId}`}
                  className="inline-flex items-baseline gap-1.5 rounded-control bg-surface-3 px-3 py-1.5"
                >
                  <span className="font-bold tabular">{row.quantity} ×</span>
                  <span className="font-semibold">{row.name}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-muted-foreground">{t("kds.queueEmpty")}</p>
          )}
        </section>
        <section aria-labelledby="kds-tickets">
          <h2 id="kds-tickets" className="type-title mb-3">
            {t("kds.tickets")} · {data.tickets.filter(isOpenTicket).length}
          </h2>
          {data.tickets.length === 0 ? (
            <EmptyState
              title={t("kds.emptyTitle")}
              description={t("kds.emptyHint")}
            />
          ) : (
            <div className="grid items-start gap-3 md:grid-cols-2 2xl:grid-cols-3">
              {data.tickets.map((ticket) => {
                const clockNow =
                  import.meta.env.VITE_API_MOCK === "true"
                    ? Date.parse(data.generatedAt) +
                      Math.max(0, now - mockStartedAt)
                    : now;
                const firedAt = Date.parse(ticket.firedAt);
                // A finished ticket shows how long it took; a live one keeps
                // counting. A cancelled ticket has no running clock.
                const endedAt =
                  ticket.status === "done" && ticket.doneAt !== null
                    ? Date.parse(ticket.doneAt)
                    : clockNow;
                const elapsed =
                  ticket.status === "cancelled"
                    ? null
                    : Math.max(0, Math.floor((endedAt - firedAt) / 1000));
                const stopped =
                  ticket.status === "done" || ticket.status === "cancelled";
                const timer =
                  !stopped && targetSeconds !== null && elapsed !== null
                    ? kdsTimerStatus(elapsed, targetSeconds)
                    : null;
                const band =
                  ticket.status === "done"
                    ? {
                        tone: "success" as const,
                        icon: CircleCheck,
                        label: t("kds.status.done"),
                      }
                    : ticket.status === "cancelled"
                      ? {
                          tone: "neutral" as const,
                          icon: Ban,
                          label: t("kds.status.cancelled"),
                        }
                      : timer
                        ? {
                            tone: TIMER_BAND[timer].tone,
                            icon: TIMER_BAND[timer].icon,
                            label: t(TIMER_BAND[timer].labelKey),
                          }
                        : {
                            tone: "neutral" as const,
                            icon: Clock,
                            label: t("kds.targetMissing"),
                          };
                return (
                  <article
                    key={ticket.id}
                    data-slot="kds-ticket"
                    data-timer-state={timer ?? ticket.status}
                    className="flex flex-col overflow-hidden rounded-container border-(length:--border-w) bg-card text-foreground"
                  >
                    <StatusBand
                      tone={band.tone}
                      icon={band.icon}
                      label={band.label}
                    >
                      <div className="flex min-w-0 flex-col">
                        <p className="text-sm leading-5 font-semibold">
                          {ticket.tableLabel !== null && (
                            <>
                              {t("kds.table", { label: ticket.tableLabel })}
                              {" · "}
                            </>
                          )}
                          {t("kds.orderCode")}{" "}
                          <span className="ml-1 font-mono tracking-wider">
                            #{ticketScanCode(ticket.ticketNo)}
                          </span>
                        </p>
                        <p className="text-xs leading-4">
                          {t(`kds.channel.${ticket.channel}`)}
                        </p>
                      </div>
                      {elapsed !== null && (
                        <p className="text-[30px] leading-9 font-bold tabular">
                          {formatElapsedSeconds(elapsed)}
                          <span className="sr-only">
                            {" "}
                            ·{" "}
                            {t("timer.elapsed", {
                              minutes: Math.floor(elapsed / 60),
                            })}
                          </span>
                        </p>
                      )}
                    </StatusBand>
                    <div className="flex flex-col gap-4 p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        {!stopped && (
                          <Badge>{t(`kds.status.${ticket.status}`)}</Badge>
                        )}
                        {ticket.priority > 0 && (
                          <Badge tone="warning">{t("kds.priority")}</Badge>
                        )}
                      </div>
                      <ul className="divide-y">
                        {ticket.items.map((item) => (
                          <li
                            key={item.id}
                            className="flex flex-col gap-2 py-3"
                          >
                            <div className="flex items-start gap-3">
                              {/* Quantities are a 44px raised square; the count
                                stays in the text for screen readers. */}
                              <span
                                aria-hidden="true"
                                className="grid size-11 shrink-0 place-items-center rounded-md bg-surface-3 text-lg font-bold tabular"
                              >
                                {item.quantity}
                              </span>
                              <div className="min-w-0 flex-1">
                                <p
                                  className={`font-semibold ${item.status === "voided" ? "line-through" : ""}`}
                                >
                                  <span className="sr-only">
                                    {item.quantity} ×{" "}
                                  </span>
                                  {item.name}
                                </p>
                                {item.modifiers.length > 0 && (
                                  <p className="mt-1 inline-flex w-fit items-start gap-1.5 rounded-md bg-warning-subtle px-2 py-1 text-sm leading-5 font-semibold text-warning">
                                    <TriangleAlert
                                      className="mt-0.5 size-4 shrink-0"
                                      aria-hidden="true"
                                    />
                                    <span>
                                      {t("kds.modifier")}:{" "}
                                      {item.modifiers.join(", ")}
                                    </span>
                                  </p>
                                )}
                                {item.note && (
                                  <p className="mt-1 inline-flex w-fit items-start gap-1.5 rounded-md bg-warning-subtle px-2 py-1 text-sm leading-5 font-semibold text-warning">
                                    <TriangleAlert
                                      className="mt-0.5 size-4 shrink-0"
                                      aria-hidden="true"
                                    />
                                    <span>
                                      {t("kds.note")}: {item.note}
                                    </span>
                                  </p>
                                )}
                              </div>
                              <Badge
                                tone={
                                  item.status === "voided"
                                    ? "danger"
                                    : "neutral"
                                }
                              >
                                {t(`kds.itemStatus.${item.status}`)}
                              </Badge>
                            </div>
                            {item.status !== "voided" && (
                              <div className="flex flex-wrap gap-2 pl-14">
                                {item.status === "queued" && (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="flex-1"
                                    disabled={action.isPending}
                                    onClick={() =>
                                      run({
                                        kind: "item",
                                        id: item.id,
                                        action: "start",
                                      })
                                    }
                                  >
                                    {t("kds.startItem")}
                                  </Button>
                                )}
                                {item.status === "in_progress" && (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="flex-1"
                                    disabled={action.isPending}
                                    onClick={() =>
                                      run({
                                        kind: "item",
                                        id: item.id,
                                        action: "ready",
                                      })
                                    }
                                  >
                                    {t("kds.bumpItem")}
                                  </Button>
                                )}
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="flex-1"
                                  disabled={action.isPending}
                                  onClick={() =>
                                    action.mutate(
                                      { kind: "soldOut", id: item.menuItemId },
                                      {
                                        onSuccess: () =>
                                          toast({
                                            title: t("kds.soldOutDone"),
                                            tone: "success",
                                          }),
                                      },
                                    )
                                  }
                                >
                                  {t("kds.soldOut")}
                                </Button>
                              </div>
                            )}
                          </li>
                        ))}
                      </ul>
                      <div className="flex flex-col gap-2 border-t-(length:--border-w) pt-3">
                        {/* The ticket's main action is full width, but neutral:
                          a board shows several tickets, and a filled accent
                          button on each would spend the accent budget
                          (DESIGN.md §2, owner Q21). */}
                        {canTransitionKitchenTicket(ticket.status, "bump") && (
                          <Button
                            variant="secondary"
                            className="w-full"
                            disabled={action.isPending}
                            onClick={() =>
                              run({
                                kind: "ticket",
                                id: ticket.id,
                                action: "bump",
                              })
                            }
                          >
                            {t("kds.bump")}
                          </Button>
                        )}
                        {canTransitionKitchenTicket(ticket.status, "start") && (
                          <Button
                            variant="secondary"
                            className="w-full"
                            disabled={action.isPending}
                            onClick={() =>
                              run({
                                kind: "ticket",
                                id: ticket.id,
                                action: "start",
                              })
                            }
                          >
                            {t("kds.start")}
                          </Button>
                        )}
                        {ticket.status !== "cancelled" && (
                          <CloudPrintButton
                            kind="ticket"
                            size="sm"
                            printKey={`kds-ticket:${ticket.id}`}
                            load={ticketPrintLoader(outletId, ticket.id)}
                          />
                        )}
                        <div className="flex flex-wrap gap-2">
                          {canTransitionKitchenTicket(
                            ticket.status,
                            "recall",
                          ) && (
                            <Button
                              variant="outline"
                              className="flex-1"
                              disabled={action.isPending}
                              onClick={() => {
                                setReason("");
                                recallDone.current = null;
                                setRecall(ticket);
                              }}
                            >
                              {t("kds.recall")}
                            </Button>
                          )}
                          {ticket.status !== "cancelled" && (
                            <Button
                              variant="outline"
                              className="flex-1"
                              disabled={action.isPending}
                              onClick={() =>
                                run({
                                  kind: "priority",
                                  id: ticket.id,
                                  priority: ticket.priority > 0 ? 0 : 1,
                                })
                              }
                            >
                              {t(
                                ticket.priority > 0
                                  ? "kds.removePriority"
                                  : "kds.priority",
                              )}
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </div>
      <ScannerPanel
        tickets={data.tickets}
        action={action}
        status={scanner.data?.status ?? "unknown"}
        onRecall={(ticket, done) => {
          setReason("");
          recallDone.current = done;
          setRecall(ticket);
        }}
      />
      <Dialog
        open={recall !== null}
        onOpenChange={(open) => {
          if (!open) closeRecall(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("kds.recallTitle")}</DialogTitle>
            <DialogDescription>{t("kds.recallHint")}</DialogDescription>
          </DialogHeader>
          <Label htmlFor="recall-reason">{t("kds.reason")}</Label>
          <Input
            id="recall-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={200}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => closeRecall(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              disabled={!reason.trim() || action.isPending}
              onClick={() => {
                if (recall)
                  action.mutate(
                    {
                      kind: "ticket",
                      id: recall.id,
                      action: "recall",
                      reason: reason.trim(),
                    },
                    { onSuccess: () => closeRecall(true) },
                  );
              }}
            >
              {t("kds.recall")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
