// Customer reviews (legend-vqicf, docs/briefs/981-reviews.md; migration 0455).
// Not the staff-handled `feedback` queue (crm-feedback.ts): this table keeps
// the public review itself, its source and the moderation outcome.
//
// Database guarantees (hand SQL in customer-reviews.custom.sql):
// - Tenant + outlet RLS (`outlet_id` is NOT NULL).
// - No DELETE or TRUNCATE for legend_app: a review is hidden, never removed.
// - `body` is personal data: never log it, never send it to a dashboard queue
//   or to AI output.

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
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type {
  CustomerReviewModerationStatus,
  CustomerReviewSource,
} from "@starter/shared/crm";
import { outletIdColumn, tenantIdColumn, ulidInUuid } from "../columns";
import { customerProfiles } from "./crm-member";
import { outlets, tenants } from "./platform-org";
import { orders } from "./qr-order";
import { reservations } from "./reservation";

export const CUSTOMER_REVIEW_SOURCES = [
  "qr",
  "app",
  "web",
  "google",
  "manual",
] as const;
export const CUSTOMER_REVIEW_MODERATION_STATUSES = [
  "pending",
  "published",
  "hidden",
] as const;

/** `customer_reviews` (T, E): a customer's rating and optional text. */
export const customerReviews = pgTable(
  "customer_reviews",
  {
    id: uuid("id").defaultRandom().notNull(),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    orderId: ulidInUuid("order_id"),
    reservationId: uuid("reservation_id"),
    customerProfileId: uuid("customer_profile_id"),
    rating: integer("rating").notNull(),
    /** Personal data: never logged, never in a dashboard queue or AI output. */
    body: varchar("body", { length: 2000 }),
    source: varchar("source", { length: 16 })
      .$type<CustomerReviewSource>()
      .notNull(),
    moderationStatus: varchar("moderation_status", { length: 12 })
      .$type<CustomerReviewModerationStatus>()
      .notNull()
      .default("pending"),
    moderatedBy: text("moderated_by"),
    moderatedAt: timestamp("moderated_at", { withTimezone: true }),
    moderationNote: varchar("moderation_note", { length: 500 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      name: "customer_reviews_pkey",
      columns: [table.tenantId, table.id],
    }),
    foreignKey({
      name: "customer_reviews_order_fk",
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
    }),
    foreignKey({
      name: "customer_reviews_reservation_fk",
      columns: [table.tenantId, table.reservationId],
      foreignColumns: [reservations.tenantId, reservations.id],
    }),
    foreignKey({
      name: "customer_reviews_profile_fk",
      columns: [table.tenantId, table.customerProfileId],
      foreignColumns: [customerProfiles.tenantId, customerProfiles.id],
    }),
    index("customer_reviews_queue_idx").on(
      table.tenantId,
      table.outletId,
      table.moderationStatus,
      table.createdAt,
    ),
    check(
      "customer_reviews_rating_check",
      sql`${table.rating} BETWEEN 1 AND 5`,
    ),
    check(
      "customer_reviews_source_check",
      sql`${table.source} IN ('qr', 'app', 'web', 'google', 'manual')`,
    ),
    check(
      "customer_reviews_moderation_status_check",
      sql`${table.moderationStatus} IN ('pending', 'published', 'hidden')`,
    ),
  ],
);
