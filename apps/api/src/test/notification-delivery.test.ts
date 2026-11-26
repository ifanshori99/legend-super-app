import { randomUUID } from "node:crypto";
import { afterAll, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";
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
import { logger } from "../lib/logger.ts";

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
    if (!this.sent.includes(request.reference))
      this.sent.push(request.reference);
    return { reference: request.reference, accepted: true };
  },
};
const push = new FakePushProvider();
const email = new FakeEmailProvider();
const policy = notificationPolicySchema.parse({
  ...cafeLegendNotificationFixtures.policy,
  tenantId: tenant,
  webPushEnabled: true,
  emailEnabled: true,
});
let seededOutlet: string | undefined;
async function whatsappOutlet() {
  seededOutlet ??= (await seedTenantOutlets(tenant))[0];
  return seededOutlet;
}
async function makeAttempt(
  channel: "email" | "web_push" | "whatsapp",
  category = "order_ready",
) {
  const outletId = channel === "whatsapp" ? await whatsappOutlet() : null;
  const notificationId = createUlid();
  const attemptId = createUlid();
  await withTenant(db, context, async (tx) => {
    await tx.insert(schema.notifications).values({
      tenantId: tenant,
      id: ulidToUuid(notificationId),
      outletId,
      userId: randomUUID(),
      category: category as "order_ready",
      title: "Ready",
      body: "Order ready",
      link: null,
      dedupeKey: notificationId,
    });
    await tx.insert(schema.deliveryAttempts).values({
      tenantId: tenant,
      id: ulidToUuid(attemptId),
      notificationId: ulidToUuid(notificationId),
      outletId,
      channel,
      idempotencyKey: `${attemptId}:${channel}`,
      nextAttemptAt: new Date(0),
    });
  });
  return attemptId;
}
const resolve = async (
  _context: unknown,
  notification: { userId: string },
) => ({
  policy,
  preference: notificationPreferenceSchema.parse({
    tenantId: tenant,
    userId: notification.userId,
    categories: {
      order_ready: { web_push: true, email: true, whatsapp: false },
    },
    quietHours: null,
    timeZone: "Asia/Jakarta",
    updatedAt: "2026-11-01T02:00:00.000Z",
  }),
  reachability: {
    hasPushSubscription: true,
    hasVerifiedEmail: true,
    whatsappOptIn: false,
  },
  defaultTimeZone: "Asia/Jakarta",
  email: "staff@example.com",
  pushEndpoint: "https://push.example.com/send/1",
  whatsappNumber: "628123456789",
  whatsappTemplate: { name: "order_ready_v1", variables: { order: "A-01" } },
});
afterAll(async () => {
  await pool.end();
});
it("PRD §3.15 delivers with durable status and idempotently skips replay", async () => {
  const attemptId = await makeAttempt("email");
  expect(
    await deliverNotificationAttempt(db, context, attemptId, {
      resolve,
      push,
      email,
    }),
  ).toBe("sent");
  expect(
    await deliverNotificationAttempt(db, context, attemptId, {
      resolve,
      push,
      email,
    }),
  ).toBe("not_due");
  expect(email.sent).toHaveLength(1);
  const rows = await withTenant(db, context, (tx) =>
    tx
      .select()
      .from(schema.deliveryAttempts)
      .where(eq(schema.deliveryAttempts.id, ulidToUuid(attemptId))),
  );
  expect(rows[0].status).toBe("sent");
  expect(rows[0].attempts).toBe(1);
});
it("legend-18qw logs a provider failure with channel and status only, never the body or address", async () => {
  const attemptId = await makeAttempt("email");
  const failing = {
    async send() {
      throw new Error("Brevo email request failed with status 401");
    },
  };
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
  try {
    await deliverNotificationAttempt(db, context, attemptId, {
      resolve,
      push,
      email: failing as unknown as typeof email,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toEqual({
      deliveryAttemptId: ulidToUuid(attemptId),
      channel: "email",
      providerStatus: 401,
      errorType: "Error",
    });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain("staff@example.com");
    expect(logged).not.toContain("Order ready");
    expect(logged).not.toContain(`${attemptId}:email`);
  } finally {
    warn.mockRestore();
  }
});
it("PRD §3.15 prevents cross-tenant attempt access", async () => {
  const attemptId = await makeAttempt("web_push");
  const other = establishScopedTenantContext(
    establishTenantContext({
      tenantId: randomUUID(),
      brandId: null,
      source: "job",
    }),
    { kind: "tenant" },
  );
  expect(
    await deliverNotificationAttempt(db, other, attemptId, {
      resolve,
      push,
      email,
    }),
  ).toBe("not_due");
  expect(push.sent).toHaveLength(0);
});

it("PRD §3.15 AUTH-03 serializes WhatsApp monthly cap across concurrent sends", async () => {
  const one = await makeAttempt("whatsapp");
  const two = await makeAttempt("whatsapp");
  const resolveWhatsapp = async (
    ctx: unknown,
    notification: { userId: string },
  ) => {
    const base = await resolve(ctx, notification);
    return {
      ...base,
      policy: notificationPolicySchema.parse({
        ...base.policy,
        whatsapp: {
          enabled: true,
          allowedCategories: ["order_ready"],
          monthlyCap: 1,
          costPerMessageIdr: 1,
        },
      }),
      preference: notificationPreferenceSchema.parse({
        ...base.preference,
        categories: {
          order_ready: { web_push: false, email: false, whatsapp: true },
        },
      }),
      reachability: {
        hasPushSubscription: false,
        hasVerifiedEmail: false,
        whatsappOptIn: true,
      },
    };
  };
  const results = await Promise.all(
    [one, two].map((id) =>
      deliverNotificationAttempt(db, context, id, {
        resolve: resolveWhatsapp,
        push,
        email,
        whatsapp,
      }),
    ),
  );
  expect(results.filter((r) => r === "sent")).toHaveLength(1);
  expect(whatsapp.sent).toHaveLength(1);
});
it("legend-wasr7.14 a certain WhatsApp failure (invalid_template, no_sender) ends dead without retry and frees the quota slot", async () => {
  const resolveWhatsapp = async (
    ctx: unknown,
    notification: { userId: string },
  ) => {
    const base = await resolve(ctx, notification);
    return {
      ...base,
      policy: notificationPolicySchema.parse({
        ...base.policy,
        whatsapp: {
          enabled: true,
          allowedCategories: ["order_ready"],
          monthlyCap: 10,
          costPerMessageIdr: 1,
        },
      }),
      preference: notificationPreferenceSchema.parse({
        ...base.preference,
        categories: {
          order_ready: { web_push: false, email: false, whatsapp: true },
        },
      }),
      reachability: {
        hasPushSubscription: false,
        hasVerifiedEmail: false,
        whatsappOptIn: true,
      },
    };
  };
  for (const code of ["invalid_template", "no_sender"]) {
    const attemptId = await makeAttempt("whatsapp");
    const failing = {
      async send() {
        throw Object.assign(new Error(`Kirimdev send failed: code=${code}`), {
          name: "KirimdevSendError",
          code,
          retryable: false,
        });
      },
    };
    expect(
      await deliverNotificationAttempt(db, context, attemptId, {
        resolve: resolveWhatsapp,
        push,
        email,
        whatsapp: failing,
      }),
    ).toBe("failed");
    const rows = await withTenant(db, context, async (tx) => {
      const attempt = await tx.execute(
        sql`SELECT status, next_attempt_at FROM delivery_attempts WHERE tenant_id = ${tenant}::uuid AND id = ${ulidToUuid(attemptId)}::uuid`,
      );
      const reservation = await tx.execute(
        sql`SELECT status FROM whatsapp_reservations WHERE tenant_id = ${tenant}::uuid AND delivery_attempt_id = ${ulidToUuid(attemptId)}::uuid`,
      );
      return { attempt: attempt.rows[0], reservation: reservation.rows[0] };
    });
    expect(rows.attempt).toMatchObject({
      status: "dead",
      next_attempt_at: null,
    });
    expect(rows.reservation).toMatchObject({ status: "released" });
  }
});
it("PRD §3.15 waits for free channels before reconsidering last-resort WhatsApp", async () => {
  const attemptId = await makeAttempt("whatsapp");
  await withTenant(db, context, async (tx) => {
    const [attempt] = await tx
      .select()
      .from(schema.deliveryAttempts)
      .where(eq(schema.deliveryAttempts.id, ulidToUuid(attemptId)));
    await tx
      .update(schema.deliveryAttempts)
      .set({
        status: "skipped",
        skipReason: "free_channel_available",
        nextAttemptAt: null,
      })
      .where(eq(schema.deliveryAttempts.id, attempt.id));
    await tx.insert(schema.deliveryAttempts).values({
      tenantId: tenant,
      outletId: attempt.outletId,
      id: ulidToUuid(createUlid()),
      notificationId: attempt.notificationId,
      channel: "web_push",
      status: "queued",
      idempotencyKey: `${attemptId}:free`,
    });
  });
  const resolveWhatsapp = async (
    ctx: unknown,
    notification: { userId: string },
  ) => {
    const base = await resolve(ctx, notification);
    return {
      ...base,
      policy: notificationPolicySchema.parse({
        ...base.policy,
        whatsapp: {
          enabled: true,
          allowedCategories: ["order_ready"],
          monthlyCap: 10,
          costPerMessageIdr: 1,
        },
      }),
      preference: notificationPreferenceSchema.parse({
        ...base.preference,
        categories: {
          order_ready: { web_push: true, email: false, whatsapp: true },
        },
      }),
      reachability: {
        hasPushSubscription: true,
        hasVerifiedEmail: false,
        whatsappOptIn: true,
      },
    };
  };
  expect(
    await deliverNotificationAttempt(db, context, attemptId, {
      resolve: resolveWhatsapp,
      push,
      email,
      whatsapp,
    }),
  ).toBe("not_due");
  await withTenant(db, context, async (tx) => {
    const [attempt] = await tx
      .select()
      .from(schema.deliveryAttempts)
      .where(eq(schema.deliveryAttempts.id, ulidToUuid(attemptId)));
    await tx.execute(
      sql`UPDATE delivery_attempts SET status = 'dead' WHERE tenant_id = ${tenant}::uuid AND notification_id = ${attempt.notificationId}::uuid AND channel = 'web_push'`,
    );
  });
  expect(
    await deliverNotificationAttempt(db, context, attemptId, {
      resolve: resolveWhatsapp,
      push,
      email,
      whatsapp,
    }),
  ).toBe("sent");
});
it("AUTH-03 monthly cap uses UTC consistently across recipient time zones", async () => {
  const one = await makeAttempt("whatsapp");
  const two = await makeAttempt("whatsapp");
  const when = new Date("2025-01-31T20:00:00Z");
  const zoneResolver =
    (zone: string) =>
    async (ctx: unknown, notification: { userId: string }) => {
      const base = await resolve(ctx, notification);
      return {
        ...base,
        defaultTimeZone: zone,
        policy: notificationPolicySchema.parse({
          ...base.policy,
          whatsapp: {
            enabled: true,
            allowedCategories: ["order_ready"],
            monthlyCap: 1,
            costPerMessageIdr: 1,
          },
        }),
        preference: notificationPreferenceSchema.parse({
          ...base.preference,
          categories: {
            order_ready: { web_push: false, email: false, whatsapp: true },
          },
        }),
        reachability: {
          hasPushSubscription: false,
          hasVerifiedEmail: false,
          whatsappOptIn: true,
        },
      };
    };
  const results = await Promise.all([
    deliverNotificationAttempt(
      db,
      context,
      one,
      { resolve: zoneResolver("Asia/Jakarta"), push, email, whatsapp },
      when,
    ),
    deliverNotificationAttempt(
      db,
      context,
      two,
      { resolve: zoneResolver("UTC"), push, email, whatsapp },
      when,
    ),
  ]);
  expect(results.filter((result) => result === "sent")).toHaveLength(1);
});

it("AUTH-03 releases the monthly WhatsApp slot when the provider declines for good", async () => {
  const declined = await makeAttempt("whatsapp");
  const next = await makeAttempt("whatsapp");
  const when = new Date("2024-03-15T03:00:00Z");
  const resolveOnce = async (
    ctx: unknown,
    notification: { userId: string },
  ) => {
    const base = await resolve(ctx, notification);
    return {
      ...base,
      policy: notificationPolicySchema.parse({
        ...base.policy,
        maxAttempts: 1,
        whatsapp: {
          enabled: true,
          allowedCategories: ["order_ready"],
          monthlyCap: 1,
          costPerMessageIdr: 1,
        },
      }),
      preference: notificationPreferenceSchema.parse({
        ...base.preference,
        categories: {
          order_ready: { web_push: false, email: false, whatsapp: true },
        },
      }),
      reachability: {
        hasPushSubscription: false,
        hasVerifiedEmail: false,
        whatsappOptIn: true,
      },
    };
  };
  const decline = {
    async send(_context: unknown, request: { reference: string }) {
      return { reference: request.reference, accepted: false };
    },
  };
  expect(
    await deliverNotificationAttempt(
      db,
      context,
      declined,
      { resolve: resolveOnce, push, email, whatsapp: decline },
      when,
    ),
  ).toBe("failed");
  const reservation = await withTenant(db, context, (tx) =>
    tx.execute(
      sql`SELECT status FROM whatsapp_reservations WHERE tenant_id = ${tenant}::uuid AND delivery_attempt_id = ${ulidToUuid(declined)}::uuid`,
    ),
  );
  expect(reservation.rows[0]?.status).toBe("released");
  expect(
    await deliverNotificationAttempt(
      db,
      context,
      next,
      { resolve: resolveOnce, push, email, whatsapp },
      when,
    ),
  ).toBe("sent");
});

// legend-307w3: security email ignores the tenant switch and the user's email
// opt-out; any other category keeps both. Every other input is held equal.
const emailOff = (
  category: string,
  over: { tenantOff: boolean; userOptOut: boolean },
) =>
  async function resolveEmailOff(
    ctx: unknown,
    notification: { userId: string },
  ) {
    const base = await resolve(ctx, notification);
    return {
      ...base,
      policy: notificationPolicySchema.parse({
        ...base.policy,
        emailEnabled: !over.tenantOff,
      }),
      preference: notificationPreferenceSchema.parse({
        ...base.preference,
        categories: {
          [category]: {
            web_push: false,
            email: !over.userOptOut,
            whatsapp: false,
          },
        },
      }),
    };
  };
async function emailAttemptState(attemptId: string) {
  const rows = await withTenant(db, context, (tx) =>
    tx
      .select()
      .from(schema.deliveryAttempts)
      .where(eq(schema.deliveryAttempts.id, ulidToUuid(attemptId))),
  );
  return rows[0];
}
it("legend-307w3 sends a security email even when the tenant disabled email and the user opted out", async () => {
  const provider = new FakeEmailProvider();
  const attemptId = await makeAttempt("email", "security");
  expect(
    await deliverNotificationAttempt(db, context, attemptId, {
      resolve: emailOff("security", { tenantOff: true, userOptOut: true }),
      push,
      email: provider,
    }),
  ).toBe("sent");
  expect(provider.sent).toHaveLength(1);
  const row = await emailAttemptState(attemptId);
  expect(row.status).toBe("sent");
  expect(row.skipReason).toBeNull();
});
it("legend-307w3 still skips a non-security email when the tenant disabled email or the user opted out", async () => {
  const provider = new FakeEmailProvider();
  const tenantOff = await makeAttempt("email", "order_ready");
  expect(
    await deliverNotificationAttempt(db, context, tenantOff, {
      resolve: emailOff("order_ready", { tenantOff: true, userOptOut: true }),
      push,
      email: provider,
    }),
  ).toBe("skipped");
  expect((await emailAttemptState(tenantOff)).skipReason).toBe(
    "policy_disabled",
  );
  const userOff = await makeAttempt("email", "order_ready");
  expect(
    await deliverNotificationAttempt(db, context, userOff, {
      resolve: emailOff("order_ready", { tenantOff: false, userOptOut: true }),
      push,
      email: provider,
    }),
  ).toBe("skipped");
  expect((await emailAttemptState(userOff)).skipReason).toBe("opted_out");
  expect(provider.sent).toHaveLength(0);
});
