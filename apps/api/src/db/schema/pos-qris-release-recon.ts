// QRIS release reconciliation queue (legend-adiov, so-879 P1). A manager may
// force-release a stuck QRIS hold without provider proof (founder Q93), and a
// release means the local code is dead while the provider may still take the
// money. One durable row per release keeps asking the provider until it
// answers for good (paid / expired / failed), however long that takes and
// whatever the local expiry or the poller's 24 h window says. Never deleted.
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { outletIdColumn, tenantIdColumn, ulidInUuid } from "../columns";
import { paymentIntents } from "./payment";
import { outlets, tenants } from "./platform-org";
import { posQrisHolds } from "./pos-qris-hold";

export const POS_QRIS_RECON_STATUSES = ["open", "resolved"] as const;
export type PosQrisReconStatus = (typeof POS_QRIS_RECON_STATUSES)[number];

export const POS_QRIS_RECON_RESOLUTIONS = [
  "paid_recorded",
  "provider_expired",
  "provider_failed",
] as const;
export type PosQrisReconResolution =
  (typeof POS_QRIS_RECON_RESOLUTIONS)[number];

export const posQrisReleaseReconciliations = pgTable(
  "pos_qris_release_reconciliations",
  {
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    id: ulidInUuid("id").notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    holdId: ulidInUuid("hold_id").notNull(),
    paymentIntentId: uuid("payment_intent_id").notNull(),
    status: text("status").$type<PosQrisReconStatus>().notNull(),
    /** Why the row exists, e.g. `force_released`. */
    reason: text("reason").notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }).notNull(),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    /** The provider's last answer: pending / paid / expired / failed /
     * unreachable / paid_without_amount / no_provider_ref. */
    lastProviderStatus: text("last_provider_status"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolution: text("resolution").$type<PosQrisReconResolution>(),
  },
  (table) => [
    primaryKey({
      name: "pos_qris_release_reconciliations_pkey",
      columns: [table.tenantId, table.id],
    }),
    unique("pos_qris_release_reconciliations_hold_key").on(
      table.tenantId,
      table.holdId,
    ),
    foreignKey({
      name: "pos_qris_release_reconciliations_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }),
    foreignKey({
      name: "pos_qris_release_reconciliations_hold_fk",
      columns: [table.tenantId, table.holdId],
      foreignColumns: [posQrisHolds.tenantId, posQrisHolds.id],
    }),
    foreignKey({
      name: "pos_qris_release_reconciliations_intent_fk",
      columns: [table.tenantId, table.paymentIntentId],
      foreignColumns: [paymentIntents.tenantId, paymentIntents.id],
    }),
    index("pos_qris_release_reconciliations_due_idx")
      .on(table.status, table.nextCheckAt)
      .where(sql`${table.status} = 'open'`),
    check(
      "pos_qris_release_reconciliations_status_check",
      sql`${table.status} IN ('open', 'resolved')`,
    ),
    check(
      "pos_qris_release_reconciliations_attempts_check",
      sql`${table.attempts} >= 0`,
    ),
    check(
      "pos_qris_release_reconciliations_resolved_check",
      sql`(${table.status} = 'resolved') = (${table.resolvedAt} IS NOT NULL AND ${table.resolution} IS NOT NULL)`,
    ),
    check(
      "pos_qris_release_reconciliations_resolution_check",
      sql`${table.resolution} IS NULL OR ${table.resolution} IN ('paid_recorded', 'provider_expired', 'provider_failed')`,
    ),
  ],
);
