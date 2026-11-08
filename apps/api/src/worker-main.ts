import "./load-env";
import { Pool } from "pg";
import { assertDeploymentEnv } from "@starter/shared/env";
import { loadWorkerConfig } from "./worker/production-config.ts";
import { sql } from "drizzle-orm";
import {
  assertTrustedScopedContext,
  tenantIdSchema,
  ulidToUuid,
  uuidToUlid,
} from "@starter/shared/core";
import { databaseUrl } from "./db/connection";
import { withTenant } from "./db/tenant.ts";
import { db, pool } from "./db";
import {
  consumeOutbox,
  markOutboxDead,
  relayOutbox,
} from "./services/core-outbox";
import { resolveFilledOutboxGaps } from "./services/core-outbox-gaps.ts";
import { createNotificationConsumer } from "./services/notification-consumer.ts";
import { deliverNotificationAttempt } from "./services/notification-delivery.ts";
import { expireDueApprovalRequests } from "./services/platform-approval.service.ts";
import { releaseExpiredSlotHolds } from "./services/facility-slots.service.ts";
import { handlePaymentPaid } from "./services/reservation-consumers.ts";
import { deliverOrderPaymentEvent } from "./services/order-payment-consumers.ts";
import { sweepUnpaidQrOrders } from "./services/qr-order-consumers.ts";
import { handleApprovalResolved } from "./services/staff-override-consumers.ts";
import { createPaymentReservationDepositPort } from "./services/reservation-deposit-payment.ts";
import { setReservationDepositPort } from "./services/reservation-ports.ts";
import { retryPendingRefunds } from "./services/reservation-refunds.ts";
import { sweepStaleDepositHolds } from "./services/reservation-sweeps.ts";
import { sweepOverdueServiceRequests } from "./services/service-request.service.ts";
import { expireDueSupportAccessGrants } from "./services/platform-support.service.ts";
import { sweepMissedChecklistRuns } from "./services/operations-escalation.service.ts";
import { sweepExpiredPrepLabels } from "./services/operations-food-safety.service.ts";
import { createPgBoss, createWorkerRuntime } from "./worker/runtime";
import {
  createRelayRuntime,
  createRelayScheduler,
  createWakeListener,
} from "./worker/relay";
import { runInventoryParAlertJob } from "./worker/inventory-par-alerts.job.ts";
import { runInventoryExpiryJob } from "./worker/inventory-expiry.job.ts";
import { runDueDepreciation } from "./worker/accounting-depreciation.job.ts";
import { runPaymentGatewayPollJob } from "./worker/payment-gateway-poll.job.ts";
import { setPaymentGateway } from "./services/payment-gateway.ts";
import { createDoitGateway } from "./services/payment-doit.ts";

assertDeploymentEnv(process.env);

// The configuration belongs to the deployment, never to the incoming request.
// Missing transport or notification adapters are startup errors (legend-18qw).
const handlers = await loadWorkerConfig({ env: process.env, database: db });
if (!process.env.WORKER_DATABASE_URL)
  throw new Error(
    "WORKER_DATABASE_URL is required for the isolated queue role",
  );
