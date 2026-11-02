import { useState, useSyncExternalStore } from "react";
import type {
  KitchenTicketDetail,
  StationConfig,
} from "@starter/shared/kitchen";
import { canTransitionKitchenTicket } from "@starter/shared/kitchen";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { Badge, StatusPill } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
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
import { kdsTimerStatus } from "../timer.ts";

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
        <h1 className="text-xl font-bold">{t("kds.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("kds.intro")}</p>
        {import.meta.env.VITE_API_MOCK === "true" && (
          <p className="text-sm text-muted-foreground">{t("kds.sample")}</p>
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
          <nav aria-label={t("kds.stations")} className="flex flex-wrap gap-2">
            {active.map((item) => {
              const name = names.data?.find(
                (row) => row.id === item.stationId,
              )?.name;
              return (
                <Button
                  key={item.stationId}
                  variant={item.stationId === stationId ? "default" : "outline"}
                  aria-pressed={item.stationId === stationId}
                  onClick={() => setSelected(item.stationId)}
                >
                  {name ?? item.stationId}
                </Button>
              );
            })}
          </nav>
          {stationId ? (
            <StationBoard
              key={stationId}
              stationId={stationId}
              targetSeconds={station?.targetSeconds ?? null}
            />
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
      <section aria-labelledby="kds-all-day" className="border-y py-4">
        <h2 id="kds-all-day" className="font-bold">
          {t("kds.queue")}
        </h2>
        {data.allDay.rows.length ? (
          <ul className="mt-3 flex flex-wrap gap-2">
            {data.allDay.rows.map((row) => (
              <li
                key={`${row.menuItemId}-${row.variantId}`}
                className="rounded-md bg-muted px-3 py-2 font-semibold tabular"
              >
                {row.quantity} × {row.name}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-muted-foreground">{t("kds.queueEmpty")}</p>
        )}
      </section>
      <section aria-labelledby="kds-tickets">
        <h2 id="kds-tickets" className="mb-3 text-lg font-bold">
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
              const elapsed = Math.max(
                0,
                Math.floor(
                  ((import.meta.env.VITE_API_MOCK === "true"
                    ? Date.parse(data.generatedAt) +
                      Math.max(0, now - mockStartedAt)
                    : now) -
                    Date.parse(ticket.firedAt)) /
                    1000,
                ),
              );
              const status =
                targetSeconds === null
                  ? "onTrack"
                  : kdsTimerStatus(elapsed, targetSeconds);
              return (
                <Card
                  key={ticket.id}
                  data-slot="kds-ticket"
                  className="flex flex-col gap-4 p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <h3 className="font-bold">
                        {t("kds.order", { id: ticket.orderId.slice(-6) })}
                      </h3>
                      <Badge>{t(`kds.status.${ticket.status}`)}</Badge>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      {targetSeconds === null ? (
                        <span className="text-sm text-muted-foreground">
                          {t("kds.targetMissing")}
                        </span>
                      ) : (
                        <StatusPill status={status}>
                          {t("kds.elapsed", {
                            minutes: Math.floor(elapsed / 60),
                          })}
                          {/* Children replace the pill label; keep the timer
                              status for screen readers (WCAG 1.4.1). */}
                          <span className="sr-only">
                            {" · "}
                            {t(`timer.${status}`)}
                          </span>
                        </StatusPill>
                      )}
                      {ticket.priority > 0 && (
                        <Badge tone="warning">{t("kds.priority")}</Badge>
                      )}
                    </div>
                  </div>
                  <ul className="divide-y">
                    {ticket.items.map((item) => (
                      <li key={item.id} className="flex flex-col gap-2 py-3">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <p
                            className={`font-bold ${item.status === "voided" ? "line-through" : ""}`}
                          >
                            {item.quantity} × {item.name}
                          </p>
                          <Badge
                            tone={
                              item.status === "voided" ? "danger" : "neutral"
                            }
                          >
                            {t(`kds.itemStatus.${item.status}`)}
                          </Badge>
                        </div>
                        {item.modifiers.length > 0 && (
                          <p className="font-semibold">
                            {t("kds.modifier")}: {item.modifiers.join(", ")}
                          </p>
                        )}
                        {item.note && (
                          <p className="rounded-md bg-warning-subtle p-2 font-bold text-warning">
                            {t("kds.note")}: {item.note}
                          </p>
                        )}
                        {item.status !== "voided" && (
                          <div className="flex flex-wrap gap-2">
                            {item.status === "queued" && (
                              <Button
                                variant="outline"
                                size="sm"
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
                  <div className="flex flex-wrap gap-2 border-t pt-3">
                    {canTransitionKitchenTicket(ticket.status, "start") && (
                      <Button
                        variant="secondary"
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
                    {canTransitionKitchenTicket(ticket.status, "bump") && (
                      <Button
                        variant="secondary"
                        disabled={action.isPending}
                        onClick={() =>
                          run({ kind: "ticket", id: ticket.id, action: "bump" })
                        }
                      >
                        {t("kds.bump")}
                      </Button>
                    )}
                    {canTransitionKitchenTicket(ticket.status, "recall") && (
                      <Button
                        variant="secondary"
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
                </Card>
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
