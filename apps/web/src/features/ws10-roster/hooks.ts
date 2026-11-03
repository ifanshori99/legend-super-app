// The only way the roster components touch data: queries keep their endpoint
// keys, the publish mutation invalidates the assignment list, and the local
// draft store is an external store (`useSyncExternalStore`) so a drop
// re-renders the grid without a setState-in-effect round trip.
import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listShiftAssignments,
  type RosterPublication,
  type ShiftAssignment,
} from "@starter/shared/hris";
import * as api from "./api";
import {
  clearDrafts,
  localWeekServerSnapshot,
  localWeekSnapshot,
  removeDraft,
  replaceDrafts as replaceDraftsInStore,
  saveDraft,
  savePublication,
  subscribeLocalRoster,
} from "./draft-store";
import {
  employeesQuery,
  holidaysQuery,
  positionsQuery,
  weekShiftsQuery,
} from "./queries";

// ---- Queries -------------------------------------------------------------

export function useRosterEmployees() {
  return useQuery(employeesQuery());
}

export function useRosterPositions() {
  return useQuery(positionsQuery());
}

export function useRosterWeek(weekStart: string) {
  return useQuery(weekShiftsQuery(weekStart));
}

export function useRosterHolidays(weekStart: string) {
  return useQuery(holidaysQuery(weekStart));
}

// ---- Local drafts and publication ---------------------------------------

export type LocalRosterWeek = {
  drafts: ShiftAssignment[];
  publication: RosterPublication | null;
  /** Appends drafts made in this session (one drop, or many copied rows). */
  addDrafts: (rows: readonly ShiftAssignment[]) => void;
  /** Replaces the whole draft list of the week. */
  replaceDrafts: (rows: readonly ShiftAssignment[]) => void;
  removeDraft: (assignmentId: string) => void;
  /** After a successful publish: the week becomes published, drafts clear. */
  recordPublication: (publication: RosterPublication) => void;
};

/**
 * The week's local drafts and publication. The server render and the hydration
 * pass use the empty snapshot (localStorage does not exist on the server), then
 * the client subscribes to the store, so the markup always matches.
 */
export function useLocalRosterWeek(
  outletId: string,
  weekStart: string,
): LocalRosterWeek {
  const getSnapshot = React.useCallback(
    () => localWeekSnapshot(outletId, weekStart),
    [outletId, weekStart],
  );
  const snapshot = React.useSyncExternalStore(
    subscribeLocalRoster,
    getSnapshot,
    localWeekServerSnapshot,
  );

  const addDrafts = React.useCallback(
    (rows: readonly ShiftAssignment[]) => {
      for (const row of rows) saveDraft(outletId, weekStart, row);
    },
    [outletId, weekStart],
  );

  const replaceWeekDrafts = React.useCallback(
    (rows: readonly ShiftAssignment[]) => {
      replaceDraftsInStore(outletId, weekStart, rows);
    },
    [outletId, weekStart],
  );

  const removeDraftRow = React.useCallback(
    (assignmentId: string) => {
      removeDraft(outletId, weekStart, assignmentId);
    },
    [outletId, weekStart],
  );

  const recordPublication = React.useCallback(
    (published: RosterPublication) => {
      savePublication(published);
      clearDrafts(published.outletId, published.weekStart);
    },
    [],
  );

  return {
    drafts: snapshot.drafts,
    publication: snapshot.publication,
    addDrafts,
    replaceDrafts: replaceWeekDrafts,
    removeDraft: removeDraftRow,
    recordPublication,
  };
}

// ---- Publish -------------------------------------------------------------

/** The contract body plus the key the screen mints per publish attempt. */
export type PublishRosterBody = {
  outletId: string;
  weekStart: string;
  idempotencyKey: string;
};

export function usePublishRoster() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: PublishRosterBody) => api.publishRoster(body),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: [listShiftAssignments.id],
      }),
  });
}
