// /pos/meja — the live floor board (PRD §3 "9. Denah & Meja": Papan Status;
// ORD-10). Every state the gate asks for: loading skeleton, empty floor plan,
// empty zone/search, error with retry, offline strip, and the action panel.
import * as React from "react";
import { RefreshCw, Search, WifiOff } from "lucide-react";
import { useT } from "@/components/i18n";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/ui/feedback-state";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useOnline } from "@/lib/use-online";
import type { TableLiveStatus } from "@starter/shared/qr-order";
import { useTenantContext } from "@/lib/tenant-context";
import { useFloorBoard, useRefreshBoard } from "../hooks";
import {
  boardCounts,
  filterBoard,
  urgentTableCount,
  zoneCounts,
  type ZoneFilter,
} from "../lib";
import { BoardStatusBar } from "./board-status";
import { TableActionsPanel } from "./table-actions-panel";
import { TableCard } from "./table-card";

const ALL_ZONES = "all";

function PageHeading({ outlet }: { outlet?: string }) {
  const t = useT();
  return (
    <div className="min-w-0">
      <h1 className="type-display">{t("floor.title")}</h1>
      <p className="text-sm text-muted-foreground">{t("floor.subtitle")}</p>
      {outlet && <p className="text-sm font-semibold">{outlet}</p>}
    </div>
  );
}

function BoardSkeleton() {
  const t = useT();
  return (
    <div aria-busy="true" className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <span className="sr-only" role="status">
        {t("floor.loadingBoard")}
      </span>
      <Skeleton className="h-10 w-full max-w-md" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 8 }, (_, index) => (
          <Skeleton key={index} className="h-32 w-full rounded-container" />
        ))}
      </div>
    </div>
  );
}

/**
 * Keyed by outlet: switching outlet in the shell starts a fresh board, so a
 * zone tab or selected table of the previous outlet cannot hide this one's.
 */
export function FloorBoardPage({ canManage }: { canManage: boolean }) {
  const { outlet } = useTenantContext();
  return <FloorBoardContent key={outlet?.id ?? "none"} canManage={canManage} />;
}

function FloorBoardContent({ canManage }: { canManage: boolean }) {
  const t = useT();
  const online = useOnline();
  // The outlet the shell selected from the session's assigned outlets.
  const { outlet } = useTenantContext();
  const board = useFloorBoard(outlet?.id);
  const refresh = useRefreshBoard();
  const [zoneId, setZoneId] = React.useState<string>(ALL_ZONES);
  const [query, setQuery] = React.useState("");
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [now, setNow] = React.useState(() => new Date());

  // Seat durations tick even when the board poll is between refetches.
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  if (outlet && board.isPending) return <BoardSkeleton />;

  if (board.error)
    return (
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
        <PageHeading />
        <ErrorState
          title={t("floor.error.title")}
          description={t("floor.error.hint")}
          onRetry={() => {
            void board.refetch();
          }}
        />
      </div>
    );

  if (!outlet || !board.data)
    return (
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
        <PageHeading />
        <EmptyState
          title={t("floor.error.emptyTitle")}
          description={t("floor.error.emptyHint")}
        />
      </div>
    );

  const data = board.data;
  const zones = [...data.zones].sort((a, b) => a.sortOrder - b.sortOrder);
  const filter: ZoneFilter = {
    zoneId: zoneId === ALL_ZONES ? null : zoneId,
    query,
  };
  const visible = filterBoard(data.tables, filter);
  const counts = boardCounts(data.tables);
  const perZone = zoneCounts(data.tables);
  const sessionUsage = new Map<string, number>();
  for (const row of data.tables)
    if (row.session)
      sessionUsage.set(
        row.session.id,
        (sessionUsage.get(row.session.id) ?? 0) + 1,
      );
  const isShared = (row: TableLiveStatus) =>
    row.session !== null && (sessionUsage.get(row.session.id) ?? 0) > 1;
  const selected =
    data.tables.find((row) => row.table.id === selectedId) ?? null;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <PageHeading outlet={outlet.name} />
        <div className="flex flex-wrap items-center gap-3">
          <p
            className="text-sm text-muted-foreground tabular"
            aria-live="polite"
          >
            {data.generatedAt
              ? t("floor.updatedAt", {
                  time: new Intl.DateTimeFormat("id-ID", {
                    hour: "2-digit",
                    minute: "2-digit",
                  }).format(new Date(data.generatedAt)),
                })
              : t("floor.updatedNever")}
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() => void refresh()}
          >
            <RefreshCw aria-hidden="true" />
            {t("floor.refresh")}
          </Button>
        </div>
      </div>

      {!online && (
        <div className="flex items-start gap-2 rounded-lg bg-warning-subtle p-3 text-sm text-foreground">
          <WifiOff className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>
            <span className="font-semibold">{t("floor.offline.title")}</span>{" "}
            {t("floor.offline.hint")}
          </span>
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_16rem] md:items-center">
        <Tabs value={zoneId} onValueChange={setZoneId} className="min-w-0">
          <TabsList aria-label={t("floor.zoneTabsLabel")} className="min-w-0">
            <TabsTrigger value={ALL_ZONES}>
              {t("floor.allZones")} ({data.tables.length})
            </TabsTrigger>
            {zones.map((zone) => (
              <TabsTrigger key={zone.id} value={zone.id}>
                {t("floor.zoneTab", {
                  name: zone.name,
                  count: perZone.get(zone.id) ?? 0,
                })}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="relative w-full min-w-0">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("floor.searchPlaceholder")}
            aria-label={t("floor.searchPlaceholder")}
            className="pl-9"
          />
        </div>
      </div>

      <BoardStatusBar counts={counts} urgent={urgentTableCount(data.tables)} />

      {visible.length === 0 ? (
        <EmptyState
          title={t(
            data.tables.length === 0
              ? "floor.error.emptyTitle"
              : "floor.error.emptyZoneTitle",
          )}
          description={t(
            data.tables.length === 0
              ? "floor.error.emptyHint"
              : "floor.error.emptyZoneHint",
          )}
        />
      ) : (
        <ul className="grid min-w-0 list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
          {visible.map((row) => (
            <li key={row.table.id} className="min-w-0">
              <TableCard
                row={row}
                now={now}
                shared={isShared(row)}
                selected={row.table.id === selectedId}
                onSelect={() => setSelectedId(row.table.id)}
              />
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs text-muted-foreground">{t("floor.autoRefresh")}</p>

      <TableActionsPanel
        row={selected}
        board={data}
        zones={zones}
        now={now}
        open={selected !== null}
        canManage={canManage}
        onOpenChange={(next) => {
          if (!next) setSelectedId(null);
        }}
      />
    </div>
  );
}
