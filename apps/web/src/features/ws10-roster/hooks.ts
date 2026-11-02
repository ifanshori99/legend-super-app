// The only way the roster components touch data: queries keep their endpoint
// keys, the publish mutation invalidates the assignment list, and the local
// draft store is mirrored into React state so a drop re-renders the grid.
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
  readDrafts,
  readPublication,
  removeDraft,
  replaceDrafts as replaceDraftsInStore,
  saveDraft,
  savePublication,
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
 * Reads the local draft/publication store after hydration (localStorage is not
 * available during SSR) and writes every change back to it.
 */
export function useLocalRosterWeek(
  outletId: string,
  weekStart: string,
): LocalRosterWeek {
  const [drafts, setDraftsState] = React.useState<ShiftAssignment[]>([]);
  const [publication, setPublication] =
    React.useState<RosterPublication | null>(null);

  React.useEffect(() => {
    setDraftsState(readDrafts(outletId, weekStart));
    setPublication(readPublication(outletId, weekStart));
  }, [outletId, weekStart]);

  const addDrafts = React.useCallback(
    (rows: readonly ShiftAssignment[]) => {
      let next = readDrafts(outletId, weekStart);
      for (const row of rows) next = saveDraft(outletId, weekStart, row);
      setDraftsState(next);
    },
    [outletId, weekStart],
  );

  const replaceWeekDrafts = React.useCallback(
    (rows: readonly ShiftAssignment[]) => {
      setDraftsState(replaceDraftsInStore(outletId, weekStart, rows));
    },
    [outletId, weekStart],
  );

  const removeDraftRow = React.useCallback(
    (assignmentId: string) => {
      setDraftsState(removeDraft(outletId, weekStart, assignmentId));
    },
    [outletId, weekStart],
  );

  const recordPublication = React.useCallback(
    (published: RosterPublication) => {
      savePublication(published);
      clearDrafts(published.outletId, published.weekStart);
      setDraftsState([]);
      setPublication(published);
    },
    [],
  );

  return {
    drafts,
    publication,
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
