// legend-k2l: `identity_merges` (global, no tenant, no RLS) — one row per
// account merge (brief 290b, 290-aturan-bersama §C/§F, design ws08 M3). When a
// customer links a WhatsApp number that already belongs to a second, empty
// account, that second account (the absorbed one) is closed and its identities
// move to the survivor. This table is the permanent record support reads.
//
// - `absorbed_user_id` is unique: an account is absorbed at most once.
// - `identity_ids` lists the `user_identities` rows moved to the survivor.
// - `profile_moves` lists what happened to the member profiles of each tenant
//   (`[{ tenantId, profileId, action }]`); empty until the member profile
//   tables (legend-111j / 290a) exist. No foreign key to any profile table.
// - Append-only: migration 0204 installs a trigger that rejects UPDATE and
//   DELETE, and `legend_app` is granted SELECT and INSERT only.
// - `created_by` is the signed-in user who asked for the link, or null when the
//   WhatsApp webhook completed it.
import { sql } from "drizzle-orm";
import {
  check,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { user } from "./user";

export type IdentityMergeTrigger = "whatsapp_link" | "support";

export type IdentityMergeProfileMove = {
  tenantId: string;
  profileId: string;
  action: string;
};

export const identityMerges = pgTable(
  "identity_merges",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    survivorUserId: text("survivor_user_id")
      .notNull()
      .references(() => user.id),
    absorbedUserId: text("absorbed_user_id")
      .notNull()
      .unique()
      .references(() => user.id),
    trigger: varchar("trigger", { length: 20 })
      .$type<IdentityMergeTrigger>()
      .notNull(),
    identityIds: uuid("identity_ids").array().notNull(),
    profileMoves: jsonb("profile_moves")
      .$type<IdentityMergeProfileMove[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdBy: text("created_by"),
  },
  (table) => [
    check(
      "identity_merges_trigger_check",
      sql`${table.trigger} IN ('whatsapp_link', 'support')`,
    ),
    check(
      "identity_merges_distinct_users_check",
      sql`${table.survivorUserId} <> ${table.absorbedUserId}`,
    ),
  ],
);
