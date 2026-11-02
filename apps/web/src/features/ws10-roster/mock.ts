// Mock mode for the weekly roster (bead legend-299s; PRD v1.7 §3 Kelompok D
// 28, F26, HR-05). Only `publishRoster` lives here: the HRIS read models
// (`listEmployees`, `listPositions`, `listShiftAssignments`, `listHolidays`)
// are registered by the shared `lib/mock/handlers/hris-directory.ts`, and a
// duplicate registration is a bug.
//
// The contract has no assignment write endpoint, so a draf made in the grid is
// stored by `draft-store.ts` in the browser. Publishing reads those same rows
// (the mock runs in the browser too), flips the week's drafts to published,
// evaluates compliance with the contract, and keeps the idempotency key so a
// replayed request returns the first publication unchanged.
import {
  addBusinessDays,
  cafeLegendHrisFixtures,
  evaluateShiftCompliance,
  publishRoster,
  rosterPublicationSchema,
  type RosterPublication,
  type ShiftAssignment,
} from "@starter/shared/hris";
import { ApiError } from "@/lib/api/errors";
import { registerMock } from "@/lib/mock/registry";
import { createMockStore } from "@/lib/mock/store";
import { readDrafts } from "./draft-store.ts";
import { ROSTER_COMPLIANCE_POLICY } from "./fixtures.ts";

const fixtureAssignments = cafeLegendHrisFixtures.shiftAssignments;

type PublishReplay = {
  /** outletId|weekStart: a reused key with another body is refused. */
  fingerprint: string;
  publication: RosterPublication;
};

type RosterMockState = {
  /** idempotency key → the publication it produced. */
  replays: Record<string, PublishReplay>;
};

/** Re-seeded on `resetMocks()` like every mock store. */
const rosterStore = createMockStore<RosterMockState>(() => ({ replays: {} }));

function sortRows(rows: readonly ShiftAssignment[]): ShiftAssignment[] {
  return [...rows].sort(
    (left, right) =>
      left.businessDate.localeCompare(right.businessDate) ||
      (left.segments[0]?.startsAt ?? "").localeCompare(
        right.segments[0]?.startsAt ?? "",
      ) ||
      left.id.localeCompare(right.id),
  );
}

registerMock(publishRoster, ({ body }) => {
  const { outletId, weekStart, idempotencyKey } = body;
  const fingerprint = `${outletId}|${weekStart}`;
  const state = rosterStore.get();
  const replay = state.replays[idempotencyKey];
  if (replay) {
    if (replay.fingerprint !== fingerprint)
      throw new ApiError(
        409,
        "IDEMPOTENCY_KEY_REUSED",
        "Kunci idempotensi sudah dipakai untuk minggu atau outlet lain.",
      );
    return { data: replay.publication };
  }

  const weekEnd = addBusinessDays(weekStart, 6);
  const fixtureRows = fixtureAssignments.filter(
    (assignment) =>
      assignment.outletId === outletId &&
      assignment.businessDate >= weekStart &&
      assignment.businessDate <= weekEnd &&
      assignment.status !== "cancelled",
  );
  // Drafts made on this device; deduplicated by id in case a row is in both.
  const byId = new Map<string, ShiftAssignment>();
  for (const row of fixtureRows) byId.set(row.id, row);
  for (const draft of readDrafts(outletId, weekStart)) byId.set(draft.id, draft);
  const rows = sortRows([...byId.values()]);
  if (rows.length === 0)
    throw new ApiError(
      409,
      "CONFLICT",
      "Belum ada shift pada minggu ini untuk diterbitkan.",
    );

  const publishedAt = new Date().toISOString();
  const publishedBy = cafeLegendHrisFixtures.userIds.outletManager;
  const assignments: ShiftAssignment[] = rows.map((assignment) =>
    assignment.status === "draft"
      ? {
          ...assignment,
          status: "published" as const,
          publishedBy,
          publishedAt,
        }
      : assignment,
  );
  const publication = rosterPublicationSchema.parse({
    outletId,
    weekStart,
    assignments,
    complianceIssues: evaluateShiftCompliance(
      assignments,
      ROSTER_COMPLIANCE_POLICY,
    ),
    publishedBy,
    publishedAt,
  });

  rosterStore.set({
    ...state,
    replays: {
      ...state.replays,
      [idempotencyKey]: { fingerprint, publication },
    },
  });
  return { data: publication };
});
