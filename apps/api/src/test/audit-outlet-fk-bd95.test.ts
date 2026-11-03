// legend-bd95: audit and notification rows may only name an outlet of their own
// tenant (composite FK (tenant_id, outlet_id) -> outlets(tenant_id, id)).
// outlet_id stays nullable, so tenant-wide rows remain valid (MATCH SIMPLE).
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTableConfig } from "drizzle-orm/pg-core";
import { auditLogs } from "../db/schema/core-audit";
import {
  deliveryAttempts,
  notifications,
  whatsappReservations,
} from "../db/schema/notification";

const owner = process.env.STARTER_TEST_DATABASE_URL
  ? new Pool({
      connectionString: process.env.STARTER_TEST_DATABASE_URL,
      max: 2,
    })
  : null;
afterAll(async () => {
  await owner?.end();
});

const tables = [
  [auditLogs, "audit_logs_outlet_fk"],
  [notifications, "notifications_outlet_fk"],
  [deliveryAttempts, "delivery_attempts_outlet_fk"],
  [whatsappReservations, "whatsapp_reservations_outlet_fk"],
] as const;

describe("bd95 tenant-scoped outlet foreign keys", () => {
  it.each(tables)(
    "bd95 declares (tenant_id, outlet_id) FK on %#",
    (table, name) => {
      const fk = getTableConfig(table).foreignKeys.find(
        (key) => key.getName() === name,
      );
      expect(fk).toBeDefined();
      const ref = fk!.reference();
      expect(ref.columns.map((c) => c.name)).toEqual([
        "tenant_id",
        "outlet_id",
      ]);
      expect(ref.foreignColumns.map((c) => c.name)).toEqual([
        "tenant_id",
        "id",
      ]);
      expect(getTableConfig(ref.foreignTable).name).toBe("outlets");
    },
  );

  it("bd95 rejects a cross-tenant or unknown outlet reference, accepts NULL", async () => {
    if (!owner) return;
    const tenant = randomUUID();
    const auditRow = (outlet: string | null) =>
      owner.query(
        "INSERT INTO audit_logs (tenant_id, id, outlet_id, event) VALUES ($1, $2, $3, $4::jsonb)",
        [
          tenant,
          randomUUID(),
          outlet,
          JSON.stringify({
            tenantId: tenant,
            outletId: outlet,
            retentionClass: "audit_2y",
          }),
        ],
      );
    await expect(auditRow(randomUUID())).rejects.toThrow(
      /audit_logs_outlet_fk/,
    );
    await expect(
      owner.query(
        "INSERT INTO notifications (tenant_id, id, outlet_id, user_id, category, title, body, dedupe_key) VALUES ($1, $2, $3, $4, 'c', 't', '', $5)",
        [tenant, randomUUID(), randomUUID(), randomUUID(), randomUUID()],
      ),
    ).rejects.toThrow(/notifications_outlet_fk/);
    await expect(auditRow(null)).resolves.toBeDefined();
  });
});
