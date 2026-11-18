// WFC minimum spend reminder outbox for a participant without an account
// (PRD v1.7 §3 F39; bead legend-qr3sd). `notifications.user_id` is NOT NULL,
// so a guest who left a WhatsApp number or email gets a row here instead. One
// row per session + completed hour + destination (`dedupe_key`); the outbound
// send reads this table. RLS: wfc-guest-reminder.custom.sql (appended to the
// migration). A message only: nothing here touches orders or payments.
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { outletIdColumn, tenantIdColumn } from "../columns.ts";
import { sessionParticipants, tableSessions } from "./floor.ts";
import { outlets, tenants } from "./platform-org.ts";

export const wfcGuestReminders = pgTable(
  "wfc_guest_reminders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    tableSessionId: uuid("table_session_id").notNull(),
    /** The participant whose contact was chosen for this destination. */
    participantId: uuid("participant_id").notNull(),
    /** The completed hour the reminder is for. */
    hours: integer("hours").notNull(),
    channel: varchar("channel", { length: 10 })
      .$type<"whatsapp" | "email">()
      .notNull(),
    /** Normalised contact: E.164 number or lower-cased email. */
    destination: text("destination").notNull(),
    /** `wfc_min_spend:<sessionId>:<hours>:<destination>`. */
    dedupeKey: varchar("dedupe_key", { length: 400 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("wfc_guest_reminders_tenant_dedupe_key").on(
      table.tenantId,
      table.dedupeKey,
    ),
    foreignKey({
      name: "wfc_guest_reminders_session_fk",
      columns: [table.tenantId, table.tableSessionId],
      foreignColumns: [tableSessions.tenantId, tableSessions.id],
    }),
    foreignKey({
      name: "wfc_guest_reminders_participant_fk",
      columns: [table.tenantId, table.participantId],
      foreignColumns: [sessionParticipants.tenantId, sessionParticipants.id],
    }),
    index("wfc_guest_reminders_session_idx").on(
      table.tenantId,
      table.tableSessionId,
      table.hours,
    ),
    check(
      "wfc_guest_reminders_channel_check",
      sql`${table.channel} IN ('whatsapp', 'email')`,
    ),
    check("wfc_guest_reminders_hours_check", sql`${table.hours} >= 1`),
  ],
);
