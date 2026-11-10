// legend-9p0k: notification domain events are written to domain_event_outbox
// (destination "cloud-sync") in the same transaction as the notification change.
//
// Assumptions (the brief leaves them open):
// - appendNotificationEvent(actorUserId = uuid) records actor {type:"user", id};
//   actorUserId = null records actor {type:"system"}.
// - With no previous preference row, "previous" quiet hours count as null, so a
//   body that sets quiet hours reports quietHoursChanged = true.
// - The order of changedCategories is not specified, so it is compared sorted.
// - Rows are filtered by destination "cloud-sync": the consumer test source row
//   uses destination "notification" in the same table and must not be counted.

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, asc, eq, sql } from "drizzle-orm";
import { createUlid, outletIdSchema, uuidToUlid } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { eventFixture } from "@starter/shared/events";
import {
  cafeLegendNotificationFixtures,
  notificationCreated,
  notificationPolicySchema,
  notificationPreferenceUpdated,
  notificationRead,
} from "@starter/shared/notification";
import * as schema from "../db/schema/index.ts";
import { domainEventOutbox } from "../db/schema/core-events.ts";
import { withTenant } from "../db/tenant.ts";
import { seedTenantOutlets } from "./floor-test-helpers";
import { appendOutbox, consumeOutbox } from "../services/core-outbox.ts";
import { createNotificationService } from "../services/notification-center.ts";
import { createNotificationConsumer } from "../services/notification-consumer.ts";
import { appendNotificationEvent } from "../services/notification-events.ts";

const pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
const database = drizzle(pool, { schema });
const scope = (tenantId: string) =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
const jobScope = (tenantId: string) =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "job" }),
    { kind: "tenant" },
  );
const service = createNotificationService(database, async () => true);
afterAll(async () => pool.end());

/** Cloud-sync outbox rows visible to the tenant (RLS applies), in stable order. */
async function syncRows(tenantId: string) {
  return withTenant(database, scope(tenantId), (tx) =>
    tx
      .select()
      .from(domainEventOutbox)
      .where(eq(domainEventOutbox.destination, "cloud-sync"))
      .orderBy(
        asc(domainEventOutbox.aggregateType),
        asc(domainEventOutbox.aggregateId),
        asc(domainEventOutbox.sequence),
        asc(domainEventOutbox.createdAt),
      ),
  );
}
const byName = (rows: Awaited<ReturnType<typeof syncRows>>, name: string) =>
  rows.filter((row) => row.event.name === name);

async function insertNotification(
  tenantId: string,
  userId: string,
  id: string,
  options: { read?: boolean; category?: string } = {},
) {
  await withTenant(database, scope(tenantId), (tx) =>
    tx.execute(
      sql`INSERT INTO notifications (tenant_id,id,user_id,category,title,body,dedupe_key,read_at) VALUES (${tenantId}::uuid,${id}::uuid,${userId}::uuid,${options.category ?? "order_ready"},'T','',${`k-${id}`},${options.read ? new Date() : null})`,
    ),
  );
}

const preferenceBody = (overrides: Record<string, unknown> = {}) => ({
  categories: {
    order_ready: { web_push: true, email: false, whatsapp: false },
    waiter_call: { web_push: true, email: false, whatsapp: false },
  },
  quietHours: { start: "22:00", end: "07:00" },
  timeZone: "Asia/Jakarta",
  ...overrides,
});

