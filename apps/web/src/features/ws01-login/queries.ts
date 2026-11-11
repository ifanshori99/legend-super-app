// Query keys and options for the sign-in screens. Keys are hierarchical, so a
// completed sign-in can invalidate the session view without touching other
// features (docs/frontend.md "Query options and keys").
import { queryOptions } from "@tanstack/react-query";
import { fetchCurrentAuth, fetchLoginChallenge } from "./api";
import { LOGIN_POLL_MS } from "./flow";

export const loginKeys = {
  all: ["login"] as const,
  challenge: (challengeId: string) =>
    [...loginKeys.all, "challenge", challengeId] as const,
  currentAuth: () => [...loginKeys.all, "current-auth"] as const,
};

/**
 * Polls this browser's own challenge while it is pending and unexpired; the
 * server hands out the session once the WhatsApp message lands (AUTH-01).
 * A completed, cancelled or expired challenge stops the poll, and so does a
 * challenge that awaits the person's confirmation.
 */
export function loginChallengeQuery(challengeId: string) {
  return queryOptions({
    queryKey: loginKeys.challenge(challengeId),
    queryFn: ({ signal }) => fetchLoginChallenge(challengeId, signal),
    staleTime: 0,
    refetchInterval: (query) => {
      const view = query.state.data;
      if (!view || view.challenge.status !== "pending") return false;
      // Waiting for a tap on "Ya, masuk" / "Bukan saya": the confirm mutation
      // invalidates this query, which resumes the poll.
      if (view.awaitingConfirmation === true) return false;
      return Date.parse(view.challenge.expiresAt) > Date.now()
        ? LOGIN_POLL_MS
        : false;
    },
  });
}

/** The visitor's identity state (signed in? WhatsApp verified?). */
export function currentAuthQuery() {
  return queryOptions({
    queryKey: loginKeys.currentAuth(),
    queryFn: ({ signal }) => fetchCurrentAuth(signal),
    staleTime: 0,
    retry: false,
  });
}
