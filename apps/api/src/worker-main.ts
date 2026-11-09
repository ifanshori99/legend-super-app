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
import { verifyQueueConnection } from "./db/role";
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
import { runPurchasingPoEmailJob } from "./worker/purchasing-po-email.job.ts";
import { handlePurchasingApprovalResolved } from "./services/purchasing-approval-consumer.ts";
import { releaseExpiredSlotHolds } from "./services/facility-slots.service.ts";
import { handlePaymentPaid } from "./services/reservation-consumers.ts";
import {
  deliverInventoryGlEvent,
  retryBlockedInventoryGl,
} from "./services/inventory-gl-consumer.ts";
import { parseEdgeRuntimeConfig } from "./edge/config.ts";
import { deliverOrderPaymentEvent } from "./services/order-payment-consumers.ts";
import { sweepUnpaidQrOrders } from "./services/qr-order-consumers.ts";
import {
  handleRefundApprovalResolved,
  sweepApprovedRefundPayouts,
} from "./services/payment-refund.service.ts";
import { handleHrisApprovalResolved } from "./services/hris-approval-consumers.ts";
import { runScheduledLeaveJobs } from "./services/hris-leave-jobs.ts";
import { handleJournalApprovalResolved } from "./services/accounting-journal-consumers.ts";
import { handleApprovalResolved } from "./services/staff-override-consumers.ts";
import { createPaymentReservationDepositPort } from "./services/reservation-deposit-payment.ts";
import { setReservationDepositPort } from "./services/reservation-ports.ts";
import { retryPendingRefunds } from "./services/reservation-refunds.ts";
import { sweepStaleDepositHolds } from "./services/reservation-sweeps.ts";
import { sweepOverdueServiceRequests } from "./services/service-request.service.ts";
import { expireDueSupportAccessGrants } from "./services/platform-support.service.ts";
import { generateScheduledChecklistRuns } from "./services/operations-checklist-scheduler.service.ts";
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
import { runDueRecurringJournals } from "./services/accounting-journal-recurring.service.ts";
import { logger } from "./lib/logger";

assertDeploymentEnv(process.env);

// The configuration belongs to the deployment, never to the incoming request.
// Missing transport or notification adapters are startup errors (legend-18qw).
const handlers = await loadWorkerConfig({ env: process.env, database: db });
if (!process.env.WORKER_DATABASE_URL)
  throw new Error(
    "WORKER_DATABASE_URL is required for the isolated queue role",
  );
