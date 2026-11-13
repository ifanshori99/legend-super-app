// Support access (PRD v1.7 §3 F4 "Support Access", §6 A
// `support_access_grants`, TEN-04).
//
// "Data pribadi dan keuangan tenant hanya dapat dibuka Super Admin melalui
// sesi berjangka (default 60 menit) dengan alasan wajib, read-only secara
// default, tercatat di audit log, dan memicu notifikasi ke admin tenant."
// TEN-04: without an active session Super Admin cannot open that data; every
// session is recorded and visible to the tenant admin.
//
// The grant row is global (Super Admin is not a tenant member). The tenant
// is the platform route's path parameter, chosen by a platform-permissioned
// user, never the caller's own tenant context.

import {
  cursorPageSchema,
  isoDateTimeSchema,
  tenantIdSchema,
  userIdSchema,
  z,
} from "../core/index.ts";
import type { TenantId, UserId } from "../core/index.ts";
import { PlatformError } from "./errors.ts";
import {
  supportAccessGrantIdSchema,
  supportAccessRequestIdSchema,
} from "./ids.ts";

/** Durations offered (minutes); 60 is the PRD default. */
export const SUPPORT_ACCESS_DURATIONS = [15, 30, 60, 120] as const;
export const SUPPORT_ACCESS_DEFAULT_MINUTES = 60;

export const supportAccessModeSchema = z.enum(["read_only", "read_write"]);
export type SupportAccessMode = z.infer<typeof supportAccessModeSchema>;

/** Data classes that need an active session (PRD: "data pribadi dan
 * keuangan"). Everything else Super Admin sees (tenant settings, packages,
 * usage, health, cross-tenant audit metadata) needs only the platform role. */
export const SUPPORT_GATED_DATA_CLASSES = ["personal", "financial"] as const;
export const dataClassSchema = z.enum([
  ...SUPPORT_GATED_DATA_CLASSES,
  "configuration",
  "usage",
  "health",
]);
export type DataClass = z.infer<typeof dataClassSchema>;

export function requiresSupportAccess(dataClass: DataClass): boolean {
  return (SUPPORT_GATED_DATA_CLASSES as readonly string[]).includes(dataClass);
}

const reasonSchema = z.string().trim().min(20).max(500);

/** `support_access_grants` (global). */
export const supportAccessGrantSchema = z
  .strictObject({
    id: supportAccessGrantIdSchema,
    tenantId: tenantIdSchema,
    superAdminUserId: userIdSchema,
    /** Super Admin display name (never the email); null when unknown. */
    actorName: z.string().nullable().optional(),
    reason: reasonSchema,
    accessMode: supportAccessModeSchema,
    durationMinutes: z.union(
      SUPPORT_ACCESS_DURATIONS.map((minutes) => z.literal(minutes)),
    ),
    startedAt: isoDateTimeSchema,
    expiresAt: isoDateTimeSchema,
    /** Second factor re-verified when the session was opened. */
    mfaVerifiedAt: isoDateTimeSchema,
    /** Set when the tenant-admin notification was queued (support_access.granted). */
    tenantAdminNotifiedAt: isoDateTimeSchema.nullable(),
    endedAt: isoDateTimeSchema.nullable(),
    endedBy: userIdSchema.nullable(),
  })
  .refine(
    (grant) =>
      Date.parse(grant.expiresAt) - Date.parse(grant.startedAt) ===
      grant.durationMinutes * 60_000,
    { path: ["expiresAt"], message: "expiresAt = startedAt + duration" },
  )
  .refine((grant) => (grant.endedAt === null) === (grant.endedBy === null), {
    path: ["endedBy"],
    message: "endedAt and endedBy go together",
  })
  .refine(
    (grant) => Date.parse(grant.mfaVerifiedAt) <= Date.parse(grant.startedAt),
    { path: ["mfaVerifiedAt"], message: "MFA must precede the session" },
  );
export type SupportAccessGrant = z.infer<typeof supportAccessGrantSchema>;

/** Session list page. `serverNow` is the API clock at read time, so a device
 * clock running ahead does not hide the banner early. */
export const supportAccessGrantPageSchema = cursorPageSchema(
  supportAccessGrantSchema,
).extend({ serverNow: isoDateTimeSchema });
export type SupportAccessGrantPage = z.infer<
  typeof supportAccessGrantPageSchema
