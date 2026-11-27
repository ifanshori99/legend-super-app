// Paired EDC bridge tablets (B2 legend-wasr7.21). One row per tablet; only
// SHA-256 of its device token is stored. A WSS upgrade resolves the hash
// through `app.edc_bridge_resolve_token` (no tenant is known before auth), then
// re-reads the row under tenant RLS. `revoked_at` ends the device for good.
// Leases and commands: edc-bridge.ts. RLS: edc-bridge.custom.sql (0541).
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  pgTable,
  text,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";
import { outletIdColumn, tenantIdColumn, ulidInUuid } from "../columns.ts";
import { outlets, tenants } from "./platform-org.ts";

export const edcBridgeDevices = pgTable(
  "edc_bridge_devices",
  {
    id: ulidInUuid("id").primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    label: varchar("label", { length: 100 }).notNull(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    unique("edc_bridge_devices_token_hash_key").on(t.tokenHash),
    unique("edc_bridge_devices_tenant_id_key").on(t.tenantId, t.id),
    unique("edc_bridge_devices_tenant_outlet_id_key").on(
      t.tenantId,
      t.outletId,
      t.id,
    ),
    foreignKey({
      name: "edc_bridge_devices_outlet_fk",
      columns: [t.tenantId, t.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    check(
      "edc_bridge_devices_token_hash_check",
      sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export type EdcBridgeDeviceRow = typeof edcBridgeDevices.$inferSelect;
