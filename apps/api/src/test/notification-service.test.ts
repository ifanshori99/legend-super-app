import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { outletIdSchema, uuidToUlid } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import * as schema from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { createNotificationService } from "../services/notification-center.ts";

const pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
const database = drizzle(pool, { schema });
const tenantA = randomUUID(),
  tenantB = randomUUID(),
  user = randomUUID(),
  other = randomUUID(),
  id = randomUUID();
const scope = (tenantId: string) =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
const service = createNotificationService(database, async () => true, {
  seal: async () => ({
    endpointHash: "hash",
    ciphertext: "ciphertext",
    keyVersion: "test",
  }),
});
afterAll(async () => pool.end());
describe("notification center (PRD §3.15)", () => {
  it("TEN-01 TEN-02 scopes listing and marking to the tenant and verified recipient", async () => {
    await withTenant(database, scope(tenantA), (tx) =>
      tx.execute(
        sql`INSERT INTO notifications (tenant_id,id,user_id,category,title,body,dedupe_key) VALUES (${tenantA}::uuid,${id}::uuid,${user}::uuid,'order_ready','Ready','','key')`,
      ),
    );
    expect(
      await service.execute(scope(tenantB), user, "unreadCount", {}),
    ).toEqual({ data: { unread: 0 } });
    expect(
      await service.execute(scope(tenantA), other, "unreadCount", {}),
    ).toEqual({ data: { unread: 0 } });
    expect(
      await service.execute(scope(tenantA), user, "unreadCount", {}),
    ).toEqual({ data: { unread: 1 } });
    await expect(
      service.execute(scope(tenantA), other, "markRead", {
        params: { notificationId: uuidToUlid(id) },
      }),
    ).rejects.toThrow();
    const result = (await service.execute(scope(tenantA), user, "markRead", {
      params: { notificationId: uuidToUlid(id) },
    })) as { data: { readAt: string | null } };
    expect(result.data.readAt).not.toBeNull();
    expect(
      await service.execute(scope(tenantA), user, "unreadCount", {}),
    ).toEqual({ data: { unread: 0 } });
  });
  it("PRD §3.15 stores preferences per recipient and keeps WhatsApp off by default", async () => {
    const pref = {
      categories: {
        order_ready: { web_push: true, email: false, whatsapp: false },
      },
      quietHours: { start: "22:00", end: "07:00" },
      timeZone: "Asia/Jakarta",
    };
    expect(
      (await service.execute(scope(tenantA), user, "getPolicy", {})) as object,
    ).toMatchObject({ data: { whatsapp: { enabled: false, monthlyCap: 0 } } });
    await service.execute(scope(tenantA), user, "updatePreferences", {
      body: pref,
    });
    expect(
      await service.execute(scope(tenantA), user, "getPreferences", {}),
    ).toMatchObject({ data: pref });
    expect(
      await service.execute(scope(tenantA), other, "getPreferences", {}),
    ).toMatchObject({ data: { categories: {}, quietHours: null } });
  });
  it("PRD §3.15 stores and removes push subscriptions only for their owner", async () => {
    const body = {
      endpoint: "https://push.example.com/subscription",
      keys: { p256dh: "abc", auth: "def" },
      deviceLabel: "Device",
    };
    await expect(
      createNotificationService(database, async () => true).execute(
        scope(tenantA),
        user,
        "registerPush",
        { body },
      ),
    ).rejects.toThrow();
    const result = (await service.execute(
      scope(tenantA),
      user,
      "registerPush",
      { body },
    )) as { data: { id: string } };
    await expect(
      service.execute(scope(tenantA), other, "removePush", {
        params: { subscriptionId: result.data.id },
      }),
    ).rejects.toThrow();
    await service.execute(scope(tenantA), user, "removePush", {
      params: { subscriptionId: result.data.id },
    });
  });
  it("TEN-03 restricts all notification operations to assigned outlets", async () => {
    const restrictedUser = randomUUID(),
      allowed = randomUUID(),
      blocked = randomUUID();
    const a = randomUUID(),
      b = randomUUID(),
      c = randomUUID();
    await withTenant(database, scope(tenantA), (tx) =>
      tx.execute(
        sql`INSERT INTO notifications (tenant_id,id,user_id,outlet_id,category,title,body,dedupe_key) VALUES (${tenantA}::uuid,${a}::uuid,${restrictedUser}::uuid,${allowed}::uuid,'order_ready','A','','oa'), (${tenantA}::uuid,${b}::uuid,${restrictedUser}::uuid,${blocked}::uuid,'order_ready','B','','ob'), (${tenantA}::uuid,${c}::uuid,${restrictedUser}::uuid,NULL,'order_ready','C','','oc')`,
      ),
    );
    const restricted = establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantA,
        brandId: null,
        source: "session",
      }),
      { kind: "outlets", outletIds: [outletIdSchema.parse(allowed)] },
    );
    expect(
      await service.execute(restricted, restrictedUser, "unreadCount", {}),
    ).toEqual({ data: { unread: 1 } });
    expect(
      (await service.execute(restricted, restrictedUser, "list", {
        query: { limit: 25 },
      })) as object,
    ).toMatchObject({ data: [{ title: "A" }] });
    await expect(
      service.execute(restricted, restrictedUser, "markRead", {
        params: { notificationId: uuidToUlid(b) },
      }),
    ).rejects.toThrow();
    expect(
      await service.execute(restricted, restrictedUser, "markAllRead", {}),
    ).toEqual({ data: { updated: 1 } });
    expect(
      await service.execute(scope(tenantA), restrictedUser, "unreadCount", {}),
    ).toEqual({ data: { unread: 2 } });
  });
});
