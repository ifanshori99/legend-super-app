// Typed calls for the sign-in screens (PRD v1.7 §3 F3 "Autentikasi &
// Identitas", §4 Alur C; AUTH-01/03/07). Every function goes through
// callEndpoint with the identity contract, so mock mode
// (VITE_API_MOCK=true) serves the same shapes the API will
// (docs/frontend.md "Typed endpoints and mock mode"). No fetch and no types
// are written here: they come from @starter/shared/identity.
import { apiFetch } from "@/lib/api/client";
import { authClient } from "@/lib/auth-client";
import { callEndpoint } from "@/lib/api/endpoint.ts";
import {
  acceptTenantInvitation,
  cancelLoginChallenge,
  completeMagicLink,
  confirmLoginChallenge,
  getCurrentAuth,
  getLoginChallenge,
  requestMagicLink,
  requestWhatsAppLoginChallenge,
  startGoogleLogin,
  type InvitationAcceptBody,
} from "@starter/shared/identity";

/** POST /api/auth/login-challenges/whatsapp — code + deep link, shown once. */
export async function startWhatsAppLogin(returnTo?: string) {
  const response = await callEndpoint(requestWhatsAppLoginChallenge, {
    body: returnTo
      ? { returnTo, requireConfirm: true }
      : { requireConfirm: true },
  });
  return response.data;
}

/** GET /api/auth/login-challenges/:id — the browser polls its own challenge. */
export async function fetchLoginChallenge(
  challengeId: string,
  signal?: AbortSignal,
) {
  const response = await callEndpoint(
    getLoginChallenge,
    { params: { challengeId } },
    { signal },
  );
  return response.data;
}

/** POST .../:id/confirm — "Ya, masuk": the bound browser confirms the sender. */
export async function confirmWhatsAppLogin(challengeId: string) {
  await callEndpoint(confirmLoginChallenge, { params: { challengeId } });
}

/** POST .../:id/cancel — "Bukan saya" from the same browser. */
export async function cancelWhatsAppLogin(challengeId: string) {
  await callEndpoint(cancelLoginChallenge, { params: { challengeId } });
}

/** POST /api/auth/login-challenges/email — same answer whether the address exists. */
export async function requestMagicLinkEmail(email: string, returnTo?: string) {
  const response = await callEndpoint(requestMagicLink, {
    body: returnTo ? { email, returnTo } : { email },
  });
  return response.data;
}

/** GET /api/auth/magic-link?token=… — the clicked email link; sets the session. */
export async function useMagicLink(token: string) {
  const response = await callEndpoint(completeMagicLink, { query: { token } });
  return response.data;
}

/** POST /api/auth/login-challenges/invitation — marks the invited admin's email verified. */
export async function acceptInvitation(body: InvitationAcceptBody) {
  const response = await callEndpoint(acceptTenantInvitation, { body });
  return response.data;
}

/** GET /api/auth/google/start — the provider URL, state included server-side. */
export async function googleAuthorizationUrl(returnTo?: string) {
  const response = await callEndpoint(startGoogleLogin, {
    query: returnTo ? { returnTo } : {},
  });
  return response.data.authorizationUrl;
}

/** GET /api/auth/me — identity state for the link-WhatsApp prompt. */
export async function fetchCurrentAuth(signal?: AbortSignal) {
  const response = await callEndpoint(getCurrentAuth, {}, { signal });
  return response.data;
}

/** GET /api/auth/password-reset/status — may the "Lupa kata sandi" link show? */
export async function fetchPasswordResetStatus(signal?: AbortSignal) {
  const response = await apiFetch<{ data: { enabled: boolean } }>(
    "/api/auth/password-reset/status",
    { signal },
  );
  return response.data.enabled;
}

/**
 * POST /api/auth/request-password-reset — the same answer for every address.
 * The mail's link is built by the API; a 503 means no mail sender is set up.
 */
export async function requestPasswordResetEmail(email: string) {
  const result = await authClient.requestPasswordReset({ email });
  if (result.error) throw new PasswordResetError(result.error.status ?? 0);
}

/** POST /api/auth/reset-password — the token works once, for one hour. */
export async function resetPasswordWithToken(
  token: string,
  newPassword: string,
) {
  const result = await authClient.resetPassword({ newPassword, token });
  if (result.error) throw new PasswordResetError(result.error.status ?? 0);
}

/** `code` feeds loginErrorKey: 429 reads as "too many", 0 as "offline". */
export class PasswordResetError extends Error {
  readonly code: string;
  constructor(readonly status: number) {
    super(`password reset failed (${status})`);
    this.code =
      status === 429
        ? "RATE_LIMITED"
        : status === 0
          ? "NETWORK_ERROR"
          : "RESET_FAILED";
  }
}
