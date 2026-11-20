// Pure helpers of the profit-share back office (bead legend-ogx3; PRD v1.7
// §3 F37 "Bagi Hasil & Dividen", §4 "Alur P", SH-03, SH-04).
//
// No React and no DOM at import time, and only relative or bare package
// imports, so tests/ws07-profit-share.test.mjs loads this file with Node type
// stripping. Business rules stay in the contract (@starter/shared/accounting):
// this file only formats, diffs and derives what the screens render — it never
// re-implements the 10,000 bp invariant or a state machine.

import {
  effectiveShareAllocationVersion,
  isMoneyPaidLine,
  shareAllocationTotalBp,
  type DistributionFrequency,
  type DistributionLine,
  type DistributionLinePaymentStatus,
  type DistributionPolicy,
  type DistributionRun,
  type DistributionRunBasis,
  type DistributionRunStatus,
  type DistributionRunSummary,
  type DistributionRunType,
  type ProfitEntity,
  type ShareAllocation,
  type ShareAllocationVersion,
  type ShareAllocationVersionStatus,
  type Shareholder,
  type ShareholderStatus,
  type ShareholderType,
} from "@starter/shared/accounting";
import { formatNumber } from "@starter/shared/i18n";
import type { MessageKey } from "@starter/shared/i18n";
import type { PermissionCode } from "@starter/shared/access";

/**
 * Founder rule Q84: changing share percentages (create, edit, submit a version)
 * is its own permission, apart from posting journals and from approving. Fails
 * closed without access. The API re-checks it.
 */
export function canChangeShareAllocation(
  access: { readonly permissions: readonly PermissionCode[] } | undefined,
): boolean {
  return (
    access?.permissions.includes("profit_share.share_allocation.change") ??
    false
  );
}

/** Approving or rejecting a share version: `profit_share.distribution.approve`. */
export function canApproveShareAllocation(
  access: { readonly permissions: readonly PermissionCode[] } | undefined,
): boolean {
  return (
    access?.permissions.includes("profit_share.distribution.approve") ?? false
  );
}

/** SH-03: 10,000 bp = 100%; the API sends basis points, never a percentage. */
export const SHARE_TOTAL_BP = 10_000;

/** One page of distribution runs; the list is short (one per closed period). */
export const DISTRIBUTION_PAGE_LIMIT = 50;

/** Shortest reason accepted when withdrawing an approved distribution. */
export const CANCEL_APPROVED_REASON_MIN = 10;

// ---- Formatting -----------------------------------------------------------

/**
 * Basis points → the percentage exactly as the API expressed it. An integer bp
 * has at most two decimals, so this never rounds (SH-03).
 */
export function formatShareBp(bp: number): string {
  if (!Number.isSafeInteger(bp) || bp < 0)
    throw new RangeError(`Invalid basis points: ${bp}`);
  return `${formatNumber(bp / 100, { fractionDigits: 2 })}%`;
}

/** A signed bp delta for the version diff: 500 → "+5,00%", -250 → "−2,50%". */
export function formatShareBpDelta(deltaBp: number): string {
  if (!Number.isSafeInteger(deltaBp))
    throw new RangeError(`Invalid basis-point delta: ${deltaBp}`);
  if (deltaBp === 0) return formatShareBp(0);
  const sign = deltaBp > 0 ? "+" : "−";
  return `${sign}${formatShareBp(Math.abs(deltaBp))}`;
}

/** Whole bp with Indonesian grouping: 10000 → "10.000". */
export function formatShareBpInteger(bp: number): string {
  return formatNumber(bp);
}

/**
 * "2026-11-05" → "5 Nov 2026" (locale-stable id-ID at UTC, no zone drift).
 */
export function formatShareDate(value: string): string {
  const [year, month, day] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

/** ISO instant → "5 Nov 2026, 09.00" in the outlet time zone. */
export function formatShareDateTime(
  value: string,
  timeZone: string = "Asia/Jakarta",
): string {
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(new Date(value));
}

/** "2026-10" → "Okt 2026". */
export function formatSharePeriod(period: string): string {
  const [year, month] = period.split("-").map(Number);
  return new Intl.DateTimeFormat("id-ID", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, 1)));
}

/** The outlet's business date; the outlet-context bead supplies the zone. */
export const SHARE_TIME_ZONE = "Asia/Jakarta";

export function shareDateToday(
  now: Date = new Date(),
  timeZone: string = SHARE_TIME_ZONE,
): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(now);
}

