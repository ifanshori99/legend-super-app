import "./load-env";
import { createApp } from "./app";
import { guardEdgeUpgrades } from "./edge/mode.ts";
import { attachEmergencyRealtime } from "./edge/panic-relay-realtime.ts";
import { expressClientAddress } from "./lib/client-address.ts";
import { env } from "./config/env";
import { checkDatabase, db, pool } from "./db";
import { closePayoutGrantorPool } from "./db/grantor";
import { startCatalogPublisherWorker } from "./services/edge-master-data-publisher.ts";
import { startEdgeOfflineSweepWorker } from "./services/edge-offline-sweep.ts";
import { logger } from "./lib/logger";
import { createDoitGateway } from "./services/payment-doit.ts";
import { createDuitkuGateway } from "./services/payment-duitku.ts";
import { registerPaymentGateway } from "./services/payment-gateway.ts";
import { registerPaymentRefundGateway } from "./services/payment-refund-gateway.ts";
import { createPaymentReservationDepositPort } from "./services/reservation-deposit-payment.ts";
import { installProfitShareStatementPorts } from "./services/profit-share-statement-ports.ts";
import { setReservationDepositPort } from "./services/reservation-ports.ts";
import {
  attachNotificationRealtime,
  listenNotificationWakeups,
} from "./services/notification-realtime.ts";
import {
  attachQrOrderRealtime,
  listenQrCartWakeups,
  resolveGuestTenantFromHost,
} from "./services/qr-order-realtime.ts";
import {
  attachKdsRealtime,
  listenKdsWakeups,
} from "./services/kds-realtime.ts";
import { resolveKdsStaffConnection } from "./services/kds-realtime-auth.ts";
import { createDeviceOutletResolver } from "./services/device-outlet-resolver.ts";
import { setDeviceOutletResolver } from "./services/device-pin.service.ts";
import { verifyEdgeNodeCredential } from "./services/edge-node.service.ts";
import { setEdgeCredentialVerifier } from "./services/staff-pin-sync.ts";
import {
  EdgeBootError,
  registerEdgeLink,
  startEdgeRuntime,
  type EdgeLinkHandle,
  type EdgeRuntimeHandle,
} from "./edge/runtime.ts";
import { edgeShutdownForceMs, startEdgeEdcAgent } from "./edge/edc/runtime.ts";
import { startEdgePrintAgent } from "./edge/print/runtime.ts";

const app = createApp();
// WS-05 payment gateway (legend-b9i): DOIT, fails closed without credentials.
// Installed here, not in createApp, so tests keep their fake gateways. The
// same adapter pays approved refunds (PaymentRefundPort, legend-0ogy) only
// while DOIT_REFUNDS_ENABLED is on; otherwise the refund port stays fail-closed.
const doitGateway = createDoitGateway();
registerPaymentGateway(doitGateway);
if (env.DOIT_REFUNDS_ENABLED) registerPaymentRefundGateway(doitGateway);
// legend-3gna: the API and the worker must agree on this switch; the value in
// both startup logs makes a split visible.
logger.info(
  { doitRefundsEnabled: env.DOIT_REFUNDS_ENABLED },
  "DOIT_REFUNDS_ENABLED",
);
if (env.DOIT_REFUNDS_ENABLED)
  logger.warn(
    "Refund otomatis penyedia AKTIF; rilis 1 wajib false (DOIT_REFUNDS_ENABLED)",
  );
// Sub-302 D3: Duitku joins the registry when its public callback origin and
// return page are configured; without them no Duitku intent could be paid,
// so the provider stays unregistered (fail closed, cannot be enabled on the
// platform). Duitku has no refund API: no refund port (D6).
if (env.DUITKU_CALLBACK_BASE_URL && env.DUITKU_RETURN_URL)
  registerPaymentGateway(
    createDuitkuGateway({
      callbackBaseUrl: env.DUITKU_CALLBACK_BASE_URL,
      returnUrl: env.DUITKU_RETURN_URL,
    }),
  );
