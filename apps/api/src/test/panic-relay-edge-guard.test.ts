// Panic relay on the edge (bead legend-m47qh, follow-up of legend-bod).
//
// (a) The edge route split lets the panic relay through and nothing next to
//     it: the staff WebSocket upgrade /api/outlets/:id/panic/realtime and the
//     HTTP routes under /api/edge/panic, while the notification stream and
//     sibling paths stay cloud only. The cloud (edgeMode false) is unchanged.
// (b) Dead sockets: a staff phone that left the Wi-Fi never sends a close
//     frame. A client that never answers a ping is terminated and leaves the
//     hub; a client that answers keeps receiving frames.
//
// Assumptions where the brief is silent:
//  - The HTTP half is asserted through edgeRouteRefusal / edgeRouteGuard
//    (null / 200 = served, CLOUD_ONLY_ROUTE = refused), not through the
//    panic handlers, which panic-relay.test.ts covers.
//  - The ack path is POST /api/edge/panic/alerts/:alertId/ack and the list
//    path is GET /api/edge/panic/alerts (as in panic-relay.test.ts).
//  - Dead socket timing uses the injectable `pingIntervalMs` option with
//    waitFor on conditions, never a fixed sleep.
import { createServer, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import express from "express";
import request from "supertest";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tenantIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { PANIC_REALTIME_PROTOCOL } from "@starter/shared/facility";
import {
  classifyApiPath,
  edgeRouteGuard,
  edgeRouteRefusal,
  guardEdgeUpgrades,
} from "../edge/mode.ts";
import { publish, subscribe } from "../services/panic-relay-hub.ts";
import { attachPanicRealtime } from "../services/panic-relay-realtime.ts";
import { WEB_ORIGIN } from "./helpers.ts";
import { seededOutletA, seededTenantId } from "./floor-test-helpers.ts";

const OUTLET = "0b7c3a52-5f1e-4c47-9a0e-2a4c8f3d9e11";
const ALERT = "5d1f2c9e-7a34-4b8e-9c61-3e0a4f7b2d58";

const UPGRADE_HEADERS = {
  Connection: "Upgrade",
  Upgrade: "websocket",
  "Sec-WebSocket-Version": "13",
  "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
};

const servers: Server[] = [];
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

/** Sends a raw upgrade request line (no client-side URL normalisation). */
async function rawStatus(server: Server, target: string): Promise<number> {
  const port = (server.address() as AddressInfo).port;
  return new Promise<number>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      const lines = [
        `GET ${target} HTTP/1.1`,
        "Host: edge.test",
        ...Object.entries(UPGRADE_HEADERS).map(
          ([name, value]) => `${name}: ${value}`,
        ),
        "",
        "",
      ];
      socket.write(lines.join("\r\n"));
    });
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      data += chunk;
      const match = /^HTTP\/1\.1 (\d{3})/.exec(data);
      if (match) {
        resolve(Number(match[1]));
        socket.destroy();
      }
    });
    socket.on("error", reject);
    socket.on("close", () => resolve(0));
  });
}

function edgeApp(edgeMode: boolean) {
  const server = express();
  server.use(edgeRouteGuard({ edgeMode }));
  server.use((_req, res) => {
    res.json({ ok: true });
  });
  server.use(
    (
      error: { status?: number; code?: string },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      void _next;
      res.status(error.status ?? 500).json({ code: error.code });
    },
  );
  return server;
}

