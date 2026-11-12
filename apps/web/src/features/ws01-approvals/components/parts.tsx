// Small shared pieces of the approval inbox: source badge, status, countdown,
// requester name and the proposed-change rows.
import * as React from "react";
import {
  CircleCheck,
  CircleSlash,
  Clock,
  Plug,
  Sparkles,
  TimerOff,
  TriangleAlert,
  User,
  type LucideIcon,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import type { ApprovalSource } from "@starter/shared/access";
import type {
  ApprovalRequest,
  ApprovalRequestStatus,
} from "@starter/shared/identity";
import { isMessageKey, type MessageKey } from "@starter/shared/i18n";
import { useT } from "@/components/i18n";
import { Badge } from "@/components/ui/badge";
import { Money } from "@/components/ui/money";
import { assignablePeopleQuery } from "@/features/ws01-access/people";
import { approvalAmountIdr, CASH_SHIFT_CLOSE } from "../approval-amount.ts";
import { useCurrentAuth } from "../hooks.ts";
import {
  deadlineInfo,
  deadlineLabelKey,
  diffRows,
  humanizeKey,
  isAgentDraft,
  isOwnRequest,
  shortId,
  statusLabelKey,
  type DiffRow,
} from "../logic.ts";

const SOURCE_ICON: Record<ApprovalSource, LucideIcon> = {
  user: User,
  ai: Sparkles,
  mcp: Plug,
};
const SOURCE_TONE = { user: "neutral", ai: "info", mcp: "brand" } as const;

/**
 * Who proposed it: a person, or a draft from the AI assistant or an MCP agent
 * (PRD §4 Q, F38 Draf Aksi). Agent rows read "Draf AI" / "Draf MCP" so a draft
 * is never mistaken for something already done.
 */
export function SourceBadge({ source }: { source: ApprovalSource }) {
  const t = useT();
  const Icon = SOURCE_ICON[source];
  return (
    <Badge tone={SOURCE_TONE[source]} data-source={source}>
      <Icon aria-hidden="true" />
      {t(`approvals.sourceBadge.${source}` as MessageKey)}
    </Badge>
  );
}

/**
 * PRD §2 "AI membantu, manusia memutuskan": states plainly that an agent only
 * proposed this, on whose behalf, and that nothing runs until a human approves.
 */
export function AgentDraftNotice({
  source,
  onBehalfOf,
}: {
  source: ApprovalSource;
  onBehalfOf: string;
}) {
  const t = useT();
  if (!isAgentDraft(source)) return null;
  const Icon = SOURCE_ICON[source];
  return (
    <div
      role="note"
      data-testid="agent-draft-notice"
      className="grid gap-1 rounded-container border-(length:--border-w) bg-surface-2 p-3"
    >
      <p className="flex items-center gap-2 text-sm font-semibold">
        <Icon className="size-4" aria-hidden="true" />
        {t(`approvals.agentDraft.title.${source}` as MessageKey)}
      </p>
      <p className="text-sm text-muted-foreground">
        {t("approvals.agentDraft.body", { name: onBehalfOf })}
      </p>
    </div>
  );
}

const STATUS_VIEW: Record<
  ApprovalRequestStatus,
  { icon: LucideIcon; tone: "warning" | "success" | "danger" | "neutral" }
> = {
  pending: { icon: Clock, tone: "warning" },
  approved: { icon: CircleCheck, tone: "success" },
  rejected: { icon: CircleSlash, tone: "danger" },
  expired: { icon: TimerOff, tone: "neutral" },
  cancelled: { icon: CircleSlash, tone: "neutral" },
};

export function RequestStatusBadge({
  status,
}: {
  status: ApprovalRequestStatus;
}) {
  const t = useT();
  const { icon: Icon, tone } = STATUS_VIEW[status];
  return (
    <Badge tone={tone}>
      <Icon aria-hidden="true" />
      {t(statusLabelKey(status))}
    </Badge>
  );
}

/** Countdown to the deadline, or "terlambat" once it passed (never colour only). */
export function Deadline({
  request,
  now,
}: {
  request: Pick<ApprovalRequest, "status" | "deadlineAt">;
  now: number;
}) {
  const t = useT();
  const info = deadlineInfo(request, now);
  if (info.state === "closed")
    return (
      <span className="text-sm text-muted-foreground">
        {t("approvals.deadline.closed")}
      </span>
    );
  const tone =
    info.state === "overdue"
      ? "text-danger"
      : info.state === "urgent"
        ? "text-warning"
        : "text-foreground";
  const Icon = info.state === "open" ? Clock : TriangleAlert;
  return (
    <span
      data-deadline={info.state}
      className={`inline-flex items-center gap-1 text-sm font-semibold tabular ${tone}`}
    >
      <Icon className="size-4" aria-hidden="true" />
      {t(deadlineLabelKey(info), { amount: info.amount })}
    </span>
  );
}

/** Display name for a user id; the directory may be empty on a real API. */
export function useRequesterName(userId: string): string {
  const t = useT();
  const people = useQuery(assignablePeopleQuery());
  const person = people.data?.people.find(
    (row) => row.id.toLowerCase() === userId.toLowerCase(),
  );
  return (
    person?.name ?? t("approvals.requesterUnknown", { id: shortId(userId) })
  );
}

/**
 * The rupiah figure for a request, as the signed-in user may see it (legend-6om3).
 * A shift close shows its cash difference to the approver only; while the
 * signed-in user is not known yet it is treated as the requester (fail closed).
 */
export function useApprovalAmount(
  request: Pick<
    ApprovalRequest,
    "actionType" | "amountIdr" | "payload" | "requestedBy"
  >,
): { amount: number | null; isShiftClose: boolean; isRequester: boolean } {
  const userId = useCurrentAuth().data?.data.user.id ?? null;
  const own = isOwnRequest(request, userId);
  const isShiftClose = request.actionType === CASH_SHIFT_CLOSE;
  const isRequester = own || (isShiftClose && userId === null);
  return {
    amount: approvalAmountIdr(
      {
        action: request.actionType,
        amountIdr: request.amountIdr,
        payload: request.payload,
      },
      isRequester ? "requester" : "approver",
    ),
    isShiftClose,
    isRequester,
  };
}

/** The shift-close difference is shown on its own line, never as a payload row. */
export function withoutShiftValue(
  rows: DiffRow[],
  actionType: ApprovalRequest["actionType"],
): DiffRow[] {
  return actionType === CASH_SHIFT_CLOSE
    ? rows.filter((row) => row.key !== "valueIdr")
    : rows;
}

/**
 * The shift-close difference is an absolute amount (the API stores
 * `Math.abs(variance)`): direction (short or over) is not in the payload, so
 * it is shown neutral, never signed or red.
 */
export function ShiftDifference({
  amount,
  size = "lg",
}: {
  amount: number;
  size?: "md" | "lg";
}) {
  return <Money amount={amount} size={size} />;
}

export function useDiffRows(payload: ApprovalRequest["payload"]): DiffRow[] {
  const t = useT();
  return React.useMemo(
    () =>
      diffRows(
        payload,
        (key) => {
          const catalogKey = `approvals.field.${key}`;
          return isMessageKey(catalogKey)
            ? t(catalogKey as MessageKey)
            : humanizeKey(key);
        },
        {
          yes: t("approvals.value.yes"),
          no: t("approvals.value.no"),
          none: t("approvals.value.none"),
        },
      ),
    [payload, t],
  );
}

const INSTANT = new Intl.DateTimeFormat("id-ID", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Asia/Jakarta",
});
export const formatWhen = (value: string) => INSTANT.format(new Date(value));