// RSV-02 (legend-t8bz): DP links through WS-05 (fails closed without a gateway).
setReservationDepositPort(createPaymentReservationDepositPort());
// Staff device PIN (legend-obh5): a device names an outlet only through the
// WS-02 registry (fails closed while the registry table is absent).
setDeviceOutletResolver(createDeviceOutletResolver());
// Staff PIN down-sync (legend-obh5): edge credentials are verified against the
// cloud edge_nodes registry (legend-2pi); anything else is denied.
setEdgeCredentialVerifier(verifyEdgeNodeCredential);
// Profit share statements (legend-33im6): object storage from OBJECT_STORAGE_*
// and email from the Brevo settings; without storage issuing stays off and one
// warning is logged. Read from process.env: the notification keys are not part
// of the validated `env`.
installProfitShareStatementPorts(process.env);

const server = app.listen(env.PORT, env.HOST, async (error) => {
  if (error) {
    logger.fatal(
      { err: error },
      (error as NodeJS.ErrnoException).code === "EADDRINUSE"
        ? `Port ${env.PORT} is already in use. Stop the other process or set PORT.`
        : "The API could not start.",
    );
    process.exit(1);
  }
  let database = "reachable";
  try {
    await checkDatabase();
  } catch {
    database = "unreachable (run pnpm db:up, then pnpm run doctor)";
  }
  logger.info(
    { port: env.PORT, webOrigin: env.WEB_URL, database },
    `API listening on ${env.BETTER_AUTH_URL}`,
  );
});

// The EDGE_MODE route split for WebSocket upgrades (legend-zinn): Express
// never sees an upgrade, so without this the edge would still open cloud-only
// streams such as /api/notifications/realtime. Installed before any upgrade
// listener; it refuses before every listener, attached now or later.
guardEdgeUpgrades(server, { edgeMode: env.EDGE_MODE });

// Until the tenant membership and scoped role resolvers are wired, realtime
// subscriptions deny by default. Wakeups contain IDs only and follow commit.
const realtime = attachNotificationRealtime(server, {
  trustedOrigins: env.trustedOrigins,
});
const stopWakeups = listenNotificationWakeups(pool, realtime.dispatch).catch(
  (error: unknown) => {
    logger.error({ err: error }, "Notification wakeup listener unavailable");
    return async () => {};
  },
);

// WS-03 QR shared cart / order realtime (legend-x4qy): guests of the request
// host's tenant, re-verified on every dispatch; wakeups carry ids only.
const qrRealtime = attachQrOrderRealtime(server, {
  trustedOrigins: env.trustedOrigins,
  resolveTenant: resolveGuestTenantFromHost,
});
const stopQrWakeups = listenQrCartWakeups(pool, qrRealtime.dispatch).catch(
  (error: unknown) => {
    logger.error({ err: error }, "QR order wakeup listener unavailable");
    return async () => {};
  },
);

// KDS station realtime (legend-4d5): staff session + kds.ticket.process on
// the station, re-resolved on every wakeup; wakeups carry ids only.
const kdsRealtime = attachKdsRealtime(server, {
  trustedOrigins: env.trustedOrigins,
  resolveConnection: resolveKdsStaffConnection,
});
const stopKdsWakeups = listenKdsWakeups(pool, kdsRealtime.dispatch).catch(
  (error: unknown) => {
    logger.error({ err: error }, "KDS wakeup listener unavailable");
    return async () => {};
  },
);

// Emergency button socket (legend-bod): staff phones on a receiver session
// (device + PIN cookie), in the edge process and in the cloud API of a
// cloud-only outlet.
const emergencyRealtime = attachEmergencyRealtime(server, {
  trustedOrigins: env.trustedOrigins,
});

