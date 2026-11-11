// Typed calls for the sign-in screens (PRD v1.7 §3 F3 "Autentikasi &
// Identitas", §4 Alur C; AUTH-01/03/07). Every function goes through
// callEndpoint with the identity contract, so mock mode
// (VITE_API_MOCK=true) serves the same shapes the API will
// (docs/frontend.md "Typed endpoints and mock mode"). No fetch and no types
// are written here: they come from @starter/shared/identity.
import { callEndpoint } from "@/lib/api/endpoint.ts";
import {
  cancelLoginChallenge,
  completeMagicLink,
  confirmLoginChallenge,
  getCurrentAuth,
  getLoginChallenge,
  requestMagicLink,
  requestWhatsAppLoginChallenge,
  startGoogleLogin,
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
