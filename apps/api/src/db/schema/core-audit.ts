import {
  index,
  jsonb,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { AuditEvent } from "@starter/shared/audit";

export const auditLogs = pgTable(
  "audit_logs",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: uuid("id").notNull(),
    outletId: uuid("outlet_id"),
    event: jsonb("event").$type<AuditEvent>().notNull(),
    retentionClass: varchar("retention_class", { length: 32 })
      .notNull()
      .default("audit_2y"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    index("audit_logs_retention_idx").on(table.tenantId, table.createdAt),
  ],
);
