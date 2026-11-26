// EDGE_MODE route split hardening (bead legend-zinn): the edge serves only
// the sign-in/session paths of /api/auth and the operational
// /api/outlets/:id/{pos,floor} routers, refuses targets that URL parsing
// would rewrite (dot segments, backslashes), and applies the same split to
// WebSocket upgrades, which never pass through Express.
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import express from "express";
import request from "supertest";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyApiPath,
  edgeRouteGuard,
  edgeRouteRefusal,
  guardEdgeUpgrades,
} from "../edge/mode.ts";

const OUTLET = "0b7c3a52-5f1e-4c47-9a0e-2a4c8f3d9e11";

function app(edgeMode: boolean) {
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

/** Sends a raw request line (no client-side URL normalisation). */
async function rawStatus(
  server: Server,
  target: string,
  headers: Record<string, string> = {},
): Promise<number> {
  const port = (server.address() as AddressInfo).port;
  return new Promise<number>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      const lines = [
        `GET ${target} HTTP/1.1`,
        "Host: edge.test",
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
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

const UPGRADE_HEADERS = {
  Connection: "Upgrade",
  Upgrade: "websocket",
  "Sec-WebSocket-Version": "13",
  "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
};

const servers: Server[] = [];
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

async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

describe("legend-zinn edge allowlist for /api/auth and /api/outlets", () => {
  it("serves only sign-out, the session read and the caller's identity on the edge (E2: staff sign in with a PIN)", () => {
    for (const path of [
      "/api/auth/sign-out",
      "/api/auth/get-session",
      "/api/auth/me",
    ])
      expect(classifyApiPath(path), path).toBe("edge_and_cloud");
    for (const path of [
      "/api/auth",
      "/api/auth/sign-up/email",
      "/api/auth/admin/list-users",
      "/api/auth/admin/set-role",
      "/api/auth/sign-in/social",
      "/api/auth/magic-link",
      "/api/auth/google/start",
      "/api/auth/login-challenges/whatsapp",
      "/api/auth/mfa/factors",
      "/api/auth/sign-in",
      "/api/auth/sign-in/email",
      "/api/auth/sessions",
      "/api/auth/sessions/current/activity",
      "/api/auth/mfa/verify",
      "/api/auth/sign-in/email-otp",
    ])
      expect(classifyApiPath(path), path).toBe("cloud_only");
  });

  it("serves only the POS, floor, kitchen, expo and pickup routers of an outlet on the edge", () => {
    for (const path of [
      `/api/outlets/${OUTLET}/pos`,
      `/api/outlets/${OUTLET}/pos/orders`,
      `/api/outlets/${OUTLET}/pos/orders/abc/fire`,
      `/api/outlets/${OUTLET}/floor`,
      // KDS, including its realtime WebSocket path (legend-64i1).
      `/api/outlets/${OUTLET}/kitchen`,
      `/api/outlets/${OUTLET}/kitchen/stations/abc/tickets`,
      `/api/outlets/${OUTLET}/kitchen/stations/abc/feed`,
      `/api/outlets/${OUTLET}/kitchen/stations/abc/realtime`,
      `/api/outlets/${OUTLET}/kitchen/tickets/abc/start`,
      `/api/outlets/${OUTLET}/expo`,
      `/api/outlets/${OUTLET}/expo/runners`,
      `/api/outlets/${OUTLET}/expo/abc/runner`,
      `/api/outlets/${OUTLET}/expo/abc/delivered`,
      `/api/outlets/${OUTLET}/pickup-display`,
      `/api/outlets/${OUTLET}/pickup-calls/abc/call`,
      `/api/outlets/${OUTLET}/pickup-calls/abc/picked-up`,
    ])
      expect(classifyApiPath(path), path).toBe("edge_and_cloud");
    for (const path of [
      "/api/outlets",
      `/api/outlets/${OUTLET}`,
      `/api/outlets/${OUTLET}/reservations`,
      `/api/outlets/${OUTLET}/service-requests`,
      `/api/outlets/${OUTLET}/delivery-zones`,
      `/api/outlets/${OUTLET}/posx`,
      `/api/outlets/${OUTLET}/kitchenx`,
      `/api/outlets/${OUTLET}/expox`,
      `/api/outlets/${OUTLET}/pickup-displayx`,
      `/api/outlets/${OUTLET}/pickup-callsx`,
      `/api/outlets/${OUTLET}/pickup`,
      "/api/outlets/kitchen",
      "/api/outlets/expo",
      "/api/outlets/pos",
      "/api/outlets//pos",
    ])
      expect(classifyApiPath(path), path).toBe("cloud_only");
  });

  describe("legend-j6cyb edge allowlist for HRIS attendance (method + exact path)", () => {
    it("serves only the outlet attendance clock, the QR read and the selfie upload on the edge", () => {
      for (const [method, path] of [
        ["POST", "/api/hris/attendance/outlet-clock"],
        ["post", "/API/HRIS/attendance/outlet-clock"],
        ["POST", "/api/hris//attendance/outlet-clock"],
        ["GET", "/api/hris/attendance/qr"],
        ["POST", "/api/storage/uploads"],
      ] as const)
        expect(classifyApiPath(path, method), `${method} ${path}`).toBe(
          "edge_and_cloud",
        );
    });

    it("keeps every other /api/hris and /api/storage route cloud only, also with the wrong method", () => {
      for (const [method, path] of [
        ["POST", "/api/hris/attendance/clock"],
        ["GET", "/api/hris/attendance/clock"],
        ["PUT", "/api/hris/attendance/clock"],
        ["GET", "/api/hris/attendance/outlet-clock"],
        ["PUT", "/api/hris/attendance/outlet-clock"],
        ["POST", "/api/hris/attendance/outlet-clock/x"],
        ["POST", "/api/hris/attendance/outlet-clockx"],
        ["POST", "/api/hris/attendance/qr"],
        ["POST", "/api/hris/attendance/qr/rotate"],
        ["GET", "/api/hris/attendance/qr/rotate"],
        ["POST", "/api/hris/attendance/clock/x"],
        ["POST", "/api/hris/attendance/clockx"],
        ["POST", "/api/hris"],
        ["GET", "/api/hris"],
        ["GET", "/api/hris/attendance"],
        ["GET", "/api/hris/attendance/logs"],
        ["POST", "/api/hris/attendance/devices/bind"],
        ["POST", "/api/hris/attendance/devices/abc/revoke"],
        ["GET", "/api/hris/attendance/policy"],
        ["POST", "/api/hris/attendance/corrections"],
        ["GET", "/api/hris/employees"],
        ["POST", "/api/hris/payroll"],
        ["GET", "/api/storage/uploads"],
        ["DELETE", "/api/storage/uploads"],
        ["POST", "/api/storage/uploads/x"],
        ["POST", "/api/storage"],
        ["GET", "/api/storage/objects/abc"],
        ["POST", "/api/storage/objects/abc/sign"],
      ] as const)
        expect(classifyApiPath(path, method), `${method} ${path}`).toBe(
          "cloud_only",
        );
    });

    it("treats an exact route without a method as cloud only", () => {
      expect(classifyApiPath("/api/hris/attendance/outlet-clock")).toBe(
        "cloud_only",
      );
      expect(classifyApiPath("/api/storage/uploads")).toBe("cloud_only");
    });

    it("applies the method at the HTTP guard and at edgeRouteRefusal", async () => {
      const edge = app(true);
      expect(
        (await request(edge).post("/api/hris/attendance/outlet-clock")).status,
      ).toBe(200);
      expect(
        (await request(edge).post("/api/hris/attendance/clock")).status,
      ).toBe(404);
      expect((await request(edge).get("/api/hris/attendance/qr")).status).toBe(
        200,
      );
      expect((await request(edge).post("/api/storage/uploads")).status).toBe(
        200,
      );
      for (const [method, path] of [
        ["get", "/api/hris/attendance/outlet-clock"],
        ["post", "/api/hris/attendance/qr"],
        ["post", "/api/hris/attendance/qr/rotate"],
        ["get", "/api/storage/uploads"],
      ] as const) {
        const res = await request(edge)[method](path);
        expect(res.status, `${method} ${path}`).toBe(404);
        expect(res.body.code).toBe("CLOUD_ONLY_ROUTE");
      }
      expect(
        edgeRouteRefusal("/api/hris/attendance/outlet-clock", {
          edgeMode: true,
          method: "POST",
        }),
      ).toBeNull();
      expect(
        edgeRouteRefusal("/api/hris/attendance/clock", {
          edgeMode: true,
          method: "POST",
        }),
      ).toEqual(expect.objectContaining({ code: "CLOUD_ONLY_ROUTE" }));
      expect(
        edgeRouteRefusal("/api/hris/attendance/outlet-clock?x=1", {
          edgeMode: true,
        }),
      ).toEqual(expect.objectContaining({ code: "CLOUD_ONLY_ROUTE" }));
      // The cloud serves everything (the split only denies on the edge).
      expect(
        edgeRouteRefusal("/api/hris/attendance/qr/rotate", {
          edgeMode: false,
          method: "POST",
        }),
      ).toBeNull();
    });

    it("does not open the upgrade path for an exact POST route", async () => {
      expect(
        edgeRouteRefusal("/api/hris/attendance/outlet-clock", {
          edgeMode: true,
          method: "GET",
        }),
      ).toEqual(expect.objectContaining({ code: "CLOUD_ONLY_ROUTE" }));
    });
  });

  it("the edge refuses sign-up, the admin plugin and outlet back office over HTTP", async () => {
    const edge = app(true);
    for (const path of [
      "/api/auth/sign-in/email",
      "/api/auth/sessions",
      "/api/auth/mfa/verify",
      "/api/auth/sign-up/email",
      "/api/auth/admin/list-users",
      "/API/Auth/Admin/list-users",
      "/api/auth//admin/list-users",
      `/api/outlets/${OUTLET}/reservations`,
    ]) {
      const res = await request(edge).post(path);
      expect(res.status, path).toBe(404);
      expect(res.body.code, path).toBe("CLOUD_ONLY_ROUTE");
    }
    expect((await request(edge).get("/api/auth/get-session")).status).toBe(200);
    expect(
      (await request(edge).get(`/api/outlets/${OUTLET}/pos/orders`)).status,
    ).toBe(200);
    expect(
      (await request(edge).get(`/api/outlets/${OUTLET}/floor`)).status,
    ).toBe(200);
  });

  it("the edge refuses the paid WFC sale (brief 1270 W2: cloud only)", async () => {
    const edge = app(true);
    for (const [method, path] of [
      ["get", "/api/wfc/products"],
      ["get", "/api/wfc/claims"],
      ["post", "/api/wfc/claims"],
      ["get", `/api/wfc/claims/${OUTLET}`],
      ["post", `/api/wfc/claims/${OUTLET}/payment`],
    ] as const) {
      expect(classifyApiPath(path, method.toUpperCase()), path).toBe(
        "cloud_only",
      );
      const res = await request(edge)[method](path);
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(res.body.code, path).toBe("CLOUD_ONLY_ROUTE");
    }
    expect((await request(app(false)).post("/api/wfc/claims")).status).toBe(
      200,
    );
  });

  it("the cloud still serves every auth and outlet path", async () => {
    const cloud = app(false);
    expect((await request(cloud).post("/api/auth/sign-up/email")).status).toBe(
      200,
    );
    expect(
      (await request(cloud).get("/api/auth/admin/list-users")).status,
    ).toBe(200);
    expect(
      (await request(cloud).get(`/api/outlets/${OUTLET}/reservations`)).status,
    ).toBe(200);
  });

  it("a dot segment or backslash cannot walk from an allowed prefix to a cloud-only route", async () => {
    const server = await listen(createServer(app(true)));
    for (const target of [
      "/api/auth/sign-in/email/../../admin/list-users",
      "/api/auth/sign-in/email/%2e%2e/%2E%2E/admin/list-users",
      "/api/auth/sign-in/email/.%2e/.%2e/admin/list-users",
      "/api/auth/sign-in/email\\..\\..\\admin\\list-users",
      `/api/outlets/${OUTLET}/pos/../reservations`,
      "/api/auth/sign-in/email/./x",
    ])
      expect(await rawStatus(server, target), target).toBe(400);
    // The same rule on the cloud (canonical targets only).
    expect(
      edgeRouteRefusal("/api/x/../edge/status", { edgeMode: false }),
    ).toEqual(
      expect.objectContaining({ status: 400, code: "BAD_REQUEST_TARGET" }),
    );
    expect(
      edgeRouteRefusal("/api/auth/get-session?x=../..", { edgeMode: true }),
    ).toBeNull();
  });
});

describe("legend-zinn WebSocket upgrades follow the route split", () => {
  async function upgradeServer(edgeMode: boolean) {
    const server = createServer((_req, res) => res.end());
    const reached: string[] = [];
    const wss = new WebSocketServer({ noServer: true });
    // Listener attached BEFORE the guard: it must still never run for a
    // refused target.
    server.on("upgrade", (req, socket, head) => {
      reached.push(req.url ?? "");
      wss.handleUpgrade(req, socket, head, (ws) => ws.close());
    });
    const restore = guardEdgeUpgrades(server, { edgeMode });
    await listen(server);
    return { server, reached, restore };
  }

  it("the edge refuses cloud-only upgrades before any listener runs", async () => {
    const { server, reached } = await upgradeServer(true);
    expect(
      await rawStatus(server, "/api/notifications/realtime", UPGRADE_HEADERS),
    ).toBe(404);
    expect(await rawStatus(server, "/api/edge-link", UPGRADE_HEADERS)).toBe(
      404,
    );
    expect(
      await rawStatus(
        server,
        `/api/table-sessions/${OUTLET}/../../notifications/realtime`,
        UPGRADE_HEADERS,
      ),
    ).toBe(400);
    expect(reached).toEqual([]);
    expect(
      await rawStatus(
        server,
        `/api/table-sessions/${OUTLET}/realtime`,
        UPGRADE_HEADERS,
      ),
    ).toBe(101);
    expect(reached).toEqual([`/api/table-sessions/${OUTLET}/realtime`]);
  });

  it("the cloud refuses edge-only upgrades and keeps its own", async () => {
    const { server, reached, restore } = await upgradeServer(false);
    expect(await rawStatus(server, "/api/edge/status", UPGRADE_HEADERS)).toBe(
      404,
    );
    expect(reached).toEqual([]);
    expect(
      await rawStatus(server, "/api/notifications/realtime", UPGRADE_HEADERS),
    ).toBe(101);
    expect(await rawStatus(server, "/api/edge-link", UPGRADE_HEADERS)).toBe(
      101,
    );
    restore();
    expect(await rawStatus(server, "/api/edge/status", UPGRADE_HEADERS)).toBe(
      101,
    );
  });
});