/** "2026-07-01" → "2026-07-02"; the default effective date of a new version. */
export function nextBusinessDate(value: string): string {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1))
    .toISOString()
    .slice(0, 10);
}

/**
 * A short audit reference of a user id. The contract carries `requestedBy` and
 * `decidedBy` as ids only (a user directory is another contract); the screens
 * show the last six characters instead of pretending to know a name.
 */
export function shortActorRef(userId: string): string {
  return `#${userId.replace(/-/g, "").slice(-6).toUpperCase()}`;
}

// ---- Catalog keys (text never lives in this file) -------------------------

export const VERSION_STATUS_KEYS = {
  draft: "accounting.share.status.draft",
  pending_approval: "accounting.share.status.pendingApproval",
  approved: "accounting.share.status.approved",
  rejected: "accounting.share.status.rejected",
  cancelled: "accounting.share.status.cancelled",
} as const satisfies Record<ShareAllocationVersionStatus, MessageKey>;

export const RUN_STATUS_KEYS = {
  draft: "accounting.share.status.draft",
  pending_approval: "accounting.share.status.pendingApproval",
  approved: "accounting.share.status.approved",
  paid: "accounting.share.status.paid",
  cancelled: "accounting.share.status.cancelled",
} as const satisfies Record<DistributionRunStatus, MessageKey>;

export const PAYMENT_STATUS_KEYS = {
  pending: "accounting.share.paymentStatus.pending",
  paid: "accounting.share.paymentStatus.paid",
} as const satisfies Record<DistributionLinePaymentStatus, MessageKey>;

export const SHAREHOLDER_TYPE_KEYS = {
  person: "accounting.share.shareholderType.person",
  company: "accounting.share.shareholderType.company",
} as const satisfies Record<ShareholderType, MessageKey>;

export const SHAREHOLDER_STATUS_KEYS = {
  active: "accounting.share.shareholderStatus.active",
  inactive: "accounting.share.shareholderStatus.inactive",
} as const satisfies Record<ShareholderStatus, MessageKey>;

export const FREQUENCY_KEYS = {
  monthly: "accounting.share.frequency.monthly",
  quarterly: "accounting.share.frequency.quarterly",
  semi_annual: "accounting.share.frequency.semiAnnual",
  annual: "accounting.share.frequency.annual",
} as const satisfies Record<DistributionFrequency, MessageKey>;

export const RUN_TYPE_KEYS = {
  regular: "accounting.share.runType.regular",
  adjustment: "accounting.share.runType.adjustment",
} as const satisfies Record<DistributionRunType, MessageKey>;

export const BASIS_KEYS = {
  closed_period_net_profit: "accounting.share.basis.closedPeriodNetProfit",
  approved_run_adjustment: "accounting.share.basis.approvedRunAdjustment",
} as const satisfies Record<DistributionRunBasis, MessageKey>;

/** PRD §3.37: the policy's basis is fixed to a closed period's net profit. */
export const POLICY_BASIS_KEY =
  "accounting.share.basis.closedPeriodNetProfit" satisfies MessageKey;

/** Catalog key of a policy/run basis (the contract has two literals). */
export function basisKey(row: Pick<DistributionPolicy, "basis">): MessageKey {
  return BASIS_KEYS[row.basis];
}

// ---- Share versions (SH-03) ----------------------------------------------

export type ShareAllocationSumState = "exact" | "short" | "over";

/** SH-03: exactly 10,000 bp is the only activatable total. */
export function shareAllocationSumState(
  totalBp: number,
): ShareAllocationSumState {
  if (totalBp === SHARE_TOTAL_BP) return "exact";
  return totalBp < SHARE_TOTAL_BP ? "short" : "over";
}

/** Distance from 100%, in bp (always non-negative). */
export function shareAllocationSumDeltaBp(totalBp: number): number {
  return Math.abs(SHARE_TOTAL_BP - totalBp);
}

export function shareAllocationSumKey(totalBp: number): MessageKey {
  return shareAllocationSumState(totalBp) === "exact"
    ? "accounting.share.versions.sumExact"
    : shareAllocationSumState(totalBp) === "short"
      ? "accounting.share.versions.sumShort"
      : "accounting.share.versions.sumOver";
}

/** SH-03: the total must be exactly 100% before an action may activate a version. */
export function canActivateVersion(totalBp: number): boolean {
  return shareAllocationSumState(totalBp) === "exact";
}

/** A new version may only be edited while it is a draft. */
export function isVersionEditable(
  version: Pick<ShareAllocationVersion, "status">,
): boolean {
  return version.status === "draft";
}