// WS-02 edge mode (legend-2pi). The cloud accepts edge links on
// /api/edge-link; an edge node runs its boot guards and opens the link to the
// cloud. A misconfigured or unprovisioned edge node refuses to keep running.
let edgeRuntime: EdgeRuntimeHandle | null = null;
// Print Agent (legend-46p, PRD §3 F5, EDG-05): edge mode only, bound to the
// node's own tenant + outlet once the edge runtime has its identity.
let printAgent: { stop(): Promise<void> } | null = null;
// EDC agent (legend-kwy6d): edge primary only, off unless EDC_AGENT_ENABLED.
let edcAgent: { stop(): Promise<void> } | null = null;
let edgeLink: EdgeLinkHandle | null = null;
let catalogPublisher: { stop(): Promise<void> } | null = null;
// Cloud "edge offline" alarm (legend-5ab0l): cloud only, edges have no sweep.
let edgeOfflineSweep: { stop(): Promise<void> } | null = null;
const edgeReady = (async () => {
  try {
    if (env.EDGE_MODE) {
      edgeRuntime = await startEdgeRuntime();
      printAgent = startEdgePrintAgent();
      edcAgent = await startEdgeEdcAgent();
    } else {
      edgeLink = await registerEdgeLink(server, {
        // Upgrade rate limit per real client, not per proxy (legend-wg5t).
        clientAddress: expressClientAddress(app),
      });
      catalogPublisher = startCatalogPublisherWorker(db);
      edgeOfflineSweep = startEdgeOfflineSweepWorker(db, {
        intervalMs: env.EDGE_OFFLINE_SWEEP_SECONDS * 1000,
        thresholdMinutes: env.EDGE_OFFLINE_ALARM_MINUTES,
      });
    }
  } catch (error) {
    if (error instanceof EdgeBootError) {
      // The message names settings and tables only, never their values.
      logger.fatal({ errName: error.name }, error.message);
    } else {
      // Any other failure (database down at boot, LISTEN refused) used to be
      // rethrown into an unhandled rejection; exit explicitly instead. Name
      // and code only: driver errors can carry SQL parameters (legend-wg5t).
      const failure = error as { name?: unknown; code?: unknown };
      logger.fatal(
        {
          errName: typeof failure?.name === "string" ? failure.name : "Error",
          code: typeof failure?.code === "string" ? failure.code : undefined,
        },
        env.EDGE_MODE
          ? "The edge runtime could not start."
          : "The edge link server could not start.",
      );
    }
    logger.flush();
    process.exit(1);
  }
})();

// Graceful shutdown. `pnpm dev` (tsx watch) restarts on every file change;
// closing the server and the pool here frees the port and the PostgreSQL
// connections immediately, so reloads never hit EADDRINUSE or leak sessions.
let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "Shutting down");
  // 5 s normally; with the EDC agent on, long enough for a sale on the wire
  // (its approval evidence is written before stop() returns).
  const forceMs = edgeShutdownForceMs();
  const force = setTimeout(() => {
    logger.warn({ forceMs }, "Forcing exit after the shutdown timer");
    process.exit(1);
  }, forceMs);
  force.unref();
  await realtime.close();
  await (
    await stopWakeups
  )();
  await qrRealtime.close();
  await (
    await stopQrWakeups
  )();
  await kdsRealtime.close();
  await emergencyRealtime.close();
  await (
    await stopKdsWakeups
  )();
  await edgeReady.catch(() => {});
  await catalogPublisher?.stop();
  await edgeOfflineSweep?.stop();
  // Waits for sales already on the wire (up to the sale timeout); the force
  // timer above is sized for that when EDC is on. Cutting it short is NOT
  // safe: the approval evidence of a sale on the wire would be lost
  // (docs/deployment.md, EDC agent).
  await edcAgent?.stop();
  await printAgent?.stop();
  await edgeRuntime?.stop();
  await edgeLink?.close();
  server.closeIdleConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end().catch(() => {});
  await closePayoutGrantorPool();
  logger.flush();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  logger.fatal({ err: reason }, "Unhandled promise rejection");
  logger.flush();
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "Uncaught exception");
  logger.flush();
  process.exit(1);
});
