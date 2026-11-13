// Edge allowlist for the emergency button (design docs/design/edge-emergency.md
// D-11, EM-20). Ported from the draft panic-relay-edge-guard.test.ts onto the
// new paths. The edge serves press, receiver sessions, acknowledge on the edge
// and the socket upgrade, and nothing next to them; the manager list and
// resolve are cloud only. The cloud (edgeMode false) serves everything.
//
// ASSUMPTIONS:
//  - Served = edgeRouteRefusal returns null; refused = an object with code
//    CLOUD_ONLY_ROUTE (status 404), as for every other cloud-only route, or
//    BAD_REQUEST_TARGET (400) for rewritten targets. Refusal is asserted as
//    "not null" for siblings so either code passes.
//  - Methods are part of the allowlist: POST press, POST sessions, DELETE
//    sessions/current, POST alerts/:id/ack (D-11).
//  - Socket upgrades never pass through Express: guardEdgeUpgrades decides.
import { createServer, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyApiPath,
  edgeRouteGuard,
  edgeRouteRefusal,
  guardEdgeUpgrades,
} from "../edge/mode.ts";
import { PANIC_ROUTES } from "./panic-test-helpers.ts";

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

function guardedApp(edgeMode: boolean) {
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

async function upgradeServer(edgeMode: boolean) {
  const server = createServer((_req, res) => res.end());
  const reached: string[] = [];
  // Accepts every upgrade that reaches it: 101 = "the guard let it through".
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

const SERVED_ON_EDGE = [
  ["POST", PANIC_ROUTES.press],
  ["POST", PANIC_ROUTES.sessions],
  ["DELETE", PANIC_ROUTES.sessionCurrent],
  ["POST", PANIC_ROUTES.ack(ALERT)],
  ["POST", `${PANIC_ROUTES.press}?x=1`],
] as const;

const CLOUD_ONLY = [
  ["GET", PANIC_ROUTES.cloudList(OUTLET)],
  ["GET", `${PANIC_ROUTES.cloudList(OUTLET)}?limit=20`],
  ["POST", PANIC_ROUTES.cloudResolve(OUTLET, ALERT)],
  ["POST", PANIC_ROUTES.cloudAck(OUTLET, ALERT)],
] as const;

const SIBLINGS_REFUSED = [
  ["GET", PANIC_ROUTES.press],
  ["PUT", PANIC_ROUTES.press],
  ["GET", PANIC_ROUTES.sessions],
  ["DELETE", PANIC_ROUTES.sessions],
  ["POST", PANIC_ROUTES.sessionCurrent],
  ["GET", PANIC_ROUTES.sessionCurrent],
  ["GET", "/api/emergency/alerts"],
  ["GET", `/api/emergency/alerts/${ALERT}`],
  ["POST", `/api/emergency/alerts/${ALERT}/resolve`],
  ["POST", `/api/emergency/alerts/${ALERT}/ack/extra`],
  ["POST", "/api/emergency/pressx"],
  ["POST", "/api/emergency/sessionsx"],
  ["POST", "/api/emergency/other"],
  ["POST", "/api/emergency"],
  ["POST", `/api/emergency/alerts/${ALERT}/../resolve`],
] as const;

describe("EM-20 D-11 the edge serves the emergency routes and nothing next to them", () => {
  it("EM-20 press, sessions, session end and acknowledge are served on the edge", () => {
    for (const [method, path] of SERVED_ON_EDGE)
      expect(
        edgeRouteRefusal(path, { edgeMode: true, method }),
        `${method} ${path}`,
      ).toBeNull();
  });

  it("EM-20 press, sessions and acknowledge are not edge-only: cloud-only outlets use them too, and the cloud serves them unchanged", () => {
    for (const [method, path] of SERVED_ON_EDGE) {
      const route = path.split("?")[0];
      expect(classifyApiPath(route, method), `${method} ${path}`).not.toBe(
        "edge_only",
      );
      expect(
        edgeRouteRefusal(path, { edgeMode: false, method }),
        `${method} ${path}`,
      ).toBeNull();
    }
  });

  it("EM-20 the manager list, resolve and cloud acknowledge are cloud only: refused on the edge, served by the cloud", () => {
    for (const [method, path] of CLOUD_ONLY) {
      expect(
        edgeRouteRefusal(path, { edgeMode: true, method }),
        `edge ${method} ${path}`,
      ).toEqual(
        expect.objectContaining({ status: 404, code: "CLOUD_ONLY_ROUTE" }),
      );
      expect(
        edgeRouteRefusal(path, { edgeMode: false, method }),
        `cloud ${method} ${path}`,
      ).toBeNull();
    }
  });

  it("EM-20 siblings, wrong methods and rewritten targets next to the allowed prefixes are refused on the edge", () => {
    for (const [method, path] of SIBLINGS_REFUSED)
      expect(
        edgeRouteRefusal(path, { edgeMode: true, method }),
        `${method} ${path}`,
      ).not.toBeNull();
  });

  it("EM-20 the edge HTTP guard lets the allowed routes reach the handlers and answers 404 CLOUD_ONLY_ROUTE for resolve and the manager list", async () => {
    const edge = guardedApp(true);
    expect((await request(edge).post(PANIC_ROUTES.press)).status).toBe(200);
    expect((await request(edge).post(PANIC_ROUTES.sessions)).status).toBe(200);
    expect(
      (await request(edge).delete(PANIC_ROUTES.sessionCurrent)).status,
    ).toBe(200);
    expect((await request(edge).post(PANIC_ROUTES.ack(ALERT))).status).toBe(
      200,
    );

    const resolve = await request(edge).post(
      PANIC_ROUTES.cloudResolve(OUTLET, ALERT),
    );
    expect(resolve.status).toBe(404);
    expect(resolve.body.code).toBe("CLOUD_ONLY_ROUTE");
    const list = await request(edge).get(PANIC_ROUTES.cloudList(OUTLET));
    expect(list.status).toBe(404);
    expect(list.body.code).toBe("CLOUD_ONLY_ROUTE");
    const sibling = await request(edge).post(
      `/api/emergency/alerts/${ALERT}/resolve`,
    );
    expect(sibling.status).toBe(404);

    const cloud = guardedApp(false);
    expect(
      (await request(cloud).post(PANIC_ROUTES.cloudResolve(OUTLET, ALERT)))
        .status,
    ).toBe(200);
  });
});

describe("EM-20 D-11 the edge lets the emergency socket upgrade through and nothing next to it", () => {
  it("EM-20 /api/emergency/ws is upgraded on the edge (also with a query), the notification stream is still refused", async () => {
    const { server, reached } = await upgradeServer(true);
    expect(await rawStatus(server, PANIC_ROUTES.ws)).toBe(101);
    expect(await rawStatus(server, `${PANIC_ROUTES.ws}?x=1`)).toBe(101);
    expect(reached).toEqual([PANIC_ROUTES.ws, `${PANIC_ROUTES.ws}?x=1`]);

    expect(await rawStatus(server, "/api/notifications/realtime")).toBe(404);
    expect(reached).toHaveLength(2);
  });

  it("EM-20 siblings and rewritten targets of the socket path are refused before the listener", async () => {
    const { server, reached } = await upgradeServer(true);
    for (const target of [
      `${PANIC_ROUTES.ws}/extra`,
      `${PANIC_ROUTES.ws}x`,
      "/api/emergency",
      "/api/emergency/other",
      "/api/emergency/sessions",
      `${PANIC_ROUTES.ws}/../other`,
      "/api/emergency/%2e%2e/ws",
      `/api/outlets/${OUTLET}/emergency-alerts`,
      `/api/outlets/${OUTLET}/panic/realtime`,
    ])
      expect(await rawStatus(server, target), target).not.toBe(101);
    expect(reached).toEqual([]);
  });

  it("EM-20 the cloud is unchanged: it hands the emergency upgrade to the listener", async () => {
    const { server, reached } = await upgradeServer(false);
    expect(await rawStatus(server, PANIC_ROUTES.ws)).toBe(101);
    expect(reached).toEqual([PANIC_ROUTES.ws]);
  });
});
