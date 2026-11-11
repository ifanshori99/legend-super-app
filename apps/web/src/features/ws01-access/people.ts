// The tenant user directory the grant dialog and the assignments table read.
//
// The screen reads a small port: mock mode fills it from the shared identity
// fixtures so the flow is reviewable end to end, while the real API serves
// `GET /api/access/users` (legend-i6ff, staff only). If that call fails, or the
// directory is longer than we page through, the result is flagged unavailable
// and the dialog explains it instead of inventing people (fail closed). An
// unavailable result is never cached as final: it is stale at once, so the
// next mount fetches again.
import { queryOptions, useQuery } from "@tanstack/react-query";
import type { AccessUser } from "@starter/shared/access";
import { listAccessUsers } from "@starter/shared/identity";
import { callEndpoint } from "@/lib/api/endpoint";

export type AssignablePerson = {
  readonly id: string;
  readonly name: string;
  readonly kind: "staff" | "customer" | "both";
  /** Inactive people still resolve names but cannot be granted a role. */
  readonly status: AccessUser["status"];
};

export type PeopleDirectory = {
  readonly people: readonly AssignablePerson[];
  /** True when the platform cannot serve the whole directory (error or truncated). */
  readonly unavailable: boolean;
};

export const EMPTY_PEOPLE_DIRECTORY: PeopleDirectory = Object.freeze({
  people: [],
  unavailable: true,
});

const MAX_DIRECTORY_PAGES = 20;

export async function loadAssignablePeople(): Promise<PeopleDirectory> {
  if (import.meta.env.VITE_API_MOCK === "true") {
    const { mockAssignablePeople } = await import("./mock-people");
    return { people: mockAssignablePeople(), unavailable: false };
  }
  try {
    const people: AssignablePerson[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_DIRECTORY_PAGES; page += 1) {
      const result = await callEndpoint(listAccessUsers, {
        query: { limit: 100, cursor },
      });
      for (const row of result.data)
        people.push({
          id: row.userId,
          name: row.displayName,
          kind: row.kind,
          status: row.status,
        });
      if (!result.meta.nextCursor) return { people, unavailable: false };
      cursor = result.meta.nextCursor;
    }
    // A cursor is still left: a partial directory would hide people silently.
    return { people, unavailable: true };
  } catch {
    return EMPTY_PEOPLE_DIRECTORY;
  }
}

export function useAssignablePeople() {
  return useQuery(assignablePeopleQuery());
}

export const assignablePeopleQuery = () =>
  queryOptions({
    queryKey: ["access", "people"] as const,
    queryFn: loadAssignablePeople,
    // Only a complete directory is kept for good; an unavailable one is
    // refetched on the next mount instead of staying cached as a success.
    staleTime: (query) =>
      query.state.data?.unavailable ? 0 : Number.POSITIVE_INFINITY,
  });
