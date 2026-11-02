// Local draft state for the weekly roster (bead legend-299s).
//
// The contract has no shift-assignment write endpoint yet (see the follow-up
// bead in the report), so a shift dropped into the calendar is a LOCAL draft:
// it is marked "Draf" in the grid and persisted in this browser so a reload
// does not lose the plan. `features/ws10-roster/mock.ts` reads the same rows
// when `publishRoster` runs, so a published week includes the drafts made on
// this device; the real endpoint will own that write and this module goes away.
//
// Nothing here is trusted: localStorage may hold an older or tampered value,
// so every row is re-parsed with the contract schema and invalid rows are
// dropped instead of crashing the screen.

import {
  rosterPublicationSchema,
  shiftAssignmentSchema,
  type RosterPublication,
  type ShiftAssignment,
} from "@starter/shared/hris";

const STORAGE_KEY = "legend-roster-local-v1";

type LocalState = {
  /** Keyed by `outletId|weekStart` (see `weekKey`). */
  drafts: Record<string, ShiftAssignment[]>;
  publications: Record<string, RosterPublication>;
};

const emptyState = (): LocalState => ({ drafts: {}, publications: {} });

let memory: LocalState = emptyState();

function browserStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function parseState(raw: string | null): LocalState {
  if (!raw) return emptyState();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return emptyState();
  }
  if (typeof value !== "object" || value === null) return emptyState();
  const record = value as Record<string, unknown>;
  const state = emptyState();

  const drafts = record.drafts;
  if (typeof drafts === "object" && drafts !== null)
    for (const [key, rows] of Object.entries(drafts)) {
      if (!Array.isArray(rows)) continue;
      const parsed = rows
        .map((row) => shiftAssignmentSchema.safeParse(row))
        .flatMap((result) => (result.success ? [result.data] : []));
      if (parsed.length > 0) state.drafts[key] = parsed;
    }

  const publications = record.publications;
  if (typeof publications === "object" && publications !== null)
    for (const [key, row] of Object.entries(publications)) {
      const parsed = rosterPublicationSchema.safeParse(row);
      if (parsed.success) state.publications[key] = parsed.data;
    }
  return state;
}

function readState(): LocalState {
  const storage = browserStorage();
  if (!storage) return memory;
  try {
    return parseState(storage.getItem(STORAGE_KEY));
  } catch {
    return memory;
  }
}

function writeState(next: LocalState): void {
  memory = next;
  const storage = browserStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage can be full or blocked; the in-memory copy still serves this tab.
  }
}

/** One key per outlet-week; a week never bleeds into another. */
export function weekKey(outletId: string, weekStart: string): string {
  return `${outletId}|${weekStart}`;
}

export function readDrafts(
  outletId: string,
  weekStart: string,
): ShiftAssignment[] {
  return readState().drafts[weekKey(outletId, weekStart)] ?? [];
}

/** Appends or replaces one draft id; returns the week's rows. */
export function saveDraft(
  outletId: string,
  weekStart: string,
  assignment: ShiftAssignment,
): ShiftAssignment[] {
  const state = readState();
  const key = weekKey(outletId, weekStart);
  const rows = state.drafts[key] ?? [];
  const nextRows = [
    ...rows.filter((row) => row.id !== assignment.id),
    assignment,
  ];
  writeState({ ...state, drafts: { ...state.drafts, [key]: nextRows } });
  return nextRows;
}

export function removeDraft(
  outletId: string,
  weekStart: string,
  assignmentId: string,
): ShiftAssignment[] {
  const state = readState();
  const key = weekKey(outletId, weekStart);
  const nextRows = (state.drafts[key] ?? []).filter(
    (row) => row.id !== assignmentId,
  );
  writeState({ ...state, drafts: { ...state.drafts, [key]: nextRows } });
  return nextRows;
}

/** Replaces every draft of a week (used by "copy previous week"). */
export function replaceDrafts(
  outletId: string,
  weekStart: string,
  rows: readonly ShiftAssignment[],
): ShiftAssignment[] {
  const state = readState();
  const key = weekKey(outletId, weekStart);
  writeState({ ...state, drafts: { ...state.drafts, [key]: [...rows] } });
  return [...rows];
}

export function clearDrafts(outletId: string, weekStart: string): void {
  const state = readState();
  const key = weekKey(outletId, weekStart);
  writeState({
    ...state,
    drafts: { ...state.drafts, [key]: [] },
  });
}

export function readPublication(
  outletId: string,
  weekStart: string,
): RosterPublication | null {
  return (
    readState().publications[weekKey(outletId, weekStart)] ?? null
  );
}

export function savePublication(publication: RosterPublication): void {
  const state = readState();
  const key = weekKey(publication.outletId, publication.weekStart);
  writeState({
    ...state,
    publications: { ...state.publications, [key]: publication },
  });
}
