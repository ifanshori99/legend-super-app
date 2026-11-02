// Identity-domain event payloads (PRD v1.7 §3 F6/F7; naming
// `<aggregate>.<past_verb>` in the WS-00 catalog, ids ULID for the envelope —
// docs/plan/contracts.md).
//
// Registered with defineDomainEvent, so a typo or an unregistered name throws
// at module load instead of publishing an event nobody consumes. This bead
// owns the identity additions to the WS-01 catalog line (`session.revoked`,
// `approval.requested`, `approval.decided`, `approval.resolved`); login challenge, identity.link and
// session.created names come from the WS-01 proposal and are now bound here.
//
// Never in a payload: a login code, magic-link token, browser binding, session
// token, TOTP secret, passkey key, staff pin, raw phone/email, IP or free-text
// reason. Ids and enums only; the audit log holds the masked detail.
//
// A platform session (tenantId null) has no tenant event stream; it is audited
// by the platform service and never published on a tenant outbox.

import {
  brandIdSchema,
  idrSchema,
  isoDateTimeSchema,
  userIdSchema,
  z,
} from "../core/index.ts";
import { defineDomainEvent } from "../events/index.ts";
import {
  APPROVAL_MAX_LEVELS,
  approvalActionTypeSchema,
  approvalSourceSchema,
} from "../access/index.ts";
import {
  approvalRequestIdSchema,
  loginChallengeIdSchema,
  sessionIdSchema,
  userIdentityIdSchema,
} from "./ids.ts";
import {
  loginChannelSchema,
  objectIdSchema,
  objectTypeSchema,
  sessionKindSchema,
  sessionRevocationReasonSchema,
  userIdentityTypeSchema,
} from "./schemas.ts";

/** A challenge was issued; the code and binding stay server-side (AUTH-01). */
export const loginChallengeCreatedEvent = defineDomainEvent({
  name: "login_challenge.created",
  payload: z.strictObject({
    challengeId: loginChallengeIdSchema,
    channel: loginChannelSchema,
    brandId: brandIdSchema.nullable(),
    expiresAt: isoDateTimeSchema,
  }),
});

/**
 * A challenge completed exactly once (AUTH-01 single use). `outcome` says
 * whether it signed a user in or linked a verified number to the signed-in
 * account; a merge emits the identity events of the survivor.
 */
export const loginChallengeCompletedEvent = defineDomainEvent({
  name: "login_challenge.completed",
  payload: z.strictObject({
    challengeId: loginChallengeIdSchema,
    channel: loginChannelSchema,
    userId: userIdSchema,
    outcome: z.enum(["signed_in", "linked"]),
    sessionId: sessionIdSchema.nullable(),
  }),
});

/** A verified identity joined the account's graph (§3 F6 "Graf Identitas"). */
export const identityLinkedEvent = defineDomainEvent({
  name: "identity.linked",
  payload: z.strictObject({
    identityId: userIdentityIdSchema,
    userId: userIdSchema,
    type: userIdentityTypeSchema,
    isPrimary: z.boolean(),
  }),
});

/** A server-side session was created (§6 B sessions; revocable per device). */
export const sessionCreatedEvent = defineDomainEvent({
  name: "session.created",
  payload: z.strictObject({
    sessionId: sessionIdSchema,
    userId: userIdSchema,
    kind: sessionKindSchema,
    expiresAt: isoDateTimeSchema,
    mfaVerified: z.boolean(),
  }),
});

/** A session ended early: sign-out, device list revoke, lock or merge. */
export const sessionRevokedEvent = defineDomainEvent({
  name: "session.revoked",
  payload: z.strictObject({
    sessionId: sessionIdSchema,
    userId: userIdSchema,
    cause: sessionRevocationReasonSchema,
  }),
});

/**
 * One level of an approval request was opened (§3 F7 "Kotak Approval").
 * `requiredLevels` is the matrix snapshot, so the inbox can show "1 dari 2"
 * without recomputing the matrix; `amountIdr` is what the tier matched.
 */
export const approvalRequestedEvent = defineDomainEvent({
  name: "approval.requested",
  payload: z.strictObject({
    requestId: approvalRequestIdSchema,
    actionType: approvalActionTypeSchema,
    objectType: objectTypeSchema,
    objectId: objectIdSchema,
    source: approvalSourceSchema,
    level: z.number().int().min(1).max(APPROVAL_MAX_LEVELS),
    requiredLevels: z.number().int().min(1).max(APPROVAL_MAX_LEVELS),
    requestedBy: userIdSchema,
    amountIdr: idrSchema.refine((value) => value >= 0).nullable(),
    deadlineAt: isoDateTimeSchema,
  }),
});

/** A level was decided; the decision reason stays in the row and audit log. */
export const approvalDecidedEvent = defineDomainEvent({
  name: "approval.decided",
  payload: z.strictObject({
    requestId: approvalRequestIdSchema,
    actionType: approvalActionTypeSchema,
    objectType: objectTypeSchema,
    objectId: objectIdSchema,
    level: z.number().int().min(1).max(APPROVAL_MAX_LEVELS),
    decision: z.enum(["approved", "rejected"]),
    decidedBy: userIdSchema,
  }),
});

/**
 * A whole request chain ended (bead legend-y5q): the callback the source
 * module consumes to apply (or drop) its own effect in its own transaction —
 * the approval service never mutates another module's tables.
 * `chainId` is the level-1 request id the source module stored when it opened
 * the request; a consumer acts only on chains it opened (`sourceModule`).
 * `outcome`: approved = every required level approved; rejected = a level was
 * rejected; expired = a level passed its deadline (§3 F7 "batas waktu", fail
 * closed); cancelled = the source module withdrew it.
 */
export const approvalResolvedEvent = defineDomainEvent({
  name: "approval.resolved",
  payload: z.strictObject({
    chainId: approvalRequestIdSchema,
    requestId: approvalRequestIdSchema,
    sourceModule: z.string().regex(/^[a-z][a-z0-9_]{0,49}$/),
    actionType: approvalActionTypeSchema,
    objectType: objectTypeSchema,
    objectId: objectIdSchema,
    source: approvalSourceSchema,
    outcome: z.enum(["approved", "rejected", "expired", "cancelled"]),
    level: z.number().int().min(1).max(APPROVAL_MAX_LEVELS),
    requiredLevels: z.number().int().min(1).max(APPROVAL_MAX_LEVELS),
    requestedBy: userIdSchema,
    decidedBy: userIdSchema.nullable(),
    amountIdr: idrSchema.refine((value) => value >= 0).nullable(),
  }),
});
