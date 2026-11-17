// Progress of the sealed-secret re-seal sweep (legend-tetyr,
// worker/sealed-secret-reseal.job.ts). One row per (table, column, scope): the
// id cursor of the pass in flight, so a killed run resumes where it stopped,
// plus running counts for the report. `scope_key` is a tenant id, or "global"
// for tables that belong to no tenant (MFA factors, identities, login
// challenges). Holds ids and counts only, never a sealed or opened value. No
// tenant_id column and no RLS on purpose: the job is a platform sweep and the
// global scope has no tenant. Stale rows themselves are found from the
// envelope version byte, so this table is progress, not the source of truth.
import {
  bigint,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const sealedSecretResealState = pgTable(
  "sealed_secret_reseal_state",
  {
    tableName: text("table_name").notNull(),
    columnName: text("column_name").notNull(),
    scopeKey: text("scope_key").notNull(),
    /** Highest id handled by the pass in flight; null = start from the top. */
    lastId: uuid("last_id"),
    /** Active key version the cursor belongs to; a new version restarts it. */
    keyVersion: integer("key_version").notNull(),
    resealedCount: bigint("resealed_count", { mode: "number" })
      .notNull()
      .default(0),
    /** Rows that could not be re-sealed in the latest pass. */
    failedCount: integer("failed_count").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "sealed_secret_reseal_state_pkey",
      columns: [table.tableName, table.columnName, table.scopeKey],
    }),
  ],
);