const workerUrl = databaseUrl(process.env.WORKER_DATABASE_URL);
// PRD §3.19 (legend-w1vo): only the cloud posts the GL from stock movements;
// an edge node (or an unreadable edge configuration) never does.
const edgeRuntime = parseEdgeRuntimeConfig(process.env);
const postsInventoryGl = edgeRuntime.ok && !edgeRuntime.config.edgeMode;
// RSV-02 (legend-t8bz): DP links go through WS-05; fails closed while no
// payment gateway is installed.
setReservationDepositPort(createPaymentReservationDepositPort());
// PAY-02/03 (legend-b9i): the polling fallback asks DOIT for the status of
// pending intents whose webhook never arrived.
setPaymentGateway(createDoitGateway());
const registry = new Pool({
  connectionString: workerUrl,
  max: 1,
  verify: verifyQueueConnection,
});
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
          // PRD §3.19 (legend-w1vo), cloud only: stock.moved of a count, waste
          // or sale posts its GL journal in a savepoint; a closed period or a
          // missing mapping parks the source for the sweep, never fails this.
          if (postsInventoryGl)
            await deliverInventoryGlEvent(context, event, tx);
          // AUTH-06 (legend-obh5): a phone-approved POS override settles from
          // the approval chain re-read under its row lock.
          await handleApprovalResolved(context, event);
          // PRD §3.18 (legend-9yz): a decided purchasing chain settles its PR/PO
          // from the chain re-read under the row lock; replays are no-ops.
          await handlePurchasingApprovalResolved(context, event);
          // PAY-04 (legend-hvvn): an approved refund chain settles the refund;
          // the payout itself runs from the approve call or the payout sweep.
          await handleRefundApprovalResolved(context, event);
          // WS-10 (legend-hggk): approved/rejected leave and overtime settle
          // from the chain outcome re-read under the request row lock.
          await handleHrisApprovalResolved(context, event);
          // Manual/recurring journals (legend-vmyg): settle from the chain.
          await handleJournalApprovalResolved(context, event);
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
    // legend-arj.1: leave accrual, carry-over and carry-over expiry once per
    // local day (idempotent through the ledger). Fail closed: an error leaves
    // no day marker, so the next tick retries, and never blocks the relay.
    try {
      await runScheduledLeaveJobs(context);
    } catch {
      console.error("Scheduled leave jobs failed");
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
    // PRD §3.19 (legend-w1vo), cloud only: retry stock sources whose journal
    // was blocked (closed period, missing mapping). Retry only, never another
    // period. A sweep error never blocks the relay.
    if (postsInventoryGl) {
      try {
        await retryBlockedInventoryGl(context, new Date());
      } catch {
        console.error("Inventory GL retry sweep failed");
      }
    }
    // §3.19 Jurnal Berulang (legend-vmyg): post due occurrences of approved
    // templates, one transaction per period. Fail closed, next tick resumes.
    try {
      const recurring = await runDueRecurringJournals(context, new Date());
      // Counts only (no template data); the per-template reason is stored on
      // recurring_journals.last_error for finance.
      if (recurring.failed > 0)
        logger.warn(
          { job: "recurring_journals", ...recurring },
          "recurring journal generation had failures",
        );
    } catch {
      console.error("Recurring journal sweep failed");
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
    // PRD §3.18 "Kirim PO" (legend-9yz): send queued PO emails. Logs carry only
    // a masked address; an unconfigured provider fails the delivery closed.
    try {
      await runPurchasingPoEmailJob([context], {
        email: handlers.notificationDelivery?.email ?? null,
      });
    } catch {
      console.error("Purchasing PO email sweep failed");
    }
    // F45 (legend-5v69): create today's checklist runs from role templates
    // before the missed sweep. Fail closed like the other sweeps.
    try {
      await withTenant(db, context, (tx) =>
        generateScheduledChecklistRuns(tx, context),
      );
    } catch {
      console.error("Checklist run generation failed");
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
// PAY-04 (legend-hvvn): pay out approved refunds whose provider call has not
// finished (unknown outcome, pending). Its own loop, not the relay tick: each
// provider call may take up to a minute and must never stall the outbox relay.
// Rounds never overlap; each tenant sweep has a time budget of its own.
const REFUND_PAYOUT_SWEEP_INTERVAL_MS = 30_000;
let refundSweepStopped = false;
let refundSweepTimer: NodeJS.Timeout | null = null;
let refundSweepRound: Promise<void> = Promise.resolve();
async function runRefundPayoutRound() {
  try {
    const tenants = await registry.query<{ id: string }>(
      "SELECT id FROM app.active_tenant_registry",
    );
    for (const { id } of tenants.rows) {
      if (refundSweepStopped) return;
      try {
        await sweepApprovedRefundPayouts(
          await resolveContext(id),
          new Date(),
          undefined,
          undefined,
          () => refundSweepStopped,
        );
      } catch {
        console.error("Refund payout sweep failed");
      }
    }
  } catch {
    console.error("Refund payout sweep failed");
  }
}
function scheduleRefundPayoutRound() {
  if (refundSweepStopped) return;
  refundSweepTimer = setTimeout(() => {
    refundSweepRound = runRefundPayoutRound().finally(
      scheduleRefundPayoutRound,
    );
  }, REFUND_PAYOUT_SWEEP_INTERVAL_MS);
}
async function stopRefundPayoutSweep() {
  refundSweepStopped = true;
  if (refundSweepTimer) clearTimeout(refundSweepTimer);
  await refundSweepRound;
}
try {
  await runtime.start();
  await relay.start();
  scheduleRefundPayoutRound();
} catch (error) {
  refundSweepStopped = true;
  await runtime.stop().catch(() => {});
  await registry.end();
  throw error;
}
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await stopRefundPayoutSweep();
  await relay.stop();
  await runtime.stop();
  await registry.end();
  await pool.end();
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
