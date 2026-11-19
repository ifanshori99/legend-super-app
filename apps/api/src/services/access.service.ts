// Tenant RBAC administration (bead legend-4f9; PRD v1.7 §3.7 "RBAC, Organisasi
// & Matriks Approval", §6 B roles / role_assignments / approval_policies,
// TEN-03).
//
// Every function runs inside `withTenant`, so RLS scopes rows to the resolved
// tenant and the service scope comes from the caller's assignments. Rules come
// from `@starter/shared/access` — role templates, custom-role validation, the
// grant rules (re-auth, no self-elevation, top-authority), the approval matrix
// validator — never re-implemented here.
//
// Sensitive changes (role created/updated, assignment granted/ended, matrix
// replaced) write the domain event through the transactional outbox and an
// audit record through the fail-closed AuditWriter port, in the same
// transaction.

import { randomUUID } from "node:crypto";
import {
  AccessError,
  DEFAULT_CASH_OUT_APPROVAL_POLICIES,
  DEFAULT_CASH_SHIFT_CLOSE_APPROVAL_POLICIES,
  DEFAULT_SUPPLIER_PAYMENT_APPROVAL_POLICIES,
  DEFAULT_SHAREHOLDER_VERSION_APPROVAL_POLICIES,
  DEFAULT_RECONCILIATION_CASE_APPROVAL_POLICIES,
  DEFAULT_REFUND_APPROVAL_POLICIES,
  approvalPolicyChangedEvent,
  approvalMatrixSchema,
  supplierPaymentBaseTierMissing,
  approvalPolicySchema,
  roleAssignmentSchema,
  roleIdSchema,
  roleSchema,
  assertCanEditCustomRole,
  assertCanGrantRole,
  isAssignmentActive,
  isRoleTemplateKey,
  normalizeCustomRolePermissions,
  ROLE_TEMPLATES,
  rolePermissionsAsGranted,
  withoutOwnerOnlyPermissions,
  roleCreatedEvent,
  roleAssignmentEndedEvent,
  roleAssignmentGrantedEvent,
  roleTemplate,
  roleUpdatedEvent,
  scopeCovers,
  type AccessTarget,
  type AccessUser,
  type ApprovalPolicy,
  type PermissionCode,
  type Role,
  type RoleAssignment,
  type CreateCustomRoleInput,
  type EndRoleAssignmentInput,
  type GrantRoleInput,
  type UpdateCustomRoleInput,
} from "@starter/shared/access";
import {
  createUlid,
  decodeCursor,
  encodeCursor,
  userIdSchema,
} from "@starter/shared/core";
import type { ScopedTenantContext } from "@starter/shared/core";
import type { ReplaceApprovalMatrixInput } from "@starter/shared/identity";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { db } from "../db";
import {
  approvalPolicies,
  domainEventOutbox,
  employees,
  roleAssignments,
  roles,
  user,
} from "../db/schema";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import { SYSTEM_ACCOUNT_ID } from "../lib/system-account";
import { recordAudit } from "./audit-writer";
import { appendOutbox } from "./core-outbox";
import { SYSTEM_ACTOR_ID, type HrisActor } from "./hris-access";
import {
  loadTenantAccessInTransaction,
  resolveAccessSnapshot,
  type AccessSnapshot,
  type Tx,
} from "./permission-resolver";

type RoleRow = typeof roles.$inferSelect;
type AssignmentRow = typeof roleAssignments.$inferSelect;
type PolicyRow = typeof approvalPolicies.$inferSelect;

/** Consumers receive access events through the cloud sync stream. */
const EVENT_DESTINATION = "cloud-sync";

function uniqueViolation(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  return (
    candidate.code === "23505" || uniqueViolation(candidate.cause, depth + 1)
  );
}

function toRole(row: RoleRow): Role {
  return roleSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    isTemplate: row.isTemplate,
    templateKey: row.templateKey,
    // legend-7vsby: Owner-only codes left in an old custom role are not shown,
    // so the editor never sends them back (they would be refused).
    permissions: rolePermissionsAsGranted(row.templateKey, row.permissions),
    mfaRequired: row.mfaRequired,
    allowedScopeTypes: row.allowedScopeTypes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

function toAssignment(row: AssignmentRow): RoleAssignment {
  return roleAssignmentSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    userId: row.userId,
    roleId: row.roleId,
    scope:
      row.scopeType === "tenant"
        ? { type: "tenant", id: null }
        : { type: row.scopeType, id: row.scopeId },
    validFrom: row.validFrom.toISOString(),
    validUntil: row.validUntil?.toISOString() ?? null,
    assignedBy: row.assignedBy,
    assignedAt: row.assignedAt.toISOString(),
  });
}

function toPolicy(row: PolicyRow): ApprovalPolicy {
  return approvalPolicySchema.parse({
    id: row.id,
    actionType: row.actionType,
    thresholdIdr: row.thresholdIdr,
    approverRoleId: row.approverRoleId,
    levels: row.levels,
    requiresDistinctActor: true,
  });
}

function targetOf(scope: RoleAssignment["scope"]): AccessTarget {
  return scope.type === "tenant"
    ? { type: "tenant" }
    : { type: scope.type, id: scope.id };
}

/** Server-side permission check, independent of the route middleware. */
async function assertTenantPermission(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  permission: PermissionCode,
  now: Date,
): Promise<AccessSnapshot> {
  const data = await loadTenantAccessInTransaction(tx, context, actorUserId);
  const snapshot = resolveAccessSnapshot({
    tenant: context.tenant,
    userId: actorUserId,
    ...data,
    mfaVerified: false,
    now,
  });
  if (!snapshot.allows(permission, { type: "tenant" }))
    throw new AccessError("PERMISSION_DENIED");
  return snapshot;
}

async function nextSequence(
  tx: Tx,
  tenantId: string,
  aggregateType: string,
  aggregateId: string,
): Promise<number> {
  const [row] = await tx
    .select({
      last: sql<number>`coalesce(max(${domainEventOutbox.sequence}), 0)`,
    })
    .from(domainEventOutbox)
    .where(
      and(
        eq(domainEventOutbox.tenantId, tenantId),
        eq(domainEventOutbox.destination, EVENT_DESTINATION),
        eq(domainEventOutbox.aggregateType, aggregateType),
        eq(domainEventOutbox.aggregateId, aggregateId),
      ),
    );
  return Number(row?.last ?? 0) + 1;
}

