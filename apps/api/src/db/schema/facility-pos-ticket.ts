// Facility tickets sold at the cashier (936, legend-hpgyw part D; migration
// 0671). A ticket is an ordinary POS bill line:
// - `facility_ticket_pos_lines` ties one access ticket to the order line that
//   pays for it. `pending` = slot held and bill unpaid, `issued` = bill paid
//   (completePosOrder), `cancelled` = order voided before payment, `refunded` =
//   voided or refunded after payment. One ticket, one line (unique keys), so a
//   replay or a race can never issue or refund a ticket twice.
// - `access_ticket_credentials` keeps only DIGESTS of the door QR token and PIN
//   (accessTicketCredentialSchema: plaintext is returned once, never stored).
//   A new mint rotates the pair in place (`version`); a refund revokes it.
// Both tables are tenant and outlet owned (RLS lines in facility.custom.sql,
// mirrored in migration 0671). Foreign keys are inline in the CREATE TABLE of
// the migration.
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  pgTable,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import {
  idrColumn,
  outletIdColumn,
  tenantIdColumn,
  ulidInUuid,
} from "../columns.ts";
import { accessTickets, facilities } from "./facility.ts";
import { outlets, tenants } from "./platform-org.ts";
import { orderItems, orders } from "./qr-order.ts";

export type PosTicketLineStatus =
  "pending" | "issued" | "cancelled" | "refunded";

const createdAt = timestamp("created_at", { withTimezone: true })
  .notNull()
  .defaultNow();
const updatedAt = timestamp("updated_at", { withTimezone: true })
  .notNull()
  .defaultNow();

export const facilityTicketPosLines = pgTable(
  "facility_ticket_pos_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    facilityId: uuid("facility_id").notNull(),
    accessTicketId: ulidInUuid("access_ticket_id").notNull(),
    orderId: ulidInUuid("order_id").notNull(),
    orderItemId: ulidInUuid("order_item_id").notNull(),
    status: varchar("status", { length: 20 })
      .$type<PosTicketLineStatus>()
      .notNull(),
    /** The line total the guest pays (server price at sale time). */
    lineTotalIdr: idrColumn("line_total_idr").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    refundedAt: timestamp("refunded_at", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("facility_ticket_pos_lines_tenant_id_id_key").on(
      table.tenantId,
      table.id,
    ),
    unique("facility_ticket_pos_lines_ticket_key").on(
      table.tenantId,
      table.accessTicketId,
    ),
    unique("facility_ticket_pos_lines_item_key").on(
      table.tenantId,
      table.orderItemId,
    ),
    foreignKey({
      name: "facility_ticket_pos_lines_facility_fk",
      columns: [table.tenantId, table.outletId, table.facilityId],
      foreignColumns: [facilities.tenantId, facilities.outletId, facilities.id],
    }),
    foreignKey({
      name: "facility_ticket_pos_lines_ticket_fk",
      columns: [table.tenantId, table.accessTicketId],
      foreignColumns: [accessTickets.tenantId, accessTickets.id],
    }),
    foreignKey({
      name: "facility_ticket_pos_lines_order_fk",
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
    }),
    foreignKey({
      name: "facility_ticket_pos_lines_item_fk",
      columns: [table.tenantId, table.orderItemId],
      foreignColumns: [orderItems.tenantId, orderItems.id],
    }),
    check(
      "facility_ticket_pos_lines_status_check",
      sql`${table.status} IN ('pending', 'issued', 'cancelled', 'refunded')`,
    ),
    check(
      "facility_ticket_pos_lines_amount_check",
      sql`${table.lineTotalIdr} >= 0`,
    ),
  ],
);

