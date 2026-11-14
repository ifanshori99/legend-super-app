// Guest self-service for reservations via a signed link (PRD v1.7 §3.22
// "DP & Kebijakan" / "Pengingat"; RSV-03; bead legend-o5gr).
//
// - `reservation_guest_links`: one link per reservation. Only the SHA-256 hex of
//   the token is stored (the token itself is never persisted or logged). A link
//   expires at reservedFor + 24h and can be revoked; at most one link per
//   reservation is active (`revoked_at IS NULL`), so issuing a new one revokes
//   the previous one in the same transaction.
// - `reservation_reschedule_requests`: a guest asks for another time. It changes
//   nothing on the reservation or its holds; staff resolve it later. At most one
//   request per reservation is pending.
//
// Tenant RLS is installed in reservation-public.custom.sql.
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { outletIdColumn, tenantIdColumn } from "../columns.ts";
import { reservations } from "./reservation.ts";
import { outlets, tenants } from "./platform-org.ts";

/** Mirrors RESCHEDULE_REQUEST_STATUSES in the shared contract (self-service.ts). */
export type RescheduleRequestStatus =
  "pending" | "approved" | "declined" | "withdrawn";

const createdAt = timestamp("created_at", { withTimezone: true })
  .notNull()
  .defaultNow();

/** `reservation_guest_links` (T): hashed guest token per reservation. */
export const reservationGuestLinks = pgTable(
  "reservation_guest_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    reservationId: uuid("reservation_id").notNull(),
    /** SHA-256 hex of the 43-char base64url token. */
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /** Staff user id that issued the link; null when the system issued it. */
    createdBy: text("created_by"),
    createdAt,
  },
  (table) => [
    unique("reservation_guest_links_tenant_id_id_key").on(
      table.tenantId,
      table.id,
    ),
    unique("reservation_guest_links_token_key").on(
      table.tenantId,
      table.tokenHash,
    ),
    foreignKey({
      name: "reservation_guest_links_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "reservation_guest_links_reservation_fk",
      columns: [table.tenantId, table.reservationId],
      foreignColumns: [reservations.tenantId, reservations.id],
    }),
    // Several automatic links may be active at once (legend-wmfip: a retry
    // never revokes the link of an earlier send); the service caps them.
    // Revoked rows stay as history.
    index("reservation_guest_links_active_key")
      .on(table.tenantId, table.reservationId)
      .where(sql`${table.revokedAt} IS NULL`),
    check(
      "reservation_guest_links_token_hash_check",
      sql`${table.tokenHash} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

/** `reservation_reschedule_requests` (T): a guest's request for another time. */
export const reservationRescheduleRequests = pgTable(
  "reservation_reschedule_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    reservationId: uuid("reservation_id").notNull(),
    guestLinkId: uuid("guest_link_id"),
    requestedFor: timestamp("requested_for", { withTimezone: true }).notNull(),
    partySize: integer("party_size"),
    note: varchar("note", { length: 300 }),
    status: varchar("status", { length: 20 })
      .$type<RescheduleRequestStatus>()
      .notNull()
      .default("pending"),
    createdAt,
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: text("resolved_by"),
    /**
     * The booking time before staff approved the move (legend-z5ygw), so the
     * guest view can say the old schedule was replaced. NULL while pending,
     * when declined, and on requests approved before this column existed.
     */
    previousReservedFor: timestamp("previous_reserved_for", {
      withTimezone: true,
    }),
  },
  (table) => [
    unique("reservation_reschedule_requests_tenant_id_id_key").on(
      table.tenantId,
      table.id,
    ),
    foreignKey({
      name: "reservation_reschedule_requests_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "reservation_reschedule_requests_reservation_fk",
      columns: [table.tenantId, table.reservationId],
      foreignColumns: [reservations.tenantId, reservations.id],
    }),
    foreignKey({
      name: "reservation_reschedule_requests_link_fk",
      columns: [table.tenantId, table.guestLinkId],
      foreignColumns: [
        reservationGuestLinks.tenantId,
        reservationGuestLinks.id,
      ],
    }),
    // One pending request per reservation; resolved rows stay as history.
    uniqueIndex("reservation_reschedule_requests_pending_key")
      .on(table.tenantId, table.reservationId)
      .where(sql`${table.status} = 'pending'`),
    index("reservation_reschedule_requests_list_idx").on(
      table.tenantId,
      table.outletId,
      table.status,
      table.createdAt,
    ),
    check(
      "reservation_reschedule_requests_status_check",
      sql`${table.status} IN ('pending', 'approved', 'declined', 'withdrawn')`,
    ),
    check(
      "reservation_reschedule_requests_party_size_check",
      sql`${table.partySize} IS NULL OR (${table.partySize} >= 1 AND ${table.partySize} <= 50)`,
    ),
  ],
);
