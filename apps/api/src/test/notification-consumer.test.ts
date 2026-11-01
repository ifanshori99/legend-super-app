import { afterAll, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { eventFixture } from "@starter/shared/events";
import {
  cafeLegendNotificationFixtures,
  notificationPolicySchema,
} from "@starter/shared/notification";
import * as schema from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { appendOutbox, consumeOutbox } from "../services/core-outbox.ts";
import { createNotificationConsumer } from "../services/notification-consumer.ts";

const pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
const database = drizzle(pool, { schema });
const tenantId = "a5000000-0000-4000-8000-000000000001";
const otherTenantId = "b5000000-0000-4000-8000-000000000002";
const ctx = (id: string) =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId: id, brandId: null, source: "job" }),
    { kind: "tenant" },
  );
const event = {
  ...eventFixture,
  id: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
  tenantId,
  outletId: null,
  sequence: 1,
};
const id = "01ARZ3NDEKTSV4RRFFQ69G5FB2";
const recipient = {
  userId: "33333333-3333-4333-8333-333333333333",
  category: "order_ready" as const,
  title: "Ready",
  body: "Ready",
  link: null,
  policy: notificationPolicySchema.parse({
    ...cafeLegendNotificationFixtures.policy,
    tenantId,
  }),
  preference: null,
  reachability: {
    hasPushSubscription: true,
    hasVerifiedEmail: false,
    whatsappOptIn: false,
  },
  whatsappSentThisMonth: 0,
  defaultTimeZone: "Asia/Jakarta",
};
afterAll(async () => {
  await pool.end();
});
it("F15 TEN-01 persists in-app and delivery decisions atomically, deduplicates replay, and isolates tenants", async () => {
  const context = ctx(tenantId);
  await withTenant(database, context, (tx) =>
    appendOutbox(tx, context, {
      id,
      event,
      destination: "notification",
      direction: null,
      peerId: null,
    }),
  );
  const deliver = createNotificationConsumer(context, async () => [recipient]);
  const request = { outboxId: id, authorize: async () => true, deliver };
  expect(await consumeOutbox(database, context, request)).toBe(true);
  expect(await consumeOutbox(database, context, request)).toBe(false);
  await withTenant(database, context, async (tx) => {
    expect(
      (await tx.execute(sql`SELECT id FROM notifications`)).rows,
    ).toHaveLength(1);
    expect(
      (await tx.execute(sql`SELECT id FROM notification_outbox`)).rows,
    ).toHaveLength(1);
    expect(
      (await tx.execute(sql`SELECT id FROM delivery_attempts`)).rows,
    ).toHaveLength(3);
  });
  await withTenant(database, ctx(otherTenantId), async (tx) => {
    expect(
      (await tx.execute(sql`SELECT id FROM notifications`)).rows,
    ).toHaveLength(0);
    expect(
      (await tx.execute(sql`SELECT id FROM notification_outbox`)).rows,
    ).toHaveLength(0);
    expect(
      (await tx.execute(sql`SELECT id FROM delivery_attempts`)).rows,
    ).toHaveLength(0);
  });
});
