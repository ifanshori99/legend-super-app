// O1 offline kits (bead legend-wasr7.5; docs/design/cloud-only-release.md §2).
//
//   pos_offline_kits  every kit the cloud handed a tablet: the open shift and
//                     device it was issued to, the offline receipt run (epoch)
//                     it numbers on, the catalogue version and the priced
//                     snapshot itself (O2 compares synced prices against it).
//                     Valid 24 hours. Append-only, never deleted (custom SQL).
//
// (T, O) rules: tenant_id + outlet_id NOT NULL, children reference parents
// through composite (tenant_id, id) keys, tenant + outlet RLS.

import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { PosOfflineKit } from "@starter/shared/pos";
import { outletIdColumn, tenantIdColumn } from "../columns.ts";
import { outlets, tenants } from "./platform-org.ts";
import { receiptSequences } from "./pos-receipt.ts";
import { posShifts } from "./pos-shift.ts";
import { user } from "./user.ts";

/** What the kit priced: the part of the DTO O2 checks synced sales against. */
export type PosOfflineKitSnapshot = Pick<PosOfflineKit, "catalogs" | "tax">;

export const posOfflineKits = pgTable(
  "pos_offline_kits",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    deviceId: uuid("device_id").notNull(),
    /** The open shift of the device the kit was issued to. */
    shiftId: uuid("shift_id").notNull(),
    /** The device's offline run (`L<n>`, series `offline`): the epoch. */
    sequenceId: uuid("sequence_id").notNull(),
    issuedBy: text("issued_by")
      .notNull()
      .references(() => user.id),
    /** SHA-256 hex of the snapshot (catalogs + tax). */
    catalogVersion: varchar("catalog_version", { length: 64 }).notNull(),
    snapshot: jsonb("snapshot").$type<PosOfflineKitSnapshot>().notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("pos_offline_kits_tenant_id_id_key").on(table.tenantId, table.id),
    index("pos_offline_kits_sequence_idx").on(
      table.tenantId,
      table.sequenceId,
      table.issuedAt,
    ),
    foreignKey({
      name: "pos_offline_kits_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "pos_offline_kits_shift_fk",
      columns: [table.tenantId, table.shiftId],
      foreignColumns: [posShifts.tenantId, posShifts.id],
    }),
    foreignKey({
      name: "pos_offline_kits_sequence_fk",
      columns: [table.tenantId, table.sequenceId],
      foreignColumns: [receiptSequences.tenantId, receiptSequences.id],
    }),
    check(
      "pos_offline_kits_catalog_version_check",
      sql`${table.catalogVersion} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "pos_offline_kits_expiry_check",
      sql`${table.expiresAt} > ${table.issuedAt}`,
    ),
    check(
      "pos_offline_kits_snapshot_check",
      sql`jsonb_typeof(${table.snapshot}) = 'object'`,
    ),
  ],
);
