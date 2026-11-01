import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { cafeLegendNotificationFixtures } from "@starter/shared/notification";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { attachNotificationRealtime } from "../services/notification-realtime.ts";

const notice = cafeLegendNotificationFixtures.notifications[0];
const context = establishScopedTenantContext(
  establishTenantContext({
    tenantId: notice.tenantId,
    brandId: null,
    source: "session",
  }),
  { kind: "tenant" },
);
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});
async function setup(
  options: Parameters<typeof attachNotificationRealtime>[1] = {},
) {
  const server = createServer();
  servers.push(server);
  const realtime = attachNotificationRealtime(server, {
    trustedOrigins: ["http://test.local"],
    ...options,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("address");
  return {
    realtime,
    url: `ws://127.0.0.1:${address.port}/api/notifications/realtime`,
  };
}

describe("notification realtime PRD §3.15", () => {
  it("denies upgrades by default", async () => {
    const { url, realtime } = await setup();
    const ws = new WebSocket(url, { headers: { origin: "http://test.local" } });
    const [response] = await once(ws, "unexpected-response");
    expect(response).toBeDefined();
    ws.on("error", () => {});
    ws.terminate();
    await realtime.close();
  });
  it("delivers committed signals only to authorized recipient and rechecks access", async () => {
    let allowed = true;
    const { url, realtime } = await setup({
      resolveConnection: async () =>
        allowed ? { userId: notice.userId, context } : null,
      lookup: async (_context, id) => (id === notice.id ? notice : null),
    });
    const ws = new WebSocket(url, { headers: { origin: "http://test.local" } });
    await once(ws, "open");
    const received = once(ws, "message");
    await realtime.dispatch({
      tenantId: notice.tenantId,
      notificationId: notice.id,
    });
    expect(JSON.parse(String((await received)[0]))).toEqual({
      type: "notification",
      notification: notice,
    });
    allowed = false;
    const closed = once(ws, "close");
    await realtime.dispatch({
      tenantId: notice.tenantId,
      notificationId: notice.id,
    });
    await closed;
    await realtime.close();
  });
  it("rejects an untrusted origin even when the resolver grants access", async () => {
    const { url, realtime } = await setup({
      resolveConnection: async () => ({ userId: notice.userId, context }),
    });
    const ws = new WebSocket(url, {
      headers: { origin: "https://untrusted.invalid" },
    });
    const [, response] = await once(ws, "unexpected-response");
    expect(response.statusCode).toBe(403);
    ws.on("error", () => {});
    ws.terminate();
    await realtime.close();
  });
  it("does not look up notifications for another tenant", async () => {
    let lookups = 0;
    const { url, realtime } = await setup({
      resolveConnection: async () => ({ userId: notice.userId, context }),
      lookup: async () => {
        lookups++;
        return notice;
      },
    });
    const ws = new WebSocket(url, { headers: { origin: "http://test.local" } });
    await once(ws, "open");
    await realtime.dispatch({
      tenantId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      notificationId: notice.id,
    });
    expect(lookups).toBe(0);
    ws.terminate();
    await realtime.close();
  });
  it("does not deliver another recipient's notification", async () => {
    const { url, realtime } = await setup({
      resolveConnection: async () => ({ userId: "another-user", context }),
      lookup: async () => notice,
    });
    const ws = new WebSocket(url, { headers: { origin: "http://test.local" } });
    await once(ws, "open");
    let received = false;
    ws.on("message", () => {
      received = true;
    });
    await realtime.dispatch({
      tenantId: notice.tenantId,
      notificationId: notice.id,
    });
    expect(received).toBe(false);
    ws.terminate();
    await realtime.close();
  });
});

it.skipIf(!process.env.STARTER_TEST_DATABASE_URL)(
  "PRD §3.15 receives only committed PostgreSQL wakeups",
  async () => {
    const { Pool } = await import("pg");
    const { listenNotificationWakeups, NOTIFICATION_WAKE_CHANNEL } =
      await import("../services/notification-realtime.ts");
    const pool = new Pool({
      connectionString: process.env.STARTER_TEST_DATABASE_URL,
    });
    let delivered = 0;
    const stop = await listenNotificationWakeups(pool, async () => {
      delivered++;
    });
    const tx = await pool.connect();
    const signal = JSON.stringify({
      tenantId: notice.tenantId,
      notificationId: notice.id,
    });
    try {
      await tx.query("BEGIN");
      await tx.query("SELECT pg_notify($1, $2)", [
        NOTIFICATION_WAKE_CHANNEL,
        signal,
      ]);
      await tx.query("ROLLBACK");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(delivered).toBe(0);
      const observed = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Wakeup timed out")),
          3000,
        );
        const poll = setInterval(() => {
          if (delivered) {
            clearInterval(poll);
            clearTimeout(timeout);
            resolve();
          }
        }, 10);
      });
      await tx.query("BEGIN");
      await tx.query("SELECT pg_notify($1, $2)", [
        NOTIFICATION_WAKE_CHANNEL,
        signal,
      ]);
      await tx.query("COMMIT");
      await observed;
      expect(delivered).toBe(1);
    } finally {
      tx.release();
      await stop();
      await pool.end();
    }
  },
);
