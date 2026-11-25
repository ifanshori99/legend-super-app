import { Link } from "@tanstack/react-router";
import { Plus, Send } from "lucide-react";
import { useT } from "@/components/i18n";
import { ApiError } from "@/lib/api/errors";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Notice,
  StatusPill,
} from "@/features/ws04-pos-kasir/components/shared";
import {
  isContractPending,
  useFireTableLines,
  usePendingFires,
  useTableOrder,
} from "@/features/ws04-pos-order/hooks";
import { needsCashierClose } from "@/features/ws04-pos-order/order-flow";
import type { OrderLine, PosOrderView } from "@/features/ws04-pos-order/types";
import { CaptainShell } from "./captain-shell";
import { SeatCard } from "./seat-card";
import { lineDetails, tableSessionText } from "./captain-order-parts";

/** Lines grouped by course, courses in kitchen order. */
function groupByCourse(lines: OrderLine[]) {
  const groups = new Map<
    string,
    { course: OrderLine["course"]; lines: OrderLine[] }
  >();
  for (const line of lines) {
    const group = groups.get(line.course.id);
    if (group) group.lines.push(line);
    else groups.set(line.course.id, { course: line.course, lines: [line] });
  }
  return [...groups.values()].sort((a, b) => a.course.order - b.course.order);
}

// /pos/captain/meja/$tableId — what a table has ordered: sent items and held
// ones. A held item goes to the kitchen only when the captain sends its course.
export function TableOrderScreen({ tableId }: { tableId: string }) {
  const t = useT();
  const query = useTableOrder(tableId);
  const fire = useFireTableLines();
  const view = query.data;
  const firingLineIds =
    fire.isPending && fire.variables ? fire.variables.lineIds : [];
  const pendingFires = usePendingFires();
  const orderIds = new Set((view?.orders ?? []).map((order) => order.orderId));
  const unclear = pendingFires.pending.filter((entry) =>
    orderIds.has(entry.orderId),
  );
  const seated = view ? view.table.sessionId !== null : false;
  const payFirst = view?.table.paymentMode === "pay_first";
  const refused = fire.isError && needsCashierClose(fire.error);
  const tableMissing =
    query.isError &&
    !view &&
    query.error instanceof ApiError &&
    query.error.status === 404;

  return (
    <CaptainShell
      context={
        view
          ? t("posCaptainOrder.table.title", { table: view.table.label })
          : t("posCaptainOrder.table.loadingTitle")
      }
      contextSub={view ? tableSessionText(t, view.table) : undefined}
      title={t("posCaptainOrder.order.title")}
      subtitle={t("posCaptainOrder.order.subtitle")}
      backTo="/pos/captain"
    >
      <div data-slot="captain-table-order" className="grid content-start gap-4">
        {fire.isError && (
          <Notice tone="danger" title={t("posCaptainOrder.order.fireFailed")}>
            {isContractPending(fire.error)
              ? t("posCaptainOrder.contractPending")
              : fire.error instanceof ApiError &&
                t("posCaptainOrder.review.submitFailedReason", {
                  message: fire.error.message,
                })}
          </Notice>
        )}

        {unclear.length > 0 && !fire.isPending && (
          <Notice tone="warning" title={t("posCaptainOrder.fire.pendingTitle")}>
            <div className="grid gap-2">
              <p>
                {refused
                  ? t("posCaptainOrder.fire.refusedBody")
                  : t("posCaptainOrder.fire.pendingBody")}
              </p>
              {unclear.map((entry) => (
                <div key={entry.orderId} className="flex flex-wrap gap-2">
                  {!refused && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() =>
                        fire.mutate({ tableId, lineIds: entry.itemIds })
                      }
                    >
                      {t("posCaptainOrder.fire.resend", {
                        count: entry.itemIds.length,
                      })}
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      pendingFires.close(entry.orderId);
                      fire.reset();
                    }}
                  >
                    {t("posCaptainOrder.fire.close")}
                  </Button>
                </div>
              ))}
            </div>
          </Notice>
        )}

        {query.isError && view && (
          <Notice tone="warning" title={t("posCaptainOrder.stale")} />
        )}

        {query.isPending ? (
          <div
            role="status"
            aria-busy="true"
            aria-label={t("posCaptainOrder.order.loading")}
            className="grid gap-3"
          >
            <Skeleton className="h-24 rounded-container" />
            <Skeleton className="h-36 rounded-container" />
            <Skeleton className="h-16 rounded-control" />
          </div>
        ) : tableMissing ? (
          <EmptyState
            title={t("posCaptainOrder.order.notFoundTitle")}
            description={t("posCaptainOrder.order.notFoundHint")}
            action={
              <Button asChild>
                <Link to="/pos/captain">
                  {t("posCaptainOrder.order.backToTables")}
                </Link>
              </Button>
            }
          />
        ) : query.isError && !view ? (
          <ErrorState
            title={t("posCaptainOrder.order.loadFailedTitle")}
            description={
              isContractPending(query.error)
                ? t("posCaptainOrder.contractPending")
                : t("posCaptainOrder.order.loadFailedHint")
            }
            error={query.error}
            onRetry={() => void query.refetch()}
          />
        ) : (
          <>
            {!seated && view ? (
              <SeatCard tableId={tableId} table={view.table} />
            ) : view && view.orders.length > 0 ? (
              view.orders.map((order) => (
                <OrderSection
                  key={order.orderId}
                  order={order}
                  tableId={tableId}
                  fire={fire}
                  firingLineIds={firingLineIds}
                  canFire={!payFirst}
                />
              ))
            ) : (
              <EmptyState
                title={t("posCaptainOrder.order.emptyTitle")}
                description={t("posCaptainOrder.order.emptyHint")}
              />
            )}
            {payFirst && (
              <Notice tone="info" title={t("posCaptainOrder.payFirst.title")}>
                {t("posCaptainOrder.payFirst.hint")}
              </Notice>
            )}
            {seated && !payFirst && (
              <Button asChild variant="outline" size="lg" className="w-full">
                <Link
                  to="/pos/captain/meja/$tableId/tambah"
                  params={{ tableId }}
                >
                  <Plus aria-hidden="true" />
                  {t("posCaptainOrder.order.add")}
                </Link>
              </Button>
            )}
          </>
        )}
      </div>
    </CaptainShell>
  );
}

