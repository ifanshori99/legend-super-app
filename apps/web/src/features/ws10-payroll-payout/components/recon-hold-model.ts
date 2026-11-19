// Pure helpers of the slip-hold section on the recon screen: what status a hold
// has and who may do what. No React, no fetching. A hold keeps a slip held when
// its flag could not be written; it lifts when a later flag takes it over or
// two different people release it on clean evidence.
import type { MessageKey } from "@starter/shared/i18n";
import type { PayoutReconHoldDto } from "@starter/shared/types";
import type { ReconTone } from "./recon-model";

export type HoldStatus = "held" | "proposed" | "released" | "takenOver";

/**
 * One status per hold. A hold a later flag took over is decided by that flag;
 * otherwise an approved release lifts it, a proposed one waits for a second
 * person, and anything else keeps the slip held.
 */
export function holdStatus(
  hold: Pick<PayoutReconHoldDto, "takenOver" | "release">,
): HoldStatus {
  if (hold.takenOver) return "takenOver";
  if (hold.release?.status === "approved") return "released";
  if (hold.release?.status === "proposed") return "proposed";
  return "held";
}

export const HOLD_STATUS_META: Record<
  HoldStatus,
  { labelKey: MessageKey; tone: ReconTone }
> = {
  held: {
    labelKey: "payrollPayoutReview.reconHold.status.held",
    tone: "warning",
  },
  proposed: {
    labelKey: "payrollPayoutReview.reconHold.status.proposed",
    tone: "info",
  },
  released: {
    labelKey: "payrollPayoutReview.reconHold.status.released",
    tone: "success",
  },
  takenOver: {
    labelKey: "payrollPayoutReview.reconHold.status.takenOver",
    tone: "neutral",
  },
};

/** The hold still keeps its slip held by itself (no flag took over, no approved release). */
export function holdStillHolds(
  hold: Pick<PayoutReconHoldDto, "takenOver" | "release">,
): boolean {
  const status = holdStatus(hold);
  return status === "held" || status === "proposed";
}

/** A release can be proposed only on clean evidence and when none is waiting. */
export function canProposeRelease(
  hold: Pick<PayoutReconHoldDto, "takenOver" | "release" | "releasable">,
): boolean {
  return holdStatus(hold) === "held" && hold.releasable;
}

/** True when this user made the proposal. Compared by user id, never by name. */
export function isOwnRelease(
  hold: Pick<PayoutReconHoldDto, "release">,
  currentUserId: string,
): boolean {
  return (
    hold.release?.status === "proposed" &&
    currentUserId !== "" &&
    hold.release.proposedBy === currentUserId
  );
}

/** Held ones first (still holding a slip), the rest after; the API order is kept inside each group. */
export function sortHolds(
  holds: readonly PayoutReconHoldDto[],
): PayoutReconHoldDto[] {
  return [
    ...holds.filter((hold) => holdStillHolds(hold)),
    ...holds.filter((hold) => !holdStillHolds(hold)),
  ];
}

/** One message above the section; replaced by the next action or dismissed. */
export type HoldNotice =
  | { kind: "sent"; holdId: string }
  | { kind: "released"; holdId: string }
  /** 409: a flag took the hold over, the evidence is not clean, or the release was already approved. */
  | { kind: "stale" }
  | null;
