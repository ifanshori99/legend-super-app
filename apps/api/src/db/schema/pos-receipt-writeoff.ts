// Audited write-off of a lost receipt number (bead legend-0hzqw).
//
//   receipt_number_writeoffs  the tenant owner marks one number (prefix +
//                             ordinal) of a device run as permanently lost,
//                             with a reason. Gap checks (day close, shift
//                             report) count it as present and report it as
//                             written off. Append-only: never updated or
//                             deleted, so the decision is irreversible.
//
// (T, O) rules as in pos-receipt.ts. RLS, the append-only trigger and the
// insert backstop live in pos-receipt-writeoff.custom.sql.

import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { outletIdColumn, tenantIdColumn } from "../columns";
import { outlets, tenants } from "./platform-org";
import { receiptSequences } from "./pos-receipt";

/** `receipt_number_writeoffs` (T, O): one lost receipt number, written off. */
export const receiptNumberWriteoffs = pgTable(
  "receipt_number_writeoffs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    sequenceId: uuid("sequence_id").notNull(),
    prefix: varchar("prefix", { length: 12 }).notNull(),
    sequenceNumber: integer("sequence_number").notNull(),
    reason: text("reason").notNull(),
    /** User id of the owner who wrote the number off. */
    writtenOffBy: uuid("written_off_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("receipt_number_writeoffs_tenant_id_id_key").on(
      table.tenantId,
      table.id,
    ),
    // Each ordinal of a device run is written off at most once.
    unique("receipt_number_writeoffs_ordinal_key").on(
      table.tenantId,
      table.sequenceId,
      table.sequenceNumber,
    ),
    foreignKey({
      name: "receipt_number_writeoffs_sequence_fk",
      columns: [table.tenantId, table.sequenceId],
      foreignColumns: [receiptSequences.tenantId, receiptSequences.id],
    }),
    foreignKey({
      name: "receipt_number_writeoffs_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    check(
      "receipt_number_writeoffs_sequence_number_check",
      sql`${table.sequenceNumber} > 0`,
    ),
    check(
      "receipt_number_writeoffs_reason_check",
      sql`char_length(${table.reason}) BETWEEN 10 AND 500`,
    ),
  ],
);
