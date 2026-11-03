// QR guest realtime relay (beads legend-x4qy, legend-6ohy; PRD v1.7 §3 F10
// "Menu & Keranjang": the shared cart updates live on every phone; ORD-01,
// ORD-02 order status, ORD-04 closed sessions lose access, TEN-01/TEN-02).
// The tenant resolver and the guest check are injected; the production
// defaults are `resolveGuestTenantFromHost` and `verifyGuestCredential`.

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  createUlid,
  tenantIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  attachQrOrderRealtime,
  QR_REALTIME_PROTOCOL,
} from "../services/qr-order-realtime.ts";

const ORIGIN = "http://test.local";
const tenantA = randomUUID();
const tenantB = randomUUID();
const sessionA = randomUUID();
const sessionB = randomUUID();
const tokenA = "guest-token-aaaaaaaaaaaaaaaaaaaa";
const tokenB = "guest-token-bbbbbbbbbbbbbbbbbbbb";

function contextOf(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "domain",
    }),
    { kind: "tenant" },
  );
}

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

/** The test host header names the tenant; guests: token -> (tenant, session). */
async function setup(
  options: Parameters<typeof attachQrOrderRealtime>[1] = {},
  revoked = new Set<string>(),
) {
  const server = createServer();
  servers.push(server);
  const realtime = attachQrOrderRealtime(server, {
    trustedOrigins: [ORIGIN],
    resolveTenant: async (request: IncomingMessage) => {
      const tenant = request.headers["x-test-tenant"];
      return tenant === tenantA || tenant === tenantB
        ? contextOf(tenant)
        : null;
    },
    verifyGuest: async (context, credential, sessionId) =>
      !revoked.has(credential) &&
      ((credential === tokenA &&
        sessionId === sessionA &&
        context.tenant.tenantId === tenantA) ||
        (credential === tokenB &&
          sessionId === sessionB &&
          context.tenant.tenantId === tenantA)),
    ...options,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("address");
  const connect = (
    sessionId: string,
    token: string | null,
    extra: { origin?: string; tenant?: string } = {},
  ) =>
    new WebSocket(
      `ws://127.0.0.1:${address.port}/api/table-sessions/${sessionId}/realtime`,
      token === null
        ? [QR_REALTIME_PROTOCOL]
        : [QR_REALTIME_PROTOCOL, `bearer.${token}`],
      {
        headers: {
          origin: extra.origin ?? ORIGIN,
          "x-test-tenant": extra.tenant ?? tenantA,
        },
      },
    );
  return { realtime, connect };
}

async function refused(ws: WebSocket) {
  ws.on("error", () => {});
  const [response] = (await once(ws, "unexpected-response")) as [
    unknown,
    { statusCode: number },
  ];
  ws.terminate();
  return response;
}

describe("QR guest realtime relay (legend-x4qy, legend-6ohy)", () => {
  it("ORD-01 TEN-02 denies upgrades by default, from untrusted origins and without a credential", async () => {
    // No tenant resolver wired: even a valid guest is denied.
    const unwired = await setup({ resolveTenant: undefined });
    await refused(unwired.connect(sessionA, tokenA));
    await unwired.realtime.close();

    const { realtime, connect } = await setup();
    await refused(
      connect(sessionA, tokenA, { origin: "https://evil.example" }),
    );
    await refused(connect(sessionA, null));
    // Another session's credential, and an unknown host tenant.
    await refused(connect(sessionA, tokenB));
    await refused(connect(sessionA, tokenA, { tenant: "unknown" }));
    await realtime.close();
  });

  it("ORD-01 ORD-02 relays cart and order wake-ups only to sockets of that tenant's session", async () => {
    const { realtime, connect } = await setup();
    const a = connect(sessionA, tokenA);
    const b = connect(sessionB, tokenB);
    await Promise.all([once(a, "open"), once(b, "open")]);
    // The bearer entry is never echoed back as the selected protocol.
    expect(a.protocol).toBe(QR_REALTIME_PROTOCOL);
    const bMessages: unknown[] = [];
    b.on("message", (data) => bMessages.push(JSON.parse(String(data))));

    const firstA = once(a, "message");
    // Another tenant's signal for the same session id reaches nobody.
    await realtime.dispatch({
      tenantId: tenantB,
      sessionId: sessionA,
      version: 9,
    });
    await realtime.dispatch({
      tenantId: tenantA,
      sessionId: sessionA,
      version: 3,
    });
    expect(JSON.parse(String((await firstA)[0]))).toEqual({
      type: "cart.updated",
      sessionId: sessionA,
      version: 3,
    });

    const orderId = createUlid();
    const secondA = once(a, "message");
    await realtime.dispatch({
      tenantId: tenantA,
      sessionId: sessionA,
      orderId,
      status: "sent",
    });
    expect(JSON.parse(String((await secondA)[0]))).toEqual({
      type: "order.updated",
      sessionId: sessionA,
      orderId,
      status: "sent",
    });
    // Signals carrying anything but identifiers are dropped.
    await realtime.dispatch({
      tenantId: tenantA,
      sessionId: sessionA,
      version: 4,
      totalIdr: 90_000,
    });
    expect(bMessages).toEqual([]);
    a.close();
    b.close();
    await realtime.close();
  });

  it("ORD-04 a socket whose session closed or rotated is dropped on the next signal", async () => {
    const revoked = new Set<string>();
    const { realtime, connect } = await setup({}, revoked);
    const a = connect(sessionA, tokenA);
    await once(a, "open");
    revoked.add(tokenA);
    const closed = once(a, "close");
    await realtime.dispatch({
      tenantId: tenantA,
      sessionId: sessionA,
      version: 5,
    });
    const [code] = (await closed) as [number];
    expect(code).toBe(1008);
    await realtime.close();
  });
});