/** Append one catalogued access event inside the caller's transaction. */
export async function appendAccessEvent(
  tx: Tx,
  context: ScopedTenantContext,
  definition: {
    readonly name: string;
    readonly version: number;
    readonly payloadSchemaRef: string;
    readonly entry: { readonly aggregateType: string };
    readonly envelopeSchema: { parse(value: unknown): unknown };
  },
  input: {
    aggregateId: string;
    /** A string is a user id; `{type:"system"}` is a scheduled job. */
    actorUserId: string | HrisActor;
    payload: Record<string, unknown>;
    now: Date;
  },
) {
  const sequence = await nextSequence(
    tx,
    context.tenant.tenantId,
    definition.entry.aggregateType,
    input.aggregateId,
  );
  const event = definition.envelopeSchema.parse({
    id: createUlid(input.now.getTime()),
    tenantId: context.tenant.tenantId,
    outletId: null,
    name: definition.name,
    version: definition.version,
    aggregateType: definition.entry.aggregateType,
    aggregateId: input.aggregateId,
    sequence,
    occurredAt: input.now.toISOString(),
    actor:
      typeof input.actorUserId === "string"
        ? { type: "user", id: input.actorUserId }
        : input.actorUserId,
    deviceId: null,
    idempotencyKey: `${definition.name}:${input.aggregateId}:${sequence}`.slice(
      0,
      100,
    ),
    payloadSchemaRef: definition.payloadSchemaRef,
    payload: input.payload,
  });
  await appendOutbox(tx, context, {
    id: createUlid(input.now.getTime()),
    event,
    destination: EVENT_DESTINATION,
    direction: null,
    peerId: null,
  });
}

// ------------------------------------------------------------------- roles

export async function listRoles(
  context: ScopedTenantContext,
  actorUserId: string,
  now = new Date(),
): Promise<{ data: Role[] }> {
  return withTenant(db, context, async (tx) => {
    await assertTenantPermission(
      tx,
      context,
      actorUserId,
      "access.role.view",
      now,
    );
    const rows = await tx
      .select()
      .from(roles)
      .where(eq(roles.tenantId, context.tenant.tenantId))
      .orderBy(
        desc(roles.isTemplate),
        asc(roles.templateKey),
        asc(roles.name),
        asc(roles.id),
      );
    return { data: rows.map(toRole) };
  });
}

/**
 * Seeds the 17 tenant-level templates (PRD §3.7 table; Super Admin is a
 * platform role and is never a tenant row) into a new tenant. Idempotent, so a
 * retried provisioning run cannot duplicate or overwrite renamed roles.
 */
export async function seedTenantRoleTemplates(
  tx: Tx,
  tenantId: string,
): Promise<void> {
  const values = roleTemplateValues(tenantId);
  await tx
    .insert(roles)
    .values(values)
    .onConflictDoNothing({ target: [roles.tenantId, roles.templateKey] });
  // AIG-03 (legend-zw9r): AI and MCP actions only propose, the matrix decides;
  // with no policy the approval service fails closed. Default: one level, the
  // outlet manager (same as migration 0089 for existing tenants). Only fills
  // actions the tenant has no policy for.
  await tx.execute(sql`
    INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
    SELECT r.tenant_id, a.action_type, NULL, r.id, 1, true
    FROM roles r
    CROSS JOIN (VALUES ('ai_action'), ('mcp_action')) AS a(action_type)
    WHERE r.tenant_id = ${tenantId}
      AND r.is_template
      AND r.template_key = 'outlet_manager'
      AND NOT EXISTS (
        SELECT 1 FROM approval_policies p
        WHERE p.tenant_id = r.tenant_id AND p.action_type = a.action_type
      )
  `);
  // legend-zi9o: refund needs the supervisor's approval (PRD §3.6, D14), so a
  // refund below every tier must not skip the inbox. Default matrix from Rp0
  // (DEFAULT_REFUND_APPROVAL_POLICIES; same rows as migration 0286, Q63): level
  // 1 at floor 0 for supervisor, outlet manager, general manager and owner.
  // Only when the tenant has no refund row; a template role that does not exist
  // adds no row (the join yields nothing for it).
  const refundValues = sql.join(
    DEFAULT_REFUND_APPROVAL_POLICIES.map(
      (row) =>
        sql`(${row.thresholdIdr}::bigint, ${row.level}::int, ${row.roleTemplateKey}::text)`,
    ),
    sql`, `,
  );
  await tx.execute(sql`
    INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
    SELECT ${tenantId}::uuid, 'refund', d.threshold_idr, r.id, d.level, true
    FROM (VALUES ${refundValues}) AS d(threshold_idr, level, template_key)
    JOIN roles r
      ON r.tenant_id = ${tenantId}::uuid
     AND r.is_template
     AND r.template_key = d.template_key
    WHERE NOT EXISTS (
      SELECT 1 FROM approval_policies p
      WHERE p.tenant_id = ${tenantId}::uuid AND p.action_type = 'refund'
    )
  `);
  // legend-ccpn: every shift close needs one approval (Q28, PRD §3.10), PIN at
  // the cashier is enough. Default matrix from Rp0
  // (DEFAULT_CASH_SHIFT_CLOSE_APPROVAL_POLICIES; same rows as the data
  // migration): level 1 for supervisor, outlet manager and general manager,
  // the templates that hold shift.cash.approve_close. All rows land in one
  // statement, only when the tenant has no cash_shift_close row; a template
  // role that does not exist adds no row.
  const cashShiftCloseValues = sql.join(
    DEFAULT_CASH_SHIFT_CLOSE_APPROVAL_POLICIES.map(
      (row) =>
        sql`(${row.thresholdIdr}::bigint, ${row.level}::int, ${row.roleTemplateKey}::text)`,
    ),
    sql`, `,
  );
  await tx.execute(sql`
    INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
    SELECT ${tenantId}::uuid, 'cash_shift_close', d.threshold_idr, r.id, d.level, true
    FROM (VALUES ${cashShiftCloseValues}) AS d(threshold_idr, level, template_key)
    JOIN roles r
      ON r.tenant_id = ${tenantId}::uuid
     AND r.is_template
     AND r.template_key = d.template_key
    WHERE NOT EXISTS (
      SELECT 1 FROM approval_policies p
      WHERE p.tenant_id = ${tenantId}::uuid AND p.action_type = 'cash_shift_close'
    )
  `);
  // legend-4qowr: a pending cash out (Q7) is decided from the approval inbox.
  // Default matrix from Rp0 (DEFAULT_CASH_OUT_APPROVAL_POLICIES; same row as
  // migration 0466): level 1 for the Finance template, only when the tenant
  // has no cash_out row; a missing Finance template adds no row.
  const cashOutValues = sql.join(
    DEFAULT_CASH_OUT_APPROVAL_POLICIES.map(
      (row) =>
        sql`(${row.thresholdIdr}::bigint, ${row.level}::int, ${row.roleTemplateKey}::text)`,
    ),
    sql`, `,
  );
  await tx.execute(sql`
    INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
    SELECT ${tenantId}::uuid, 'cash_out', d.threshold_idr, r.id, d.level, true
    FROM (VALUES ${cashOutValues}) AS d(threshold_idr, level, template_key)
    JOIN roles r
      ON r.tenant_id = ${tenantId}::uuid
     AND r.is_template
     AND r.template_key = d.template_key
    WHERE NOT EXISTS (
      SELECT 1 FROM approval_policies p
      WHERE p.tenant_id = ${tenantId}::uuid AND p.action_type = 'cash_out'
    )
  `);
  // legend-xxqz3: every supplier payment needs one approval from someone else
  // (CTO money decision 2026-11-17). Default matrix from Rp0
  // (DEFAULT_SUPPLIER_PAYMENT_APPROVAL_POLICIES; same rows as migration 0467):
  // level 1 for the Finance and Owner templates, only when the tenant has no
  // supplier_payment row; a missing template role adds no row.
  const supplierPaymentValues = sql.join(
    DEFAULT_SUPPLIER_PAYMENT_APPROVAL_POLICIES.map(
      (row) =>
        sql`(${row.thresholdIdr}::bigint, ${row.level}::int, ${row.roleTemplateKey}::text)`,
    ),
    sql`, `,
  );
  await tx.execute(sql`
    INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
    SELECT ${tenantId}::uuid, 'supplier_payment', d.threshold_idr, r.id, d.level, true
    FROM (VALUES ${supplierPaymentValues}) AS d(threshold_idr, level, template_key)
    JOIN roles r
      ON r.tenant_id = ${tenantId}::uuid
     AND r.is_template
     AND r.template_key = d.template_key
    WHERE NOT EXISTS (
      SELECT 1 FROM approval_policies p
      WHERE p.tenant_id = ${tenantId}::uuid AND p.action_type = 'supplier_payment'
    )
  `);
  // legend-tm6pp: shareholder versions need one Owner approval (Q2, 2026-11-10);
  // with no policy the approval service fails closed. Default matrix from Rp0
  // (DEFAULT_SHAREHOLDER_VERSION_APPROVAL_POLICIES; same row as migration 0241).
  // Only when the tenant has no shareholder_version row; a missing Owner
  // template adds no row.
  const shareholderVersionValues = sql.join(
    DEFAULT_SHAREHOLDER_VERSION_APPROVAL_POLICIES.map(
      (row) =>
        sql`(${row.thresholdIdr}::bigint, ${row.level}::int, ${row.roleTemplateKey}::text)`,
    ),
    sql`, `,
  );
  await tx.execute(sql`
    INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
    SELECT ${tenantId}::uuid, 'shareholder_version', d.threshold_idr, r.id, d.level, true
    FROM (VALUES ${shareholderVersionValues}) AS d(threshold_idr, level, template_key)
    JOIN roles r
      ON r.tenant_id = ${tenantId}::uuid
     AND r.is_template
     AND r.template_key = d.template_key
    WHERE NOT EXISTS (
      SELECT 1 FROM approval_policies p
      WHERE p.tenant_id = ${tenantId}::uuid AND p.action_type = 'shareholder_version'
    )
  `);
  // PAY recon (PRD §3.7): closing a reconciliation case needs one approval from
  // another user, Owner or Finance (either is enough); with no policy the
  // approval service fails closed and the case stays open. Default matrix from
  // Rp0 (same rows as migration 0357); only when the tenant has no
  // reconciliation_case row, and a tenant missing one template gets the other.
  const reconciliationValues = sql.join(
    DEFAULT_RECONCILIATION_CASE_APPROVAL_POLICIES.map(
      (row) =>
        sql`(${row.thresholdIdr}::bigint, ${row.level}::int, ${row.roleTemplateKey}::text)`,
    ),
    sql`, `,
  );
  await tx.execute(sql`
    INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
    SELECT ${tenantId}::uuid, 'reconciliation_case', d.threshold_idr, r.id, d.level, true
    FROM (VALUES ${reconciliationValues}) AS d(threshold_idr, level, template_key)
    JOIN roles r
      ON r.tenant_id = ${tenantId}::uuid
     AND r.is_template
     AND r.template_key = d.template_key
    WHERE NOT EXISTS (
      SELECT 1 FROM approval_policies p
      WHERE p.tenant_id = ${tenantId}::uuid AND p.action_type = 'reconciliation_case'
    )
  `);
}

