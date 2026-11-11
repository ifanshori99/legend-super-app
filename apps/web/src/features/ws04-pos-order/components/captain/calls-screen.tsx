import { CircleCheck, CircleDot, RotateCw } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Notice,
  PosPageHeading,
} from "@/features/ws04-pos-kasir/components/shared";
import {
  isContractPending,
  useAcknowledgeCall,
  useCaptainTables,
  useOrderingConnectivity,
  useResolveCall,
  useServiceCalls,
} from "@/features/ws04-pos-order/hooks";
import type { ServiceCall } from "@/features/ws04-pos-order/types";
import { API_MOCK } from "@/lib/api/mock-flag";
import { useOutletClock, useTenantContext } from "@/lib/tenant-context";
import { CaptainShell } from "./captain-shell";

/** "2026-11-12T07:32:00Z" -> "14.32" in the outlet's time zone. */
function formatClock(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  })
    .format(new Date(iso))
    .replace(":", ".");
}

// /pos/captain/panggilan — waiter calls for the captain's zone. A new call is
// accepted ("Terima"), then closed ("Selesaikan"): the bill request included.
export function CallsScreen() {
  const t = useT();
  const outlet = useTenantContext().outlet;
  const { timeZone } = useOutletClock();
  const { mode } = useOrderingConnectivity();
  const callsQuery = useServiceCalls();
  const tablesQuery = useCaptainTables();
  const acknowledge = useAcknowledgeCall();
  const resolve = useResolveCall();

  const zoneOf = (tableId: string) =>
    tablesQuery.data?.find((table) => table.id === tableId)?.zone ?? null;

  // Open calls only; new ones first (oldest waiting longest on top), then accepted.
  const open = (callsQuery.data ?? [])
    .filter((call) => call.status !== "resolved")
    .sort((a, b) =>
      a.status === b.status
        ? a.createdAt.localeCompare(b.createdAt)
        : a.status === "new"
          ? -1
          : 1,
    );

  const actionError = acknowledge.isError
    ? acknowledge.error
    : resolve.isError
      ? resolve.error
      : null;
  const hasActionError = acknowledge.isError || resolve.isError;
  const resolvedTable = resolve.isSuccess ? resolve.data.tableLabel : null;

  return (
    <CaptainShell
      title={t("posCaptainTables.calls.back")}
      subtitle={outlet?.name}
      backTo="/pos/captain"
    >
      <div className="grid gap-4">
        <PosPageHeading
          title={t("posCaptainTables.calls.title")}
          subtitle={t("posCaptainTables.calls.subtitle")}
          action={
            API_MOCK ? (
              <Badge tone="neutral">{t("common.sampleData")}</Badge>
            ) : undefined
          }
        />

        {mode === "edge_only" && (
          <Notice tone="warning" title={t("posCaptainTables.offline.title")}>
            {t("posCaptainTables.offline.body")}
          </Notice>
        )}

        {hasActionError && (
          <Notice
            tone="danger"
            title={
              isContractPending(actionError)
                ? t("posCaptainTables.calls.actionError.pendingTitle")
                : t("posCaptainTables.calls.actionError.title")
            }
          >
            {isContractPending(actionError)
              ? t("posCaptainTables.calls.actionError.pendingDescription")
              : t("posCaptainTables.calls.actionError.description")}
          </Notice>
        )}

        {resolvedTable && !hasActionError && (
          <Notice
            tone="info"
            role="status"
            title={t("posCaptainTables.calls.resolved", {
              table: resolvedTable,
            })}
          />
        )}

        {callsQuery.isPending ? (
          <div
            role="status"
            aria-busy="true"
            aria-label={t("posCaptainTables.calls.loading")}
            className="grid gap-3"
          >
            <Skeleton className="h-44 rounded-container" />
            <Skeleton className="h-24 rounded-container" />
          </div>
        ) : callsQuery.isError ? (
          <ErrorState
            error={callsQuery.error}
            title={
              isContractPending(callsQuery.error)
                ? t("posCaptainTables.calls.error.pendingTitle")
                : t("posCaptainTables.calls.error.title")
            }
            description={
              isContractPending(callsQuery.error)
                ? t("posCaptainTables.calls.error.pendingDescription")
                : t("posCaptainTables.calls.error.description")
            }
            action={
              <Button
                variant="outline"
                onClick={() => void callsQuery.refetch()}
              >
                <RotateCw aria-hidden="true" />
                {t("posCaptainTables.calls.error.retry")}
              </Button>
            }
          />
        ) : open.length === 0 ? (
          <EmptyState
            title={t("posCaptainTables.calls.empty.title")}
            description={t("posCaptainTables.calls.empty.description")}
          />
        ) : (
          <>
            <ul
              aria-label={t("posCaptainTables.calls.listLabel")}
              className="grid gap-3"
            >
              {open.map((call) => {
                const zone = zoneOf(call.tableId);
                const time = formatClock(call.createdAt, timeZone);
                const isNew = call.status === "new";
                const mutation = isNew ? acknowledge : resolve;
                const busy =
                  mutation.isPending && mutation.variables?.id === call.id;
                return (
                  <li key={call.id}>
                    <CallCard
                      call={call}
                      zone={zone}
                      time={time}
                      busy={busy}
                      onAct={() =>
                        isNew
                          ? acknowledge.mutate({ id: call.id })
                          : resolve.mutate({ id: call.id })
                      }
                    />
                  </li>
                );
              })}
            </ul>
            <p className="text-sm text-muted-foreground">
              {t("posCaptainTables.calls.hint")}
            </p>
          </>
        )}
      </div>
    </CaptainShell>
  );
}

