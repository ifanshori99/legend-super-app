// EDC bridge (B2 legend-wasr7.21; protocol docs/design/edc-bridge-protocol.md).
//
// - WSS `/api/edc-bridge`: outbound socket of the "Legend EDC Bridge" tablet.
//   Auth = `Authorization: Bearer <device token>` on the upgrade only (never
//   in a URL or a message; the header is redacted in logs). No cookie, so no
//   Origin check: a browser cannot send this header on a WebSocket. One JSON
//   message per text frame, at most 16 KB, parsed by the shared contract;
//   anything outside it closes the socket (1008). Ping every 15 s, dropped
//   after 45 s without a pong. The cloud runtime (edge/edc/cloud-runtime.ts)
//   does hello/lease, commands, results, ack and `sale_record_release`.
// - HTTP `/api/edc-bridge/devices`: list, create, issue a new pairing code,
//   revoke, assign terminals; `payment.edc.manage` at the outlet (UI: B4).
//   Create and "new code" answer an 8-character pairing code, never a token.
// - HTTP `/api/edc-bridge/pair` (B4 legend-wasr7.24): the tablet trades the
//   code for its device token (shown once). No session, see the router.
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { Router, type Request } from "express";
import WebSocket, { WebSocketServer } from "ws";
import {
  EDC_BRIDGE_MAX_MESSAGE_BYTES,
  parseEdcBridgeUplink,
} from "@starter/shared/edc/bridge";
import {
  EDC_BRIDGE_DEVICES_PATH,
  assignEdcBridgeTerminalsInputSchema,
  createEdcBridgeDeviceInputSchema,
  edcBridgeDeviceParamsSchema,
  listEdcBridgeDevicesQuerySchema,
  pairEdcBridgeInputSchema,
} from "@starter/shared/edc/bridge-devices";
import type { CloudEdcRuntime } from "../edge/edc/cloud-runtime.ts";
import { HttpError } from "../lib/http-error.ts";
import { clientIpDigest } from "../lib/identity-digest.ts";
import { logger } from "../lib/logger.ts";
import { toLoggableError } from "../lib/safe-error.ts";
import { getAuth, requireAuth } from "../middleware/auth.ts";
import { jsonBody } from "../middleware/body.ts";
import { requireTrustedOrigin } from "../middleware/origin.ts";
import {
  clientIp,
  rejectRateLimited,
} from "../middleware/public-rate-limit.ts";
import {
  getScopedTenantContext,
  requireMenuPermission,
  requireOutletPermission,
} from "../middleware/permissions.ts";
import { requireTenantContext } from "../middleware/tenant.ts";
import * as devices from "../services/edc-bridge-device.service.ts";
import { redeemEdcBridgePairCode } from "../services/edc-bridge-pair.service.ts";

export const EDC_BRIDGE_WS_PATH = "/api/edc-bridge";
const PING_INTERVAL_MS = 15_000;
const DEAD_AFTER_MS = 45_000;
const CLOSE_GRACE_MS = 1_000;

// ------------------------------------------------------------- HTTP

export const edcBridgeRouter = Router();
edcBridgeRouter.use(requireAuth, requireTrustedOrigin, requireTenantContext);

const route = (path: string) =>
  path.slice(EDC_BRIDGE_DEVICES_PATH.length) || "/";
const actor = (req: Request) => getAuth(req).user.id;
const scope = (req: Request) => getScopedTenantContext(req);
const byQueryOutlet = requireOutletPermission("payment.edc.manage", (req) =>
  String(req.query.outletId),
);
const byBodyOutlet = requireOutletPermission("payment.edc.manage", (req) =>
  String(req.body?.outletId),
);
// Record paths: the service checks the permission at the row's own outlet.
const byRecord = requireMenuPermission("payment.edc.manage");

edcBridgeRouter.get(
  route(EDC_BRIDGE_DEVICES_PATH),
  byQueryOutlet,
  async (req, res) => {
    const query = listEdcBridgeDevicesQuerySchema.parse(req.query);
    res.json({
      data: await devices.listEdcBridgeDevices(
        scope(req),
        actor(req),
        query.outletId,
      ),
    });
  },
);

edcBridgeRouter.post(
  route(EDC_BRIDGE_DEVICES_PATH),
  jsonBody,
  byBodyOutlet,
  async (req, res) => {
    const issued = await devices.createEdcBridgeDevice(
      scope(req),
      actor(req),
      createEdcBridgeDeviceInputSchema.parse(req.body),
    );
    // The pairing code is in this answer only: never cached.
    res.set("Cache-Control", "no-store").status(201).json({ data: issued });
  },
);

edcBridgeRouter.post(
  route(`${EDC_BRIDGE_DEVICES_PATH}/:deviceId/pair-code`),
  byRecord,
  async (req, res) => {
    const { deviceId } = edcBridgeDeviceParamsSchema.parse(req.params);
    const issued = await devices.issueEdcBridgePairCode(
      scope(req),
      actor(req),
      deviceId,
    );
    res.set("Cache-Control", "no-store").status(201).json({ data: issued });
  },
);

edcBridgeRouter.post(
  route(`${EDC_BRIDGE_DEVICES_PATH}/:deviceId/revoke`),
  byRecord,
  async (req, res) => {
    const { deviceId } = edcBridgeDeviceParamsSchema.parse(req.params);
    res.json({
      data: await devices.revokeEdcBridgeDevice(
        scope(req),
        actor(req),
        deviceId,
      ),
    });
  },
);

