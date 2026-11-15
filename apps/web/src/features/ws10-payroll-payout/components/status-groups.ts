// Groups payout items the way finance reads them: waiting, unknown, paid,
// paid by hand, failed. `unknown` stays its own group and never joins failed:
// the money may already have left, so it must not be paid again.
import type {
  PayrollDisbursementBatchDto,
  PayrollDisbursementItemDto,
} from "@starter/shared/types";

export type StatusGroup =
  | "waiting"
  | "unknown"
  | "succeeded"
  | "manual"
  | "failed"
  | "returned"
  | "overpaid"
  | "other";

export function itemGroup(
  item: PayrollDisbursementItemDto,
  batch: Pick<PayrollDisbursementBatchDto, "channel">,
): StatusGroup {
  switch (item.status) {
    case "prepared":
    case "approved":
    case "sending":
    case "exported":
      return "waiting";
    case "unknown":
      return "unknown";
    case "succeeded":
      return batch.channel === "duitku" ? "succeeded" : "manual";
    case "failed":
    case "not_sent":
      return "failed";
    case "returned":
      return "returned";
    case "overpaid":
      return "overpaid";
    default:
      return "other";
  }
}

export type GroupSummary = { count: number; amountIdr: number };

export function summarizeGroups(
  items: readonly PayrollDisbursementItemDto[],
  batch: Pick<PayrollDisbursementBatchDto, "channel">,
): Record<StatusGroup, GroupSummary> {
  const out: Record<StatusGroup, GroupSummary> = {
    waiting: { count: 0, amountIdr: 0 },
    unknown: { count: 0, amountIdr: 0 },
    succeeded: { count: 0, amountIdr: 0 },
    manual: { count: 0, amountIdr: 0 },
    failed: { count: 0, amountIdr: 0 },
    returned: { count: 0, amountIdr: 0 },
    overpaid: { count: 0, amountIdr: 0 },
    other: { count: 0, amountIdr: 0 },
  };
  for (const item of items) {
    const group = out[itemGroup(item, batch)];
    group.count += 1;
    group.amountIdr += item.amountIdr;
  }
  return out;
}
