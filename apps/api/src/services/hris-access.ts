// HRIS authorization and shared helpers (PRD v1.7 §3 F26; HR-01, HR-03;
// TEN-01..03; bead legend-qe1z).
//
// Everything runs on the caller's open tenant transaction (`withTenant`), so
// the access decision and the rows it guards come from one snapshot.
//
// Who is the viewer of one employee record (contract `HrisViewer`, pii.ts)?
// The kind is derived from permissions that reach the employee's home outlet,
// never from the client and never from a role name (custom roles must work):
//   - `hr`         holds `hr.employee.manage` there   (HR role, PII masked)
//   - `payroll`    holds `payroll.view` there         (payroll/finance)
//   - `self`       it is the caller's own employee row and they hold
//                  `self.profile.view`               (HR-01)
//   - `supervisor` holds `hr.employee.view` only     (GM / outlet manager:
//                  master data yes, HR-03 PII hidden)
//   - otherwise no viewer at all → the record answers 404 (HR-01: a direct API
//     call for someone else's row looks exactly like a missing row).
// The contract's `hrisPiiVisibility` then decides each PII class, plus a
// field-level rule: a `self` viewer gets `hidden` for a field whose
// `selfPermission` is null or not held (fail closed).

import { and, eq } from "drizzle-orm";
import { outletReachOf, type PermissionCode } from "@starter/shared/access";
import {
  createUlid,
  decodeCursor,
  isOutletInScope,
  userIdSchema,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import {
  hrisPiiVisibility,
  type EmployeeId,
  type HrisPiiFieldDefinition,
  type HrisPiiVisibility,
  type HrisViewer,
} from "@starter/shared/hris";
import { employees } from "../db/schema/hris.ts";
import { HttpError } from "../lib/http-error.ts";
import { hrisPiiDefinition, type HrisSealedField } from "../lib/hris-pii.ts";
import {
  loadTenantAccessInTransaction,
  resolveAccessSnapshot,
  type AccessSnapshot,
  type TenantAccessData,
  type Tx,
} from "./permission-resolver.ts";

export type { Tx };

/** Codes that list/read HR master data of employees other than oneself. */
export const HRIS_READ_CODES = [
  "hr.employee.view",
  "hr.employee.manage",
  "payroll.view",
] as const satisfies readonly PermissionCode[];
export const HRIS_SELF_CODE: PermissionCode = "self.profile.view";
export const HRIS_MANAGE_CODE: PermissionCode = "hr.employee.manage";

const HRIS_CODES: readonly PermissionCode[] = [
  "hr.employee.view",
  "hr.employee.manage",
  "payroll.view",
  "payroll.run",
  "self.profile.view",
];

/** `tenant` = every outlet; otherwise the explicit outlet ids (lower-case). */
export type HrisReach =
  | { readonly kind: "tenant" }
  | { readonly kind: "outlets"; readonly outletIds: readonly string[] };

export type HrisSubject = {
  readonly id: string;
  readonly homeOutletId: string;
};

export type HrisAccess = {
  readonly actorUserId: UserId;
  readonly snapshot: AccessSnapshot;
  /** The caller's own employee row in this tenant, if any. */
  readonly own: HrisSubject | null;
  /** HRIS codes the caller holds on the subject's home outlet. */
  readonly permissionsAt: (outletId: string) => PermissionCode[];
  /** Union outlet reach of any of `codes` (null = no reach). */
  readonly reach: (codes: readonly PermissionCode[]) => HrisReach | null;
  /** Server-resolved viewer of one record, or null (= 404). */
  readonly viewerFor: (subject: HrisSubject) => HrisViewer | null;
};

const lower = (value: string) => value.toLowerCase();

export async function loadHrisAccess(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  now: Date = new Date(),
): Promise<HrisAccess> {
  const actor = userIdSchema.parse(actorUserId);
  const data: TenantAccessData = await loadTenantAccessInTransaction(
    tx,
    context,
    actor,
  );
  const snapshot = resolveAccessSnapshot({
    tenant: context.tenant,
    userId: actor,
    ...data,
    mfaVerified: false,
    now,
  });
  const [ownRow] = await tx
    .select({ id: employees.id, homeOutletId: employees.homeOutletId })
    .from(employees)
    .where(
      and(
        eq(employees.tenantId, context.tenant.tenantId),
        eq(employees.userId, actor),
      ),
    )
    .limit(1);
  const own = ownRow ?? null;
  const holdsSelf = snapshot.permissions.includes(HRIS_SELF_CODE);

  const permissionsAt = (outletId: string) =>
    HRIS_CODES.filter((code) =>
      snapshot.allows(code, { type: "outlet", id: outletId }),
    );

  const reach = (codes: readonly PermissionCode[]): HrisReach | null => {
    const outletIds = new Set<string>();
    for (const code of codes) {
      const scope = outletReachOf({
        principal: {
          tenantId: context.tenant.tenantId,
          userId: actor,
          assignments: data.assignments,
        },
        roles: data.roles,
        org: data.org,
        now,
        permission: code,
      });
      if (scope === null) continue;
      if (scope.kind === "tenant") return { kind: "tenant" };
      for (const id of scope.outletIds) outletIds.add(lower(id));
    }
    return outletIds.size === 0
      ? null
      : { kind: "outlets", outletIds: [...outletIds] };
  };

  const viewerFor = (subject: HrisSubject): HrisViewer | null => {
    const codes = permissionsAt(subject.homeOutletId);
    const isOwn = own !== null && lower(own.id) === lower(subject.id);
    const permissions: string[] = [...codes];
    if (isOwn && holdsSelf && !permissions.includes(HRIS_SELF_CODE))
      permissions.push(HRIS_SELF_CODE);
    const employeeId = (own?.id ?? null) as EmployeeId | null;
    if (codes.includes("hr.employee.manage"))
      return { kind: "hr", employeeId, permissions };
    if (codes.includes("payroll.view"))
      return { kind: "payroll", employeeId, permissions };
    if (isOwn && holdsSelf) return { kind: "self", employeeId, permissions };
    if (codes.includes("hr.employee.view"))
      return { kind: "supervisor", employeeId, permissions };
    return null;
  };

  return {
    actorUserId: actor,
    snapshot,
    own,
    permissionsAt,
    reach,
    viewerFor,
  };
}

/** HR-01 / HR-03 visibility of one sealed field for one viewer. */
export function hrisFieldVisibility(
  viewer: HrisViewer,
  subjectEmployeeId: string,
  field: HrisSealedField,
): HrisPiiVisibility {
  return hrisDefinitionVisibility(
    viewer,
    subjectEmployeeId,
    hrisPiiDefinition(field),
  );
}

/** Same rule for any contract field definition (e.g. private file URLs). */
export function hrisDefinitionVisibility(
  viewer: HrisViewer,
  subjectEmployeeId: string,
  definition: HrisPiiFieldDefinition,
): HrisPiiVisibility {
  const visibility = hrisPiiVisibility(
    viewer,
    subjectEmployeeId,
    definition.piiClass,
  );
  if (visibility === "hidden") return "hidden";
  if (viewer.kind === "self") {
    // Fail closed on the field's own self-service rule.
    if (
      definition.selfPermission === null ||
      !viewer.permissions.includes(definition.selfPermission)
    )
      return "hidden";
  }
  return visibility;
}

/**
 * The outlet an audit row is filed under. recordAudit requires the outlet to
 * be inside the caller's scope (or a tenant-wide scope for null), so a self
 * viewer whose role reaches another outlet files the row under that outlet.
 */
export function auditOutletFor(
  context: ScopedTenantContext,
  homeOutletId: string,
): string {
  const scope = context.outletScope;
  if (scope.kind === "tenant" || isOutletInScope(scope, homeOutletId))
    return homeOutletId;
  const first = scope.outletIds[0];
  if (!first) throw new Error("Outlet scope without outlets");
  return first;
}

/** Field names only — never values — so the masker has nothing to hide. */
export const HRIS_AUDIT_SAFE_FIELDS = [
  "fields",
  "changedFields",
  "status",
  "employeeNo",
  "employmentType",
  "type",
  "viewerKind",
] as const;

export function hrisAuditEntry(
  context: ScopedTenantContext,
  actor: string,
  now: Date,
  entry: {
    readonly outletId: string;
    readonly action: string;
    readonly objectType: string;
    readonly objectId: string;
    readonly after: Record<string, unknown> | null;
    readonly sensitiveReason?: string;
  },
) {
  return {
    id: createUlid(now.getTime()),
    tenantId: context.tenant.tenantId,
    outletId: auditOutletFor(context, entry.outletId),
    actorType: "user" as const,
    actorId: actor,
    deviceId: null,
    action: entry.action,
    objectType: entry.objectType,
    objectId: entry.objectId,
    reason: entry.sensitiveReason ?? null,
    maskedChanges: { before: null, after: entry.after },
    ipHash: null,
    sensitiveAccess: entry.sensitiveReason !== undefined,
    retentionClass: "audit_2y" as const,
    createdAt: now.toISOString(),
  };
}

/** PostgreSQL unique violation (code 23505) and its constraint name. */
export function uniqueViolation(
  error: unknown,
  depth = 0,
): { constraint: string | null } | null {
  if (depth > 4 || typeof error !== "object" || error === null) return null;
  const candidate = error as {
    code?: unknown;
    constraint?: unknown;
    cause?: unknown;
  };
  if (candidate.code === "23505")
    return {
      constraint:
        typeof candidate.constraint === "string" ? candidate.constraint : null,
    };
  return uniqueViolation(candidate.cause, depth + 1);
}

/** Decodes a two-key cursor `[sortKey, id]`; 422 on anything else. */
export function cursorPair(cursor: string): [string, string] {
  let keys;
  try {
    keys = decodeCursor(cursor);
  } catch {
    throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
  }
  const [first, second] = keys;
  if (typeof first !== "string" || typeof second !== "string")
    throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
  return [first, second];
}

export function notFound(what = "Data karyawan"): HttpError {
  return new HttpError(404, "NOT_FOUND", `${what} tidak ditemukan.`);
}

export function forbidden(): HttpError {
  return new HttpError(
    403,
    "FORBIDDEN",
    "Your account cannot perform this action in this tenant.",
  );
}