describe("legend-m47qh the edge serves the panic relay and nothing next to it", () => {
  async function upgradeServer(edgeMode: boolean) {
    const server = createServer((_req, res) => res.end());
    const reached: string[] = [];
    // Accepts every upgrade that reaches it, so a 101 means "the guard let it
    // through" and 404 means "the guard refused before this listener".
    const { WebSocketServer } = await import("ws");
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
      reached.push(req.url ?? "");
      wss.handleUpgrade(req, socket, head, (ws) => ws.close());
    });
    guardEdgeUpgrades(server, { edgeMode });
    await listen(server);
    cleanups.push(() => new Promise<void>((done) => wss.close(() => done())));
    return { server, reached };
  }

  it("the edge lets the panic realtime upgrade through and still refuses the notification stream", async () => {
    const { server, reached } = await upgradeServer(true);
    const panicPath = `/api/outlets/${OUTLET}/panic/realtime`;
    expect(await rawStatus(server, panicPath)).toBe(101);
    expect(await rawStatus(server, `${panicPath}?x=1`)).toBe(101);
    expect(reached).toEqual([panicPath, `${panicPath}?x=1`]);

    expect(await rawStatus(server, "/api/notifications/realtime")).toBe(404);
    expect(reached).toHaveLength(2);
  });

  it("the edge refuses siblings of the panic realtime path", async () => {
    const { server, reached } = await upgradeServer(true);
    for (const target of [
      `/api/outlets/${OUTLET}/panic/other`,
      `/api/outlets/${OUTLET}/panic`,
      `/api/outlets/${OUTLET}/panic/realtime/extra`,
      `/api/outlets/${OUTLET}/panicx/realtime`,
      `/api/outlets/${OUTLET}/reservations/realtime`,
      "/api/outlets/panic/realtime",
      `/api/outlets/${OUTLET.toUpperCase()}/panic/realtime`,
      `/api/outlets/${OUTLET}/panic/realtime/../other`,
      `/api/outlets/${OUTLET}/panic/%2e%2e/realtime`,
    ])
      expect(await rawStatus(server, target), target).not.toBe(101);
    expect(reached).toEqual([]);
  });

  it("the cloud is unchanged: it still hands the panic upgrade to the listener", async () => {
    const { server, reached } = await upgradeServer(false);
    const panicPath = `/api/outlets/${OUTLET}/panic/realtime`;
    expect(await rawStatus(server, panicPath)).toBe(101);
    expect(reached).toEqual([panicPath]);
  });

  it("the edge serves the panic ingest, acknowledge and list routes", () => {
    for (const [method, path] of [
      ["POST", "/api/edge/panic/events"],
      ["POST", `/api/edge/panic/alerts/${ALERT}/ack`],
      ["GET", "/api/edge/panic/alerts"],
      ["GET", "/api/edge/panic/alerts?limit=20"],
    ] as const) {
      // /api/edge/* is edge only (classified "edge_only"), served on the edge.
      expect(classifyApiPath(path, method), `${method} ${path}`).toBe(
        "edge_only",
      );
      expect(
        edgeRouteRefusal(path, { edgeMode: true, method }),
        `${method} ${path}`,
      ).toBeNull();
    }
  });

  it("the edge HTTP guard lets the panic routes reach the handlers and refuses siblings", async () => {
    const edge = edgeApp(true);
    for (const path of [
      "/api/edge/panic/events",
      `/api/edge/panic/alerts/${ALERT}/ack`,
    ]) {
      const res = await request(edge).post(path);
      expect(res.status, path).toBe(200);
    }
    expect((await request(edge).get("/api/edge/panic/alerts")).status).toBe(
      200,
    );

    for (const path of [
      `/api/outlets/${OUTLET}/panic/other`,
      `/api/outlets/${OUTLET}/panicx`,
      `/api/outlets/${OUTLET}/reservations`,
      "/api/notifications/realtime",
    ]) {
      const res = await request(edge).get(path);
      expect(res.status, path).toBe(404);
      expect(res.body.code, path).toBe("CLOUD_ONLY_ROUTE");
    }
  });

  it("the cloud is unchanged: it serves no edge-only panic route and everything else as before", () => {
    // Assumption: as for every /api/edge route, the cloud answers
    // EDGE_ONLY_ROUTE (see "the cloud app does not serve the edge ingest route").
    for (const path of [
      "/api/edge/panic/events",
      `/api/edge/panic/alerts/${ALERT}/ack`,
    ])
      expect(
        edgeRouteRefusal(path, { edgeMode: false, method: "POST" }),
        path,
      ).toEqual(expect.objectContaining({ code: "EDGE_ONLY_ROUTE" }));
    for (const path of [
      `/api/outlets/${OUTLET}/panic/other`,
      "/api/notifications/realtime",
    ])
      expect(
        edgeRouteRefusal(path, { edgeMode: false, method: "POST" }),
        path,
      ).toBeNull();
  });
});

