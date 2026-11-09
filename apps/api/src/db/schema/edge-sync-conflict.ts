// WS-02 edge sync conflict review (bead legend-wqc6; PRD v1.7 §3 F5
// "Sinkronisasi", EDG-02). `edge_sync_conflicts` stays append-only evidence;
// what a supervisor decided about a conflict is a NEW row here, never an
// update. A conflict is "open" until it has a resolution with outcome
// `applied` or `dismissed`; a `failed` replay keeps it open and is recorded
// for the audit trail.
//
// Tenant + outlet owned, like the conflict it points at: the migration must
// call `app.enforce_tenant_rls(...)` and then `app.enforce_outlet_rls(...)`
// for this table, and attach the append-only trigger
// (`app.reject_edge_sync_log_mutation`, see edge-node.custom.sql).
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { outletIdColumn, tenantIdColumn, ulidInUuid } from "../columns.ts";
import { edgeSyncConflicts } from "./edge-node.ts";
import { outlets, tenants } from "./platform-org.ts";

export type EdgeSyncConflictAction = "replayed" | "dismissed";
export type EdgeSyncConflictOutcome = "applied" | "failed" | "dismissed";

export const edgeSyncConflictResolutions = pgTable(
  "edge_sync_conflict_resolutions",
  {
    id: ulidInUuid("id").notNull(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    conflictId: ulidInUuid("conflict_id").notNull(),
    action: varchar("action", { length: 20 })
      .$type<EdgeSyncConflictAction>()
      .notNull(),
    outcome: varchar("outcome", { length: 20 })
      .$type<EdgeSyncConflictOutcome>()
      .notNull(),
    /** Applier error message of a failed replay; null otherwise. */
    error: text("error"),
    note: varchar("note", { length: 500 }).notNull(),
    /** Better Auth user id of the supervisor. */
    resolvedBy: text("resolved_by").notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    foreignKey({
      name: "edge_sync_conflict_resolutions_conflict_fk",
      columns: [table.tenantId, table.conflictId],
      foreignColumns: [edgeSyncConflicts.tenantId, edgeSyncConflicts.id],
    }),
    index("edge_sync_conflict_resolutions_conflict_idx").on(
      table.tenantId,
      table.conflictId,
      table.resolvedAt,
    ),
    check(
      "edge_sync_conflict_resolutions_action_check",
      sql`${table.action} IN ('replayed', 'dismissed')`,
    ),
    check(
      "edge_sync_conflict_resolutions_outcome_check",
      sql`(${table.action} = 'replayed' AND ${table.outcome} IN ('applied', 'failed')) OR (${table.action} = 'dismissed' AND ${table.outcome} = 'dismissed')`,
    ),
    check(
      "edge_sync_conflict_resolutions_error_check",
      sql`(${table.outcome} = 'failed') = (${table.error} IS NOT NULL)`,
    ),
  ],
);
