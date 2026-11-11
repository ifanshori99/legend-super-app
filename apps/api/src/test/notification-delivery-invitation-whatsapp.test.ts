// legend-fy5y architect F3: the WhatsApp last-resort fallback must not count an
// unverified invitation address as a free channel. The fallback reachability
// clears hasUnverifiedEmail together with hasVerifiedEmail.
import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { createUlid, ulidToUuid } from "@starter/shared/core";
import {
  establishTenantContext,
  establishScopedTenantContext,
} from "@starter/shared/core/server";
import {
  cafeLegendNotificationFixtures,
  notificationPolicySchema,
  notificationPreferenceSchema,
} from "@starter/shared/notification";
import { FakeEmailProvider, FakePushProvider } from "@starter/shared/adapters";
import * as schema from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { deliverNotificationAttempt } from "../services/notification-delivery.ts";
import { seedTenantOutlets } from "./floor-test-helpers";

const pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
const db = drizzle(pool, { schema });
const tenant = randomUUID();
const context = establishScopedTenantContext(
  establishTenantContext({ tenantId: tenant, brandId: null, source: "job" }),
  { kind: "tenant" },
);
const whatsapp = {
  sent: [] as string[],
  async send(_context: unknown, request: { reference: string }) {
    this.sent.push(request.reference);
    return { reference: request.reference, accepted: true };
  },
};
const push = new FakePushProvider();
const email = new FakeEmailProvider();

afterAll(async () => {
  await pool.end();
});

it("legend-fy5y F3 WhatsApp fallback ignores an unverified invitation email", async () => {
  const outletId = (await seedTenantOutlets(tenant))[0];
  const notificationId = createUlid();
  const attemptId = createUlid();
  await withTenant(db, context, async (tx) => {
    await tx.insert(schema.notifications).values({
      tenantId: tenant,
      id: ulidToUuid(notificationId),
      outletId,
      userId: randomUUID(),
      category: "tenant_invitation" as "order_ready",
      title: "Undangan",
      body: "Undangan admin",
      link: null,
      dedupeKey: notificationId,
    });
    await tx.insert(schema.deliveryAttempts).values({
      tenantId: tenant,
      id: ulidToUuid(attemptId),
      notificationId: ulidToUuid(notificationId),
      outletId,
      channel: "whatsapp",
      idempotencyKey: `${attemptId}:whatsapp`,
      nextAttemptAt: new Date(0),
    });
  });
  const resolve = async (_ctx: unknown, notification: { userId: string }) => ({
    policy: notificationPolicySchema.parse({
      ...cafeLegendNotificationFixtures.policy,
      tenantId: tenant,
      webPushEnabled: true,
      emailEnabled: true,
      whatsapp: {
        enabled: true,
        allowedCategories: ["tenant_invitation"],
        monthlyCap: 5,
        costPerMessageIdr: 1,
      },
    }),
    preference: notificationPreferenceSchema.parse({
      tenantId: tenant,
      userId: notification.userId,
      categories: {
        tenant_invitation: { web_push: false, email: true, whatsapp: true },
      },
      quietHours: null,
      timeZone: "Asia/Jakarta",
      updatedAt: "2026-11-01T02:00:00.000Z",
    }),
    reachability: {
      hasPushSubscription: false,
      hasVerifiedEmail: false,
      hasUnverifiedEmail: true,
      whatsappOptIn: true,
    },
    defaultTimeZone: "Asia/Jakarta",
    email: "admin@example.com",
    pushEndpoint: null,
    whatsappNumber: "628123456789",
    whatsappTemplate: { name: "invitation_v1", variables: { name: "Admin" } },
  });
  const result = await deliverNotificationAttempt(db, context, attemptId, {
    resolve: resolve as never,
    push,
    email,
    whatsapp,
  });
  expect(result).toBe("sent");
  expect(whatsapp.sent).toHaveLength(1);
  const [row] = await withTenant(db, context, (tx) =>
    tx
      .select()
      .from(schema.deliveryAttempts)
      .where(eq(schema.deliveryAttempts.id, ulidToUuid(attemptId))),
  );
  expect(row.status).toBe("sent");
});
