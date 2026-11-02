// Board status shown as icon + text, never color alone (DESIGN.md §4, WCAG
// 1.4.1). Built from the design-system Badge; the label comes from the catalog
// so PRD terminology ("perlu dibersihkan", "menunggu tagihan") stays one home.
import {
  CalendarClock,
  CircleAlert,
  CircleCheck,
  ClipboardList,
  PowerOff,
  ReceiptText,
  Sparkles,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useT } from "@/components/i18n";
import { Badge, StatusPill } from "@/components/ui/badge";
import {
  TABLE_BOARD_STATUSES,
  type TableBoardStatus,
} from "@starter/shared/qr-order";
import { boardStatusLabel } from "../lib";

type Style = {
  tone: "neutral" | "brand" | "success" | "warning" | "danger" | "info";
  icon: LucideIcon;
};

const STYLE: Record<TableBoardStatus, Style> = {
  available: { tone: "success", icon: CircleCheck },
  seated: { tone: "info", icon: Users },
  awaiting_order: { tone: "warning", icon: ClipboardList },
  // A requested bill is calm attention, not the urgent state (Q25).
  awaiting_bill: { tone: "warning", icon: ReceiptText },
  needs_cleaning: { tone: "neutral", icon: Sparkles },
  reserved: { tone: "brand", icon: CalendarClock },
  awaiting_confirmation: { tone: "warning", icon: CircleAlert },
  inactive: { tone: "neutral", icon: PowerOff },
};

export function BoardStatusBadge({
  status,
  className,
}: {
  status: TableBoardStatus;
  className?: string;
}) {
  const t = useT();
  const { tone, icon: Icon } = STYLE[status];
  return (
    <Badge tone={tone} className={className}>
      <Icon aria-hidden="true" />
      {boardStatusLabel(status, t)}
    </Badge>
  );
}

/** The six PRD states (plus confirmation and inactive) with outlet counts. */
export function BoardLegend({
  counts,
}: {
  counts: Record<TableBoardStatus, number>;
}) {
  const t = useT();
  return (
    <ul
      aria-label={t("floor.legend")}
      className="flex flex-wrap items-center gap-x-4 gap-y-2"
    >
      {TABLE_BOARD_STATUSES.map((status) => (
        <li key={status} className="flex items-center gap-1.5">
          <BoardStatusBadge status={status} />
          <span
            className="text-sm text-muted-foreground tabular"
            aria-label={t("floor.legendCount", {
              status: boardStatusLabel(status, t),
              count: counts[status],
            })}
          >
            {counts[status]}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Status bar on `surface-2` (DESIGN v2 "Operations — status hierarchy"):
 * "Perlu tindakan" first, with the solid pill for open waiter calls (Q25),
 * then the full legend with tinted status pills.
 */
export function BoardStatusBar({
  counts,
  urgent,
}: {
  counts: Record<TableBoardStatus, number>;
  /** Tables with an open waiter call. */
  urgent: number;
}) {
  const t = useT();
  return (
    <div
      data-slot="board-status-bar"
      className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-container bg-surface-2 p-3"
    >
      <span className="flex flex-wrap items-center gap-2">
        <span className="type-eyebrow text-muted-foreground">
          {t("floor.attention.title")}
        </span>
        {urgent > 0 ? (
          <StatusPill status="danger" solid>
            {t("floor.attention.urgent", { count: urgent })}
          </StatusPill>
        ) : (
          <span className="text-sm text-muted-foreground">
            {t("floor.attention.clear")}
          </span>
        )}
      </span>
      <BoardLegend counts={counts} />
    </div>
  );
}
