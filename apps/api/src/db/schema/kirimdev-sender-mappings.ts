// `kirimdev_sender_mappings` (T, bead legend-nqxtb): which Kirimdev WhatsApp
// number a tenant (or one outlet) may send from. One platform KIRIM_API_KEY can
// send from every number of the Kirimdev org, so the mapping is written only by
// a platform admin; a tenant admin never sets it (the old
// `tenant_integrations.config.phoneNumberId` is ignored by the sender).
// `phone_number_id` is unique across ALL tenants, so one number can never
// serve two tenants. A null `outlet_id` is the tenant-wide sender; an outlet
// row wins for that outlet.

import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { outlets, tenants } from "./platform-org";

export const kirimdevSenderMappings = pgTable(
  "kirimdev_sender_mappings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    /** null = the tenant-wide sender; set = only this outlet. */
    outletId: uuid("outlet_id"),
    phoneNumberId: text("phone_number_id").notNull(),
    createdByUserId: text("created_by_user_id"),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    foreignKey({
      name: "kirimdev_sender_mappings_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    uniqueIndex("kirimdev_sender_mappings_phone_number_key").on(
      table.phoneNumberId,
    ),
    // NULL outlet_id would escape a plain unique index, so split the key.
    uniqueIndex("kirimdev_sender_mappings_tenant_key")
      .on(table.tenantId)
      .where(sql`${table.outletId} IS NULL`),
    uniqueIndex("kirimdev_sender_mappings_outlet_key")
      .on(table.tenantId, table.outletId)
      .where(sql`${table.outletId} IS NOT NULL`),
    check(
      "kirimdev_sender_mappings_phone_number_check",
      sql`${table.phoneNumberId} ~ '^[A-Za-z0-9_-]{1,64}$'`,
    ),
  ],
);
