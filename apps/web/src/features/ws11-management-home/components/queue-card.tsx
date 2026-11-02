// One queue card: what the person works through, in a v3 double shell
// (DESIGN.md §4). The card never shows a count it does not have — the queue
// rows arrive with the dashboard API — so it states which list it is and links
// to the report behind its numbers (DASH-01).
import { Link } from "@tanstack/react-router";
import { FileText } from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardShell,
  CardShellFooter,
  CardTitle,
} from "@/components/ui/card";
import {
  dashboardTileReport,
  type DashboardTile,
} from "@starter/shared/dashboard";
import { QUEUE_ICONS } from "../icons";
import { tileKindKey, QUEUE_HINT_KEYS, QUEUE_LABEL_KEYS } from "../labels";
import { queueOf } from "../lib";
import { contractHref } from "./href";

export function QueueCard({
  tile,
  /** Cards under a section that already names the list skip the title. */
  hideTitle = false,
}: {
  tile: DashboardTile;
  hideTitle?: boolean;
}) {
  const t = useT();
  const queue = queueOf(tile);
  const report = dashboardTileReport(tile);
  const Icon = queue !== null ? QUEUE_ICONS[queue] : FileText;
  return (
    <CardShell>
      <Card className="gap-2.5">
        <div className="flex items-center justify-between gap-2">
          <Badge tone="neutral">
            <Icon aria-hidden="true" />
            {t(tileKindKey(tile))}
          </Badge>
          {queue !== null && (
            <span className="type-eyebrow text-muted-foreground">
              {t(QUEUE_LABEL_KEYS[queue])}
            </span>
          )}
        </div>
        {!hideTitle && <CardTitle>{tile.title}</CardTitle>}
        {queue !== null && (
          <p className="text-sm leading-5 text-muted-foreground">
            {t(QUEUE_HINT_KEYS[queue])}
          </p>
        )}
      </Card>
      {report !== null && (
        <CardShellFooter>
          <span>{t("managementHome.sourceLabel")}</span>
          <Link
            to={contractHref(report.route)}
            className="font-semibold text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {report.name}
          </Link>
        </CardShellFooter>
      )}
    </CardShell>
  );
}
