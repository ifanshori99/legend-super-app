// Shared pieces of the AI action request screens: status badge, the
// "Dibantu AI" label and the draft summary (label/value lines, with a
// before/after diff when a value is a change).
import {
  BadgeCheck,
  CircleCheck,
  CircleSlash,
  Clock,
  TimerOff,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type { ActionRequestStatus } from "@starter/shared/ai";
import type { MessageKey } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import {
  actionStatusView,
  splitChange,
  type ActionStatusTone,
} from "../logic.ts";

const STATUS_ICON: Record<ActionRequestStatus, LucideIcon> = {
  pending: Clock,
  approved: BadgeCheck,
  executed: CircleCheck,
  rejected: CircleSlash,
  failed: TriangleAlert,
  expired: TimerOff,
};
const BADGE_TONE = {
  waiting: "warning",
  info: "info",
  success: "success",
  danger: "danger",
  muted: "neutral",
} as const satisfies Record<ActionStatusTone, string>;

/** Status as icon + text, never colour alone. */
export function ActionStatusBadge({ status }: { status: ActionRequestStatus }) {
  const t = useT();
  const view = actionStatusView(status);
  const Icon = STATUS_ICON[status];
  return (
    <Badge tone={BADGE_TONE[view.tone]} data-status={status}>
      <Icon aria-hidden="true" />
      {t(view.labelKey as MessageKey)}
    </Badge>
  );
}

/** The "Dibantu AI" label every AI-made draft carries. */
export function AiLabel() {
  const t = useT();
  return (
    <p className="type-eyebrow text-muted-foreground">
      {t("aiAction.aiLabel")}
    </p>
  );
}

/** Label/value lines of the draft; "a → b" values read as a change. */
export function DraftLines({
  lines,
  className,
}: {
  lines: readonly { label: string; value: string }[];
  className?: string;
}) {
  const t = useT();
  return (
    <dl className={className ?? "divide-y"} data-testid="ai-action-summary">
      {lines.map((line, index) => {
        const change = splitChange(line.value);
        return (
          <div
            key={`${line.label}-${index}`}
            className="flex flex-wrap items-baseline justify-between gap-x-5 gap-y-1 py-2.5 text-sm"
          >
            <dt className="text-muted-foreground">{line.label}</dt>
            <dd className="min-w-0 text-right font-semibold break-words">
              {change ? (
                <span className="flex flex-wrap items-center justify-end gap-2">
                  <span className="rounded-field bg-danger-subtle px-2 py-0.5 text-danger line-through">
                    <span className="sr-only">
                      {t("aiAction.summary.before")}{" "}
                    </span>
                    {change.before}
                  </span>
                  <span aria-hidden="true">→</span>
                  <span className="rounded-field bg-success-subtle px-2 py-0.5 text-success">
                    <span className="sr-only">
                      {t("aiAction.summary.after")}{" "}
                    </span>
                    {change.after}
                  </span>
                </span>
              ) : (
                line.value
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

const INSTANT = new Intl.DateTimeFormat("id-ID", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Asia/Jakarta",
});
export const formatWhen = (value: string) => INSTANT.format(new Date(value));