export function roleTemplateValues(tenantId: string) {
  return ROLE_TEMPLATES.filter((template) => template.level === "tenant").map(
    (template) => ({
      tenantId,
      name: template.defaultName,
      isTemplate: true,
      templateKey: template.key,
      permissions: [...template.permissions],
      mfaRequired: template.mfaRequired,
      allowedScopeTypes: [...template.allowedScopeTypes],
    }),
  );
}

export async function createCustomRole(
  context: ScopedTenantContext,
  input: CreateCustomRoleInput,
  actorUserId: string,
  now = new Date(),
  options: {
    /** Last successful re-authentication of the creator, or null (no bypass). */
    reauthenticatedAt: Date | null;
    mfaVerified: boolean;
  } = { reauthenticatedAt: null, mfaVerified: false },
): Promise<Role> {
  return withTenant(db, context, async (tx) => {
    await assertTenantPermission(
      tx,
      context,
      actorUserId,
      "access.role.manage",
      now,
    );
    const normalized = normalizeCustomRolePermissions(input.permissions, {
      mfaRequested: input.mfaRequired,
    });
    // legend-sjq5w: a new role is a grant of every permission it lists. Same
    // rule as updateCustomRole: hold each one at tenant scope, or be a
    // re-authenticated Owner/Admin Tenant (PRD §3.7; coordinator decision C6).
    const data = await loadTenantAccessInTransaction(tx, context, actorUserId);
    assertCanEditCustomRole({
      grantor: {
        tenantId: context.tenant.tenantId,
        userId: userIdSchema.parse(actorUserId),
        assignments: data.assignments,
      },
      grantorRoles: data.roles,
      grantorMfaVerified: options.mfaVerified,
      grantorReauthenticatedAt: options.reauthenticatedAt,
      addedPermissions: normalized.permissions,
      org: data.org,
      now,
    });
    let row: RoleRow;
    try {
      [row] = await tx
        .insert(roles)
        .values({
          tenantId: context.tenant.tenantId,
          name: input.name,
          isTemplate: false,
          templateKey: null,
          permissions: normalized.permissions,
          mfaRequired: normalized.mfaRequired,
          allowedScopeTypes: input.allowedScopeTypes,
        })
        .returning();
    } catch (error) {
      if (uniqueViolation(error))
        throw new HttpError(409, "CONFLICT", "That role name is taken.");
      throw error;
    }
    await appendAccessEvent(tx, context, roleCreatedEvent, {
      aggregateId: row.id,
      actorUserId,
      now,
      payload: {
        roleId: row.id,
        name: row.name,
        isTemplate: false,
        permissions: normalized.permissions,
        mfaRequired: normalized.mfaRequired,
      },
    });
    await recordAudit(
      {
        tenantId: context.tenant.tenantId,
        outletId: null,
        actorType: "user",
        actorId: actorUserId,
        deviceId: null,
        action: "role.created",
        objectType: "role",
        objectId: row.id,
        reason: null,
        before: null,
        after: {
          name: row.name,
          permissions: normalized.permissions,
          mfaRequired: normalized.mfaRequired,
          allowedScopeTypes: input.allowedScopeTypes,
        },
        sensitiveAccess: false,
      },
      { tx, context },
    );
    return toRole(row);
  });
}

