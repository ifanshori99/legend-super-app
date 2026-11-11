// legend-fy5y T4-T8: first-admin invitation through the notification pipeline
// (tenant.created -> notification category tenant_invitation -> email), with
// the one-time link minted at send time and never stored in notifications.body.
//
// Written from design-invite.md; names assumed from it:
//   - createWorkerNotificationHandlers(database, env, { fetch }) wires
//     `resolveNotificationRecipients` and `notificationDelivery` (incl. the
//     `invitationLink` dependency built from env.WEB_URL).
//   - DeliveryDependencies.invitationLink?: (context, notification) =>
//     Promise<string | null>.
//   - The recipient resolver handles "tenant.created" (worker-main only routes
//     the event to it on cloud; that wiring is not exercised here).
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createUlid, ulidToUuid } from "@starter/shared/core";
import { FakeEmailProvider, FakePushProvider } from "@starter/shared/adapters";
import { eventEnvelopeSchema } from "@starter/shared/events";
import {
  defaultNotificationPolicy,
  notificationPolicySchema,
  notificationSchema,
  type NotificationCategory,
} from "@starter/shared/notification";
import * as schema from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { appendOutbox, consumeOutbox } from "../services/core-outbox.ts";
import { createNotificationConsumer } from "../services/notification-consumer.ts";
import { deliverNotificationAttempt } from "../services/notification-delivery.ts";
import { createWorkerNotificationHandlers } from "../worker/notification-adapters.ts";
import {
  owner,
  scopedContext,
  seedInvitationTenant,
  type SeededInvitation,
} from "./tenant-invitation-helpers.ts";

const appPool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
const database = drizzle(appPool, { schema });
const WEB_URL = "https://app.legend.example.test";
const env = {
  NOTIFICATION_EMAIL_PROVIDER: "brevo",
  NOTIFICATION_PUSH_PROVIDER: "disabled",
  NOTIFICATION_WHATSAPP_PROVIDER: "disabled",
  BREVO_API_KEY: "xkeysib-test-secret-value",
  NOTIFICATION_EMAIL_FROM: "noreply@example.test",
  NOTIFICATION_EMAIL_FROM_NAME: "Legend",
  WEB_URL,
};

function tenantCreatedEvent(seed: SeededInvitation) {
  return eventEnvelopeSchema.parse({
    id: createUlid(),
    tenantId: seed.tenantId,
    outletId: null,
    name: "tenant.created",
    version: 1,
    aggregateType: "tenant",
    aggregateId: createUlid(),
    sequence: 1,
    occurredAt: new Date().toISOString(),
    actor: { type: "user", id: seed.userId },
    idempotencyKey: `tenant-created-${seed.tenantId}`,
    payloadSchemaRef: "tenant.created.v1",
    payload: {
      slug: `undangan-${seed.tenantId}`,
      plan: "lengkap",
      modules: [],
      firstAdminUserId: seed.userId,
    },
  });
}

/** Appends the event and consumes it through the real consumer, like the worker. */
async function consumeTenantCreated(seed: SeededInvitation) {
  const context = scopedContext(seed.tenantId);
  const handlers = createWorkerNotificationHandlers(database, env);
  const event = tenantCreatedEvent(seed);
  const outboxId = createUlid();
  await withTenant(database, context, (tx) =>
    appendOutbox(tx, context, {
      id: outboxId,
      event,
      destination: "notification",
      direction: null,
      peerId: null,
    }),
  );
  const request = {
    outboxId,
    authorize: async () => true,
    deliver: createNotificationConsumer(
      context,
      handlers.resolveNotificationRecipients,
    ),
  };
  const first = await consumeOutbox(database, context, request);
  const replay = await consumeOutbox(database, context, request);
  return { first, replay };
}

async function notificationsOf(tenantId: string) {
  const { rows } = await owner.query<{
    id: string;
    user_id: string;
    category: string;
    title: string;
    body: string;
    link: string | null;
  }>(
    "SELECT id, user_id, category, title, body, link FROM notifications WHERE tenant_id = $1",
    [tenantId],
  );
  return rows;
}

afterAll(async () => {
  await appPool.end();
  await owner.end();
});