describe("notification outbox events (legend-9p0k)", () => {
  it("markRead writes exactly one valid notification.read event", async () => {
    const tenantId = randomUUID(),
      user = randomUUID(),
      id = randomUUID();
    await insertNotification(tenantId, user, id);
    expect(await syncRows(tenantId)).toHaveLength(0);

    await service.execute(scope(tenantId), user, "markRead", {
      params: { notificationId: uuidToUlid(id) },
    });

    const rows = await syncRows(tenantId);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({
      tenantId,
      destination: "cloud-sync",
      aggregateType: "notification",
      aggregateId: id,
      sequence: 1,
    });
    const event = notificationRead.envelopeSchema.parse(row.event);
    expect(event).toMatchObject({
      name: "notification.read",
      aggregateType: "notification",
      aggregateId: uuidToUlid(id),
      sequence: 1,
      payload: {
        notificationId: uuidToUlid(id),
        userId: user,
        category: "order_ready",
      },
    });
  });

  it("markRead twice writes only one read event and still returns the notification", async () => {
    const tenantId = randomUUID(),
      user = randomUUID(),
      id = randomUUID();
    await insertNotification(tenantId, user, id);
    const params = { notificationId: uuidToUlid(id) };

    await service.execute(scope(tenantId), user, "markRead", { params });
    const second = (await service.execute(scope(tenantId), user, "markRead", {
      params,
    })) as { data: { readAt: string | null } };

    expect(second.data.readAt).not.toBeNull();
    const rows = byName(await syncRows(tenantId), "notification.read");
    expect(rows).toHaveLength(1);
    expect(rows[0].sequence).toBe(1);
  });

  it("markRead on an already-read notification writes no event", async () => {
    const tenantId = randomUUID(),
      user = randomUUID(),
      id = randomUUID();
    await insertNotification(tenantId, user, id, { read: true });
    await service.execute(scope(tenantId), user, "markRead", {
      params: { notificationId: uuidToUlid(id) },
    });
    expect(await syncRows(tenantId)).toHaveLength(0);
  });

  it("markAllRead writes one read event per notification that changed", async () => {
    const tenantId = randomUUID(),
      user = randomUUID(),
      first = randomUUID(),
      second = randomUUID(),
      alreadyRead = randomUUID();
    await insertNotification(tenantId, user, first);
    await insertNotification(tenantId, user, second, {
      category: "waiter_call",
    });
    await insertNotification(tenantId, user, alreadyRead, { read: true });

    expect(
      await service.execute(scope(tenantId), user, "markAllRead", {}),
    ).toEqual({ data: { updated: 2 } });

    const rows = await syncRows(tenantId);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.aggregateId).sort()).toEqual(
      [first, second].sort(),
    );
    for (const row of rows) {
      const event = notificationRead.envelopeSchema.parse(row.event);
      expect(event.sequence).toBe(1);
      expect(event.aggregateId).toBe(uuidToUlid(row.aggregateId));
      expect(event.payload).toEqual({
        notificationId: uuidToUlid(row.aggregateId),
        userId: user,
        category: row.aggregateId === first ? "order_ready" : "waiter_call",
      });
    }

    // Nothing left to change: no further events.
    await service.execute(scope(tenantId), user, "markAllRead", {});
    expect(await syncRows(tenantId)).toHaveLength(2);
  });

  it("updatePreferences writes one valid event per call with changed categories and quiet hours", async () => {
    const tenantId = randomUUID(),
      user = randomUUID();

    await service.execute(scope(tenantId), user, "updatePreferences", {
      body: preferenceBody(),
    });
    let rows = byName(
      await syncRows(tenantId),
      "notification_preference.updated",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      aggregateType: "notification_preference",
      aggregateId: user,
      destination: "cloud-sync",
      sequence: 1,
    });
    let event = notificationPreferenceUpdated.envelopeSchema.parse(
      rows[0].event,
    );
    // No previous row: every category in the body counts as changed.
    expect([...event.payload.changedCategories].sort()).toEqual([
      "order_ready",
      "waiter_call",
    ]);
    expect(event.payload).toMatchObject({
      userId: user,
      quietHoursChanged: true,
    });

    // Identical body: still one event, but nothing changed.
    await service.execute(scope(tenantId), user, "updatePreferences", {
      body: preferenceBody(),
    });
    rows = byName(await syncRows(tenantId), "notification_preference.updated");
    expect(rows).toHaveLength(2);
    event = notificationPreferenceUpdated.envelopeSchema.parse(rows[1].event);
    expect(event.sequence).toBe(2);
    expect(event.payload).toEqual({
      userId: user,
      changedCategories: [],
      quietHoursChanged: false,
    });

    // One category flipped and quiet hours cleared.
    await service.execute(scope(tenantId), user, "updatePreferences", {
      body: preferenceBody({
        categories: {
          order_ready: { web_push: false, email: false, whatsapp: false },
          waiter_call: { web_push: true, email: false, whatsapp: false },
        },
        quietHours: null,
      }),
    });
    rows = byName(await syncRows(tenantId), "notification_preference.updated");
    expect(rows).toHaveLength(3);
    event = notificationPreferenceUpdated.envelopeSchema.parse(rows[2].event);
    expect(event.sequence).toBe(3);
    expect(event.payload).toEqual({
      userId: user,
      changedCategories: ["order_ready"],
      quietHoursChanged: true,
    });
  });

  describe("consumer", () => {
    const recipientFor = (tenantId: string, userId: string) => ({
      userId,
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
    });
    async function consumeOne(tenantId: string, userId: string) {
      const context = jobScope(tenantId);
      await withTenant(database, context, (tx) =>
        appendOutbox(tx, context, {
          id: createUlid(),
          event: {
            ...eventFixture,
            id: createUlid(),
            tenantId,
            outletId: null,
            sequence: 1,
          },
          destination: "notification",
          direction: null,
          peerId: null,
        }),
      );
      const [source] = await withTenant(database, context, (tx) =>
        tx
          .select()
          .from(domainEventOutbox)
          .where(
            and(
              eq(domainEventOutbox.tenantId, tenantId),
              eq(domainEventOutbox.destination, "notification"),
            ),
          ),
      );
      const request = {
        outboxId: uuidToUlid(source.id),
        authorize: async () => true,
        deliver: createNotificationConsumer(context, async () => [
          recipientFor(tenantId, userId),
        ]),
      };
      return { context, request };
    }

    it("writes exactly one notification.created event per new notification, and none on replay", async () => {
      const tenantId = randomUUID(),
        user = randomUUID();
      const { context, request } = await consumeOne(tenantId, user);
      expect(await syncRows(tenantId)).toHaveLength(0);

      expect(await consumeOutbox(database, context, request)).toBe(true);

      const created = await withTenant(database, context, (tx) =>
        tx.execute(sql`SELECT id FROM notifications`),
      );
      expect(created.rows).toHaveLength(1);
      const notificationUuid = String(created.rows[0].id);
      const rows = await syncRows(tenantId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        aggregateType: "notification",
        aggregateId: notificationUuid,
        destination: "cloud-sync",
        sequence: 1,
      });
      const event = notificationCreated.envelopeSchema.parse(rows[0].event);
      expect(event.name).toBe("notification.created");
      expect(event.payload).toMatchObject({
        notificationId: uuidToUlid(notificationUuid),
        userId: user,
        category: "order_ready",
      });
      expect(typeof event.payload.realtime).toBe("boolean");

      // Replay: already consumed, nothing new is written.
      expect(await consumeOutbox(database, context, request)).toBe(false);
      expect(await syncRows(tenantId)).toHaveLength(1);
    });

    it("orders created then read for the same notification as sequence 1 then 2", async () => {
      const tenantId = randomUUID(),
        user = randomUUID();
      const { context, request } = await consumeOne(tenantId, user);
      await consumeOutbox(database, context, request);
      const created = await withTenant(database, context, (tx) =>
        tx.execute(sql`SELECT id FROM notifications`),
      );
      const notificationUuid = String(created.rows[0].id);

      await service.execute(scope(tenantId), user, "markRead", {
        params: { notificationId: uuidToUlid(notificationUuid) },
      });

      const rows = await syncRows(tenantId);
      expect(rows.map((row) => [row.event.name, row.sequence])).toEqual([
        ["notification.created", 1],
        ["notification.read", 2],
      ]);
      expect(new Set(rows.map((row) => row.aggregateId))).toEqual(
        new Set([notificationUuid]),
      );
    });
  });

  describe("appendNotificationEvent", () => {
    const readPayload = (id: string, userId: string) => ({
      notificationId: uuidToUlid(id),
      userId,
      category: "order_ready" as const,
    });

    it("rolls the event back together with the data when the transaction fails", async () => {
      const tenantId = randomUUID(),
        user = randomUUID(),
        id = randomUUID();
      const context = scope(tenantId);
      await expect(
        withTenant(database, context, async (tx) => {
          await tx.execute(
            sql`INSERT INTO notifications (tenant_id,id,user_id,category,title,body,dedupe_key) VALUES (${tenantId}::uuid,${id}::uuid,${user}::uuid,'order_ready','T','','rollback')`,
          );
          await appendNotificationEvent(tx, context, notificationRead, {
            aggregateId: id,
            outletId: null,
            actorUserId: user,
            payload: readPayload(id, user),
            now: new Date(),
          });
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      expect(await syncRows(tenantId)).toHaveLength(0);
      const notifications = await withTenant(database, context, (tx) =>
        tx.execute(sql`SELECT id FROM notifications`),
      );
      expect(notifications.rows).toHaveLength(0);
    });

    it("writes one cloud-sync row per call with a valid envelope and the right actor", async () => {
      const tenantId = randomUUID(),
        user = randomUUID(),
        id = randomUUID();
      const context = scope(tenantId);
      const now = new Date("2026-11-10T03:00:00.000Z");
      await withTenant(database, context, async (tx) => {
        await appendNotificationEvent(tx, context, notificationRead, {
          aggregateId: id,
          outletId: null,
          actorUserId: user,
          payload: readPayload(id, user),
          now,
        });
      });
      await withTenant(database, context, async (tx) => {
        await appendNotificationEvent(tx, context, notificationRead, {
          aggregateId: randomUUID(),
          outletId: null,
          actorUserId: null,
          payload: readPayload(id, user),
          now,
        });
      });

      const rows = await syncRows(tenantId);
      expect(rows).toHaveLength(2);
      const events = rows.map((row) =>
        notificationRead.envelopeSchema.parse(row.event),
      );
      expect(events.map((event) => event.actor)).toEqual(
        expect.arrayContaining([
          { type: "user", id: user },
          { type: "system" },
        ]),
      );
      for (const event of events) {
        expect(event.tenantId).toBe(tenantId);
        expect(event.outletId).toBeNull();
        expect(Date.parse(event.occurredAt)).toBe(now.getTime());
      }
    });

    it("numbers events per aggregate: 1,2 for the same aggregate, 1 for a different one, never repeating", async () => {
      const tenantId = randomUUID(),
        user = randomUUID(),
        a = randomUUID(),
        b = randomUUID();
      const context = scope(tenantId);
      const append = (
        definition: typeof notificationRead | typeof notificationCreated,
        aggregateId: string,
      ) =>
        withTenant(database, context, (tx) =>
          appendNotificationEvent(tx, context, definition as never, {
            aggregateId,
            outletId: null,
            actorUserId: user,
            payload:
              definition === notificationCreated
                ? { ...readPayload(aggregateId, user), realtime: true }
                : readPayload(aggregateId, user),
            now: new Date(),
          }),
        );

      await append(notificationCreated, a);
      await append(notificationRead, a);
      await append(notificationRead, b);

      const rows = await syncRows(tenantId);
      const sequencesOf = (id: string) =>
        rows.filter((row) => row.aggregateId === id).map((row) => row.sequence);
      expect(sequencesOf(a)).toEqual([1, 2]);
      expect(sequencesOf(b)).toEqual([1]);
      expect(
        rows.find((row) => row.aggregateId === a && row.sequence === 1)?.event
          .name,
      ).toBe("notification.created");
    });

    it("numbers two preference updates of the same user 1 then 2", async () => {
      const tenantId = randomUUID(),
        user = randomUUID();
      await service.execute(scope(tenantId), user, "updatePreferences", {
        body: preferenceBody(),
      });
      await service.execute(scope(tenantId), user, "updatePreferences", {
        body: preferenceBody({ quietHours: null }),
      });
      const rows = await syncRows(tenantId);
      expect(rows.map((row) => row.sequence)).toEqual([1, 2]);
    });

    it("keeps sequences unique and gap-free when two preference updates run at once", async () => {
      const tenantId = randomUUID(),
        user = randomUUID();
      const results = await Promise.all([
        service.execute(scope(tenantId), user, "updatePreferences", {
          body: preferenceBody(),
        }),
        service.execute(scope(tenantId), user, "updatePreferences", {
          body: preferenceBody({ quietHours: null }),
        }),
      ]);
      expect(results).toHaveLength(2);
      const rows = await syncRows(tenantId);
      expect(rows.map((row) => row.sequence).sort()).toEqual([1, 2]);
    });
  });

  it("lets an outlet-scoped user save preferences and writes the tenant-wide event", async () => {
    const tenantId = randomUUID(),
      user = randomUUID();
    const [outlet] = await seedTenantOutlets(tenantId, 1);
    const restricted = establishScopedTenantContext(
      establishTenantContext({ tenantId, brandId: null, source: "session" }),
      { kind: "outlets", outletIds: [outletIdSchema.parse(outlet)] },
    );
    await service.execute(restricted, user, "updatePreferences", {
      body: preferenceBody(),
    });
    await service.execute(restricted, user, "updatePreferences", {
      body: preferenceBody({ quietHours: null }),
    });
    const rows = byName(
      await syncRows(tenantId),
      "notification_preference.updated",
    );
    expect(rows.map((row) => [row.sequence, row.outletId])).toEqual([
      [1, null],
      [2, null],
    ]);
  });

  it("markAllRead continues each aggregate's sequence in one batch (60 notifications)", async () => {
    const tenantId = randomUUID(),
      user = randomUUID();
    const ids = Array.from({ length: 60 }, () => randomUUID());
    for (const id of ids) await insertNotification(tenantId, user, id);
    // The first 20 already carry a created event (sequence 1).
    await withTenant(database, scope(tenantId), async (tx) => {
      for (const id of ids.slice(0, 20))
        await appendNotificationEvent(
          tx,
          scope(tenantId),
          notificationCreated,
          {
            aggregateId: uuidToUlid(id),
            outletId: null,
            actorUserId: null,
            payload: {
              notificationId: uuidToUlid(id),
              userId: user,
              category: "order_ready",
              realtime: false,
            },
            now: new Date(),
          },
        );
    });

    expect(
      await service.execute(scope(tenantId), user, "markAllRead", {}),
    ).toEqual({ data: { updated: 60 } });

    const reads = byName(await syncRows(tenantId), "notification.read");
    expect(reads).toHaveLength(60);
    const sequenceOf = new Map(
      reads.map((row) => [row.aggregateId, row.sequence]),
    );
    for (const [index, id] of ids.entries())
      expect(sequenceOf.get(id)).toBe(index < 20 ? 2 : 1);
  });

  it("isolates tenants: B cannot see A's events and B's sequences are independent", async () => {
    const tenantA = randomUUID(),
      tenantB = randomUUID(),
      user = randomUUID(),
      id = randomUUID();
    await insertNotification(tenantA, user, id);
    await insertNotification(tenantB, user, id);

    // Tenant A: preference events for the user get 1, 2; the read event gets 1.
    await service.execute(scope(tenantA), user, "updatePreferences", {
      body: preferenceBody(),
    });
    await service.execute(scope(tenantA), user, "updatePreferences", {
      body: preferenceBody({ quietHours: null }),
    });
    await service.execute(scope(tenantA), user, "markRead", {
      params: { notificationId: uuidToUlid(id) },
    });

    expect(await syncRows(tenantB)).toHaveLength(0);

    // Same user and same notification id in tenant B start from sequence 1.
    await service.execute(scope(tenantB), user, "updatePreferences", {
      body: preferenceBody(),
    });
    await service.execute(scope(tenantB), user, "markRead", {
      params: { notificationId: uuidToUlid(id) },
    });

    const rowsB = await syncRows(tenantB);
    expect(rowsB).toHaveLength(2);
    expect(rowsB.every((row) => row.tenantId === tenantB)).toBe(true);
    expect(rowsB.map((row) => row.sequence)).toEqual([1, 1]);
    const rowsA = await syncRows(tenantA);
    expect(rowsA).toHaveLength(3);
    expect(rowsA.every((row) => row.tenantId === tenantA)).toBe(true);
    expect(
      rowsA
        .filter((row) => row.aggregateType === "notification_preference")
        .map((row) => row.sequence),
    ).toEqual([1, 2]);
  });
});
