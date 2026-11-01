// State machines for the WS-11 export and saved-report lifecycle (PRD v1.7
// §3.36 "Ekspor", DASH-04). Explicit typed transitions so API, worker and web
// code cannot invent a path; an invalid transition is a CONFLICT (409), same
// as every other Legend domain.
//
// The export path is the DASH-04 guard at the transition level: a personal-data
// job may move out of `pending_approval` only after its approval request is
// approved, and the worker asserts that again before generation.

import { CoreError } from "../core/index.ts";
import { ReportError } from "./errors.ts";
import type {
  ReportExportApprovalStatus,
  ReportExportStatus,
} from "./exports.ts";
import type { SavedReportStatus } from "./builder.ts";

export const reportExportTransitions = {
  /** No rows have left the server; waits for WS-01 approval. */
  pending_approval: ["queued", "rejected", "expired", "cancelled"],
  queued: ["generating", "failed", "cancelled"],
  generating: ["ready", "failed"],
  /** A ready file stays downloadable until retention expires. */
  ready: ["expired"],
  failed: [],
  rejected: [],
  expired: [],
  cancelled: [],
} as const satisfies Record<ReportExportStatus, readonly ReportExportStatus[]>;

export const savedReportTransitions = {
  active: ["archived"],
  archived: ["active"],
} as const satisfies Record<SavedReportStatus, readonly SavedReportStatus[]>;

function allows<State extends string>(
  transitions: Readonly<Record<State, readonly State[]>>,
  from: State,
  to: State,
): boolean {
  return (transitions[from] as readonly State[]).includes(to);
}

export function canTransitionReportExport(
  from: ReportExportStatus,
  to: ReportExportStatus,
): boolean {
  return allows(reportExportTransitions, from, to);
}

/** Returns the next status; throws CoreError CONFLICT for an invalid move. */
export function transitionReportExport(
  from: ReportExportStatus,
  to: ReportExportStatus,
): ReportExportStatus {
  if (!canTransitionReportExport(from, to))
    throw new CoreError(
      "CONFLICT",
      `Report export cannot move from ${from} to ${to}.`,
    );
  return to;
}

export function canTransitionSavedReport(
  from: SavedReportStatus,
  to: SavedReportStatus,
): boolean {
  return allows(savedReportTransitions, from, to);
}

export function transitionSavedReportStatus(
  from: SavedReportStatus,
  to: SavedReportStatus,
): SavedReportStatus {
  if (!canTransitionSavedReport(from, to))
    throw new CoreError(
      "CONFLICT",
      `Saved report cannot move from ${from} to ${to}.`,
    );
  return to;
}

/** The fields the DASH-04 guard reads; keeps the helper usable by the worker. */
export type ReportExportApprovalCheck = {
  readonly containsPersonalData: boolean;
  readonly approvalRequestId: string | null;
  /** Status of that approval request, read by the worker from WS-01. */
  readonly approvalStatus: ReportExportApprovalStatus;
  readonly status: ReportExportStatus;
};

/**
 * DASH-04 server guard: before a worker generates an export that contains
 * personal data, the job must carry an approval request that is `approved`,
 * and be `queued` (the only status that may become `generating`). Throws
 * ReportError EXPORT_PII_APPROVAL_REQUIRED (403), so a caller that skipped
 * the gate cannot produce a file.
 */
export function assertReportExportMayGenerate(
  job: ReportExportApprovalCheck,
): void {
  if (
    job.containsPersonalData &&
    (job.approvalRequestId === null || job.approvalStatus !== "approved")
  )
    throw new ReportError(
      "EXPORT_PII_APPROVAL_REQUIRED",
      "Personal-data exports need an approved approval request (DASH-04).",
    );
  if (job.status !== "queued")
    throw new CoreError(
      "CONFLICT",
      `Report export must be queued before generation, not ${job.status}.`,
    );
}
