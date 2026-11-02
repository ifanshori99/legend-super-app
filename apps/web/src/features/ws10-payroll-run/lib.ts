// Pure helpers of the payroll-run screens: status vocabulary, the wizard step
// rail, money/date formatting and the service-charge totals. No React, no
// fetching; every rule that changes money or status lives in the contract
// (@starter/shared/hris/payroll), never here.
import { sumIdr, type Idr } from "@starter/shared/core";
import type { MessageKey } from "@starter/shared/i18n";
import { formatNumber, formatRupiah } from "@starter/shared/i18n";
import type {
  PayrollRun,
  PayrollRunStatus,
  ServiceChargeAllocation,
  ServiceChargeMethod,
  ServiceChargePool,
  ServiceChargePoolStatus,
} from "@starter/shared/hris/payroll";
import type { StatusKind } from "@/components/ui/badge";
import { PAYROLL_TIME_ZONE } from "./outlet";

/** One page is enough for the pay-component and result lists in the demo. */
export const LIST_LIMIT = 100;

/**
 * `?mock=empty|slow|error|offline` must reach the browser instead of being
 * frozen into the SSR HTML (docs/frontend.md "See loading, empty and error
 * states"), so a route loader skips its prefetch for those requests.
 */
export function isMockScenarioRequest(searchStr: string): boolean {
  const scenario = new URLSearchParams(searchStr).get("mock");
  return scenario !== null && scenario !== "normal";
}

/** Follows a cursor list to its last page (D-CORE-5), bounded. */
const MAX_CATALOG_PAGES = 50;

type Page<T> = {
  data: T[];
  meta: { limit: number; nextCursor: string | null };
};

export async function collectAllPages<T, P extends Page<T>>(
  fetchPage: (cursor: string | undefined) => Promise<P>,
  maxPages: number = MAX_CATALOG_PAGES,
): Promise<P> {
  let cursor: string | undefined;
  let merged: P | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const next = await fetchPage(cursor);
    merged =
      merged === undefined
        ? next
        : { ...next, data: [...merged.data, ...next.data] };
    if (next.meta.nextCursor === null) return merged;
    cursor = next.meta.nextCursor;
  }
  throw new Error(`List has more than ${maxPages} pages; narrow the query.`);
}

// ---- Status vocabulary --------------------------------------------------

export const RUN_STATUS_ORDER: readonly PayrollRunStatus[] = [
  "draft",
  "simulated",
  "hr_approved",
  "approved",
  "locked",
  "paid",
  "reversed",
];

export const RUN_STATUS_LABEL: Record<PayrollRunStatus, MessageKey> = {
  draft: "payrollRun.status.draft",
  simulated: "payrollRun.status.simulated",
  hr_approved: "payrollRun.status.hrApproved",
  approved: "payrollRun.status.approved",
  locked: "payrollRun.status.locked",
  paid: "payrollRun.status.paid",
  reversed: "payrollRun.status.reversed",
};

/** Status is always icon + words; tone only reinforces it (WCAG 1.4.1). */
export const RUN_STATUS_TONE: Record<PayrollRunStatus, StatusKind> = {
  draft: "neutral",
  simulated: "info",
  hr_approved: "warning",
  approved: "info",
  locked: "success",
  paid: "success",
  reversed: "danger",
};

const RANK: Record<PayrollRunStatus, number> = {
  draft: 0,
  simulated: 1,
  hr_approved: 2,
  approved: 3,
  locked: 4,
  paid: 5,
  reversed: 5,
};

export function runRank(status: PayrollRunStatus): number {
  return RANK[status];
}

// ---- Wizard steps -------------------------------------------------------

export const RUN_STEPS = [
  "overview",
  "simulate",
  "review",
  "approveHr",
  "approveFinal",
  "lock",
  "paid",
] as const;
export type RunStepKey = (typeof RUN_STEPS)[number];
export type RunStepState = "done" | "current" | "pending" | "blocked";

