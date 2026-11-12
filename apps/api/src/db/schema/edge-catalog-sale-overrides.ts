// Owner override of the 24 h stale-catalog sales block (bead legend-10nex,
// founder Q57). When an edge node has not synced a critical catalog stream for
// more than 24 h, selling is held until an OWNER allows it for a bounded time.
// One row per grant: who (`granted_by`), when, until when and why. At most one
// row per edge is active at once (not closed, not superseded, `until_at` in the
// future); granting again marks the old row `superseded_at`, and a successful
// sync of all critical streams closes it (`closed_reason` SYNC_OK). Rows are
// kept as evidence, never deleted.
//
// Tenant + outlet owned: the migration must call `app.enforce_tenant_rls(...)`
// and then `app.enforce_outlet_rls(...)` for this table (see
// edge-catalog-sale-overrides.custom.sql). The row is written on the edge
// (works offline), so it is not append-only: `superseded_at`, `closed_at` and
// `closed_reason` are set later.
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { outletIdColumn, tenantIdColumn, ulidInUuid } from "../columns.ts";
import { edgeNodes } from "./edge-node.ts";
import { outlets, tenants } from "./platform-org.ts";

export type EdgeCatalogOverrideClosedReason = "SYNC_OK" | "EXPIRED" | "OWNER";

export const edgeCatalogSaleOverrides = pgTable(
  "edge_catalog_sale_overrides",
  {
    id: ulidInUuid("id").notNull(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    edgeNodeId: uuid("edge_node_id").notNull(),
    /** Better Auth user id of the owner who allowed selling. */
    grantedBy: text("granted_by").notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull(),
    /** Override ends here, by the edge's trusted clock. */
    untilAt: timestamp("until_at", { withTimezone: true }).notNull(),
    reason: text("reason").notNull(),
    /** Replaced by a newer grant on the same edge; the row is kept. */
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    /** Episode ended (a full catalog sync succeeded); the row is kept. */
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedReason:
      text("closed_reason").$type<EdgeCatalogOverrideClosedReason>(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    foreignKey({
      name: "edge_catalog_sale_overrides_edge_node_fk",
      columns: [table.tenantId, table.outletId, table.edgeNodeId],
      foreignColumns: [edgeNodes.tenantId, edgeNodes.outletId, edgeNodes.id],
    }),
    index("edge_catalog_sale_overrides_edge_until_idx").on(
      table.edgeNodeId,
      table.untilAt,
    ),
    // One active override per edge node, enforced by the database.
    uniqueIndex("edge_catalog_sale_overrides_active_uniq")
      .on(table.edgeNodeId)
      .where(sql`${table.supersededAt} IS NULL AND ${table.closedAt} IS NULL`),
    check(
      "edge_catalog_sale_overrides_window_check",
      sql`${table.untilAt} > ${table.grantedAt} AND ${table.untilAt} <= ${table.grantedAt} + interval '24 hours'`,
    ),
    check(
      "edge_catalog_sale_overrides_reason_check",
      sql`char_length(btrim(${table.reason})) BETWEEN 3 AND 500`,
    ),
    check(
      "edge_catalog_sale_overrides_closed_check",
      sql`(${table.closedAt} IS NULL) = (${table.closedReason} IS NULL)`,
    ),
  ],
);

export type EdgeCatalogSaleOverrideRow =
  typeof edgeCatalogSaleOverrides.$inferSelect;
