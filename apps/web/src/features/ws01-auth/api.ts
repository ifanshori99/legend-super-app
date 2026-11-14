// One function per identity endpoint these screens use. Components never call
// these directly (they use ./hooks.ts). Contracts, schemas and fixtures come
// from @starter/shared/identity, so the mock and the future API share one
// shape (docs/frontend.md "Typed endpoints and mock mode").
import {
  deleteMfaFactor,
  enrollMfaFactor,
  extendCurrentSession,
  generateMfaRecoveryCodes,
  getCurrentAuth,
  getMfaRecoveryStatus,
  listMfaFactors,
  listPushDevices,
  listSessions,
  revokePushDevice,
  revokeSession,
  verifyMfaFactor,
  verifyMfaRecoveryCode,
  type MfaEnrollInput,
  type MfaRecoveryVerifyInput,
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

/**
 * Phones registered for panic alarms on this account, including ones whose
 * login session has already ended (they still receive alarms until revoked).
 */
export async function fetchPushDevices(signal?: AbortSignal) {
  const { data } = await callEndpoint(listPushDevices, undefined, { signal });
  return data;
}

export async function revokeAlarmDevice(id: string) {
  await callEndpoint(revokePushDevice, { params: { id } });
}

/** Records explicit staff activity before refreshing the idle deadline. */
export async function extendStaffSession() {
  await callEndpoint(extendCurrentSession, undefined);
}

/** Unused recovery codes left; never the codes themselves. */
export async function fetchMfaRecoveryStatus(signal?: AbortSignal) {
  const { data } = await callEndpoint(getMfaRecoveryStatus, undefined, {
    signal,
  });
  return data;
}

/** Replaces the whole set. The plaintext codes are in this response only. */
export async function createMfaRecoveryCodes() {
  const { data } = await callEndpoint(generateMfaRecoveryCodes, undefined);
  return data;
}

/** Signs this session in with one single-use code (the second factor). */
export async function submitMfaRecoveryCode(input: MfaRecoveryVerifyInput) {
  const { data } = await callEndpoint(verifyMfaRecoveryCode, { body: input });
  return data;
}
