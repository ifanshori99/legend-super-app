import { useState, useSyncExternalStore } from "react";
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
import {
  useBoard,
  useKdsActions,
  useMenuStations,
  useStations,
} from "../hooks.ts";
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

export function KdsPage() {
  const t = useT();
  const stations = useStations();
  const names = useMenuStations();
  const [selected, setSelected] = useState<StationId | null>(null);
  const active = (stations.data ?? [])
    .filter((station) => station.isActive)
    .sort((a, b) => a.displayOrder - b.displayOrder);
  const stationId = selected ?? active[0]?.stationId;
  const station = names.data?.find((row) => row.id === stationId);
  const failure = stations.error ?? names.error;
  const offline =
    failure instanceof ApiError && failure.code === "NETWORK_ERROR";
  return (
    <div className="flex w-full flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="type-display">{t("kds.title")}</h1>
        <p className="max-w-prose text-sm leading-5 text-muted-foreground">
          {t("kds.intro")}
        </p>
        {import.meta.env.VITE_API_MOCK === "true" && (
          <p className="text-sm leading-5 text-muted-foreground">
            {t("kds.sample")}
          </p>
        )}
      </header>
      {stations.isPending || names.isPending ? (
        <div aria-busy="true">
          <span className="sr-only">{t("kds.loading")}</span>
          <Skeleton className="h-28 w-full" />
        </div>
      ) : failure ? (
        <ErrorState
          title={t(offline ? "kds.offlineTitle" : "kds.errorTitle")}
          description={t(offline ? "kds.offlineHint" : "kds.errorHint")}
          onRetry={() => {
            void stations.refetch();
            void names.refetch();
          }}
        />
      ) : (
        <>
          {stationId ? (
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
                  label:
                    names.data?.find((row) => row.id === item.stationId)
                      ?.name ?? item.stationId,
                }))}
              />
              <StationBoard
                key={stationId}
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

function StationBoard({
  stationId,
  targetSeconds,
}: {
  stationId: StationId;
  targetSeconds: number | null;
}) {
  const t = useT();
  const board = useBoard(stationId);
  const action = useKdsActions();
  const toast = useToast();
  const [recall, setRecall] = useState<KitchenTicketDetail | null>(null);
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
        title={t(offline ? "kds.offlineTitle" : "kds.errorTitle")}
        description={t(offline ? "kds.offlineHint" : "kds.errorHint")}
        onRetry={() => void board.refetch()}
      />
    );
  const data = board.data;
  if (!data) return null;
  const run = action.mutate;
  return (
    <>
      {action.isError && (
        <p role="alert" className="rounded-md bg-danger-subtle p-3 text-danger">
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
          {t("kds.tickets")} · {data.tickets.length}
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
                    <p className="text-sm leading-5 font-semibold">
                      {t("kds.orderCode")}{" "}
                      <span className="font-mono tracking-wider">
                        {ticket.orderId.slice(-6)}
                      </span>
                    </p>
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
                        <li key={item.id} className="flex flex-col gap-2 py-3">
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
                                item.status === "voided" ? "danger" : "neutral"
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
      <Dialog
        open={recall !== null}
        onOpenChange={(open) => {
          if (!open) setRecall(null);
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
            <Button variant="outline" onClick={() => setRecall(null)}>
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
                    { onSuccess: () => setRecall(null) },
                  );
              }}
            >
              {t("kds.recall")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