/**
 * legend-hzdy5: the database wall clock, read inside the transaction AFTER the
 * per-tenant advisory lock. The app server's clock can differ from the one that
 * stamped a valid_until committed by another caller, so assignment checks and
 * valid_from/valid_until use this instant, not `new Date()` or `now()` (which is
 * the transaction start and predates the lock wait).
 */
export async function readDbClock(tx: Tx): Promise<Date> {
  const result = await tx.execute(sql`SELECT clock_timestamp() AS now`);
  const value = result.rows[0]?.now;
  if (value instanceof Date) return value;
  if (typeof value === "string") return new Date(value);
  throw new Error("Database clock returned no timestamp.");
}

export async function updateCustomRole(
  context: ScopedTenantContext,
  roleId: string,
  input: UpdateCustomRoleInput,
  options: {
    actorUserId: string;
    /** Last successful re-authentication of the editor, or null (no bypass). */
    reauthenticatedAt: Date | null;
    mfaVerified: boolean;
  },
): Promise<Role> {
  const { actorUserId } = options;
  return withTenant(db, context, async (tx) => {
    // legend-v8dfx: the same per-tenant lock as grantRoleAssignment,
    // endRoleAssignment and the platform Owner path, taken first and before the
    // role row lock. An editor ended or demoted while this call waited is then
    // seen as such by the permission check below.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${"legend:role-assignment-end:" + context.tenant.tenantId}, 0))`,
    );
    const [current] = await tx
      .select()
      .from(roles)
      .where(
        and(eq(roles.id, roleId), eq(roles.tenantId, context.tenant.tenantId)),
      )
      .limit(1)
      .for("update");
    // legend-tegsk: "now" is read AFTER the role row lock. An editor ended
    // while this call waited for another editor's lock would otherwise still
    // look active at a clock read taken before the wait. The permission check
    // runs before the 404 so an unauthorized caller learns nothing about the
    // role.
    // legend-hzdy5: the DB clock, so an editor ended on another API instance
    // is judged by the same clock that stamped valid_until.
    const now = await readDbClock(tx);
    await assertTenantPermission(
      tx,
      context,
      actorUserId,
      "access.role.manage",
      now,
    );
    if (!current) throw new HttpError(404, "NOT_FOUND", "Role not found.");
    if (current.isTemplate)
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "Template roles are fixed; create a custom role instead.",
      );
    // legend-7vsby: any edit drops Owner-only codes stored before the rule;
    // the removal shows in the event and the audit entry.
    const nextPermissions =
      input.permissions === undefined
        ? withoutOwnerOnlyPermissions(current.permissions)
        : normalizeCustomRolePermissions(input.permissions, {
            mfaRequested: input.mfaRequired,
          }).permissions;
    const nextMfa =
      input.permissions === undefined && input.mfaRequired === undefined
        ? current.mfaRequired
        : normalizeCustomRolePermissions(nextPermissions, {
            mfaRequested: input.mfaRequired,
          }).mfaRequired;
    const added = nextPermissions.filter(
      (code) => !current.permissions.includes(code),
    );
    const removed = current.permissions.filter(
      (code) => !nextPermissions.includes(code),
    );
    if (added.length > 0 || (current.mfaRequired && !nextMfa)) {
      const data = await loadTenantAccessInTransaction(
        tx,
        context,
        actorUserId,
      );
      // PRD §3.7 Pemberian Role: "pengguna tidak dapat menaikkan hak dirinya
      // sendiri". Adding a permission follows the grant rule (hold it, or be a
      // re-authenticated Owner/Admin Tenant; coordinator decision C6).
      assertCanEditCustomRole({
        grantor: {
          tenantId: context.tenant.tenantId,
          userId: userIdSchema.parse(actorUserId),
          assignments: data.assignments,
        },
        grantorRoles: data.roles,
        grantorMfaVerified: options.mfaVerified,
        grantorReauthenticatedAt: options.reauthenticatedAt,
        addedPermissions: added,
        org: data.org,
        now,
      });
      // Dropping the MFA requirement from a role the editor holds would let
      // them reach back office without the second factor; the grant rule only
      // covers permissions, so keep this guard separate (AUTH-05).
      if (
        current.mfaRequired &&
        !nextMfa &&
        data.assignments.some(
          (row) =>
            row.roleId.toLowerCase() === roleId.toLowerCase() &&
            isAssignmentActive(row, now),
        )
      )
        throw new AccessError(
          "SELF_ELEVATION_FORBIDDEN",
          "Anda tidak dapat menghapus syarat MFA pada role yang Anda pegang sendiri.",
        );
    }
    const previous = {
      name: current.name,
      permissions: current.permissions,
      mfaRequired: current.mfaRequired,
      allowedScopeTypes: current.allowedScopeTypes,
    };
    let row: RoleRow;
    try {
      [row] = await tx
        .update(roles)
        .set({
          ...(input.name === undefined ? {} : { name: input.name }),
          permissions: nextPermissions,
          mfaRequired: nextMfa,
          ...(input.allowedScopeTypes === undefined
            ? {}
            : { allowedScopeTypes: input.allowedScopeTypes }),
          updatedAt: now,
        })
        .where(eq(roles.id, roleId))
        .returning();
    } catch (error) {
      if (uniqueViolation(error))
        throw new HttpError(409, "CONFLICT", "That role name is taken.");
      throw error;
    }
    await appendAccessEvent(tx, context, roleUpdatedEvent, {
      aggregateId: row.id,
      actorUserId,
      now,
      payload: {
        roleId: row.id,
        addedPermissions: added,
        removedPermissions: removed,
        mfaRequired: row.mfaRequired,
      },
    });
    await recordAudit(
      {
        tenantId: context.tenant.tenantId,
        outletId: null,
        actorType: "user",
        actorId: actorUserId,
        deviceId: null,
        action: "role.updated",
        objectType: "role",
        objectId: row.id,
        reason: null,
        before: previous,
        after: {
          name: row.name,
          permissions: row.permissions,
          mfaRequired: row.mfaRequired,
          allowedScopeTypes: row.allowedScopeTypes,
        },
        sensitiveAccess: false,
      },
      { tx, context },
    );
    return toRole(row);
  });
}

