// The tenant user directory the grant dialog and the assignments table read.
//
// WS-01 has no directory endpoint yet (follow-up bead from legend-g6d), so the
// screen reads a small port: mock mode fills it from the shared identity
// fixtures so the flow is reviewable end to end, while a real API gets an empty
// directory that the dialog explains instead of inventing people (fail closed).
// Wiring this to `GET /api/access/users` is part of WS-01 INT (legend-91i).
import { queryOptions, useQuery } from "@tanstack/react-query";

export type AssignablePerson = {
  readonly id: string;
  readonly name: string;
  readonly kind: "staff" | "customer" | "both";
};

export type PeopleDirectory = {
  readonly people: readonly AssignablePerson[];
  /** True when the platform cannot serve a directory at all. */
  readonly unavailable: boolean;
};

export const EMPTY_PEOPLE_DIRECTORY: PeopleDirectory = Object.freeze({
  people: [],
  unavailable: true,
});

export async function loadAssignablePeople(): Promise<PeopleDirectory> {
  if (import.meta.env.VITE_API_MOCK === "true") {
    const { mockAssignablePeople } = await import("./mock-people");
    return { people: mockAssignablePeople(), unavailable: false };
  }
  return EMPTY_PEOPLE_DIRECTORY;
}

export function useAssignablePeople() {
  return useQuery(assignablePeopleQuery());
}

export const assignablePeopleQuery = () =>
  queryOptions({
    queryKey: ["access", "people"] as const,
    queryFn: loadAssignablePeople,
    staleTime: Number.POSITIVE_INFINITY,
  });
