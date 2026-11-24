// Hooks for the sign-in screens: components never call the API or useQuery
// directly (docs/frontend.md "Custom hooks"). A completed sign-in invalidates
// the cached identity view, so the shell and the link-WhatsApp prompt refresh.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { InvitationAcceptBody } from "@starter/shared/identity";
import * as api from "./api";
import {
  currentAuthQuery,
  loginChallengeQuery,
  loginKeys,
  passwordResetStatusQuery,
} from "./queries";

export function useStartWhatsAppLogin() {
  return useMutation({
    mutationFn: (returnTo?: string) => api.startWhatsAppLogin(returnTo),
  });
}

/** Polls the challenge; disabled until the browser has one. */
export function useLoginChallenge(challengeId: string | null) {
  return useQuery({
    ...loginChallengeQuery(challengeId ?? ""),
    enabled: challengeId !== null,
  });
}

/**
 * "Ya, masuk": confirms the masked sender. The challenge query is refetched so
 * the next poll yields the session.
 */
export function useConfirmWhatsAppLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (challengeId: string) => api.confirmWhatsAppLogin(challengeId),
    onSuccess: (_data, challengeId) =>
      queryClient.invalidateQueries({
        queryKey: loginKeys.challenge(challengeId),
      }),
  });
}

/** "Batal": cancels this browser's challenge. */
export function useCancelWhatsAppLogin() {
  return useMutation({
    mutationFn: (challengeId: string) => api.cancelWhatsAppLogin(challengeId),
  });
}

export function useRequestMagicLink() {
  return useMutation({
    mutationFn: ({ email, returnTo }: { email: string; returnTo?: string }) =>
      api.requestMagicLinkEmail(email, returnTo),
  });
}

export function useCompleteMagicLink() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (token: string) => api.useMagicLink(token),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: loginKeys.currentAuth() }),
  });
}

export function useAcceptInvitation() {
  return useMutation({
    mutationFn: (body: InvitationAcceptBody | null) =>
      body ? api.acceptInvitation(body) : Promise.reject(new Error("invalid")),
  });
}

/** Resolves the provider URL; the screen navigates once it has one. */
export function useStartGoogleLogin() {
  return useMutation({
    mutationFn: (returnTo?: string) => api.googleAuthorizationUrl(returnTo),
  });
}

/**
 * Identity state for the link-WhatsApp prompt. A 401 is an expected answer
 * (signed out), not a fault, so this query never retries and the screen reads
 * `error.status` instead of an error boundary.
 */
export function useCurrentAuth() {
  return useQuery(currentAuthQuery());
}

/** `true` / `false` once known; `undefined` while loading or if the call failed. */
export function usePasswordResetEnabled() {
  return useQuery(passwordResetStatusQuery()).data;
}

export function useRequestPasswordReset() {
  return useMutation({
    mutationFn: (email: string) => api.requestPasswordResetEmail(email),
  });
}

export function useResetPassword() {
  return useMutation({
    mutationFn: (input: { token: string; newPassword: string }) =>
      api.resetPasswordWithToken(input.token, input.newPassword),
  });
}