// ---- dead sockets ---------------------------------------------------------

const scopedContext = () =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(seededTenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );

describe("legend-m47qh a staff socket that never answers a ping is dropped", () => {
  const PING_MS = 200;
  const key = { tenantId: seededTenantId, outletId: seededOutletA };

  /** The session resolver is this test's port: the user is a header value. */
  async function startRelay() {
    const server = createServer((_req, res) => res.end());
    const relay = attachPanicRealtime(server, {
      trustedOrigins: [WEB_ORIGIN],
      pingIntervalMs: PING_MS,
      resolveConnection: async (req) => {
        const userId = req.headers["x-test-user"];
        return typeof userId === "string"
          ? { userId, context: scopedContext() }
          : null;
      },
    });
    await listen(server);
    cleanups.push(() => relay.close());
    const port = (server.address() as AddressInfo).port;

    async function open(userId: string, autoPong: boolean) {
      const frames: Array<{ type?: string }> = [];
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/api/outlets/${seededOutletA}/panic/realtime`,
        PANIC_REALTIME_PROTOCOL,
        {
          headers: { Origin: WEB_ORIGIN, "x-test-user": userId },
          autoPong,
        },
      );
      ws.on("message", (data) => frames.push(JSON.parse(String(data))));
      const closed = new Promise<number>((resolve) =>
        ws.on("close", (code) => resolve(code)),
      );
      cleanups.push(() => ws.terminate());
      await vi.waitFor(
        () => expect(frames.map((f) => f.type)).toContain("hello"),
        {
          timeout: 5000,
        },
      );
      return { ws, frames, closed };
    }
    return { open };
  }

  it("terminates the silent client, drops it from the hub, and keeps feeding the live one", async () => {
    const { open } = await startRelay();
    const dead = await open("user-dead", false);
    const live = await open("user-live", true);

    // Both are subscribed while they are fresh.
    expect(
      publish(key, { type: "panic", n: 0 }, { userIds: ["user-dead"] }),
    ).toBe(1);
    expect(
      publish(key, { type: "panic", n: 0 }, { userIds: ["user-live"] }),
    ).toBe(1);

    // The silent socket is cut by the server (abnormal close, no close frame).
    expect(await dead.closed).toBe(1006);
    await vi.waitFor(
      () =>
        expect(
          publish(key, { type: "panic", n: 1 }, { userIds: ["user-dead"] }),
        ).toBe(0),
      { timeout: 5000 },
    );

    // The live socket survived several ping rounds and still gets frames.
    await new Promise<void>((resolve) => setTimeout(resolve, PING_MS * 3));
    expect(live.ws.readyState).toBe(WebSocket.OPEN);
    expect(
      publish(key, { type: "panic", n: 2 }, { userIds: ["user-live"] }),
    ).toBe(1);
    await vi.waitFor(
      () =>
        expect(live.frames.filter((f) => f.type === "panic")).toHaveLength(2),
      { timeout: 5000 },
    );
    expect(dead.frames.filter((f) => f.type === "panic")).toHaveLength(1);
  });

  it("a hub subscriber outside the relay is not affected by the heartbeat", async () => {
    const { open } = await startRelay();
    const send = vi.fn();
    cleanups.push(subscribe(key, send, "user-other"));
    const dead = await open("user-dead", false);
    expect(await dead.closed).toBe(1006);
    expect(publish(key, { type: "panic" }, { userIds: ["user-other"] })).toBe(
      1,
    );
    expect(send).toHaveBeenCalledOnce();
  });
});