export const STEP_STATE_LABEL: Record<RunStepState, MessageKey> = {
  done: "payrollRun.stepState.done",
  current: "payrollRun.stepState.current",
  pending: "payrollRun.stepState.pending",
  blocked: "payrollRun.stepState.blocked",
};

export const STEP_LABEL: Record<RunStepKey, MessageKey> = {
  overview: "payrollRun.step.overview",
  simulate: "payrollRun.step.simulate",
  review: "payrollRun.step.review",
  approveHr: "payrollRun.step.approveHr",
  approveFinal: "payrollRun.step.approveFinal",
  lock: "payrollRun.step.lock",
  paid: "payrollRun.step.paid",
};

export const STEP_HINT: Record<RunStepKey, MessageKey> = {
  overview: "payrollRun.step.hint.overview",
  simulate: "payrollRun.step.hint.simulate",
  review: "payrollRun.step.hint.review",
  approveHr: "payrollRun.step.hint.approveHr",
  approveFinal: "payrollRun.step.hint.approveFinal",
  lock: "payrollRun.step.hint.lock",
  paid: "payrollRun.step.hint.paid",
};

/**
 * Milestones already reached, derived from the run's own timestamps — the
 * same facts the audit strip shows (Alur K). Nothing here changes a status.
 */
export function runStepState(
  run: PayrollRun,
  step: RunStepKey,
): RunStepState {
  const rank = runRank(run.status);
  if (run.status === "reversed" && (step === "paid" || step === "lock"))
    return "blocked";
  switch (step) {
    case "overview":
      // A run exists, so its period and policy are already chosen.
      return "done";
    case "simulate":
      if (rank >= 1) return "done";
      return "current";
    case "review":
      if (rank >= 2) return "done";
      return run.status === "simulated" ? "current" : "pending";
    case "approveHr":
      return rank >= 2 ? "done" : "pending";
    case "approveFinal":
      if (rank >= 3) return "done";
      return run.status === "hr_approved" ? "current" : "pending";
    case "lock":
      if (rank >= 4) return "done";
      return run.status === "approved" ? "current" : "pending";
    case "paid":
      return run.status === "paid" ? "done" : "pending";
    default:
      return "pending";
  }
}

/** When a milestone happened, for the rail's timestamp line. */
export function stepAt(run: PayrollRun, step: RunStepKey): string | null {
  switch (step) {
    case "overview":
      return run.createdAt;
    case "simulate":
      return run.lastSimulatedAt;
    case "review":
      return run.lastSimulatedAt;
    case "approveHr":
      return run.approvedByHrAt;
    case "approveFinal":
      return run.approvedByFinanceAt;
    case "lock":
      return run.lockedAt;
    case "paid":
      return run.paidAt;
    default:
      return null;
  }
}

// ---- Formatting ---------------------------------------------------------

/** "2026-10-26" → "26 Okt 2026" (UTC, so SSR and the browser agree). */
export function formatBusinessDate(value: string): string {
  const [year, month, day] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

/** An API instant → "27 Okt 2026, 10.00" in the outlet zone (SSR-safe). */
export function formatDateTime(instant: string): string {
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: PAYROLL_TIME_ZONE,
  }).format(new Date(instant));
}

/** A positive rupiah amount with a "+" and a negative one with "−". */
export function formatSignedRupiah(amount: Idr): string {
  if (amount > 0) return `+${formatRupiah(amount)}`;
  return formatRupiah(amount);
}

/** Tone for a signed delta: more net is success, less is danger (status tokens). */
export function deltaTone(amount: Idr): StatusKind {
  if (amount > 0) return "success";
  if (amount < 0) return "danger";
  return "neutral";
}

/** A share of a total as "12,5%", integer arithmetic (no float rupiah math). */
export function formatSharePercent(amount: Idr, total: Idr): string {
  if (total <= 0) return "0%";
  const permille = Number((BigInt(amount) * 1000n) / BigInt(total));
  return `${formatNumber(permille / 10, { fractionDigits: 1 })}%`;
}

