// One request in "Pengajuan saya" (mockups kosong-mobile, ditolak-mobile): the
// status as icon + text (never color alone), the title, the period and when it
// was submitted/decided. The contract carries no rejection reason for leave,
// overtime or swaps, so none is shown (see the report of bead legend-ydf2).
import {
  Ban,
  CircleCheck,
  CircleX,
  Clock,
  TimerOff,
  type LucideIcon,
} from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  formatInstantDate,
  formatPeriod,
  type MyRequestItem,
  type MyRequestStatus,
} from "./my-requests-model.ts";

const STATUS_VIEW: Record<
  MyRequestStatus,
  {
    tone: "neutral" | "success" | "warning" | "danger";
    icon: LucideIcon;
  }
> = {
  pending: { tone: "warning", icon: Clock },
  approved: { tone: "success", icon: CircleCheck },
  rejected: { tone: "danger", icon: CircleX },
  cancelled: { tone: "neutral", icon: Ban },
  expired: { tone: "neutral", icon: TimerOff },
};

export function MyRequestCard({ item }: { item: MyRequestItem }) {
  const t = useT();
  const view = STATUS_VIEW[item.status];
  const Icon = view.icon;
  const title = item.title ?? t(`hrisRequestsMine.kind.${item.kind}`);
  const period =
    item.startDate && item.endDate
      ? formatPeriod(item.startDate, item.endDate)
      : null;
  const quantity =
    item.days !== null
      ? t("hrisRequestsMine.card.days", { days: item.days })
      : item.minutes !== null
        ? t("hrisRequestsMine.card.minutes", { minutes: item.minutes })
        : null;
  return (
    <Card className="gap-3" data-status={item.status}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={view.tone}>
          <Icon aria-hidden="true" />
          {t(`hrisRequestsMine.status.${item.status}`)}
        </Badge>
        {item.title !== null && (
          <span className="text-xs leading-5 text-muted-foreground">
            {t(`hrisRequestsMine.kind.${item.kind}`)}
          </span>
        )}
      </div>
      <div className="grid gap-0.5">
        <h2 className="text-lg leading-6 font-bold">{title}</h2>
        {period && <p className="text-base leading-6">{period}</p>}
        {quantity && (
          <p className="text-sm leading-5 text-muted-foreground">{quantity}</p>
        )}
      </div>
      <div className="grid gap-0.5 border-t border-border pt-3 text-sm leading-5 text-muted-foreground">
        <p>
          {t("hrisRequestsMine.card.submitted", {
            date: formatInstantDate(item.submittedAt),
          })}
        </p>
        {item.decidedAt && (
          <p>
            {t("hrisRequestsMine.card.decided", {
              date: formatInstantDate(item.decidedAt),
            })}
          </p>
        )}
        {item.status === "rejected" && (
          <p>{t("hrisRequestsMine.card.rejectedHint")}</p>
        )}
        {item.status === "pending" &&
          (item.kind === "swap" || item.kind === "cover") && (
            <p>{t("hrisRequestsMine.card.swapWaiting")}</p>
          )}
      </div>
    </Card>
  );
}