// ------------------------------------------------------- staff directory

/**
 * Staff directory for the role picker (bead legend-i6ff). Staff only: users
 * with at least one assignment in this tenant, filtered in SQL. Returns the
 * listed fields and nothing else (no email, phone, image or PIN data).
 */
export async function listAccessUsers(
  context: ScopedTenantContext,
  query: { limit: number; cursor?: string; q?: string },
  actorUserId: string,
  now = new Date(),
): Promise<{
  data: AccessUser[];
  meta: { limit: number; nextCursor: string | null };
}> {
  return withTenant(db, context, async (tx) => {
    await assertTenantPermission(
      tx,
      context,
      actorUserId,
      "access.role.view",
      now,
    );
    const filters = [eq(roleAssignments.tenantId, context.tenant.tenantId)];
    if (query.q) {
      // `%`, `_` and the escape character match themselves.
      const escaped = query.q.replace(/[\\%_]/g, (char) => `\\${char}`);
      filters.push(sql`${user.name} ILIKE ${`%${escaped}%`} ESCAPE '\\'`);
    }
    if (query.cursor) {
      const [name, id] = decodeCursor(query.cursor);
      if (typeof name !== "string" || typeof id !== "string")
        throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
      filters.push(
        or(
          sql`${user.name} > ${name}`,
          and(eq(user.name, name), sql`${user.id} > ${id}`),
        )!,
      );
    }
    const rows = await tx
      .select({
        userId: user.id,
        displayName: user.name,
        banned: user.banned,
        banExpires: user.banExpires,
        current: sql<boolean>`bool_or(${roleAssignments.validFrom} <= ${now} and (${roleAssignments.validUntil} is null or ${roleAssignments.validUntil} > ${now}))`,
      })
      .from(roleAssignments)
      .innerJoin(user, eq(user.id, roleAssignments.userId))
      .where(and(...filters))
      .groupBy(user.id)
      .orderBy(asc(user.name), asc(user.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map((row): AccessUser => {
        const banned =
          row.banned === true && (!row.banExpires || row.banExpires > now);
        return {
          userId: userIdSchema.parse(row.userId),
          displayName: row.displayName,
          kind: "staff",
          status: row.current && !banned ? "active" : "inactive",
        };
      }),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.displayName, last.userId])
            : null,
      },
    };
  });
}

// ------------------------------------------------------- role assignments

export async function listRoleAssignments(
  context: ScopedTenantContext,
  query: {
    limit: number;
    cursor?: string;
    userId?: string;
    roleId?: string;
    activeOnly?: boolean;
  },
  actorUserId: string,
  now = new Date(),
): Promise<{
  data: RoleAssignment[];
  meta: { limit: number; nextCursor: string | null };
}> {
  return withTenant(db, context, async (tx) => {
    await assertTenantPermission(
      tx,
      context,
      actorUserId,
      "access.role.view",
      now,
    );
    const filters = [eq(roleAssignments.tenantId, context.tenant.tenantId)];
    if (query.userId) filters.push(eq(roleAssignments.userId, query.userId));
    if (query.roleId) filters.push(eq(roleAssignments.roleId, query.roleId));
    if (query.activeOnly) {
      filters.push(lte(roleAssignments.validFrom, now));
      filters.push(
        or(
          isNull(roleAssignments.validUntil),
          gt(roleAssignments.validUntil, now),
        )!,
      );
    }
    if (query.cursor) {
      const [assignedAt, id] = decodeCursor(query.cursor);
      if (typeof assignedAt !== "string" || typeof id !== "string")
        throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
      const at = new Date(assignedAt);
      filters.push(
        or(
          sql`${roleAssignments.assignedAt} < ${at}`,
          and(
            eq(roleAssignments.assignedAt, at),
            sql`${roleAssignments.id} < ${id}`,
          ),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(roleAssignments)
      .where(and(...filters))
      .orderBy(desc(roleAssignments.assignedAt), desc(roleAssignments.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toAssignment),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.assignedAt.toISOString(), last.id])
            : null,
      },
    };
  });
}