/** Versions of one profit entity, newest number first. */
export function versionsOfEntity(
  versions: readonly ShareAllocationVersion[],
  profitEntityId: string,
): ShareAllocationVersion[] {
  return versions
    .filter((row) => row.profitEntityId === profitEntityId)
    .sort((a, b) => b.version - a.version);
}

/** Highest version number of an entity's register, null when it has none. */
export function latestVersionOfEntity(
  versions: readonly ShareAllocationVersion[],
  profitEntityId: string,
): ShareAllocationVersion | null {
  return versionsOfEntity(versions, profitEntityId)[0] ?? null;
}

/** The version a diff is measured against: the next lower number, if any. */
export function previousVersionOf(
  versions: readonly ShareAllocationVersion[],
  version: Pick<ShareAllocationVersion, "profitEntityId" | "version">,
): ShareAllocationVersion | null {
  return (
    versionsOfEntity(versions, version.profitEntityId)
      .filter((row) => row.version < version.version)
      .sort((a, b) => b.version - a.version)[0] ?? null
  );
}

/** The approved version in force on `asOf` (SH-03), full object for render. */
export function effectiveVersionOfEntity(
  versions: readonly ShareAllocationVersion[],
  profitEntityId: string,
  asOf: string,
): ShareAllocationVersion | null {
  return (
    effectiveShareAllocationVersion(versions, profitEntityId, asOf) ?? null
  );
}

export function versionTotalBp(
  version: Pick<ShareAllocationVersion, "allocations">,
): number {
  return shareAllocationTotalBp(version.allocations);
}

/** Default effective date of a new version: the day after the latest approved. */
export function suggestedEffectiveFrom(
  versions: readonly ShareAllocationVersion[],
  profitEntityId: string,
  today: string,
): string {
  const latestApproved = versionsOfEntity(versions, profitEntityId)
    .filter((row) => row.status === "approved")
    .sort((a, b) =>
      a.effectiveFrom === b.effectiveFrom
        ? b.version - a.version
        : a.effectiveFrom < b.effectiveFrom
          ? 1
          : -1,
    )[0];
  if (!latestApproved) return today;
  const next = nextBusinessDate(latestApproved.effectiveFrom);
  return next > today ? next : today;
}

// ---- Version diff (bead scope "version diff view") ------------------------

export type ShareAllocationDiffKind = "added" | "removed" | "changed";

export type ShareAllocationDiffRow = {
  shareholderId: string;
  kind: ShareAllocationDiffKind;
  beforeBp: number | null;
  afterBp: number | null;
  /** after − before; a removal is the negative of the old share. */
  deltaBp: number;
};

export type ShareAllocationDiff = {
  /** Changed, added and removed rows only; equal shares are omitted. */
  rows: ShareAllocationDiffRow[];
  beforeTotalBp: number;
  afterTotalBp: number;
  totalDeltaBp: number;
};

/**
 * Compares two versions shareholder by shareholder. `before` null means the
 * version is the first: every row is "added". A shareholder that disappears
 * is "removed"; a different bp is "changed"; an equal bp is not a difference.
 */
export function diffShareAllocations(
  before: readonly Pick<ShareAllocation, "shareholderId" | "shareBp">[] | null,
  after: readonly Pick<ShareAllocation, "shareholderId" | "shareBp">[],
): ShareAllocationDiff {
  const beforeById = new Map(
    (before ?? []).map((row) => [row.shareholderId, row.shareBp]),
  );
  const afterById = new Map(
    after.map((row) => [row.shareholderId, row.shareBp]),
  );
  const rows: ShareAllocationDiffRow[] = [];
  for (const shareholderId of new Set([
    ...beforeById.keys(),
    ...afterById.keys(),
  ])) {
    const beforeBp = beforeById.get(shareholderId) ?? null;
    const afterBp = afterById.get(shareholderId) ?? null;
    if (beforeBp !== null && afterBp !== null) {
      if (beforeBp === afterBp) continue;
      rows.push({
        shareholderId,
        kind: "changed",
        beforeBp,
        afterBp,
        deltaBp: afterBp - beforeBp,
      });
      continue;
    }
    if (beforeBp === null && afterBp !== null) {
      rows.push({
        shareholderId,
        kind: "added",
        beforeBp: null,
        afterBp,
        deltaBp: afterBp,
      });
      continue;
    }
    rows.push({
      shareholderId,
      kind: "removed",
      beforeBp,
      afterBp: null,
      deltaBp: -1 * (beforeBp ?? 0),
    });
  }
  const ranked: Record<ShareAllocationDiffKind, number> = {
    changed: 0,
    added: 1,
    removed: 2,
  };
  rows.sort(
    (a, b) =>
      ranked[a.kind] - ranked[b.kind] ||
      a.shareholderId.localeCompare(b.shareholderId),
  );
  const beforeTotalBp = (before ?? []).reduce(
    (total, row) => total + row.shareBp,
    0,
  );
  const afterTotalBp = after.reduce((total, row) => total + row.shareBp, 0);
  return {
    rows,
    beforeTotalBp,
    afterTotalBp,
    totalDeltaBp: afterTotalBp - beforeTotalBp,
  };
}

