// One card per dashboard tile of the management home. The tile payload is the
// contract's own definition (title, role, metric codes, source report), so a
// card never computes or invents a figure: it shows what the tile measures,
// its period and the report the number drills into (DASH-01).
import { Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  dashboardTileReport,
  type DashboardTile,
  type ReportPeriodPreset,
} from "@starter/shared/dashboard";
import { metricLines, queueOf } from "../lib";
import {
  PERIOD_LABEL_KEYS,
  QUEUE_LABEL_KEYS,
  tileKindKey,
  UNIT_LABEL_KEYS,
} from "../labels";
import { tileIcon } from "../icons";
import { contractHref } from "./href";

function SourceLine({ tile }: { tile: DashboardTile }) {
  const t = useT();
  const report = dashboardTileReport(tile);
  if (report === null) return null;
  return (
    <p className="mt-auto text-sm leading-5 text-muted-foreground">
      {t("managementHome.sourceLabel")}{" "}
      <Link
        to={contractHref(report.route)}
        className="font-semibold text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {report.name}
        <ArrowUpRight className="ml-0.5 inline size-3.5" aria-hidden="true" />
      </Link>
    </p>
  );
}

function KindBadge({ tile }: { tile: DashboardTile }) {
  const t = useT();
  const Icon = tileIcon(tile);
  return (
    <Badge tone="neutral">
      <Icon aria-hidden="true" />
      {t(tileKindKey(tile))}
    </Badge>
  );
}

function PeriodLabel({ period }: { period: ReportPeriodPreset }) {
  const t = useT();
  return (
    <span className="text-xs leading-4 font-medium text-muted-foreground tabular">
      {t(PERIOD_LABEL_KEYS[period])}
    </span>
  );
}

/** KPI tile: the registry rows it cites (name + unit) and its period. */
export function MetricTileCard({ tile }: { tile: DashboardTile }) {
  const t = useT();
  const lines = metricLines(tile);
  return (
    <Card className="gap-3">
      <div className="flex items-center justify-between gap-2">
        <KindBadge tile={tile} />
        {tile.kind === "metric" && <PeriodLabel period={tile.period} />}
      </div>
      <h4 className="text-(length:--density-text) leading-6 font-semibold">
        {tile.title}
      </h4>
      {lines.length > 0 && (
        <dl className="grid gap-1 text-sm leading-5">
          {lines.map((line) => (
            <div key={line.code} className="flex items-baseline gap-3">
              <dt className="min-w-0 flex-1 text-muted-foreground">
                {line.name}
              </dt>
              <dd className="shrink-0 text-xs text-muted-foreground">
                {t(UNIT_LABEL_KEYS[line.unit])}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <SourceLine tile={tile} />
    </Card>
  );
}

/** Queue tile: the list this role works through and where its numbers live. */
export function QueueTileCard({ tile }: { tile: DashboardTile }) {
  const t = useT();
  const queue = queueOf(tile);
  return (
    <Card className="gap-3">
      <div className="flex items-center justify-between gap-2">
        <KindBadge tile={tile} />
        {queue !== null && (
          <span className="text-xs leading-4 font-medium text-muted-foreground">
            {t(QUEUE_LABEL_KEYS[queue])}
          </span>
        )}
      </div>
      <h4 className="text-(length:--density-text) leading-6 font-semibold">
        {tile.title}
      </h4>
      {tile.section === "approvals" && (
        <p className="text-sm leading-5 text-muted-foreground">
          {t("managementHome.approvalsNote")}
        </p>
      )}
      <SourceLine tile={tile} />
    </Card>
  );
}

export function TileCard({ tile }: { tile: DashboardTile }) {
  return tile.kind === "metric" ? (
    <MetricTileCard tile={tile} />
  ) : (
    <QueueTileCard tile={tile} />
  );
}
