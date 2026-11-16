import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { tenantIdSchema } from "@starter/shared/core";
import * as schema from "../db/schema";
import { withTenant } from "../db/tenant";

const pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
const database = drizzle(pool, { schema });
const tenantA = randomUUID();
const tenantB = randomUUID();
const outlet = randomUUID();
const scope = (tenantId: string) =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "domain",
    }),
    { kind: "tenant" },
  );
afterAll(async () => {
  await pool.end();
});

describe("notification persistence", () => {
  it("legend-nb2mk indexes push subscriptions by user for account-wide lookup", async () => {
    const result = await database.execute(sql`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'push_subscriptions'
    `);
    expect(
      result.rows.some((row) =>
        /\bUSING btree \(user_id\)/.test(String(row.indexdef)),
      ),
    ).toBe(true);
  });

  it("TEN-01 TEN-02 isolates WhatsApp cap reservations by tenant and deduplicates attempts", async () => {
    const reservationTenant = randomUUID();
    const attempt = randomUUID();
    const notification = randomUUID();
    await withTenant(database, scope(reservationTenant), async (tx) => {
      await tx.execute(
        sql`INSERT INTO notifications (tenant_id, id, user_id, category, title, body, dedupe_key) VALUES (${reservationTenant}::uuid, ${notification}::uuid, ${randomUUID()}::uuid, 'order_ready', 'Ready', '', ${randomUUID()})`,
      );
      await tx.execute(
        sql`INSERT INTO delivery_attempts (tenant_id, id, notification_id, channel, idempotency_key) VALUES (${reservationTenant}::uuid, ${attempt}::uuid, ${notification}::uuid, 'whatsapp', ${randomUUID()})`,
      );
      await tx.execute(
        sql`INSERT INTO whatsapp_reservations (tenant_id, id, delivery_attempt_id, month) VALUES (${reservationTenant}::uuid, ${randomUUID()}::uuid, ${attempt}::uuid, '2026-11')`,
      );
    });
    await withTenant(database, scope(tenantB), async (tx) => {
      expect(
        (await tx.execute(sql`SELECT id FROM whatsapp_reservations`)).rows,
      ).toEqual([]);
    });
    await expect(
      withTenant(database, scope(reservationTenant), (tx) =>
        tx.execute(
          sql`INSERT INTO whatsapp_reservations (tenant_id, id, delivery_attempt_id, month) VALUES (${reservationTenant}::uuid, ${randomUUID()}::uuid, ${attempt}::uuid, '2026-11')`,
        ),
      ),
    ).rejects.toThrow();
  });
  it("TEN-01 TEN-02 isolates tenant notification policy, preferences, subscriptions and templates", async () => {
    const user = randomUUID();
    const template = randomUUID();
    const insert = (tenantId: string) =>
      withTenant(database, scope(tenantId), async (tx) => {
        await tx.execute(
          sql`INSERT INTO notification_policies (tenant_id, whatsapp, retry_backoff_seconds) VALUES (${tenantId}::uuid, '{"enabled":false,"allowedCategories":[],"monthlyCap":0,"costPerMessageIdr":0}'::jsonb, '[60]'::jsonb)`,
        );
        await tx.execute(
          sql`INSERT INTO notification_preferences (tenant_id, user_id, categories, time_zone) VALUES (${tenantId}::uuid, ${user}::uuid, '{}'::jsonb, 'Asia/Jakarta')`,
        );
        await tx.execute(
          sql`INSERT INTO push_subscriptions (tenant_id, id, user_id, endpoint_hash, subscription_ciphertext, key_version) VALUES (${tenantId}::uuid, ${randomUUID()}::uuid, ${user}::uuid, 'digest', 'encrypted', 'v1')`,
        );
        await tx.execute(
          sql`INSERT INTO notification_templates (tenant_id, id, category, channel, locale, title, body, variables, version) VALUES (${tenantId}::uuid, ${template}::uuid, 'order_ready', 'in_app', 'id', 'Title', 'Body', '[]'::jsonb, 1)`,
        );
      });
    await insert(tenantA);
    await insert(tenantB);
    await withTenant(database, scope(tenantA), async (tx) => {
      for (const table of [
        "notification_policies",
        "notification_preferences",
        "push_subscriptions",
        "notification_templates",
      ]) {
        const result = await tx.execute(
          sql`SELECT tenant_id FROM ${sql.identifier(table)}`,
        );
        expect(result.rows).toEqual([{ tenant_id: tenantA }]);
      }
    });
    await expect(insert(tenantA)).rejects.toThrow();
  });
  it("TEN-01 TEN-02 enforces RLS and tenant-scoped event and recipient dedupe", async () => {
    const event = randomUUID();
    const user = randomUUID();
    const notificationId = randomUUID();
    const insert = (tenantId: string) =>
      withTenant(database, scope(tenantId), async (tx) => {
        await tx.execute(
          sql`INSERT INTO notification_outbox (tenant_id, id, outlet_id, source_event_id, event_type, payload) VALUES (${tenantId}::uuid, ${randomUUID()}::uuid, ${outlet}::uuid, ${event}::uuid, 'order.placed', '{}'::jsonb)`,
        );
        await tx.execute(
          sql`INSERT INTO notifications (tenant_id, id, outlet_id, user_id, category, title, body, source_event_id, dedupe_key) VALUES (${tenantId}::uuid, ${notificationId}::uuid, NULL, ${user}::uuid, 'order_ready', 'Ready', '', ${event}::uuid, 'same-key')`,
        );
        await tx.execute(
          sql`INSERT INTO delivery_attempts (tenant_id, id, outlet_id, notification_id, channel, idempotency_key) VALUES (${tenantId}::uuid, ${randomUUID()}::uuid, NULL, ${notificationId}::uuid, 'web_push', 'same-key')`,
        );
      });
    await insert(tenantA);
    await insert(tenantB);
    await withTenant(database, scope(tenantA), async (tx) => {
      expect(
        (await tx.execute(sql`SELECT tenant_id FROM notification_outbox`)).rows,
      ).toEqual([{ tenant_id: tenantA }]);
      expect(
        (await tx.execute(sql`SELECT tenant_id FROM notifications`)).rows,
      ).toEqual([{ tenant_id: tenantA }]);
      expect(
        (await tx.execute(sql`SELECT tenant_id FROM delivery_attempts`)).rows,
      ).toEqual([{ tenant_id: tenantA }]);
    });
    await expect(insert(tenantA)).rejects.toThrow();
    await expect(
      withTenant(database, scope(tenantB), (tx) =>
        tx.execute(
          sql`INSERT INTO notifications (tenant_id, id, user_id, category, title, body, dedupe_key) VALUES (${tenantA}::uuid, ${randomUUID()}::uuid, ${user}::uuid, 'order_ready', 'X', '', 'forged')`,
        ),
      ),
    ).rejects.toThrow();
  });
});
