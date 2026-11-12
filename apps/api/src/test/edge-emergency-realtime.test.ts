// FAC-08 local LAN transport: independent real sockets, no cloud link.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import WebSocket from "ws";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { attachEmergencyRealtime } from "../edge/emergency-realtime.ts";

const origin = "http://outlet.test";
const signal = {
  tenantId: "tenant-a",
  outletId: "outlet-a",
  incidentId: "incident-1",
  unitId: "unit-1",
  triggeredAt: "2026-11-12T09:00:00.000Z",
};

describe("FAC-08 local emergency realtime", () => {
  const server = createServer();
  const active = new Map<
    string,
    { userId: string; tenantId: string; outletId: string }
  >();
  const transport = attachEmergencyRealtime(server, {
    trustedOrigins: [origin],
    resolveConnection: async (req) =>
      active.get(req.headers["x-staff"] as string) ?? null,
  });
  const sockets: WebSocket[] = [];
  async function connect(name: string) {
    if (!server.listening) {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
    }
    const port = (server.address() as AddressInfo).port;
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/api/edge/emergency/realtime`,
      { origin, headers: { "x-staff": name } },
    );
    sockets.push(socket);
    await once(socket, "open");
    return socket;
  }
  afterEach(async () => {
    for (const socket of sockets) socket.terminate();
    sockets.length = 0;
    active.clear();
  });
  it("delivers within five seconds only to connected eligible staff at the same tenant and outlet", async () => {
    active.set("on-duty", {
      userId: "a",
      tenantId: "tenant-a",
      outletId: "outlet-a",
    });
    active.set("other-outlet", {
      userId: "b",
      tenantId: "tenant-a",
      outletId: "outlet-b",
    });
    active.set("other-tenant", {
      userId: "c",
      tenantId: "tenant-b",
      outletId: "outlet-a",
    });
    const staff = await connect("on-duty");
    await connect("other-outlet");
    await connect("other-tenant");
    const received = once(staff, "message");
    const start = Date.now();
    expect(await transport.dispatch(signal)).toBe(1);
    const [bytes] = await received;
    expect(Date.now() - start).toBeLessThanOrEqual(5000);
    expect(JSON.parse(String(bytes))).toEqual({
      type: "emergency",
      incidentId: signal.incidentId,
      unitId: signal.unitId,
      triggeredAt: signal.triggeredAt,
    });
  });
  it("does not deliver after staff eligibility changes and reports zero recipients", async () => {
    active.set("staff", {
      userId: "a",
      tenantId: "tenant-a",
      outletId: "outlet-a",
    });
    await connect("staff");
    active.delete("staff");
    expect(await transport.dispatch(signal)).toBe(0);
  });
  it("returns zero when nobody is connected", async () => {
    expect(await transport.dispatch(signal)).toBe(0);
  });
  afterAll(async () => {
    transport.close();
    if (server.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