>;

/** Super Admin opens a session (tenant in the path). The TOTP code is
 * checked by the API; this schema checks its shape only. */
export const requestSupportAccessInputSchema = z.strictObject({
  reason: reasonSchema,
  durationMinutes: z
    .union(SUPPORT_ACCESS_DURATIONS.map((minutes) => z.literal(minutes)))
    .default(SUPPORT_ACCESS_DEFAULT_MINUTES),
  accessMode: supportAccessModeSchema.default("read_only"),
  mfaCode: z.string().regex(/^\d{6}$/),
});
export type RequestSupportAccessInput = z.infer<
  typeof requestSupportAccessInputSchema
>;

/** read_write needs tenant owner approval (founder Q37, legend-c9kbk): a
 * request not decided within this window expires. */
export const SUPPORT_ACCESS_APPROVAL_WINDOW_HOURS = 24;

/** Durations a read_write request may ask for (30 min cap). */
export const SUPPORT_ACCESS_WRITE_DURATIONS = [15, 30] as const;
export const SUPPORT_ACCESS_WRITE_DEFAULT_MINUTES = 30;

export const supportAccessRequestStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "expired",
]);
export type SupportAccessRequestStatus = z.infer<
  typeof supportAccessRequestStatusSchema
>;

const writeDurationSchema = z.union(
  SUPPORT_ACCESS_WRITE_DURATIONS.map((minutes) => z.literal(minutes)),
);

/** `support_access_requests` (tenant-owned). Until the tenant owner approves
 * a request no grant exists, so every guard sees "no grant" (fail closed). */
export const supportAccessRequestSchema = z
  .strictObject({
    id: supportAccessRequestIdSchema,
    tenantId: tenantIdSchema,
    superAdminUserId: userIdSchema,
    requesterName: z.string().nullable().optional(),
    reason: reasonSchema,
    accessMode: z.literal("read_write"),
    durationMinutes: writeDurationSchema,
    mfaVerifiedAt: isoDateTimeSchema,
    requestedAt: isoDateTimeSchema,
    approvalExpiresAt: isoDateTimeSchema,
    status: supportAccessRequestStatusSchema,
    decidedAt: isoDateTimeSchema.nullable(),
    decidedBy: userIdSchema.nullable(),
    grantId: supportAccessGrantIdSchema.nullable(),
    /** Set when the owner notification was queued (support_access.requested). */
    ownerNotifiedAt: isoDateTimeSchema.nullable(),
  })
  .refine(
    (request) =>
      Date.parse(request.approvalExpiresAt) -
        Date.parse(request.requestedAt) ===
      SUPPORT_ACCESS_APPROVAL_WINDOW_HOURS * 3_600_000,
    {
      path: ["approvalExpiresAt"],
      message: "approvalExpiresAt = requestedAt + 24 hours",
    },
  )
  .refine(
    (request) =>
      Date.parse(request.mfaVerifiedAt) <= Date.parse(request.requestedAt),
    { path: ["mfaVerifiedAt"], message: "MFA must precede the request" },
  )
  .refine(
    (request) =>
      (request.status === "pending") === (request.decidedAt === null),
    {
      path: ["decidedAt"],
      message: "pending <-> decidedAt is null",
    },
  )
  .refine(
    (request) =>
      (request.status === "approved" || request.status === "rejected") ===
      (request.decidedBy !== null),
    { path: ["decidedBy"], message: "approved/rejected <-> decidedBy is set" },
  )
  .refine(
    (request) => (request.status === "approved") === (request.grantId !== null),
    {
      path: ["grantId"],
      message: "approved <-> grantId is set",
    },
  )
  .refine(
    (request) =>
      request.decidedBy === null ||
      request.decidedBy !== request.superAdminUserId,
    { path: ["decidedBy"], message: "the requester cannot decide" },
  );
export type SupportAccessRequest = z.infer<typeof supportAccessRequestSchema>;

/** Super Admin files a read_write request (tenant in the path). The TOTP
 * code is checked by the API; this schema checks its shape only. */
