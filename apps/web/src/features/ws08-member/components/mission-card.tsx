import { CircleCheck, Gift, Stamp } from "lucide-react";
import { formatNumber, formatRupiah } from "@starter/shared/i18n";
import type { MissionRule, MissionWithProgress } from "@starter/shared/crm";
import { cn } from "cn";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { formatMemberDate } from "../format";
import { ProgressMeter } from "./progress-meter";

function targetOf(rule: MissionRule): number {
  switch (rule.kind) {
    case "visit_count":
      return rule.targetVisits;
    case "weekday_visit":
      return rule.targetVisits;
    case "try_new_item":
      return rule.targetItems;
    case "stamp_card":
      return rule.stampsRequired;
  }
}

// Mission card (PRD §3.20 "Mission"): behaviour challenge with its progress,
// digital stamp card included. Progress and completion come from the server;
// the card only renders them.
export function MissionCard({ item }: { item: MissionWithProgress }) {
  const t = useT();
  const { mission, progress } = item;
  const target = targetOf(mission.rule);
  const current = progress?.progress ?? 0;
  const completed = progress?.completedAt != null;
  const rewardIssued = progress?.rewardIssuedAt != null;
  const period =
    mission.period.kind === "monthly"
      ? t("member.missions.periodMonthly")
      : mission.period.kind === "weekly"
        ? t("member.missions.periodWeekly")
        : t("member.missions.periodRange", {
            start: formatMemberDate(`${mission.period.start}T00:00:00.000Z`),
            end: formatMemberDate(`${mission.period.end}T00:00:00.000Z`),
          });
  const reward =
    mission.reward.kind === "points"
      ? t("member.missions.rewardPoints", {
          points: formatNumber(mission.reward.points),
        })
      : t("member.missions.rewardVoucher", {
          value: formatRupiah(mission.reward.valueIdr),
        });

  return (
    <Card className="gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="brand">
          <Stamp aria-hidden="true" />
          {t(`member.missions.type.${mission.type}`)}
        </Badge>
        <span className="text-xs leading-4 text-muted-foreground">
          {period}
        </span>
        {completed && (
          <Badge tone="success" className="ml-auto">
            <CircleCheck aria-hidden="true" />
            {t("member.missions.completed")}
          </Badge>
        )}
      </div>

      <div className="grid gap-1">
        <h3 className="type-heading">{mission.name}</h3>
        <p className="text-sm leading-5 text-muted-foreground">
          {mission.description}
        </p>
      </div>

      {mission.rule.kind === "stamp_card" ? (
        <div className="grid gap-2">
          <ol className="flex flex-wrap gap-1.5" aria-hidden="true">
            {Array.from({ length: target }, (_, index) => (
              <li
                key={index}
                className={cn(
                  "grid size-6 place-items-center rounded-full border-(length:--border-w)",
                  index < current
                    ? "border-foreground bg-foreground text-background"
                    : "border-border bg-surface-2 text-muted-foreground",
                )}
              >
                <Stamp className="size-3" />
              </li>
            ))}
          </ol>
          <p className="text-sm leading-5 font-medium text-muted-foreground">
            {t("member.missions.stamps", {
              current: formatNumber(current),
              target: formatNumber(target),
            })}
          </p>
        </div>
      ) : progress === null ? (
        <p className="text-sm leading-5 font-medium text-muted-foreground">
          {t("member.missions.start")}
        </p>
      ) : (
        <div className="grid gap-1.5">
          <ProgressMeter
            value={current}
            max={target}
            label={t("member.missions.progress", {
              current: formatNumber(current),
              target: formatNumber(target),
            })}
            tone={completed ? "success" : "brand"}
          />
          <p className="text-sm leading-5 font-medium text-muted-foreground">
            {t("member.missions.progress", {
              current: formatNumber(current),
              target: formatNumber(target),
            })}
          </p>
        </div>
      )}

      <p className="flex items-center gap-1.5 text-sm leading-5 font-medium">
        <Gift
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        {reward}
      </p>
      {rewardIssued && (
        <p className="text-sm leading-5 text-success">
          {t("member.missions.rewardIssued")}
        </p>
      )}
    </Card>
  );
}