function CallCard({
  call,
  zone,
  time,
  busy,
  onAct,
}: {
  call: ServiceCall;
  zone: string | null;
  time: string;
  busy: boolean;
  onAct: () => void;
}) {
  const t = useT();
  const isNew = call.status === "new";
  const table = t("posCaptainTables.calls.table", { table: call.tableLabel });
  const typeLabel = t(`posCaptainTables.calls.type.${call.type}`);
  // The reason is what the guest asked for; fall back to the call type.
  const headline = call.reason || typeLabel;
  const meta = t("posCaptainTables.calls.meta", {
    detail: isNew ? (zone ?? typeLabel) : headline,
    time,
  });
  return (
    <article
      data-slot="captain-call-card"
      data-status={call.status}
      aria-label={table}
      className={
        isNew
          ? "rounded-container border-2 border-l-[6px] border-border border-l-warning bg-card p-4"
          : "rounded-container border-2 border-border bg-card p-card"
      }
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className={isNew ? "type-title" : "text-lg leading-6 font-bold"}>
          {table}
        </h2>
        {isNew ? (
          <Badge tone="warning" className="px-3 py-1 text-sm">
            <CircleDot aria-hidden="true" />
            {t("posCaptainTables.calls.status.new")}
          </Badge>
        ) : (
          <Badge tone="success" className="px-3 py-1 text-sm">
            <CircleCheck aria-hidden="true" />
            {t("posCaptainTables.calls.status.acknowledged")}
          </Badge>
        )}
      </div>
      {isNew && (
        <p className="mt-2 text-(length:--density-text) leading-6 font-bold">
          {headline}
        </p>
      )}
      <p className="mt-1 text-sm leading-5 text-muted-foreground">{meta}</p>
      <div className="mt-3 border-t-2 border-border pt-3">
        <Button
          variant={isNew ? "default" : "outline"}
          loading={busy}
          onClick={onAct}
          aria-label={t(
            isNew
              ? "posCaptainTables.calls.acknowledgeFor"
              : "posCaptainTables.calls.resolveFor",
            { table: call.tableLabel },
          )}
          className="w-full"
        >
          {isNew
            ? t("posCaptainTables.calls.acknowledge")
            : t("posCaptainTables.calls.resolve")}
        </Button>
      </div>
    </article>
  );
}
