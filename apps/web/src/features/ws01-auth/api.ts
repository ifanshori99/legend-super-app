// One function per identity endpoint these screens use. Components never call
// these directly (they use ./hooks.ts). Contracts, schemas and fixtures come
// from @starter/shared/identity, so the mock and the future API share one
// shape (docs/frontend.md "Typed endpoints and mock mode").
import {
  deleteMfaFactor,
  enrollMfaFactor,
  getCurrentAuth,
  listMfaFactors,
  listSessions,
  revokeSession,
  verifyMfaFactor,
  type MfaEnrollInput,
  type MfaVerifyInput,
} from "@starter/shared/identity";
import { callEndpoint } from "@/lib/api/endpoint";

/** Everything the shell needs about this session (AUTH-05 state included). */
export async function fetchCurrentAuth(signal?: AbortSignal) {
  const { data } = await callEndpoint(getCurrentAuth, undefined, { signal });
  return data;
}

export async function fetchMfaFactors(signal?: AbortSignal) {
  const { data } = await callEndpoint(listMfaFactors, undefined, { signal });
  return data;
}

/** Starts enrollment: a TOTP secret + otpauth URI, or passkey options. */
export async function startMfaEnrollment(input: MfaEnrollInput) {
  const { data } = await callEndpoint(enrollMfaFactor, { body: input });
  return data;
}

/** Verifies the second factor for this session or finishes enrollment. */
export async function verifySecondFactor(input: MfaVerifyInput) {
  const { data } = await callEndpoint(verifyMfaFactor, { body: input });
  return data;
}

export async function removeMfaFactor(factorId: string) {
  await callEndpoint(deleteMfaFactor, { params: { factorId } });
}

/** The owner's device list; `current` marks the session making the request. */
export async function fetchSessions(signal?: AbortSignal) {
  const { data } = await callEndpoint(listSessions, undefined, { signal });
  return data;
}

export async function revokeDeviceSession(sessionId: string) {
  await callEndpoint(revokeSession, { params: { sessionId } });
}