export const requestSupportWriteAccessInputSchema = z.strictObject({
  reason: reasonSchema,
  durationMinutes: writeDurationSchema.default(
    SUPPORT_ACCESS_WRITE_DEFAULT_MINUTES,
  ),
  mfaCode: z.string().regex(/^\d{6}$/),
});
export type RequestSupportWriteAccessInput = z.infer<
  typeof requestSupportWriteAccessInputSchema
>;

/** Tenant owner approves or rejects (request id in the path, no body). */
export const decideSupportAccessRequestInputSchema = z.strictObject({});
export type DecideSupportAccessRequestInput = z.infer<
  typeof decideSupportAccessRequestInputSchema
>;

export type SupportAccessStatus = "active" | "expired" | "ended";

/** Derived status; a session is never extended, only ended early. */
export function supportAccessStatus(
  grant: Pick<SupportAccessGrant, "expiresAt" | "endedAt" | "startedAt">,
  now: string | Date,
): SupportAccessStatus {
  const at = typeof now === "string" ? Date.parse(now) : now.getTime();
  if (grant.endedAt !== null && Date.parse(grant.endedAt) <= at) return "ended";
  if (at < Date.parse(grant.startedAt)) return "expired"; // clock skew: fail closed
  return at < Date.parse(grant.expiresAt) ? "active" : "expired";
}

export function findActiveSupportGrant(
  grants: readonly SupportAccessGrant[],
  who: { tenantId: TenantId | string; superAdminUserId: UserId | string },
  now: string | Date,
): SupportAccessGrant | null {
  const tenantId = who.tenantId.toLowerCase();
  const userId = who.superAdminUserId.toLowerCase();
  return (
    grants.find(
      (grant) =>
        grant.tenantId === tenantId &&
        grant.superAdminUserId === userId &&
        supportAccessStatus(grant, now) === "active",
    ) ?? null
  );
}

/**
 * TEN-04 gate for Super Admin reads/writes of tenant data. Reads of
 * non-gated classes (usage, health, configuration) need only the platform
 * role; any write into tenant data needs a `read_write` session. Platform
 * settings (package, flags, quotas) are platform data and not gated here. Returns the grant
 * the access is attributed to (for the audit row), or null for data classes
 * that need no session. Throws SUPPORT_ACCESS_REQUIRED without an active
 * session and SUPPORT_ACCESS_READ_ONLY for a write in a read-only one.
 */
export function assertSupportAccess(
  grants: readonly SupportAccessGrant[],
  request: {
    tenantId: TenantId | string;
    superAdminUserId: UserId | string;
    dataClass: DataClass;
    intent: "read" | "write";
    now: string | Date;
  },
): SupportAccessGrant | null {
  dataClassSchema.parse(request.dataClass);
  z.enum(["read", "write"]).parse(request.intent);
  const grant = findActiveSupportGrant(grants, request, request.now);
  if (!requiresSupportAccess(request.dataClass) && request.intent === "read")
    return grant;
  if (!grant) throw new PlatformError("SUPPORT_ACCESS_REQUIRED");
  if (request.intent === "write" && grant.accessMode !== "read_write")
    throw new PlatformError("SUPPORT_ACCESS_READ_ONLY");
  return grant;
}

/** One open session per Super Admin and tenant. */
export function assertCanOpenSupportAccess(
  grants: readonly SupportAccessGrant[],
  who: { tenantId: TenantId | string; superAdminUserId: UserId | string },
  now: string | Date,
): void {
  if (findActiveSupportGrant(grants, who, now))
    throw new PlatformError("SUPPORT_ACCESS_ALREADY_ACTIVE");
}

/** Server-side expiry for a new session. */
export function supportAccessExpiry(
  startedAt: string,
  durationMinutes: (typeof SUPPORT_ACCESS_DURATIONS)[number],
): string {
  return new Date(
    Date.parse(startedAt) + durationMinutes * 60_000,
  ).toISOString();
}

/** Fields every audit row written under a support session carries (audit
 * contract: `sensitiveAccess` + mandatory `reason`), so the tenant admin sees
 * which session opened what (TEN-04). */
export function supportAccessAuditFields(grant: SupportAccessGrant): {
  sensitiveAccess: true;
  reason: string;
} {
  return {
    sensitiveAccess: true,
    reason: `support_access:${grant.id} ${grant.reason}`,
  };
}
