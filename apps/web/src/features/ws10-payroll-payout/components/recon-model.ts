// Pure helpers of the recon flag screen: what a flag's status is, which slips
// a batch still holds, and which flag the panel opens. No React, no fetching.
import type { MessageKey } from "@starter/shared/i18n";
import type {
  PayoutReconFlagDto,
  PayrollDisbursementItemDto,
} from "@starter/shared/types";

export type ReconStatus = "open" | "proposed" | "approved" | "reopened";
export type ReconTone = "neutral" | "info" | "warning" | "success";

/** The list API returns at most this many flags and does not say if it cut. */
export const RECON_LIST_LIMIT = 200;
export const REASON_MIN = 10;
export const REASON_MAX = 500;

/**
 * One status per flag. A flag with a proposal for the current data reads
 * Diusulkan or Disetujui even when `reopened` is also true (the reopened mark
 * stays visible next to it, see `isReopenedNotice`). Without a proposal a
 * reopened flag reads Terbuka ulang.
 */
export function reconStatus(
  flag: Pick<PayoutReconFlagDto, "clearance" | "reopened">,
): ReconStatus {
  if (flag.clearance?.status === "approved") return "approved";
  if (flag.clearance?.status === "proposed") return "proposed";
  return flag.reopened ? "reopened" : "open";
}

export const RECON_STATUS_META: Record<
  ReconStatus,
  { labelKey: MessageKey; tone: ReconTone }
> = {
  open: { labelKey: "payrollPayoutReview.recon.status.open", tone: "warning" },
  proposed: {
    labelKey: "payrollPayoutReview.recon.status.proposed",
    tone: "info",
  },
  approved: {
    labelKey: "payrollPayoutReview.recon.status.approved",
    tone: "success",
  },
  reopened: {
    labelKey: "payrollPayoutReview.recon.status.reopened",
    tone: "warning",
  },
};

/** An approved clearance for the current data is the only thing that releases a slip. */
export function isHeld(
  flag: Pick<PayoutReconFlagDto, "clearance" | "reopened">,
): boolean {
  return reconStatus(flag) !== "approved";
}

/** The old clearance no longer applies and nothing approved replaces it. */
export function isReopenedNotice(
  flag: Pick<PayoutReconFlagDto, "clearance" | "reopened">,
): boolean {
  return flag.reopened && flag.clearance?.status !== "approved";
}

/** Distinct payslips held by flags not yet approved (one slip may carry several flags). */
export function heldPayslipIds(flags: readonly PayoutReconFlagDto[]): string[] {
  return [
    ...new Set(flags.filter((flag) => isHeld(flag)).map((f) => f.payslipId)),
  ];
}

/** Flags grouped by batch, in the order the API gave them (newest first). */
export function batchIdsOf(flags: readonly PayoutReconFlagDto[]): string[] {
  return [...new Set(flags.map((flag) => flag.batchId))];
}

/** The item a flag marks, matched by id inside its batch; null when unknown. */
export function itemOfFlag(
  items: readonly PayrollDisbursementItemDto[] | undefined,
  flag: Pick<PayoutReconFlagDto, "itemId">,
): PayrollDisbursementItemDto | null {
  return items?.find((item) => item.id === flag.itemId) ?? null;
}

/**
 * Salary (net) of the held slips: one amount per payslip, so two flags on the
 * same slip do not count it twice. Null when any held item is not readable;
 * a failed read never turns into Rp0.
 */
export function heldSlipValue(
  flags: readonly PayoutReconFlagDto[],
  items: readonly PayrollDisbursementItemDto[] | undefined,
): number | null {
  if (!items) return null;
  const byPayslip = new Map<string, number>();
  for (const flag of flags) {
    if (!isHeld(flag) || byPayslip.has(flag.payslipId)) continue;
    const item = itemOfFlag(items, flag);
    if (!item) return null;
    byPayslip.set(flag.payslipId, item.amountIdr);
  }
  return [...byPayslip.values()].reduce((sum, value) => sum + value, 0);
}

/** The flag the panel opens first: one still held (open, reopened, proposed), else the first. */
export function defaultFlagId(
  flags: readonly PayoutReconFlagDto[],
): string | undefined {
  return (flags.find((flag) => isHeld(flag)) ?? flags[0])?.id;
}

/** True when this user made the proposal. Compared by user id, never by name. */
export function isOwnProposal(
  flag: Pick<PayoutReconFlagDto, "clearance">,
  currentUserId: string,
): boolean {
  return (
    flag.clearance?.status === "proposed" &&
    currentUserId !== "" &&
    flag.clearance.proposedBy === currentUserId
  );
}

/** The reason the way the server sees it: trimmed at both ends. */
export function reasonProblem(reason: string): boolean {
  const length = reason.trim().length;
  return length < REASON_MIN || length > REASON_MAX;
}

/** Short, distinguishable reference for an id the screen cannot name. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** One message above the panel; replaced by the next action or dismissed. */
export type ReconNotice =
  | { kind: "sent"; flagId: string }
  | { kind: "approved"; flagId: string }
  /** 409 PAYOUT_RECON_FLAG_CHANGED: the proposal is for older data. */
  | { kind: "changed" }
  /** 409 PAYOUT_RECON_CLEAR_STATE: the clearance is no longer in that state. */
  | { kind: "stale" }
  | null;
