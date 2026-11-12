import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import WebSocket from "ws";
import { expect, it } from "vitest";
import {
  attachEmergencyRealtime,
  closeEmergencyRealtime,
} from "../edge/emergency-realtime.ts";

it("closes active emergency sockets before HTTP server shutdown", async () => {
  const server = createServer();
  attachEmergencyRealtime(server, {
    trustedOrigins: ["http://outlet.test"],
    resolveConnection: async () => ({
      userId: "staff",
      tenantId: "tenant",
      outletId: "outlet",
    }),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const socket = new WebSocket(
    `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/edge/emergency/realtime`,
    { origin: "http://outlet.test" },
  );
  await once(socket, "open");
  const closed = once(socket, "close");
  closeEmergencyRealtime();
  await closed;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  expect(socket.readyState).toBe(WebSocket.CLOSED);
});