const workerUrl = databaseUrl(process.env.WORKER_DATABASE_URL);
// RSV-02 (legend-t8bz): DP links go through WS-05; fails closed while no
// payment gateway is installed.
setReservationDepositPort(createPaymentReservationDepositPort());
// PAY-02/03 (legend-b9i): the polling fallback asks DOIT for the status of
// pending intents whose webhook never arrived.
setPaymentGateway(createDoitGateway());
const registry = new Pool({ connectionString: workerUrl, max: 1 });
registry.on("error", () => console.error("Worker registry connection error"));
async function resolveContext(tenantId: string) {
  const parsed = tenantIdSchema.parse(tenantId);
  const result = await registry.query(
    "SELECT id FROM app.active_tenant_registry WHERE id = $1",
    [parsed],
  );
  if (result.rowCount !== 1) throw new Error("Worker tenant is not active");
  const context = await handlers.resolveContext(parsed);
  assertTrustedScopedContext(context);
  if (context.outletScope.kind !== "tenant")
    throw new Error("Worker requires tenant-wide scope");
  if (context.tenant.tenantId !== parsed)
    throw new Error("Worker tenant context mismatch");
  return context;
}
const runtime = createWorkerRuntime({
  boss: createPgBoss(workerUrl),
  resolveContext,
  authorize: handlers.authorize,
  deliver: async (context, job) => {
    await consumeOutbox(db, context, {
      outboxId: job.outboxId,
      generation: job.generation,
      authorize: (event) => handlers.authorizeEvent(context, event),
      deliver: async (event, key, tx) => {
        const result = await tx.execute(
          sql`SELECT destination, direction, peer_id FROM domain_event_outbox WHERE id = ${ulidToUuid(job.outboxId)}::uuid`,
        );
        const row = result.rows[0];
        if (!row) throw new Error("Outbox row not found");
        const route = {
          destination: String(row.destination),
          direction: row.direction === null ? null : String(row.direction),
          peerId: row.peer_id === null ? null : String(row.peer_id),
        };
        if (route.destination === "notification") {
          await createNotificationConsumer(
            context,
            handlers.resolveNotificationRecipients,
          )(event, key, tx);
        } else {
          // RSV-02 (legend-t8bz): a paid DP confirms its reservation first
          // (idempotent, replay safe), then the deployment consumer runs.
          if (event.name === "payment.paid")
            await handlePaymentPaid(context, event);
          // ORD-02 (legend-x4qy/kk7): a verified payment fires its QR order
          // (in this consumption transaction) or settles its POS bill; an
          // expired/failed QR payment re-offers a code or voids the order.
          // Each consumer re-reads its locked rows, so a replay is a no-op.
          await deliverOrderPaymentEvent(context, event, tx);
          // AUTH-06 (legend-obh5): a phone-approved POS override settles from
          // the approval chain re-read under its row lock.
          await handleApprovalResolved(context, event);
          await handlers.deliverEvent(context, event, key, tx, route);
        }
      },
    });
  },
  markDead: async (context, job) => {
    await markOutboxDead(db, context, job);
  },
});
const relay = createRelayRuntime({
  scheduler: createRelayScheduler(workerUrl),
  listener: createWakeListener(workerUrl),
  listActiveTenantIds: async () =>
    (
      await registry.query<{ id: string }>(
        "SELECT id FROM app.active_tenant_registry",
      )
    ).rows.map((row) => row.id),
  resolveContext,
  relay: async (context) => {
    // A failing gap record is an alerting problem, not a delivery one: it
    // must not abort the relay (claimed rows unenqueued) or the sweeps below.
    await relayOutbox(db, context, runtime.enqueue, async (gap) => {
      try {
        await handlers.requestMissing(context, gap);
      } catch {
        console.error("Outbox gap request could not be recorded");
      }
    });
    // legend-18qw: close gap records whose missing sequence was consumed.
    try {
      await resolveFilledOutboxGaps(db, context);
    } catch {
      console.error("Outbox gap resolution sweep failed");
    }
    // §3 F7 approval deadlines (legend-y5q): expire overdue levels and append
    // approval.resolved for the source module + notifications. Fail closed: a
    // sweep error never blocks the relay, the next tick retries.
    try {
      await expireDueApprovalRequests(context);
    } catch {
      console.error("Approval deadline sweep failed");
    }
    // TEN-04: record lapsed support-access sessions exactly once.
    try {
      await expireDueSupportAccessGrants(context);
    } catch {
      console.error("Support access expiry sweep failed");
    }
    // FAC-02 (legend-nm4f): cancel facility slot holds whose payment TTL
    // lapsed so the unit frees up. Same fail-closed rule as above.
    try {
      await withTenant(db, context, (tx) =>
        releaseExpiredSlotHolds(tx, context),
      );
    } catch {
      console.error("Facility hold expiry sweep failed");
    }
    // RSV-01/RSV-02 (legend-t8bz): release DP holds whose link expired unpaid
    // or was never attached, and retry pending DP refund requests. Same
    // fail-closed rule: an error never blocks the relay.
    try {
      await withTenant(db, context, (tx) =>
        sweepStaleDepositHolds(tx, context, new Date()),
      );
    } catch {
      console.error("Reservation deposit hold sweep failed");
    }
    try {
      await retryPendingRefunds(context, new Date());
    } catch {
      console.error("Reservation refund retry sweep failed");
    }
    // §3.19 Aset Tetap (legend-hpgo): post last month's depreciation once per
    // legal entity (idempotent per entity+period and asset+period). Fail closed.
    try {
      await runDueDepreciation(context, new Date());
    } catch {
      console.error("Depreciation job sweep failed");
    }
    // PAY-02/03 (legend-b9i): settle pending intents whose DOIT webhook never
    // arrived and retry stored webhook events. Fail closed like the sweeps.
    try {
      await runPaymentGatewayPollJob(context, new Date());
    } catch {
      console.error("Payment gateway poll sweep failed");
    }
    // §3 F16 par-level critical + FEFO expiry alerts (legend-ugo); self-throttled.
    try {
      await runInventoryParAlertJob(context);
    } catch {
      console.error("Inventory par alert sweep failed");
    }
    try {
      await runInventoryExpiryJob(context);
    } catch {
      console.error("Inventory expiry sweep failed");
    }
    // OPS-01 (legend-5zkp): mark overdue checklist runs missed and queue the
    // supervisor alert through the notification outbox. Same fail-closed rule:
    // a sweep error never blocks the relay, the next tick retries.
    try {
      await withTenant(db, context, (tx) =>
        sweepMissedChecklistRuns(tx, context),
      );
    } catch {
      console.error("Checklist missed-run sweep failed");
    }
    // OPS-03 (legend-sdet): raise the expiry alert for prep labels past their
    // use-by exactly once. Fail closed like the other sweeps.
    try {
      await withTenant(db, context, (tx) =>
        sweepExpiredPrepLabels(tx, context),
      );
    } catch {
      console.error("Prep label expiry sweep failed");
    }
    // ORD-02 (legend-x4qy): void unpaid pay-first QR orders whose payment
    // window closed when no expiry event arrives (abandoned guests). Each
    // order is decided under its own row lock; a rerun voids nothing twice.
    try {
      await sweepUnpaidQrOrders(context, new Date());
    } catch {
      console.error("Unpaid QR order sweep failed");
    }
    // ORD-07 (legend-7qg): escalate waiter calls / bill requests left open
    // past SERVICE_REQUEST_OVERDUE_SECONDS, once each. The relay ticks every
    // minute, so an escalation fires 180-240 s after the call.
    try {
      await sweepOverdueServiceRequests(new Date(), context);
    } catch {
      console.error("Service request overdue sweep failed");
    }
    // The relay's periodic sweep also recovers due notification attempts.
    // Providers and recipient lookup are required at startup (legend-18qw); a
    // disabled channel is never planned, so its attempts are skipped, not lost.
    const due = await withTenant(db, context, async (tx) =>
      tx.execute(
        sql`SELECT a.id FROM delivery_attempts a WHERE ((a.status IN ('queued','failed','sending') AND (a.next_attempt_at IS NULL OR a.next_attempt_at <= now())) OR (a.channel = 'whatsapp' AND a.status = 'skipped' AND a.skip_reason = 'free_channel_available')) AND (a.channel <> 'whatsapp' OR ${Boolean(handlers.notificationDelivery?.whatsapp)}::boolean) AND (a.channel <> 'whatsapp' OR NOT EXISTS (SELECT 1 FROM delivery_attempts f WHERE f.tenant_id = a.tenant_id AND f.notification_id = a.notification_id AND f.channel IN ('email','web_push') AND f.status IN ('queued','failed','sending','sent','delivered'))) ORDER BY a.created_at, a.id LIMIT 100`,
      ),
    );
    for (const row of due.rows) {
      try {
        await deliverNotificationAttempt(
          db,
          context,
          uuidToUlid(String(row.id)),
          handlers.notificationDelivery,
        );
      } catch {
        console.error("Notification delivery attempt failed");
      }
    }
  },
});
try {
  await runtime.start();
  await relay.start();
} catch (error) {
  await runtime.stop().catch(() => {});
  await registry.end();
  throw error;
}
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await relay.stop();
  await runtime.stop();
  await registry.end();
  await pool.end();
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