// ---- Distribution policy --------------------------------------------------

/** Reserve and withholding are bp from the API; the screen only formats them. */
export function policyPercent(
  policy: Pick<DistributionPolicy, "reserveBp" | "taxWithholdingBp">,
): { reserve: string; tax: string } {
  return {
    reserve: formatShareBp(policy.reserveBp),
    tax: formatShareBp(policy.taxWithholdingBp),
  };
}

// ---- Distribution runs (SH-04) -------------------------------------------

export const DISTRIBUTION_WIZARD_STEPS = [
  "calculate",
  "simulate",
  "approval",
  "payment",
  "statement",
] as const;
export type DistributionWizardStep = (typeof DISTRIBUTION_WIZARD_STEPS)[number];

/**
 * Which wizard step a run resumes at (the page keeps the run id in state, so a
 * refresh resumes from the loaded run):
 * no run → calculate; draft → simulate; pending → approval; approved →
 * payment; paid → statement; cancelled → approval (where it stopped).
 */
export function distributionWizardStep(
  run: Pick<DistributionRun, "status"> | null,
): DistributionWizardStep {
  if (run === null) return "calculate";
  switch (run.status) {
    case "draft":
      return "simulate";
    case "pending_approval":
      return "approval";
    case "approved":
      return "payment";
    case "paid":
      return "statement";
    case "cancelled":
      return "approval";
  }
}

export function distributionWizardStepIndex(
  step: DistributionWizardStep,
): number {
  return DISTRIBUTION_WIZARD_STEPS.indexOf(step) + 1;
}

/** SH-04: an approved or paid run is frozen; only adjustments change it. */
export function isDistributionLocked(status: DistributionRunStatus): boolean {
  return status === "approved" || status === "paid";
}

/**
 * An approved run with no money out may be withdrawn (SO 1216 F-P1a). The API
 * re-checks; a carry-absorbed zero line is no payment.
 */
export function canCancelApprovedRun(
  run: Pick<DistributionRun, "status" | "lines">,
): boolean {
  return (
    run.status === "approved" &&
    !run.lines.some((line) => isMoneyPaidLine(line))
  );
}

/** Row version of [canCancelApprovedRun] from the list summary. */
export function canCancelApprovedSummary(
  run: Pick<DistributionRunSummary, "status" | "moneyPaidLineCount">,
): boolean {
  return run.status === "approved" && run.moneyPaidLineCount === 0;
}

/** Payment recording is the one write an approved run allows. */
export function canRecordPayments(status: DistributionRunStatus): boolean {
  return status === "approved";
}

/**
 * A line whose whole share was taken by carry: Rp0 net, settled on approval,
 * with nothing to pay and no statement.
 */
export function isCarryAbsorbedLine(
  line: Pick<DistributionLine, "grossIdr" | "carryDeductedIdr">,
): boolean {
  return line.grossIdr === 0 && line.carryDeductedIdr > 0;
}

export type DistributionProgress = {
  paidLines: number;
  totalLines: number;
  netPaidIdr: number;
  netTotalIdr: number;
  /** 0–100 for a progress bar width; 100 only when every line is paid. */
  percent: number;
};

export function distributionProgress(
  run: Pick<DistributionRun, "lines">,
): DistributionProgress {
  const paidLines = run.lines.filter(
    (line) => line.paymentStatus === "paid",
  ).length;
  const totalLines = run.lines.length;
  return {
    paidLines,
    totalLines,
    netPaidIdr: run.lines
      .filter((line) => line.paymentStatus === "paid")
      .reduce((total, line) => total + line.netIdr, 0),
    netTotalIdr: run.lines.reduce((total, line) => total + line.netIdr, 0),
    percent: totalLines === 0 ? 0 : Math.round((paidLines / totalLines) * 100),
  };
}