export async function grantRoleAssignment(
  context: ScopedTenantContext,
  input: GrantRoleInput,
  options: {
    actorUserId: string;
    /** Last successful re-authentication of the grantor, or null (denied). */
    reauthenticatedAt: Date | null;
    mfaVerified: boolean;
  },
): Promise<RoleAssignment> {
  return withTenant(db, context, async (tx) => {
    // legend-8ajy4: the same per-tenant lock as endRoleAssignment and the
    // platform Owner path, taken first, and "now" read after it. A grantor
    // whose assignment another caller ended while this one waited is then
    // seen as ended (READ COMMITTED re-reads below) and cannot still grant.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${"legend:role-assignment-end:" + context.tenant.tenantId}, 0))`,
    );
    const now = await readDbClock(tx);
    const [roleRow] = await tx
      .select()
      .from(roles)
      .where(
        and(
          eq(roles.id, input.roleId),
          eq(roles.tenantId, context.tenant.tenantId),
        ),
      )
      .limit(1);
    if (!roleRow) throw new HttpError(404, "NOT_FOUND", "Role not found.");
    const [grantee] = await tx
      .select({ id: user.id, banned: user.banned, banExpires: user.banExpires })
      .from(user)
      .where(eq(user.id, input.userId))
      .limit(1);
    if (!grantee)
      throw new HttpError(422, "VALIDATION_ERROR", "Unknown user account.");
    // legend-2dnh: the reserved system account (approval requester of refunds the
    // system creates) and an account under an active ban (no expiry, or one still
    // ahead) never receive a role. Migration 0144 enforces the same rule in the
    // database for every other path.
    const banActive =
      grantee.banned === true &&
      (grantee.banExpires === null ||
        grantee.banExpires.getTime() > now.getTime());
    if (grantee.id === SYSTEM_ACCOUNT_ID || banActive)
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "This account cannot be given a role.",
      );
    const data = await loadTenantAccessInTransaction(
      tx,
      context,
      options.actorUserId,
    );
    const templateKey = roleRow.templateKey;
    const template =
      templateKey !== null && isRoleTemplateKey(templateKey)
        ? roleTemplate(templateKey)
        : null;
    if (!scopeCovers(input.scope, targetOf(input.scope), data.org))
      throw new AccessError("ROLE_SCOPE_NOT_ALLOWED");
    assertCanGrantRole({
      grantor: {
        tenantId: context.tenant.tenantId,
        userId: userIdSchema.parse(options.actorUserId),
        assignments: data.assignments,
      },
      grantorRoles: data.roles,
      grantorMfaVerified: options.mfaVerified,
      grantorReauthenticatedAt: options.reauthenticatedAt,
      granteeUserId: input.userId,
      role: {
        id: roleIdSchema.parse(roleRow.id),
        // Same read rule as toRole (legend-7vsby): Owner-only codes left in
        // an old custom role are not part of what this grant delegates.
        permissions: rolePermissionsAsGranted(templateKey, roleRow.permissions),
        mfaRequired: roleRow.mfaRequired,
        templateKey,
        level: template?.level ?? "tenant",
        allowedScopeTypes: roleRow.allowedScopeTypes,
      },
      scope: input.scope,
      org: data.org,
      now,
    });
    // legend-495 G2: a role goes to someone who already belongs to this
    // tenant: an assignment in force now (started, not expired), or an HRIS
    // employee record of this tenant linked to the account whose status is
    // still `onboarding` or `active` (employees.status, the set the attendance
    // gate accepts). The second case is how a new hire gets the first role.
    // Both reads filter by tenant in SQL. Checked after the grantor's own
    // authority, so a caller who may not grant cannot probe membership.
    const [currentAssignment] = await tx
      .select({ id: roleAssignments.id })
      .from(roleAssignments)
      .where(
        and(
          eq(roleAssignments.tenantId, context.tenant.tenantId),
          eq(roleAssignments.userId, input.userId),
          lte(roleAssignments.validFrom, now),
          or(
            isNull(roleAssignments.validUntil),
            gt(roleAssignments.validUntil, now),
          ),
        ),
      )
      .limit(1);
    if (!currentAssignment) {
      const [hire] = await tx
        .select({ id: employees.id })
        .from(employees)
        .where(
          and(
            eq(employees.tenantId, context.tenant.tenantId),
            eq(employees.userId, input.userId),
            inArray(employees.status, ["onboarding", "active"]),
          ),
        )
        .limit(1);
      if (!hire)
        throw new HttpError(
          422,
          "VALIDATION_ERROR",
          "This person is not a member of this business yet.",
        );
    }
    const validFrom =
      input.validFrom === undefined ? now : new Date(input.validFrom);
    const validUntil =
      input.validUntil === undefined || input.validUntil === null
        ? null
        : new Date(input.validUntil);
    const [row] = await tx
      .insert(roleAssignments)
      .values({
        tenantId: context.tenant.tenantId,
        userId: input.userId,
        roleId: roleRow.id,
        scopeType: input.scope.type,
        scopeId: input.scope.type === "tenant" ? null : input.scope.id,
        validFrom,
        validUntil,
        assignedBy: options.actorUserId,
        assignedAt: now,
      })
      .returning();
    const reauthenticatedAt = options.reauthenticatedAt as Date;
    await appendAccessEvent(tx, context, roleAssignmentGrantedEvent, {
      aggregateId: row.id,
      actorUserId: options.actorUserId,
      now,
      payload: {
        assignmentId: row.id,
        userId: row.userId,
        roleId: row.roleId,
        scope:
          row.scopeType === "tenant"
            ? { type: "tenant", id: null }
            : { type: row.scopeType, id: row.scopeId },
        validFrom: row.validFrom.toISOString(),
        validUntil: row.validUntil?.toISOString() ?? null,
        grantedBy: row.assignedBy,
        reauthenticatedAt: reauthenticatedAt.toISOString(),
      },
    });
    await recordAudit(
      {
        tenantId: context.tenant.tenantId,
        outletId: null,
        actorType: "user",
        actorId: options.actorUserId,
        deviceId: null,
        action: "role_assignment.granted",
        objectType: "role_assignment",
        objectId: row.id,
        reason: null,
        before: null,
        after: {
          userId: row.userId,
          roleId: row.roleId,
          scope: input.scope,
          validFrom: row.validFrom.toISOString(),
          validUntil: row.validUntil?.toISOString() ?? null,
        },
        sensitiveAccess: false,
      },
      { tx, context },
    );
    return toAssignment(row);
  });
}

/**
 * Owner assignment protection (coordinator decision C6, bead legend-vbws;
 * PRD §3.7 "Owner / Direksi — Seluruh tenant sesuai cakupan"). Only an active
 * tenant Owner may end another Owner's assignment, and the tenant must keep at
 * least one active, open-ended tenant-scoped Owner: two Owners cannot remove each other,
 * and nobody can lock a tenant out of its top authority.
 */
async function assertCanEndOwnerAssignment(
  tx: Tx,
  context: ScopedTenantContext,
  target: AssignmentRow,
  actorUserId: string,
  now: Date,
): Promise<void> {
  const [targetRole] = await tx
    .select({ templateKey: roles.templateKey })
    .from(roles)
    .where(
      and(
        eq(roles.id, target.roleId),
        eq(roles.tenantId, context.tenant.tenantId),
      ),
    )
    .limit(1);
  if (targetRole?.templateKey !== "owner") return;
  const activeOwners = await tx
    .select({
      id: roleAssignments.id,
      userId: roleAssignments.userId,
      validUntil: roleAssignments.validUntil,
    })
    .from(roleAssignments)
    .innerJoin(
      roles,
      and(
        eq(roles.tenantId, roleAssignments.tenantId),
        eq(roles.id, roleAssignments.roleId),
      ),
    )
    .where(
      and(
        eq(roleAssignments.tenantId, context.tenant.tenantId),
        eq(roles.templateKey, "owner"),
        eq(roleAssignments.scopeType, "tenant"),
        lte(roleAssignments.validFrom, now),
        or(
          isNull(roleAssignments.validUntil),
          gt(roleAssignments.validUntil, now),
        ),
      ),
    );
  // Concurrent "end Owner" calls are serialized by the per-tenant advisory
  // lock in endRoleAssignment, so this read sees the previous caller's
  // commit and two Owners cannot both remove each other.
  const actorIsOwner = activeOwners.some(
    (row) => row.userId.toLowerCase() === actorUserId.toLowerCase(),
  );
  if (
    target.userId.toLowerCase() !== actorUserId.toLowerCase() &&
    !actorIsOwner
  )
    throw new AccessError(
      "PERMISSION_DENIED",
      "Hanya Owner yang dapat mengakhiri penugasan Owner lain.",
    );
  const targetActive =
    target.validFrom.getTime() <= now.getTime() &&
    (target.validUntil === null || now.getTime() < target.validUntil.getTime());
  // legend-qr1uv: only an open-ended Owner (valid_until null) counts as the
  // Owner that remains. A temporary Owner is still an Owner for authority
  // above, but it expires by itself and would leave the tenant Owner-less;
  // after legend-7vsby only a Super Admin could recover that. Same rule as
  // the platform Owner path (platform-tenant-owner.service.ts).
  if (
    targetActive &&
    activeOwners.filter(
      (row) => row.id !== target.id && row.validUntil === null,
    ).length === 0
  )
    throw new HttpError(
      409,
      "CONFLICT",
      "Tenant harus memiliki minimal satu Owner aktif.",
    );
}

