// PRD v1.7 §3 F7 and §6 B. Tenant RLS is installed in the generated migration.
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type {
  PermissionCode,
  RoleTemplateKey,
  ScopeType,
} from "@starter/shared/access";
import { tenants } from "./platform-org";
import { syncTxidColumn } from "./sync-txid";
import { user } from "./user";

// PRD §6 B lists `roles` / `permissions` as two tables. The Legend access
// contract (`@starter/shared/access`) models a role as one row holding its
// catalog codes, and custom roles are built from the global catalog (never a
// per-tenant permission row), so the codes live in a JSONB array here; the DB
// checks only that it is an array, while the service validates every code with
// `tenantPermissionCodeSchema`.
export const roles = pgTable(
  "roles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    name: varchar("name", { length: 100 }).notNull(),
    isTemplate: boolean("is_template").notNull().default(false),
    templateKey: varchar("template_key", {
      length: 50,
    }).$type<RoleTemplateKey>(),
    permissions: jsonb("permissions").$type<PermissionCode[]>().notNull(),
    mfaRequired: boolean("mfa_required").notNull().default(false),
    allowedScopeTypes: jsonb("allowed_scope_types")
      .$type<ScopeType[]>()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("roles_tenant_id_id_key").on(table.tenantId, table.id),
    unique("roles_tenant_name_key").on(table.tenantId, table.name),
    unique("roles_tenant_template_key").on(table.tenantId, table.templateKey),
    check(
      "roles_template_check",
      sql`(${table.isTemplate} AND ${table.templateKey} IS NOT NULL AND ${table.templateKey} <> 'super_admin') OR (NOT ${table.isTemplate} AND ${table.templateKey} IS NULL)`,
    ),
    check(
      "roles_permissions_array_check",
      sql`jsonb_typeof(${table.permissions}) = 'array'`,
    ),
    check(
      "roles_scope_array_check",
      sql`jsonb_typeof(${table.allowedScopeTypes}) = 'array' AND jsonb_array_length(${table.allowedScopeTypes}) > 0`,
    ),
  ],
);

export const roleAssignments = pgTable(
  "role_assignments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    roleId: uuid("role_id").notNull(),
    scopeType: varchar("scope_type", { length: 20 })
      .$type<ScopeType>()
      .notNull(),
    scopeId: uuid("scope_id"),
    validFrom: timestamp("valid_from", { withTimezone: true })
      .notNull()
      .defaultNow(),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    assignedBy: text("assigned_by")
      .notNull()
      .references(() => user.id),
    assignedAt: timestamp("assigned_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("role_assignments_tenant_id_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "role_assignments_role_fk",
      columns: [table.tenantId, table.roleId],
      foreignColumns: [roles.tenantId, roles.id],
    }),
    index("role_assignments_tenant_user_idx").on(table.tenantId, table.userId),
    check(
      "role_assignments_scope_check",
      sql`(${table.scopeType} = 'tenant' AND ${table.scopeId} IS NULL) OR (${table.scopeType} IN ('brand', 'outlet', 'station') AND ${table.scopeId} IS NOT NULL)`,
    ),
    // valid_until is exclusive, so valid_until = valid_from is an empty window
    // that never grants anything: exit clearance ends a future-dated
    // assignment this way (legend-ovxw).
    check(
      "role_assignments_window_check",
      sql`${table.validUntil} IS NULL OR ${table.validUntil} >= ${table.validFrom}`,
    ),
  ],
);

export const approvalPolicies = pgTable(
  "approval_policies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    actionType: varchar("action_type", { length: 50 }).notNull(),
    thresholdIdr: bigint("threshold_idr", { mode: "number" }),
    approverRoleId: uuid("approver_role_id").notNull(),
    levels: integer("levels").notNull(),
    requiresDistinctActor: boolean("requires_distinct_actor")
      .notNull()
      .default(true),
    syncTxid: syncTxidColumn(),
  },
  (table) => [
    index("approval_policies_sync_txid_idx").on(
      table.tenantId,
      table.syncTxid,
      table.id,
    ),
    unique("approval_policies_tenant_id_id_key").on(table.tenantId, table.id),
    foreignKey({
      name: "approval_policies_role_fk",
      columns: [table.tenantId, table.approverRoleId],
      foreignColumns: [roles.tenantId, roles.id],
    }),
    uniqueIndex("approval_policies_tier_role_key").on(
      table.tenantId,
      table.actionType,
      sql`coalesce(${table.thresholdIdr}, -1)`,
      table.levels,
      table.approverRoleId,
    ),
    check(
      "approval_policies_threshold_check",
      sql`${table.thresholdIdr} IS NULL OR (${table.thresholdIdr} >= 0 AND ${table.thresholdIdr} <= 9007199254740991)`,
    ),
    check(
      "approval_policies_level_check",
      sql`${table.levels} BETWEEN 1 AND 3`,
    ),
    check(
      "approval_policies_distinct_actor_check",
      sql`${table.requiresDistinctActor}`,
    ),
  ],
);