/** Progress of one list row: the summary carries counts, not the lines. */
export function runSummaryProgress(
  summary: Pick<DistributionRunSummary, "paidLineCount" | "lineCount">,
): number {
  return summary.lineCount === 0
    ? 0
    : Math.round((summary.paidLineCount / summary.lineCount) * 100);
}

/** Runs of one entity, newest requested first, with the given status filter. */
export function runsOfEntity(
  summaries: readonly DistributionRunSummary[],
  profitEntityId: string,
  status?: DistributionRunStatus,
): DistributionRunSummary[] {
  return summaries
    .filter((row) => row.profitEntityId === profitEntityId)
    .filter((row) => !status || row.status === status)
    .sort(
      (a, b) =>
        b.requestedAt.localeCompare(a.requestedAt) || a.id.localeCompare(b.id),
    );
}

/** Runs that still need a decision or a payment (the list's attention strip). */
export function openRuns(
  summaries: readonly DistributionRunSummary[],
  profitEntityId: string,
): { awaitingApproval: number; awaitingPayment: number } {
  const mine = summaries.filter((row) => row.profitEntityId === profitEntityId);
  return {
    awaitingApproval: mine.filter((row) => row.status === "pending_approval")
      .length,
    awaitingPayment: mine.filter(
      (row) => row.status === "approved" && row.paidLineCount < row.lineCount,
    ).length,
  };
}

/** Official figures only from a closed period (SH-02). */
export function isClosedPeriod(status: "open" | "closed"): boolean {
  return status === "closed";
}

/** Net paid of an approved/paid run, for the list's totals. */
export function distributedNetIdr(
  summaries: readonly DistributionRunSummary[],
  profitEntityId: string,
): number {
  return summaries
    .filter(
      (row) =>
        row.profitEntityId === profitEntityId &&
        (row.status === "approved" || row.status === "paid"),
    )
    .reduce((total, row) => total + row.totalNetIdr, 0);
}

// ---- Input parsing --------------------------------------------------------

/**
 * Whole digits, optionally grouped by "." in threes ("10.000"). A dot anywhere
 * else is refused instead of stripped, so a percentage typed into a bp field
 * ("33.3" would silently become 333 bp) is an error, never a different share.
 */
const GROUPED_INTEGER = /^(?:\d+|\d{1,3}(?:\.\d{3})+)$/;

/**
 * A basis-point field: an integer ("1000", "10.000" too). Returns null for a
 * blank or invalid value; 0 is a valid parse but not a valid allocation, so
 * the editor reports it as a contract rule instead of silently dropping it.
 */
export function parseShareBpInput(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (!GROUPED_INTEGER.test(trimmed)) return null;
  const bp = Number(trimmed.replace(/\./g, ""));
  return Number.isSafeInteger(bp) && bp <= SHARE_TOTAL_BP ? bp : null;
}

/** A rupiah field for an adjustment: "1.000.000", "-1.000.000" or digits. */
export function parseAdjustmentIdrInput(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const negative = trimmed.startsWith("-") || trimmed.startsWith("−");
  const unsigned = (negative ? trimmed.slice(1) : trimmed).trim();
  if (!GROUPED_INTEGER.test(unsigned)) return null;
  const amount = Number(unsigned.replace(/\./g, ""));
  if (!Number.isSafeInteger(amount) || amount === 0) return null;
  return negative ? -amount : amount;
}

// ---- Profit entities ------------------------------------------------------

/** A profit entity may be a legal entity or one outlet (PRD §3.37). */
export function profitEntityTypeKey(
  entity: Pick<ProfitEntity, "type">,
): MessageKey {
  return entity.type === "legal_entity"
    ? "accounting.share.entityTypes.legalEntity"
    : "accounting.share.entityTypes.outlet";
}

/** Shareholders in the register, active first, then by name. */
export function sortShareholders(
  shareholders: readonly Shareholder[],
): Shareholder[] {
  return [...shareholders].sort(
    (a, b) =>
      Number(b.status === "active") - Number(a.status === "active") ||
      a.name.localeCompare(b.name, "id-ID"),
  );
}

/** Shareholders not yet in an allocation list, for the editor's picker. */
export function shareholdersNotIn(
  shareholders: readonly Shareholder[],
  allocations: readonly Pick<ShareAllocation, "shareholderId">[],
): Shareholder[] {
  const used = new Set(allocations.map((row) => row.shareholderId));
  return sortShareholders(shareholders).filter((row) => !used.has(row.id));
}