/** Short display form of an actor id: the first eight hex characters. */
export function shortId(id: string): string {
  return id.replaceAll("-", "").slice(0, 8).toUpperCase();
}

/** "26 Sep – 25 Okt 2026" (one year, both ends named). */
export function periodRange(start: string, end: string): string {
  return `${formatBusinessDate(start)} – ${formatBusinessDate(end)}`;
}

// ---- Run derivations ----------------------------------------------------

/** The newest run that already carries simulated totals, for the list strip. */
export function latestRunWithTotals(
  runs: readonly PayrollRun[],
): PayrollRun | null {
  const withTotals = runs.filter((run) => run.totals !== null);
  if (withTotals.length === 0) return null;
  return [...withTotals].sort((a, b) =>
    a.periodStart === b.periodStart
      ? b.updatedAt.localeCompare(a.updatedAt)
      : b.periodStart.localeCompare(a.periodStart),
  )[0]!;
}

/** Newest period first in the list. */
export function sortRuns(runs: readonly PayrollRun[]): PayrollRun[] {
  return [...runs].sort((a, b) =>
    b.periodStart === a.periodStart
      ? b.createdAt.localeCompare(a.createdAt)
      : b.periodStart.localeCompare(a.periodStart),
  );
}

/** Distinct legal entities the loaded runs name, for the create dialog. */
export function legalEntitiesOf(
  runs: readonly PayrollRun[],
): { legalEntityId: string; policyIds: string[] }[] {
  const byEntity = new Map<string, Set<string>>();
  for (const run of sortRuns(runs)) {
    const policies = byEntity.get(run.legalEntityId) ?? new Set<string>();
    policies.add(run.payrollPolicyId);
    byEntity.set(run.legalEntityId, policies);
  }
  return [...byEntity.entries()].map(([legalEntityId, policies]) => ({
    legalEntityId,
    policyIds: [...policies],
  }));
}

/** Counts per status for the list's status band. */
export function statusCounts(
  runs: readonly PayrollRun[],
): Record<PayrollRunStatus, number> {
  const counts = Object.fromEntries(
    RUN_STATUS_ORDER.map((status) => [status, 0]),
  ) as Record<PayrollRunStatus, number>;
  for (const run of runs) counts[run.status] += 1;
  return counts;
}

// ---- Service charge -----------------------------------------------------

export const POOL_STATUS_LABEL: Record<ServiceChargePoolStatus, MessageKey> = {
  draft: "payrollRun.pool.status.draft",
  calculated: "payrollRun.pool.status.calculated",
  approved: "payrollRun.pool.status.approved",
  distributed: "payrollRun.pool.status.distributed",
  cancelled: "payrollRun.pool.status.cancelled",
};

export const POOL_STATUS_TONE: Record<ServiceChargePoolStatus, StatusKind> = {
  draft: "neutral",
  calculated: "info",
  approved: "warning",
  distributed: "success",
  cancelled: "neutral",
};

export const POOL_METHOD_LABEL: Record<ServiceChargeMethod, MessageKey> = {
  points: "payrollRun.pool.methodLabel.points",
  points_x_attendance: "payrollRun.pool.methodLabel.pointsAttendance",
  equal: "payrollRun.pool.methodLabel.equal",
};

export function sortPools(
  pools: readonly ServiceChargePool[],
): ServiceChargePool[] {
  return [...pools].sort((a, b) => b.periodStart.localeCompare(a.periodStart));
}

/** Sum of the shares; the contract guarantees it equals the pool amount. */
export function allocatedTotal(
  allocations: readonly ServiceChargeAllocation[],
): Idr {
  return sumIdr(allocations.map((row) => row.amountIdr));
}

export function allocationsReconcile(
  pool: ServiceChargePool | null,
  allocations: readonly ServiceChargeAllocation[],
): boolean {
  if (!pool) return false;
  return allocatedTotal(allocations) === pool.amountIdr;
}