describe("legend-fy5y tenant.created notification", () => {
  it("T4 creates exactly one tenant_invitation notification and one email attempt for the first admin, replay included", async () => {
    const seed = await seedInvitationTenant({ assignment: "open" });
    const { first, replay } = await consumeTenantCreated(seed);
    expect(first).toBe(true);
    expect(replay).toBe(false);

    const rows = await notificationsOf(seed.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: seed.userId,
      category: "tenant_invitation",
      title: `Undangan admin ${seed.tenantName}`,
      link: null,
    });
    // No secret in the persisted row.
    expect(rows[0]!.body).not.toContain("token=");

    const { rows: attempts } = await owner.query<{
      channel: string;
      status: string;
    }>(
      `SELECT channel, status FROM delivery_attempts
        WHERE tenant_id = $1 AND notification_id = $2 AND channel = 'email'`,
      [seed.tenantId, rows[0]!.id],
    );
    expect(attempts).toEqual([{ channel: "email", status: "queued" }]);
  });

  it("T5 creates no notification when the first admin's tenant_admin assignment has ended", async () => {
    const seed = await seedInvitationTenant({ assignment: "ended" });
    await consumeTenantCreated(seed);
    expect(await notificationsOf(seed.tenantId)).toHaveLength(0);
  });

  it("T5 creates no notification when the first admin has no tenant_admin assignment at all", async () => {
    const seed = await seedInvitationTenant({ assignment: "none" });
    await consumeTenantCreated(seed);
    expect(await notificationsOf(seed.tenantId)).toHaveLength(0);
  });
});

function notificationFor(
  seed: SeededInvitation,
  category: NotificationCategory,
) {
  return notificationSchema.parse({
    id: createUlid(),
    tenantId: seed.tenantId,
    outletId: null,
    userId: seed.userId,
    category,
    title: "Judul",
    body: "Isi",
    link: null,
    readAt: null,
    createdAt: new Date().toISOString(),
    sourceEventId: null,
    dedupeKey: createUlid(),
  });
}

describe("legend-fy5y delivery-time recipient lookup", () => {
  const lookup = async (
    seed: SeededInvitation,
    category: NotificationCategory,
  ) => {
    const handlers = createWorkerNotificationHandlers(database, env);
    const result = await handlers.notificationDelivery.resolve(
      scopedContext(seed.tenantId),
      notificationFor(seed, category),
    );
    return result.email;
  };

  it("T6 hands the address of an unverified user only to tenant_invitation", async () => {
    const seed = await seedInvitationTenant({ emailVerified: false });
    expect(await lookup(seed, "security")).toBeNull();
    expect(await lookup(seed, "subscription_billing")).toBeNull();
    expect(await lookup(seed, "tenant_invitation")).toBe(seed.email);
  });

  it("T6 never hands out the reserved .invalid placeholder address", async () => {
    const seed = await seedInvitationTenant({
      email: `${randomUUID().replaceAll("-", "")}@wa.invalid`,
    });
    expect(await lookup(seed, "tenant_invitation")).toBeNull();
  });

  it("T6 never hands the address of a banned user to tenant_invitation", async () => {
    const seed = await seedInvitationTenant({ banned: true });
    expect(await lookup(seed, "tenant_invitation")).toBeNull();
  });
});

async function queueAttempt(
  seed: SeededInvitation,
  category: NotificationCategory,
) {
  const notificationId = createUlid();
  const attemptId = createUlid();
  await owner.query(
    `INSERT INTO notifications
       (tenant_id, id, outlet_id, user_id, category, title, body, link, dedupe_key)
     VALUES ($1, $2, NULL, $3, $4, $5, 'Anda diundang menjadi admin.', NULL, $6)`,
    [
      seed.tenantId,
      ulidToUuid(notificationId),
      seed.userId,
      category,
      `Undangan admin ${seed.tenantName}`,
      notificationId,
    ],
  );
  await owner.query(
    `INSERT INTO delivery_attempts
       (tenant_id, id, notification_id, outlet_id, channel, idempotency_key, next_attempt_at)
     VALUES ($1, $2, $3, NULL, 'email', $4, to_timestamp(0))`,
    [
      seed.tenantId,
      ulidToUuid(attemptId),
      ulidToUuid(notificationId),
      `${attemptId}:email`,
    ],
  );
  return { attemptId, notificationId: ulidToUuid(notificationId) };
}

