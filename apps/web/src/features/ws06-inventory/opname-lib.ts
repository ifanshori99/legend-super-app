// Pure rules for the stock-opname and waste screens (bead legend-fzx). Kept
// separate from lib.ts / stock-lib.ts so the parallel WS-06 FE beads never
// edited one helper file; formatting and list paging come from those modules.
import { formatDecimal4, parseDecimal4 } from "@starter/shared/core";
import type {
  StockCount,
  StockCountAction,
  StockCountLine,
  StockCountStatus,
  StockCountType,
  WasteLog,
  WasteReason,
  WasteTargetType,
} from "@starter/shared/inventory";
import type { MessageKey } from "@starter/shared/i18n";
import { formatQuantity } from "./stock-lib.ts";

export type CountCapabilities = {
  /** inventory.opname.count — start, enter lines, submit, cancel. */
  readonly canCount: boolean;
  /** inventory.adjustment.approve — approve, reject, post. */
  readonly canApprove: boolean;
};

export const NO_COUNT_CAPABILITIES: CountCapabilities = {
  canCount: false,
  canApprove: false,
};

const STATUS_KEY: Record<StockCountStatus, MessageKey> = {
  draft: "opname.status.draft",
  counting: "opname.status.counting",
  pending_approval: "opname.status.pending_approval",
  approved: "opname.status.approved",
  posted: "opname.status.posted",
  cancelled: "opname.status.cancelled",
};

const TYPE_KEY: Record<StockCountType, MessageKey> = {
  full: "opname.type.full",
  cycle: "opname.type.cycle",
};

const TYPE_HINT_KEY: Record<StockCountType, MessageKey> = {
  full: "opname.typeHint.full",
  cycle: "opname.typeHint.cycle",
};

export function statusLabelKey(status: StockCountStatus): MessageKey {
  return STATUS_KEY[status];
}

export function typeLabelKey(type: StockCountType): MessageKey {
  return TYPE_KEY[type];
}

export function typeHintKey(type: StockCountType): MessageKey {
  return TYPE_HINT_KEY[type];
}

export type CountFilter = "all" | "active" | "pending" | "done";

/** Which list filter a status belongs to. */
export function statusGroup(
  status: StockCountStatus,
): Exclude<CountFilter, "all"> {
  if (status === "draft" || status === "counting") return "active";
  if (status === "pending_approval") return "pending";
  return "done";
}

export function countProgress(lines: readonly StockCountLine[]): {
  counted: number;
  total: number;
  complete: boolean;
} {
  const total = lines.length;
  const counted = lines.filter((line) => line.countedQty !== null).length;
  return { counted, total, complete: total > 0 && counted === total };
}

/**
 * Actions the current visitor may take. Mirrors the contract's state machine
 * and INV-03: a counter never approves their own count, even when they hold
 * the approval permission.
 *
 * `actorId` is the signed-in user id. Mock mode has no Legend session yet, so
 * it passes `undefined`; the API and the mock still enforce INV-03.
 */
export function allowedCountActions(
  count: Pick<StockCount, "status" | "countedBy">,
  lines: readonly StockCountLine[],
  actorId: string | undefined,
  capabilities: CountCapabilities,
): StockCountAction[] {
  const { canCount, canApprove } = capabilities;
  switch (count.status) {
    case "draft":
      return canCount ? ["start", "cancel"] : [];
    case "counting": {
      const actions: StockCountAction[] = [];
      if (canCount && countProgress(lines).complete) actions.push("submit");
      if (canCount) actions.push("cancel");
      return actions;
    }
    case "pending_approval": {
      if (!canApprove) return [];
      const actions: StockCountAction[] = [];
      if (canApproveCount(count, actorId)) actions.push("approve");
      actions.push("reject", "cancel");
      return actions;
    }
    case "approved":
      return canApprove ? ["post"] : [];
    default:
      return [];
  }
}

/** INV-03: approval needs a submitted count and a different person. */
export function canApproveCount(
  count: Pick<StockCount, "status" | "countedBy">,
  actorId: string | undefined,
): boolean {
  if (count.status !== "pending_approval") return false;
  if (actorId === undefined) return true;
  return count.countedBy.toLowerCase() !== actorId.toLowerCase();
}

/**
 * A blind count hides the system quantity while it is still being counted
 * (PRD §16 "hitung buta"). Once submitted, the approver sees the variance.
 */
export function hidesSystemQty(
  count: Pick<StockCount, "status" | "blind">,
): boolean {
  return (
    count.blind && (count.status === "draft" || count.status === "counting")
  );
}

/** counted − system in base units, or null when the line is not counted. */
export function lineDelta(line: StockCountLine): string | null {
  if (line.countedQty === null) return null;
  const delta = parseDecimal4(line.countedQty) - parseDecimal4(line.systemQty);
  return formatQuantity(formatDecimal4(delta));
}

export function lineVarianceIdr(line: StockCountLine): number | null {
  return line.varianceIdr;
}

export function varianceLineCount(lines: readonly StockCountLine[]): number {
  return lines.filter(
    (line) =>
      line.countedQty !== null &&
      lineVarianceIdr(line) !== null &&
      lineVarianceIdr(line) !== 0,
  ).length;
}

/** Total approved valuation of the variances in whole rupiah. */
export function varianceTotalIdr(lines: readonly StockCountLine[]): number {
  return lines.reduce((sum, line) => sum + (line.varianceIdr ?? 0), 0);
}

export function matchesCountSearch(
  count: StockCount,
  locationName: string,
  query: string,
): boolean {
  const needle = query.trim().toLocaleLowerCase("id-ID");
  if (needle === "") return true;
  return [locationName, count.note ?? "", count.businessDate]
    .join(" ")
    .toLocaleLowerCase("id-ID")
    .includes(needle);
}

export function countMatchesFilter(
  count: StockCount,
  filter: CountFilter,
): boolean {
  return filter === "all" || statusGroup(count.status) === filter;
}

export const WASTE_REASONS: readonly WasteReason[] = [
  "expired",
  "spoiled",
  "dropped",
  "prep_error",
  "overproduction",
  "quality_reject",
  "other",
];

const WASTE_REASON_KEY: Record<WasteReason, MessageKey> = {
  expired: "waste.reasons.expired",
  spoiled: "waste.reasons.spoiled",
  dropped: "waste.reasons.dropped",
  prep_error: "waste.reasons.prep_error",
  overproduction: "waste.reasons.overproduction",
  quality_reject: "waste.reasons.quality_reject",
  other: "waste.reasons.other",
};

export function wasteReasonKey(reason: WasteReason): MessageKey {
  return WASTE_REASON_KEY[reason];
}

const WASTE_TARGET_KEY: Record<WasteTargetType, MessageKey> = {
  inventory_item: "waste.target.inventory_item",
  menu_item: "waste.target.menu_item",
};

export function wasteTargetKey(targetType: WasteTargetType): MessageKey {
  return WASTE_TARGET_KEY[targetType];
}

export function wasteLossTotal(logs: readonly WasteLog[]): number {
  return logs.reduce((sum, log) => sum + log.valueIdr, 0);
}

export function matchesWasteSearch(
  log: WasteLog,
  targetName: string,
  query: string,
): boolean {
  const needle = query.trim().toLocaleLowerCase("id-ID");
  if (needle === "") return true;
  return [targetName, log.reason, log.note ?? "", log.occurredAt]
    .join(" ")
    .toLocaleLowerCase("id-ID")
    .includes(needle);
}
