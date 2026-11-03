// PRD §3 F34 "Kualitas Layanan": items that failed after payment, remakes and
// comps, apology vouchers and checklist compliance, for the dashboard day.
import { useT } from "@/components/i18n";
import { StatStrip } from "@/components/ui/stat-tile";
import { countOf, metricCell } from "../board";
import { useOwnerBoardContext } from "../board-context";
import { useNamedRuns } from "../insights-hooks";
import { insightTile, INSIGHT_TILE } from "../insights";
import { BoardEmpty, BoardError, TileSkeleton } from "./board-widget";
import { dayRunsFor } from "./day-runs";
import { InsightTile } from "./insight-tile";

export function ServiceQualitySection() {
  const t = useT();
  const { layout } = useOwnerBoardContext();
  const keys = {
    failed: INSIGHT_TILE.failedItems,
    remake: INSIGHT_TILE.remakeComp,
    apology: INSIGHT_TILE.apologyVouchers,
    checklist: INSIGHT_TILE.checklist,
  };
  const { runs, all } = useNamedRuns(
    dayRunsFor(layout, keys, {
      failed: "operations.failed_items",
      remake: "operations.remake_comp",
      apology: "operations.failed_items",
      checklist: "performance.checklist",
    }),
  );
  if (all.status === "error") return <BoardError retry={all.retry} />;
  if (all.status === "empty") return <BoardEmpty retry={all.retry} />;
  if (all.status === "loading")
    return (
      <div className="grid gap-5">
        <TileSkeleton />
      </div>
    );
  const today = t("ownerDashboard.todayShort");
  const tile = (key: string) => insightTile(layout, key);
  const failed = tile(keys.failed);
  const remake = tile(keys.remake);
  const apology = tile(keys.apology);
  const checklist = tile(keys.checklist);
  const comp = countOf(metricCell(runs.remake.result, "comp_count"));
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      <StatStrip label={t("ownerInsights.service.stripLabel")} columns={4}>
        {failed && (
          <InsightTile
            tile={failed}
            state={runs.failed}
            metricCode="failed_item_count"
            label={t("ownerInsights.service.failed")}
            period={today}
            context={t("ownerInsights.service.failedContext")}
          />
        )}
        {remake && (
          <InsightTile
            tile={remake}
            state={runs.remake}
            metricCode="remake_count"
            label={t("ownerInsights.service.remake")}
            period={today}
            context={
              comp === null
                ? undefined
                : t("ownerInsights.service.remakeContext", { count: comp })
            }
          />
        )}
        {apology && (
          <InsightTile
            tile={apology}
            state={runs.apology}
            metricCode="apology_voucher_count"
            label={t("ownerInsights.service.apology")}
            period={today}
            context={t("ownerInsights.service.apologyContext")}
          />
        )}
        {checklist && (
          <InsightTile
            tile={checklist}
            state={runs.checklist}
            metricCode="checklist_compliance_pct"
            label={t("ownerInsights.service.checklist")}
            period={today}
            context={t("ownerInsights.service.checklistContext")}
          />
        )}
      </StatStrip>
    </div>
  );
}
