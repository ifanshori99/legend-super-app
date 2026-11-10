// WS-08 customer segments and their materialized members (legend-ts50,
// docs/briefs/290d, shipped as migration 0209).
//
// Database guarantees (hand SQL in crm-segments.custom.sql):
// - Tenant RLS on both tables.
// - No DELETE or TRUNCATE for legend_app on `segments`. `segment_members`
//   keeps DELETE: a refresh replaces the materialized rows.

import {
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { SegmentDefinition } from "@starter/shared/crm";
import { tenantIdColumn } from "../columns";
import { customerProfiles } from "./crm-member";
import { tenants } from "./platform-org";

/** `segments` (T): a saved audience definition (RFM, tier, outlet, ...). */
export const segments = pgTable(
  "segments",
  {
    id: uuid("id").defaultRandom().notNull(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    name: varchar("name", { length: 150 }).notNull(),
    definition: jsonb("definition").$type<SegmentDefinition>().notNull(),
    /** Last refresh of the materialized size; NULL before the first run. */
    refreshedAt: timestamp("refreshed_at", { withTimezone: true }),
    size: integer("size").notNull().default(0),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({ name: "segments_pkey", columns: [table.tenantId, table.id] }),
    index("segments_tenant_name_idx").on(table.tenantId, table.name),
  ],
);

/** `segment_members` (T): materialized membership of a segment. */
export const segmentMembers = pgTable(
  "segment_members",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    segmentId: uuid("segment_id").notNull(),
    customerProfileId: uuid("customer_profile_id").notNull(),
    /** When the refresh that produced this row ran. */
    materializedAt: timestamp("materialized_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      name: "segment_members_pkey",
      columns: [table.tenantId, table.segmentId, table.customerProfileId],
    }),
    foreignKey({
      name: "segment_members_segment_fk",
      columns: [table.tenantId, table.segmentId],
      foreignColumns: [segments.tenantId, segments.id],
    }),
    foreignKey({
      name: "segment_members_profile_fk",
      columns: [table.tenantId, table.customerProfileId],
      foreignColumns: [customerProfiles.tenantId, customerProfiles.id],
    }),
    index("segment_members_profile_idx").on(
      table.tenantId,
      table.customerProfileId,
    ),
  ],
);