export const accessTicketCredentials = pgTable(
  "access_ticket_credentials",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    accessTicketId: ulidInUuid("access_ticket_id").notNull(),
    /** SHA-256 hex of the QR token; the token itself is never stored. */
    qrDigest: varchar("qr_digest", { length: 64 }).notNull(),
    /** SHA-256 hex of the PIN bound to the ticket id (never the bare PIN). */
    pinDigest: varchar("pin_digest", { length: 64 }).notNull(),
    /** Bumped by every mint; the previous pair stops working. */
    version: integer("version").notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
    validUntil: timestamp("valid_until", { withTimezone: true }).notNull(),
    /** Idempotency key of the mint that produced this version. */
    mintedKey: varchar("minted_key", { length: 120 }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (table) => [
    unique("access_ticket_credentials_tenant_id_id_key").on(
      table.tenantId,
      table.id,
    ),
    unique("access_ticket_credentials_ticket_key").on(
      table.tenantId,
      table.accessTicketId,
    ),
    unique("access_ticket_credentials_qr_key").on(
      table.tenantId,
      table.qrDigest,
    ),
    foreignKey({
      name: "access_ticket_credentials_ticket_fk",
      columns: [table.tenantId, table.accessTicketId],
      foreignColumns: [accessTickets.tenantId, accessTickets.id],
    }),
    check(
      "access_ticket_credentials_window_check",
      sql`${table.validUntil} > ${table.validFrom} AND ${table.version} >= 1`,
    ),
  ],
);

/**
 * Every idempotency key ever used to mint a credential for a ticket (migration
 * 0672), as a SHA-256 digest only. `access_ticket_credentials.minted_key` keeps
 * just the newest key, so an older key replayed after a newer mint would look
 * fresh and rotate the newest pair. A key found here is refused (409
 * TICKET_CREDENTIAL_SHOWN) and the newest pair never changes. Rows are written
 * in the mint transaction, under the ticket row lock.
 */
export const accessTicketCredentialKeys = pgTable(
  "access_ticket_credential_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    accessTicketId: ulidInUuid("access_ticket_id").notNull(),
    /** SHA-256 hex of the idempotency key; the key itself is not stored. */
    keyDigest: varchar("key_digest", { length: 64 }).notNull(),
    /** The credential version this key produced. */
    version: integer("version").notNull(),
    createdAt,
  },
  (table) => [
    unique("access_ticket_credential_keys_key").on(
      table.tenantId,
      table.accessTicketId,
      table.keyDigest,
    ),
    foreignKey({
      name: "access_ticket_credential_keys_ticket_fk",
      columns: [table.tenantId, table.accessTicketId],
      foreignColumns: [accessTickets.tenantId, accessTickets.id],
    }),
    check(
      "access_ticket_credential_keys_version_check",
      sql`${table.version} >= 1`,
    ),
  ],
);

/**
 * PIN guess counter of the door check (migration 0676, R2-04 / legend-0xt77).
 * One row per ticket that had a PIN guess: `failures` guesses reserved since
 * `window_started_at` (fixed window). Five reserved guesses lock the PIN path
 * of that ticket until the window ends. The counter lives in the database so
 * every API instance shares it, and nothing evicts a row, so churn of other
 * ticket ids can never reset a lock. Rows exist only for real tickets (the
 * insert selects from `access_tickets`), so unknown ids add nothing.
 */
export const accessTicketPinGuesses = pgTable(
  "access_ticket_pin_guesses",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    accessTicketId: ulidInUuid("access_ticket_id").notNull(),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    failures: integer("failures").notNull(),
    updatedAt,
  },
  (table) => [
    unique("access_ticket_pin_guesses_ticket_key").on(
      table.tenantId,
      table.accessTicketId,
    ),
    foreignKey({
      name: "access_ticket_pin_guesses_ticket_fk",
      columns: [table.tenantId, table.accessTicketId],
      foreignColumns: [accessTickets.tenantId, accessTickets.id],
    }),
    check(
      "access_ticket_pin_guesses_failures_check",
      sql`${table.failures} >= 0`,
    ),
  ],
);