// One order of the table (each send is its own order, never merged), its
// items grouped by course. Held items are sent by their server item ids.
function OrderSection({
  order,
  tableId,
  fire,
  firingLineIds,
  canFire,
}: {
  canFire: boolean;
  order: PosOrderView;
  tableId: string;
  fire: ReturnType<typeof useFireTableLines>;
  firingLineIds: string[];
}) {
  const t = useT();
  const groups = groupByCourse(order.lines);
  return (
    <section className="grid gap-4" aria-label={order.number}>
      <h2 className="text-lg leading-6 font-bold">
        {t("posCaptainOrder.order.orderNumber", { number: order.number })}
      </h2>
      {groups.map((group) => {
        const held = canFire
          ? group.lines.filter((line) => line.status === "held")
          : [];
        const firing = held.some((line) => firingLineIds.includes(line.lineId));
        const course = group.course.label.toLocaleLowerCase("id-ID");
        return (
          <div key={group.course.id} className="grid gap-3">
            {group.course.label !== "" && (
              <h3 className="text-base leading-6 font-semibold text-muted-foreground">
                {group.course.label}
              </h3>
            )}
            <ul className="grid gap-3">
              {group.lines.map((line) => (
                <li key={line.lineId}>
                  <OrderLineCard line={line} />
                </li>
              ))}
            </ul>
            {held.length > 0 && (
              <div className="grid gap-2">
                <p className="text-base text-muted-foreground">
                  {t("posCaptainOrder.order.heldHint")}
                </p>
                <Button
                  onClick={() =>
                    fire.mutate({
                      tableId,
                      lineIds: held.map((line) => line.lineId),
                    })
                  }
                  loading={firing}
                  disabled={fire.isPending && !firing}
                  className="w-full"
                >
                  <Send aria-hidden="true" />
                  {firing
                    ? t("posCaptainOrder.order.firing")
                    : course === ""
                      ? t("posCaptainOrder.order.fireItems", {
                          count: held.length,
                        })
                      : held.length > 1
                        ? t("posCaptainOrder.order.fireAll", {
                            course,
                            count: held.length,
                          })
                        : t("posCaptainOrder.order.fireCourse", { course })}
                </Button>
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

function OrderLineCard({ line }: { line: OrderLine }) {
  const t = useT();
  const details = lineDetails(line);
  return (
    <div className="rounded-container border-(length:--border-w) border-border bg-card p-card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="text-(length:--density-text) leading-6 font-semibold">
            {t("posCaptainOrder.order.lineTitle", {
              qty: line.quantity,
              name: line.name,
            })}
          </h4>
          {details.length > 0 && (
            <p className="text-base text-muted-foreground">
              {details.join(" · ")}
            </p>
          )}
        </div>
        {line.status === "sent" ? (
          <StatusPill tone="success">
            {t("posCaptainOrder.order.sent")}
          </StatusPill>
        ) : (
          <StatusPill tone="warning">
            {t("posCaptainOrder.order.held")}
          </StatusPill>
        )}
      </div>
    </div>
  );
}
