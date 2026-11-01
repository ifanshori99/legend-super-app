// Lock credentials: time-boxed and verifiable offline (PRD v1.7 §3 F22 Smart
// Lock & Offline, §6 K lock_credentials, FAC-01/FAC-03).
//
// A credential is pushed once, before the session, and carries its own window.
// The lock checks the window against its local clock; nothing here needs a
// network call, a cloud lookup or a fresh signature, which is what makes
// FAC-03 hold: a ticket issued before a four-hour outage still opens its door
// inside its session. Revocation is the only online action, and the provider
// pushes it to the lock; a lock that has not received the revocation still
// fails closed at `validUntil`.
//
// Never log, audit, event-publish or store the credential value itself
// (docs/plan/contracts.md adapters: "lock credentials are secrets").

import { FacilityError } from "./errors.ts";
import type { AccessTicket, LockCredential } from "./schemas.ts";
import { ticketCredentialWindow } from "./machines.ts";

/**
 * Maximum divergence between the lock clock and the edge clock that the
 * contract tolerates when a credential is pushed. Larger skew needs NTP repair,
 * not a wider window: widening it would extend access past the session.
 */
export const LOCK_CLOCK_SKEW_TOLERANCE_SECONDS = 120;

/** Statuses that make a credential unusable regardless of its window. */
const DEAD_STATUSES: ReadonlySet<LockCredential["status"]> = new Set([
  "revoked",
  "expired",
]);

/**
 * FAC-01: valid only inside `[validFrom, validUntil)` and only while the
 * credential was not revoked. Pure: the edge and the lock agree by using the
 * same stored instants.
 */
export function isLockCredentialValidAt(
  credential: LockCredential,
  at: Date | string,
): boolean {
  if (DEAD_STATUSES.has(credential.status)) return false;
  const time = typeof at === "string" ? Date.parse(at) : at.getTime();
  return (
    time >= Date.parse(credential.validFrom) &&
    time < Date.parse(credential.validUntil)
  );
}

export function assertLockCredentialValidAt(
  credential: LockCredential,
  at: Date | string,
): void {
  if (!isLockCredentialValidAt(credential, at))
    throw new FacilityError(
      "LOCK_CREDENTIAL_EXPIRED",
      "Kredensial pintu sudah kedaluwarsa.",
    );
}

/**
 * The credential belongs to exactly one ticket and must not open more than the
 * ticket's own door window (FAC-01): same ticket, same lock window or narrower.
 */
export function lockCredentialCoversTicket(
  credential: LockCredential,
  ticket: AccessTicket,
): boolean {
  if (credential.accessTicketId !== ticket.id) return false;
  const window = ticketCredentialWindow(ticket);
  return (
    Date.parse(credential.validFrom) >= Date.parse(window.validFrom) &&
    Date.parse(credential.validUntil) <= Date.parse(window.validUntil)
  );
}

/** Provider revocation (refund, cancellation, incident): the window stays, the status closes it. */
export function revokeLockCredential(
  credential: LockCredential,
  at: Date | string,
): LockCredential {
  if (credential.status === "revoked") return credential;
  const time = new Date(typeof at === "string" ? at : at.getTime());
  return {
    ...credential,
    status: "revoked",
    revokedAt: time.toISOString(),
  };
}

/** Marks the provider acknowledgement after LockProvider.issue succeeds. */
export function markLockCredentialPushed(
  credential: LockCredential,
  input: { pushedAt: Date | string; providerRef: string },
): LockCredential {
  const time = new Date(
    typeof input.pushedAt === "string"
      ? input.pushedAt
      : input.pushedAt.getTime(),
  );
  return {
    ...credential,
    status: "pushed",
    pushedAt: time.toISOString(),
    providerRef: input.providerRef,
  };
}
