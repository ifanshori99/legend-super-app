// The outlet a staff session pinned for outlet-less routes (legend-6vgv; PRD
// v1.7 §3.7 RBAC, TEN-02/TEN-03). `PUT /api/me/active-outlet` writes one row
// per (session, tenant); `resolveFloorContext` and GET /api/me/access read it.
//
// A separate tenant + outlet owned table instead of a column on `session`:
// `session` is a global table (auth runs before a tenant is known), and a
// foreign key into the FORCE RLS `outlets` table must sit inside CREATE TABLE
// (docs/plan/contracts.md "Migrations: foreign keys into FORCE RLS tables").
// The row is a preference, not a grant: it is re-checked against the caller's
// assigned outlets on every read. Tenant + outlet RLS is applied in the
// 0324_session_active_outlet migration. The session FK cascades, so signing
// out or revoking a session drops its pin.
import {
  foreignKey,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { outletIdColumn, tenantIdColumn } from "../columns";
import { outlets, tenants } from "./platform-org";
import { session } from "./session";

export const sessionActiveOutlets = pgTable(
  "session_active_outlets",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => session.id, { onDelete: "cascade" }),
    tenantId: tenantIdColumn(() => tenants.id).notNull(),
    outletId: outletIdColumn(() => outlets.id).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      name: "session_active_outlets_pk",
      columns: [table.sessionId, table.tenantId],
    }),
    foreignKey({
      name: "session_active_outlets_outlet_fk",
      columns: [table.tenantId, table.outletId],
      foreignColumns: [outlets.tenantId, outlets.id],
    }).onDelete("cascade"),
  ],
);