export async function endRoleAssignment(
  context: ScopedTenantContext,
  assignmentId: string,
  input: EndRoleAssignmentInput,
  actorUserId: string,
): Promise<RoleAssignment> {
  return withTenant(db, context, async (tx) => {
    // One lock per tenant for every "end assignment", taken BEFORE any row
    // lock: two Owners ending each other's assignment would otherwise each
    // hold their target row and wait for the other's in the Owner check
    // (deadlock → 40P01 → 500). The second caller now waits here and
    // re-reads the Owner set after the first commits (READ COMMITTED).
    // The platform Owner path (platform-tenant-owner.service.ts) and
    // grantRoleAssignment (legend-8ajy4) take the same lock; the key keeps
    // its "-end" name so all three stay in step.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${"legend:role-assignment-end:" + context.tenant.tenantId}, 0))`,
    );
    // legend-qr1uv: "now" is read AFTER the lock. A clock read before it is
    // earlier than the valid_until the previous holder committed, so an Owner
    // ended while this call waited would still look active, and two Owners
    // could end each other. The permission check uses the same instant, and
    // it is the database clock (legend-hzdy5), not the app server's.
    const now = await readDbClock(tx);
    await assertTenantPermission(
      tx,
      context,
      actorUserId,
      "access.role.assign",
      now,
    );
    const [current] = await tx
      .select()
      .from(roleAssignments)
      .where(
        and(
          eq(roleAssignments.id, assignmentId),
          eq(roleAssignments.tenantId, context.tenant.tenantId),
        ),
      )
      .limit(1)
      .for("update");
    if (!current)
      throw new HttpError(404, "NOT_FOUND", "Role assignment not found.");
    const validUntil =
      input.validUntil === undefined ? now : new Date(input.validUntil);
    if (validUntil.getTime() <= current.validFrom.getTime())
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "validUntil must be after validFrom.",
      );
    // "End" only shortens. Moving valid_until later would extend a temporary
    // assignment or re-activate an ended one (incl. the actor's own) without
    // the grant rules (re-auth, no self-elevation; PRD §3.7 Pemberian Role).
    if (
      current.validUntil !== null &&
      validUntil.getTime() > current.validUntil.getTime()
    )
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "An assignment can only be shortened; grant a new one to extend it.",
      );
    await assertCanEndOwnerAssignment(tx, context, current, actorUserId, now);
    const [row] = await tx
      .update(roleAssignments)
      .set({ validUntil })
      .where(eq(roleAssignments.id, assignmentId))
      .returning();
    await appendAccessEvent(tx, context, roleAssignmentEndedEvent, {
      aggregateId: row.id,
      actorUserId,
      now,
      payload: {
        assignmentId: row.id,
        userId: row.userId,
        roleId: row.roleId,
        validUntil: validUntil.toISOString(),
        endedBy: actorUserId,
        reason: input.reason,
      },
    });
    await recordAudit(
      {
        tenantId: context.tenant.tenantId,
        outletId: null,
        actorType: "user",
        actorId: actorUserId,
        deviceId: null,
        action: "role_assignment.ended",
        objectType: "role_assignment",
        objectId: row.id,
        reason: input.reason,
        before: {
          userId: row.userId,
          roleId: row.roleId,
          validUntil: current.validUntil?.toISOString() ?? null,
        },
        after: { validUntil: validUntil.toISOString() },
        sensitiveAccess: false,
      },
      { tx, context },
    );
    return toAssignment(row);
  });
}

// ------------------------------------------------------- approval matrix

export async function getApprovalMatrix(
  context: ScopedTenantContext,
  actorUserId: string,
  now = new Date(),
): Promise<{ data: ApprovalPolicy[] }> {
  return withTenant(db, context, async (tx) => {
    await assertTenantPermission(
      tx,
      context,
      actorUserId,
      "access.approval_policy.manage",
      now,
    );
    const rows = await tx
      .select()
      .from(approvalPolicies)
      .where(eq(approvalPolicies.tenantId, context.tenant.tenantId))
      .orderBy(
        asc(approvalPolicies.actionType),
        asc(approvalPolicies.levels),
        asc(approvalPolicies.id),
      );
    return { data: rows.map(toPolicy) };
  });
}

export async function replaceApprovalMatrix(
  context: ScopedTenantContext,
  input: ReplaceApprovalMatrixInput,
  actorUserId: string,
  now = new Date(),
): Promise<{ data: ApprovalPolicy[] }> {
  // Supplier payment must keep a base tier (founder Q27): answer with the
  // dedicated code the matrix UI shows beside that row.
  if (supplierPaymentBaseTierMissing(input.policies))
    throw new AccessError("SUPPLIER_PAYMENT_BASE_TIER_REQUIRED");
  // The stored-row schema carries ids; the request does not. Validate the
  // rules (tiers, contiguous levels, distinct actor) on synthetic rows.
  const matrix = approvalMatrixSchema.parse(
    input.policies.map((row) => ({
      ...row,
      id: randomUUID(),
      requiresDistinctActor: true,
    })),
  );
  return withTenant(db, context, async (tx) => {
    await assertTenantPermission(
      tx,
      context,
      actorUserId,
      "access.approval_policy.manage",
      now,
    );
    const roleIds = [...new Set(matrix.map((row) => row.approverRoleId))];
    if (roleIds.length > 0) {
      const known = await tx
        .select({ id: roles.id })
        .from(roles)
        .where(
          and(
            eq(roles.tenantId, context.tenant.tenantId),
            inArray(roles.id, roleIds),
          ),
        );
      if (known.length !== roleIds.length)
        throw new HttpError(
          422,
          "VALIDATION_ERROR",
          "Every approver role must belong to this tenant.",
        );
    }
    const beforeRows = await tx
      .select()
      .from(approvalPolicies)
      .where(eq(approvalPolicies.tenantId, context.tenant.tenantId));
    const before = beforeRows.map(toPolicy);
    await tx
      .delete(approvalPolicies)
      .where(eq(approvalPolicies.tenantId, context.tenant.tenantId));
    if (matrix.length > 0) {
      await tx.insert(approvalPolicies).values(
        matrix.map((row) => ({
          tenantId: context.tenant.tenantId,
          actionType: row.actionType,
          thresholdIdr: row.thresholdIdr,
          approverRoleId: row.approverRoleId,
          levels: row.levels,
          requiresDistinctActor: true,
        })),
      );
    }
    const afterRows = await tx
      .select()
      .from(approvalPolicies)
      .where(eq(approvalPolicies.tenantId, context.tenant.tenantId))
      .orderBy(
        asc(approvalPolicies.actionType),
        asc(approvalPolicies.levels),
        asc(approvalPolicies.id),
      );
    const after = afterRows.map(toPolicy);
    const actions = new Set([
      ...before.map((row) => row.actionType),
      ...after.map((row) => row.actionType),
    ]);
    for (const actionType of actions) {
      const beforeOfType = before.filter(
        (row) => row.actionType === actionType,
      );
      const afterOfType = after.filter((row) => row.actionType === actionType);
      if (JSON.stringify(beforeOfType) === JSON.stringify(afterOfType))
        continue;
      const aggregateId =
        afterOfType[0]?.id ?? beforeOfType[0]?.id ?? randomUUID();
      await appendAccessEvent(tx, context, approvalPolicyChangedEvent, {
        aggregateId,
        actorUserId,
        now,
        payload: {
          actionType,
          before: beforeOfType,
          after: afterOfType,
        },
      });
    }
    await recordAudit(
      {
        tenantId: context.tenant.tenantId,
        outletId: null,
        actorType: "user",
        actorId: actorUserId,
        deviceId: null,
        action: "approval_policy.changed",
        objectType: "approval_policy",
        objectId: null,
        reason: null,
        before: { policies: before },
        after: { policies: after },
        sensitiveAccess: false,
      },
      { tx, context },
    );
    return { data: after };
  });
}

