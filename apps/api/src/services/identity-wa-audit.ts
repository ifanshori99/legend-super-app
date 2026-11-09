// Audit trail for the WhatsApp login challenge (bead legend-wq3f; PRD v1.7 §3
// F6, §6 B audit_logs; AUTH-01/02/04/06).
//
// One `audit_logs` row per challenge milestone, appended on the caller's tenant
// transaction so the row commits (or rolls back) with the state change it
// describes. Rows never carry the code, a binding or session token, or a full
// number: only the challenge id, the outcome, the masked sender and the keyed
// client-IP digest. The `after` keys are all in SAFE_FIELDS and deliberately avoid
// names the masking deny list redacts (session, phone, ip, ...).
//
// A rejection that matched no challenge (unknown or foreign code) and the
// webhook's per-number rate limit (AUTH-04) have no tenant to write under, so
// they are not audited here; the inbound row (wa_inbound_messages) keeps their
// kind.

import { createUlid } from "@starter/shared/core";
import type { ScopedTenantContext } from "@starter/shared/core";
import { normalizeWhatsAppNumber } from "@starter/shared/identity";
import { recordAudit } from "./core-audit.ts";

type Transaction = Parameters<typeof recordAudit>[0];

export type LoginAuditAction =
  | "login_challenge.created"
  | "login_challenge.completed"
  | "login_challenge.rejected"
  | "login_challenge.expired"
  | "login_challenge.cancelled"
  | "login_challenge.rate_limited"
  | "login_challenge.claimed"
  | "login_challenge.claim_failed";

/** The only `after` keys a login audit row keeps; anything else is redacted. */
export const LOGIN_AUDIT_SAFE_FIELDS = [
  "channel",
  "status",
  "expiresAt",
  "linking",
  "matchedUserId",
  "senderMasked",
  "cause",
] as const;

/**
 * Data minimisation (CTO decision 2026-11-10): an audit row keeps only the last
 * three digits of the sender ("•••123"), for every event including rejected.
 */
export function maskSenderForAudit(
  number: string | null | undefined,
): string | null {
  const digits = normalizeWhatsAppNumber(number);
  return digits === null ? null : `•••${digits.slice(-3)}`;
}

export type LoginAuditDetails = {
  readonly channel?: "whatsapp_inbound";
  readonly status?: string;
  readonly expiresAt?: string;
  readonly linking?: boolean;
  readonly matchedUserId?: string | null;
  /** `maskSenderForAudit` output only, never the raw number. */
  readonly senderMasked?: string | null;
  readonly cause?: string;
};

export async function recordLoginAudit(
  tx: Transaction,
  context: ScopedTenantContext,
  input: {
    readonly action: LoginAuditAction;
    /** The login challenge id (UUID); null when none was created (rate limit). */
    readonly challengeId: string | null;
    /** The matched user for a completion; otherwise the guest is anonymous. */
    readonly actorUserId?: string | null;
    readonly details: LoginAuditDetails;
    readonly now: Date;
    /** Keyed client-IP digest (never the IP itself). */
    readonly ipHash?: string | null;
  },
): Promise<void> {
  const actorUserId = input.actorUserId ?? null;
  const ipHash =
    input.ipHash && /^[a-f0-9]{64}$/.test(input.ipHash) ? input.ipHash : null;
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(input.now.getTime()),
      tenantId: context.tenant.tenantId,
      outletId: null,
      actorType: actorUserId ? "user" : "system",
      actorId: actorUserId,
      deviceId: null,
      action: input.action,
      objectType: "login_challenge",
      objectId: input.challengeId,
      reason: null,
      maskedChanges: { before: null, after: { ...input.details } },
      ipHash,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: input.now.toISOString(),
    },
    LOGIN_AUDIT_SAFE_FIELDS,
  );
}