describe("legend-fy5y send-time link", () => {
  it("T7 mails a WEB_URL link with the token, while the DB keeps only the digest", async () => {
    const seed = await seedInvitationTenant({ emailVerified: false });
    const { attemptId, notificationId } = await queueAttempt(
      seed,
      "tenant_invitation",
    );
    const bodies: string[] = [];
    const fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(JSON.parse(String(init?.body)).textContent));
      return new Response(JSON.stringify({ messageId: "m-inv" }), {
        status: 201,
      });
    }) as typeof globalThis.fetch;
    const handlers = createWorkerNotificationHandlers(database, env, {
      fetch,
    });
    expect(
      await deliverNotificationAttempt(
        database,
        scopedContext(seed.tenantId),
        attemptId,
        handlers.notificationDelivery,
      ),
    ).toBe("sent");

    expect(bodies).toHaveLength(1);
    const match = new RegExp(
      `${WEB_URL.replace(/[.]/g, "\\.")}/undangan#token=([A-Za-z0-9_-]{43})`,
    ).exec(bodies[0]!);
    expect(match, "provider body has the invitation link").not.toBeNull();
    const token = match![1]!;

    const { rows: notes } = await owner.query<{ body: string }>(
      "SELECT body FROM notifications WHERE tenant_id = $1 AND id = $2",
      [seed.tenantId, notificationId],
    );
    expect(notes[0]!.body).not.toContain("token=");
    expect(notes[0]!.body).not.toContain(token);

    const { rows: challenges } = await owner.query(
      "SELECT * FROM login_challenges WHERE link_user_id = $1",
      [seed.userId],
    );
    expect(challenges).toHaveLength(1);
    // Only the digest is stored, never the raw token.
    expect(JSON.stringify(challenges)).not.toContain(token);
    expect(challenges[0]).toMatchObject({
      channel: "email_magic_link",
      status: "pending",
    });
  });

  const stubDeps = (
    tenantId: string,
    category: NotificationCategory,
    extra: Record<string, unknown>,
  ) => {
    const email = new FakeEmailProvider();
    const invitation = category === "tenant_invitation";
    const policy = notificationPolicySchema.parse({
      ...defaultNotificationPolicy(tenantId, new Date()),
      emailEnabled: true,
    });
    return {
      email,
      deps: {
        push: new FakePushProvider(),
        email,
        resolve: async () => ({
          policy,
          preference: null,
          reachability: {
            hasPushSubscription: false,
            hasVerifiedEmail: !invitation,
            hasUnverifiedEmail: invitation,
            whatsappOptIn: false,
          },
          defaultTimeZone: "Asia/Jakarta",
          email: "admin@example.test",
          pushEndpoint: null,
          whatsappNumber: null,
          whatsappTemplate: null,
        }),
        ...extra,
      },
    };
  };

  it("T8 makes no provider call when invitationLink returns null (fail closed)", async () => {
    const seed = await seedInvitationTenant();
    const { attemptId } = await queueAttempt(seed, "tenant_invitation");
    const { email, deps } = stubDeps(seed.tenantId, "tenant_invitation", {
      invitationLink: vi.fn(async () => null),
    });
    const result = await deliverNotificationAttempt(
      database,
      scopedContext(seed.tenantId),
      attemptId,
      deps as never,
    );
    expect(result).not.toBe("sent");
    expect(email.sent).toHaveLength(0);
    const { rows } = await owner.query<{ status: string }>(
      "SELECT status FROM delivery_attempts WHERE id = $1",
      [ulidToUuid(attemptId)],
    );
    expect(["failed", "dead", "skipped"]).toContain(rows[0]!.status);
  });

  it("T8 makes no provider call when the invitationLink dependency is missing", async () => {
    const seed = await seedInvitationTenant();
    const { attemptId } = await queueAttempt(seed, "tenant_invitation");
    const { email, deps } = stubDeps(seed.tenantId, "tenant_invitation", {});
    expect(
      await deliverNotificationAttempt(
        database,
        scopedContext(seed.tenantId),
        attemptId,
        deps as never,
      ),
    ).not.toBe("sent");
    expect(email.sent).toHaveLength(0);
  });

  it("T8 never calls invitationLink for another category", async () => {
    const seed = await seedInvitationTenant({ emailVerified: true });
    // "security" defaults to email; "order_ready" defaults to web_push only,
    // so the email attempt would be skipped before any provider call.
    const { attemptId } = await queueAttempt(seed, "security");
    const invitationLink = vi.fn(async () => "https://x.example/undangan#t");
    const { email, deps } = stubDeps(seed.tenantId, "security", {
      invitationLink,
    });
    expect(
      await deliverNotificationAttempt(
        database,
        scopedContext(seed.tenantId),
        attemptId,
        deps as never,
      ),
    ).toBe("sent");
    expect(invitationLink).not.toHaveBeenCalled();
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]!.body).not.toContain("/undangan");
  });
});
