import { Link } from "@tanstack/react-router";
import { Plus, Send } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Notice,
  PosPageHeading,
  StatusPill,
} from "@/features/ws04-pos-kasir/components/shared";
import {
  isContractPending,
  useFireTableLines,
  useTableOrder,
} from "@/features/ws04-pos-order/hooks";
import type { OrderLine } from "@/features/ws04-pos-order/types";
import { CaptainShell } from "./captain-shell";
import {
  SampleBadge,
  lineDetails,
  tableSessionText,
} from "./captain-order-parts";

// /pos/captain/meja/$tableId — what a table has ordered: sent items and held
// ones. A held item goes to the kitchen only when the captain sends it.
export function TableOrderScreen({ tableId }: { tableId: string }) {
  const t = useT();
  const query = useTableOrder(tableId);
  const fire = useFireTableLines();
  const view = query.data;
  const firingLineId =
    fire.isPending && fire.variables ? fire.variables.lineIds[0] : null;

  return (
    <CaptainShell
      title={
        view
          ? t("posCaptainOrder.table.title", { table: view.table.label })
          : t("posCaptainOrder.order.title")
      }
      subtitle={view ? tableSessionText(t, view.table) : undefined}
      backTo="/pos/captain"
    >
      <div data-slot="captain-table-order" className="grid content-start gap-4">
        <PosPageHeading
          title={t("posCaptainOrder.order.title")}
          subtitle={t("posCaptainOrder.order.subtitle")}
          action={<SampleBadge />}
        />

        {fire.isError && (
          <Notice tone="danger" title={t("posCaptainOrder.order.fireFailed")}>
            {isContractPending(fire.error) &&
              t("posCaptainOrder.contractPending")}
          </Notice>
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
        ) : query.isError ? (
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
            {view?.order && view.order.lines.length > 0 ? (
              <ul className="grid gap-3">
                {view.order.lines.map((line) => (
                  <li key={line.lineId}>
                    <OrderLineCard
                      line={line}
                      firing={firingLineId === line.lineId}
                      onFire={() =>
                        fire.mutate({ tableId, lineIds: [line.lineId] })
                      }
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                title={t("posCaptainOrder.order.emptyTitle")}
                description={t("posCaptainOrder.order.emptyHint")}
              />
            )}
            <Button asChild variant="outline" size="lg" className="w-full">
              <Link to="/pos/captain/meja/$tableId/tambah" params={{ tableId }}>
                <Plus aria-hidden="true" />
                {t("posCaptainOrder.order.add")}
              </Link>
            </Button>
          </>
        )}
      </div>
    </CaptainShell>
  );
}

function OrderLineCard({
  line,
  firing,
  onFire,
}: {
  line: OrderLine;
  firing: boolean;
  onFire: () => void;
}) {
  const t = useT();
  const details = [
    ...lineDetails(line),
    ...(line.status === "held" ? [line.course.label] : []),
  ];
  return (
    <div className="rounded-container border-(length:--border-w) border-border bg-card p-card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-(length:--density-text) leading-6 font-semibold">
            {t("posCaptainOrder.order.lineTitle", {
              qty: line.quantity,
              name: line.name,
            })}
          </h3>
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
      {line.status === "held" && (
        <div className="mt-3 grid gap-3 border-t-(length:--border-w) border-border pt-3">
          <p className="text-base text-muted-foreground">
            {t("posCaptainOrder.order.heldHint")}
          </p>
          <Button onClick={onFire} loading={firing} className="w-full">
            <Send aria-hidden="true" />
            {firing
              ? t("posCaptainOrder.order.firing")
              : t("posCaptainOrder.order.fireCourse", {
                  course: line.course.label.toLocaleLowerCase("id-ID"),
                })}
          </Button>
        </div>
      )}
    </div>
  );
}