// ------------------------------------------------- offboarding (legend-ovxw)

export type OffboardingRoleEndResult = { endedAssignmentIds: string[] };

/**
 * Ends every active or future role assignment of `userId` in this tenant,
 * inside the caller's tenant transaction, for exit clearance
 * (`hris-offboarding.service.ts`; docs/DECISIONS.md "WS-10 lifecycle" §2).
 * The caller has already authorised the offboarding with tenant-wide
 * `hr.employee.manage`, so `context` is tenant scoped (access events are
 * tenant-wide and the outbox refuses them under an outlet scope).
 *
 * Takes the same tenant advisory lock as `endRoleAssignment`, before any row
 * lock, so it serialises with grants and other ends. `now` must be read by the
 * caller AFTER that lock is held (legend-qr1uv); the lock is re-entrant, so a
 * caller that took it first keeps one instant for the whole clearance.
 * Refuses (409, nothing written) an employee who holds an Owner assignment:
 * the Owner is replaced through the access flow first, never by HR. A
 * tenant-scoped assignment needs `canAssignRoles` (the caller holds
 * `access.role.assign` tenant-wide), else 409: HR alone cannot strip a
 * company-level role. An active row ends at `now`; a future-dated row ends at
 * its own `valid_from`, an empty window that never grants (`valid_until` is
 * exclusive). Each ended row gets the `role_assignment.ended` event and audit
 * row, like `endRoleAssignment`. Already ended rows are skipped, so a rerun
 * ends nothing.
 */
export async function endUserRoleAssignmentsForOffboardingInTx(
  tx: Tx,
  context: ScopedTenantContext,
  userId: string,
  actor: HrisActor | string,
  reason: string,
  canAssignRoles: boolean,
  now: Date,
): Promise<OffboardingRoleEndResult> {
  if (context.outletScope.kind !== "tenant")
    throw new Error("offboarding role end needs a tenant-scoped context");
  const resolved: HrisActor =
    typeof actor === "string" ? { type: "user", id: actor } : actor;
  // A system run records the nil UUID wherever a "who" column needs a value.
  const actorUserId = resolved.type === "user" ? resolved.id : SYSTEM_ACTOR_ID;
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${"legend:role-assignment-end:" + context.tenant.tenantId}, 0))`,
  );
  const open = await tx
    .select({
      assignment: roleAssignments,
      templateKey: roles.templateKey,
    })
    .from(roleAssignments)
    .innerJoin(
      roles,
      and(
        eq(roles.tenantId, roleAssignments.tenantId),
        eq(roles.id, roleAssignments.roleId),
      ),
    )
    .where(
      and(
        eq(roleAssignments.tenantId, context.tenant.tenantId),
        eq(roleAssignments.userId, userId),
        or(
          isNull(roleAssignments.validUntil),
          gt(roleAssignments.validUntil, now),
        ),
      ),
    )
    .orderBy(asc(roleAssignments.id))
    .for("update", { of: roleAssignments });
  if (open.some((row) => row.templateKey === "owner"))
    throw new HttpError(
      409,
      "OFFBOARDING_OWNER",
      "Karyawan ini masih Owner. Ganti Owner lewat pengaturan akses dulu.",
    );
  if (
    !canAssignRoles &&
    open.some((row) => row.assignment.scopeType === "tenant")
  )
    throw new HttpError(
      409,
      "OFFBOARDING_ADMIN_ROLE",
      "Karyawan ini punya peran tingkat perusahaan. Minta admin akses mencabutnya.",
    );
  const endedAssignmentIds: string[] = [];
  for (const { assignment: current } of open) {
    // A future-dated row ends at its own start: an empty window. Copied in
    // SQL, because valid_from keeps microseconds a JS Date would drop.
    const future = current.validFrom.getTime() > now.getTime();
    const [row] = await tx
      .update(roleAssignments)
      .set({
        validUntil: future ? sql`${roleAssignments.validFrom}` : now,
      })
      .where(
        and(
          eq(roleAssignments.tenantId, context.tenant.tenantId),
          eq(roleAssignments.id, current.id),
        ),
      )
      .returning();
    const validUntil = row.validUntil ?? now;
    await appendAccessEvent(tx, context, roleAssignmentEndedEvent, {
      aggregateId: row.id,
      actorUserId: resolved,
      now,
      payload: {
        assignmentId: row.id,
        userId: row.userId,
        roleId: row.roleId,
        validUntil: validUntil.toISOString(),
        endedBy: actorUserId,
        reason,
      },
    });
    await recordAudit(
      {
        tenantId: context.tenant.tenantId,
        outletId: null,
        actorType: resolved.type,
        actorId: resolved.type === "user" ? resolved.id : null,
        deviceId: null,
        action: "role_assignment.ended",
        objectType: "role_assignment",
        objectId: row.id,
        reason,
        before: {
          userId: row.userId,
          roleId: row.roleId,
          validUntil: current.validUntil?.toISOString() ?? null,
        },
        after: { validUntil: validUntil.toISOString() },
        sensitiveAccess: false,
      },
      { tx, context },
    );
    endedAssignmentIds.push(row.id);
  }
  return { endedAssignmentIds };
}