edcBridgeRouter.put(
  route(`${EDC_BRIDGE_DEVICES_PATH}/:deviceId/terminals`),
  jsonBody,
  byRecord,
  async (req, res) => {
    const { deviceId } = edcBridgeDeviceParamsSchema.parse(req.params);
    res.json({
      data: await devices.assignEdcBridgeTerminals(
        scope(req),
        actor(req),
        deviceId,
        assignEdcBridgeTerminalsInputSchema.parse(req.body),
      ),
    });
  },
);

// ------------------------------------------------------------- pair

// POST /api/edc-bridge/pair: the tablet trades a pairing code for its device
// token. No requireAuth or requireTrustedOrigin on purpose: the tablet is an
// Android app, not a browser, so it has no session cookie and no Origin; the
// code is the credential, and no cookie means there is nothing for a
// cross-site request to ride on. Still `jsonBody` (100 kB cap, JSON only) and
// a strict schema. Brute force is bounded per IP (5 wrong codes per 15 min,
// 429) and per code (locked after 5 wrong); every wrong, expired, used or
// locked code gets the same EDC_PAIR_CODE_INVALID. See
// docs/design/edc-bridge-protocol.md "Token perangkat".
export const edcBridgePairRouter = Router();

edcBridgePairRouter.post("/", jsonBody, async (req, res) => {
  res.set("Cache-Control", "no-store");
  const input = pairEdcBridgeInputSchema.parse(req.body);
  const outcome = await redeemEdcBridgePairCode(
    input,
    clientIpDigest(clientIp(req)),
  );
  if (outcome.kind === "rate_limited")
    return rejectRateLimited(res, outcome.retryAfterSeconds);
  if (outcome.kind === "invalid")
    throw new HttpError(
      400,
      "EDC_PAIR_CODE_INVALID",
      "Kode pasang tidak berlaku. Minta kode baru di backoffice.",
    );
  // The token is in this answer only.
  res.json({ data: outcome.data });
});

// -------------------------------------------------------------- WSS

function refuse(socket: Duplex, status: 401 | 503) {
  const text = { 401: "Unauthorized", 503: "Service Unavailable" }[status];
  if (socket.destroyed) return;
  socket.once("finish", () => socket.destroy());
  socket.end(
    `HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

function bearerOf(request: IncomingMessage): string | null {
  const match = /^Bearer ([^\s]+)$/.exec(request.headers.authorization ?? "");
  return match?.[1] ?? null;
}

export function attachEdcBridgeRealtime(
  server: Server,
  options: { runtime: () => CloudEdcRuntime | null },
) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: EDC_BRIDGE_MAX_MESSAGE_BYTES,
  });
  const clients = new Map<WebSocket, { lastPongAt: number }>();

  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if ((request.url ?? "").split("?", 1)[0] !== EDC_BRIDGE_WS_PATH) return;
    void (async () => {
      try {
        const runtime = options.runtime();
        if (!runtime) return refuse(socket, 503);
        const token = bearerOf(request);
        const device = token ? await runtime.authenticate(token) : null;
        if (!device) return refuse(socket, 401);
        if (socket.destroyed) return;
        wss.handleUpgrade(request, socket, head, (ws) => {
          const client = { lastPongAt: Date.now() };
          clients.set(ws, client);
          let closed = false;
          const close = (code: number) => {
            if (closed) return;
            closed = true;
            handlers.closed();
            clients.delete(ws);
            if (ws.readyState === WebSocket.OPEN) {
              ws.close(code);
              setTimeout(() => ws.terminate(), CLOSE_GRACE_MS).unref();
            } else ws.terminate();
          };
          const handlers = runtime.open(device, {
            send: (text) => {
              if (ws.readyState !== WebSocket.OPEN) return false;
              ws.send(text);
              return true;
            },
            close: () => close(1000),
          });
          // Messages of one socket are handled in order.
          let queue: Promise<void> = Promise.resolve();
          ws.on("pong", () => {
            client.lastPongAt = Date.now();
          });
          ws.on("message", (data, isBinary) => {
            if (isBinary) return close(1008);
            let message;
            try {
              message = parseEdcBridgeUplink(String(data));
            } catch {
              return close(1008);
            }
            queue = queue
              .then(async () => {
                if (!(await handlers.message(message))) close(1008);
              })
              .catch((error: unknown) => {
                logger.error(
                  { err: toLoggableError(error) },
                  "EDC bridge message failed",
                );
                close(1011);
              });
          });
          ws.on("close", () => close(1000));
          ws.on("error", () => close(1011));
        });
      } catch (error) {
        logger.error(
          { err: toLoggableError(error) },
          "EDC bridge upgrade failed",
        );
        refuse(socket, 401);
      }
    })();
  };
  server.on("upgrade", upgrade);

  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const [ws, client] of clients) {
      if (now - client.lastPongAt > DEAD_AFTER_MS) {
        ws.terminate();
        continue;
      }
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }, PING_INTERVAL_MS);
  heartbeat.unref();

  return {
    async close() {
      clearInterval(heartbeat);
      server.off("upgrade", upgrade);
      for (const ws of clients.keys()) ws.terminate();
      clients.clear();
      await new Promise<void>((done) => wss.close(() => done()));
    },
  };
}
