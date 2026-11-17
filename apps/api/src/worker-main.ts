import "./load-env";
import "./role-worker";
import { Pool } from "pg";
import type { ObjectStorage } from "@starter/shared/adapters";
import { assertDeploymentEnv } from "@starter/shared/env";
import {
  CONTROL_PLANE_DESTINATION,
  CONTROL_PLANE_RELAYED_DESTINATIONS,
  CONTROL_PLANE_TENANT_ID,
} from "@starter/shared/events";
import {
  loadWorkerConfig,
  resolveMaintenanceDatabaseUrl,
} from "./worker/production-config.ts";
import { sql } from "drizzle-orm";
import {
  assertTrustedScopedContext,
  tenantIdSchema,
  ulidToUuid,
  uuidToUlid,
} from "@starter/shared/core";
import { databaseUrl } from "./db/connection";
import { verifyMaintenanceConnection, verifyQueueConnection } from "./db/role";
import { withTenant } from "./db/tenant.ts";
import { db, pool } from "./db";
import {
  consumeOutbox,
  markOutboxDead,
  relayOutbox,
} from "./services/core-outbox";
import { resolveFilledOutboxGaps } from "./services/core-outbox-gaps.ts";
import { deliverControlPlaneEvent } from "./services/control-plane-events.ts";
import { deliverIdentityEvent } from "./services/identity-events.ts";
import { createNotificationConsumer } from "./services/notification-consumer.ts";
import { deliverNotificationAttempt } from "./services/notification-delivery.ts";
import { expireDueApprovalRequests } from "./services/platform-approval.service.ts";
import { runPosReceiptEmailJob } from "./worker/pos-receipt-email.job.ts";
import { runPurchasingPoEmailJob } from "./worker/purchasing-po-email.job.ts";
import { handlePurchasingApprovalResolved } from "./services/purchasing-approval-consumer.ts";
import {
  expireStaleQueueNotifications,
  releaseExpiredSlotHolds,
} from "./services/facility-slots.service.ts";
import {
  handlePaymentPaid,
  handleReservationConfirmed,
} from "./services/reservation-consumers.ts";
import {
  deliverInventoryGlEvent,
  retryBlockedInventoryGl,
} from "./services/inventory-gl-consumer.ts";
import {
  deliverAutoJournalEvent,
  retryParkedAutoJournals,
} from "./services/accounting-auto-journal-consumer.ts";

import { deliverPayrollGlEvent } from "./services/payroll-gl-consumer.ts";
// legend-111j
import { deliverFacilityEntitlementEvent } from "./services/facility-entitlement-consumer.ts";
import { deliverLoyaltyEarnEvent } from "./services/loyalty-earn-consumer.ts";
import { deliverWifiQuotaEvent } from "./services/wifi-quota-consumer.ts";
import { runLoyaltyBalanceCheckSweep } from "./worker/loyalty-balance-check.job.ts";
import { redriveEdgeOrderRefusalsForTenant } from "./worker/edge-order-redrive.job.ts";
import { runLoyaltyClaimRecoverySweep } from "./worker/loyalty-claim-recovery.job.ts";
import { runRedemptionExpirySweep } from "./worker/redemption-expiry.job.ts";
import { runSegmentMaterializeSweep } from "./worker/segment-materialize.job.ts"; // legend-ts50
// legend-3zd1
import { runLoyaltyTierSweep } from "./worker/loyalty-tier.job.ts";
import { runLoyaltyExpirySweep } from "./worker/loyalty-expiry.job.ts";
import { parseEdgeRuntimeConfig } from "./edge/config.ts";
import { deliverOrderPaymentEvent } from "./services/order-payment-consumers.ts";
import { deliverOrderRecoveryRefundEvent } from "./services/order-recovery-refund.ts";
import { deliverIssueChargeEvent } from "./services/order-recovery-charge.ts";
import { deliverSwapKitchenEvent } from "./services/order-recovery-swap-kitchen.ts";
import { restoreExpiredSoldOut } from "./services/menu-availability.ts";
import { sweepInactiveOpenBillSessions } from "./services/open-bill-control.service.ts";
import {
  deliverDeliveryChannelEvent,
  syncStaleDeliveryChannels,
} from "./services/delivery-sync-consumer.ts";
import { deliverRecipeDeductionEvent } from "./services/recipe-deduction.service.ts";
import { setInventoryRecipeSource } from "./services/inventory-ops.shared.ts";
import { setAuditWriter } from "./services/audit-writer";
import { coreAuditWriter } from "./services/core-audit-writer";
import { recipeBomSource } from "./services/recipe-bom.service.ts";
import { retryDeliveryPlatformIntents } from "./services/delivery-platform-retry.ts";
import {
  createMenuPrintSweepLoopIfEnabled,
  menuPrintOutboxDeliver,
} from "./worker/menu-print.job.ts";
import { createMenuPdfRenderer } from "./services/menu-pdf-renderer.ts";
import { sweepUnpaidQrOrders } from "./services/qr-order-consumers.ts";
import { fireDueBreakfastOrders } from "./services/facility-breakfast-consumers.ts";
import { setQrOrderDepositCreditLookup } from "./services/qr-order-ports.ts";
import { qrOrderSettlementLookup } from "./services/qr-order.service.ts";
import { setTableSessionSettlementLookup } from "./services/table-session.service.ts";
import { depositCreditForSession } from "./services/reservation-lifecycle.ts";
import {
  handleRefundApprovalResolved,
  sweepApprovedRefundPayouts,
} from "./services/payment-refund.service.ts";
import { handleAiActionApprovalResolved } from "./services/ai-action-request.service.ts";
import { handleHrisApprovalResolved } from "./services/hris-approval-consumers.ts";
import { runScheduledLeaveJobs } from "./services/hris-leave-jobs.ts";
import { runScheduledExitClearance } from "./services/hris-offboarding-jobs.ts";
import { handleJournalApprovalResolved } from "./services/accounting-journal-consumers.ts";
import { handleProfitShareApprovalResolved } from "./services/profit-share-approval-consumers.ts";
import { handleReconciliationApprovalResolved } from "./services/payment-reconciliation-approval-consumer.ts";
import { handleApprovalResolved } from "./services/staff-override-consumers.ts";
import { createPaymentReservationDepositPort } from "./services/reservation-deposit-payment.ts";
import { setReservationDepositPort } from "./services/reservation-ports.ts";
import { retryPendingRefunds } from "./services/reservation-refunds.ts";
import {
  sweepReservationReminders,
  sweepStaleDepositHolds,
} from "./services/reservation-sweeps.ts";
import { sweepOverdueServiceRequests } from "./services/service-request.service.ts";
import { expireDueSupportAccessGrants } from "./services/platform-support.service.ts";
import { generateScheduledChecklistRuns } from "./services/operations-checklist-scheduler.service.ts";
import { sweepMissedChecklistRuns } from "./services/operations-escalation.service.ts";
import { sweepEquipmentServiceReminders } from "./services/operations-equipment-reminder.service.ts";
import { sweepExpiredPrepLabels } from "./services/operations-food-safety.service.ts";
import { createPgBoss, createWorkerRuntime } from "./worker/runtime";
import {
  createRelayRuntime,
  createRelayScheduler,
  createWakeListener,
} from "./worker/relay";
import { touchHeartbeat } from "./worker/heartbeat";
import { runInventoryParAlertJob } from "./worker/inventory-par-alerts.job.ts";
import { runHppRecomputeJob } from "./worker/hpp-recompute.job.ts";
import {
  createMaintenancePool,
  probeMaintenanceConnection,
  registerAuditRetentionJob,
} from "./worker/audit-retention.job.ts";
import { registerWaInboundRetentionJob } from "./worker/wa-inbound-retention.job.ts";
import { runInventoryExpiryJob } from "./worker/inventory-expiry.job.ts";
import { sweepParkedAccessEvents } from "./worker/access-drain.job.ts";
import { startGatewayProbeSweep } from "./worker/payment-failover-probe.job.ts";
import { runAiForecastJob } from "./worker/ai-forecast.job.ts";
import { runAiAnomalyJob } from "./worker/ai-anomaly.job.ts";
import { runAiDailySummaryJob } from "./worker/ai-daily-summary.job.ts";
import { runMetricsDailyJob } from "./worker/metrics-daily.job.ts";
import { runDueDepreciation } from "./worker/accounting-depreciation.job.ts";
import { runPayoutEvidenceBackfillSweep } from "./worker/payout-evidence-backfill.job.ts";
import { runPayoutGlRecoverySweep } from "./worker/payout-gl-recovery.job.ts";
import { runPayoutApprovalReceiptSweep } from "./worker/payout-approval-receipt.job.ts";
import { runPayoutTrustedReconSweep } from "./worker/payout-trusted-recon.job.ts";
import { runPaymentGatewayPollJob } from "./worker/payment-gateway-poll.job.ts";
import { runPosQrisHoldCheckJob } from "./worker/pos-qris-hold-check.job.ts";
import { runPosQrisReleaseReconJob } from "./worker/pos-qris-release-recon.job.ts";
import { runPaymentVaReleaseReconJob } from "./worker/payment-va-release-recon.job.ts";
import { expireDueIntents } from "./services/payment.service.ts";
import { createDuitkuGateway } from "./services/payment-duitku.ts";
import { registerPaymentGateway } from "./services/payment-gateway.ts";
import { registerPaymentRefundGateway } from "./services/payment-refund-gateway.ts";
import { createDoitGateway } from "./services/payment-doit.ts";
import { runDueRecurringJournals } from "./services/accounting-journal-recurring.service.ts";
import { env } from "./config/env";
import {
  consoleLikeLog,
  createStorageRuntimeFromEnv,
} from "./services/core-storage-runtime.ts";
import { registerAttendanceSelfiePurgeJob } from "./worker/attendance-selfie-purge.job.ts";
import { registerEdgeSelfieOrphanSweepJob } from "./worker/edge-selfie-orphan-sweep.job.ts";
import { registerBlindIndexRebuildJob } from "./worker/blind-index-rebuild.job.ts";
import { registerHrisPiiResealJob } from "./worker/hris-pii-reseal.job.ts";
import { registerDataKeyRotationJob } from "./worker/data-key-rotation.job.ts";
import { registerSealedSecretResealJob } from "./worker/sealed-secret-reseal.job.ts";
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
// legend-v3vo: e-receipt links resolve on the cloud only; same fail-closed rule.
const sendsReceiptEmails = edgeRuntime.ok && !edgeRuntime.config.edgeMode;
// legend-jm5c: refunds are cloud-only. An edge worker must neither pay out nor
// escalate them (duplicate alerts, provider calls from the edge); same
// fail-closed rule.
const sweepsRefunds = edgeRuntime.ok && !edgeRuntime.config.edgeMode;
// legend-7h5s: approval deadlines, leave, exit clearance and support-access
// expiry own cloud-only data (their routes are not in EDGE_API_PREFIXES) and
// may emit tenant-wide cloud-sync events, which an edge node must never
// produce (appendOutbox refuses them). Same fail-closed rule. Facility slot
// holds are NOT gated: /api/facility is served on the edge (offline smart lock).
// legend-rs2xy: the same holds for the two accounting jobs that reach tenant-wide
// producers without a route gate: runDueDepreciation (fixed-asset posting) and
// runDueRecurringJournals (journal posting + approval). Both run inside
// `if (sweepsCloudOwnedData)`; edge-worker-cloud-only-gate-855.test.ts pins it.
const sweepsCloudOwnedData = edgeRuntime.ok && !edgeRuntime.config.edgeMode;
// legend-usyi: the audit retention purge runs on the cloud only, as its own
// maintenance login. A production cloud worker without the URL fails here at
// startup; an edge worker skips the job (follow-up: edge retention).
const maintenanceUrl = resolveMaintenanceDatabaseUrl({
  env: process.env,
  cloud: postsInventoryGl,
});
// RSV-02 (legend-t8bz): DP links go through WS-05; fails closed while no
// payment gateway is installed.
setReservationDepositPort(createPaymentReservationDepositPort());
// legend-i83ls: the same session money ports as app.ts. Without them the
// worker reads a zero deposit credit and no table-session settlement, so any
// session code it runs (open-bill inactivity sweep, unpaid QR sweep) would see
// wrong numbers.
setQrOrderDepositCreditLookup(depositCreditForSession);
setTableSessionSettlementLookup(qrOrderSettlementLookup);
// INV-02 (legend-db6): recipe source for the stock deduction consumer.
setInventoryRecipeSource(recipeBomSource);
// legend-arj.6: the sensitive-write audit port (role-assignment end inside
// exit clearance) fails closed with a 503 until a writer is installed, as in
// app.ts. The worker never had one.
setAuditWriter(coreAuditWriter);
// PAY-02/03 (legend-b9i): the polling fallback asks DOIT for the status of
// pending intents whose webhook never arrived. The refund payout sweep
// (sweepApprovedRefundPayouts) sends approved refunds and polls pending ones
// through the same adapter (PaymentRefundPort, legend-0ogy), only while
// DOIT_REFUNDS_ENABLED is on; otherwise the refund port stays fail-closed.
const doitGateway = createDoitGateway();
registerPaymentGateway(doitGateway);
if (env.DOIT_REFUNDS_ENABLED) registerPaymentRefundGateway(doitGateway);
// legend-3gna: the API and the worker must agree on this switch; the value in
// both startup logs makes a split visible.
logger.info(
  { doitRefundsEnabled: env.DOIT_REFUNDS_ENABLED },
  "DOIT_REFUNDS_ENABLED",
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
// Object storage for the payout proof backfill; set once the storage runtime is
// built at start-up (null without STORAGE_*).
let payoutEvidenceStorage: ObjectStorage | null = null;
const registry = new Pool({
  connectionString: workerUrl,
  max: 1,
  verify: verifyQueueConnection,
});
registry.on("error", () => console.error("Worker registry connection error"));
async function resolveContext(tenantId: string) {
  const parsed = tenantIdSchema.parse(tenantId);
  // 488 item 4: the control-plane sentinel is not a tenant row, so it skips the
  // registry, but only on a cloud worker; an edge worker never serves it. Any
  // other non-active tenant still throws.
  if (parsed === CONTROL_PLANE_TENANT_ID) {
    if (!postsInventoryGl)
      throw new Error(
        "Control-plane stream is served by the cloud worker only",
      );
  } else {
    const result = await registry.query(
      "SELECT id FROM app.active_tenant_registry WHERE id = $1",
      [parsed],
    );
    if (result.rowCount !== 1) throw new Error("Worker tenant is not active");
  }
  const context = await handlers.resolveContext(parsed);
  assertTrustedScopedContext(context);
  if (context.outletScope.kind !== "tenant")
    throw new Error("Worker requires tenant-wide scope");
  if (context.tenant.tenantId !== parsed)
    throw new Error("Worker tenant context mismatch");
  return context;
}
const boss = createPgBoss(workerUrl);
const maintenancePool = maintenanceUrl
  ? createMaintenancePool(maintenanceUrl, verifyMaintenanceConnection)
  : null;
const runtime = createWorkerRuntime({
  boss,
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
        // 488 item 4: control-plane rows and the sentinel tenant belong together,
        // both ways. A control row never reaches the transport or the cloud-sync
        // consumers; a tenant row never reaches the control-plane consumer.
        const controlTenant =
          context.tenant.tenantId === CONTROL_PLANE_TENANT_ID;
        if (controlTenant !== (route.destination === CONTROL_PLANE_DESTINATION))
          throw new Error("Control-plane route does not match tenant");
        if (controlTenant) {
          await deliverControlPlaneEvent(context, event, tx);
          return;
        }
        if (route.destination === "identity") {
          // legend-83ll: session.revoked closes the session row (idempotent).
          await deliverIdentityEvent(context, event, tx);
          await handlers.deliverEvent(context, event, key, tx, route);
        } else if (route.destination === "notification") {
          await createNotificationConsumer(
            context,
            handlers.resolveNotificationRecipients,
          )(event, key, tx);
        } else {
          // legend-fy5y: a new tenant's first admin is invited by email (cloud
          // only, where email is sent). Replay safe: the consumer dedupes on
          // (tenant, source event) and the notification dedupe key.
          if (event.name === "tenant.created" && sendsReceiptEmails)
            await createNotificationConsumer(
              context,
              handlers.resolveNotificationRecipients,
            )(event, key, tx);
          // RSV-02 (legend-t8bz): a paid DP confirms its reservation first
          // (idempotent, replay safe), then the deployment consumer runs.
          if (event.name === "payment.paid")
            await handlePaymentPaid(context, event);
          // RSV-03 (legend-lb3c): the guest's confirmation message, written
          // only if the booking is still confirmed now. Cloud only, like the
          // reminder: an edge must not message guests.
          if (event.name === "reservation.confirmed" && sendsReceiptEmails)
            await handleReservationConfirmed(context, event);
          // ORD-02 (legend-x4qy/kk7): a verified payment fires its QR order
          // (in this consumption transaction) or settles its POS bill; an
          // expired/failed QR payment re-offers a code or voids the order.
          // Each consumer re-reads its locked rows, so a replay is a no-op.
          await deliverOrderPaymentEvent(context, event, tx);
          // legend-zm1e6: a resolved swap issue becomes a replacement order
          // line, the old line is voided and the new one routed to its KDS
          // station. Idempotent (issue row lock), no extra charge, not gated.
          await deliverSwapKitchenEvent(context, event, tx);
          // legend-i83ls: a dearer swap that got its replacement line owes
          // the price difference (+ service charge and PBJT): one charge row
          // per issue, paid through its own link or routed to the cashier.
          // Runs after the swap consumer (needs the replacement line).
          await deliverIssueChargeEvent(context, event, tx);
          // legend-94q2l: an approved manual refund of a failed item opens its
          // payment refund request (not paid out; WS-05 approves). Idempotent.
          // legend-iu91r: cloud only, like every refund (legend-jm5c): an
          // edge worker must not file a refund the cloud also files.
          if (sweepsRefunds)
            await deliverOrderRecoveryRefundEvent(context, event, tx);
          // PRD §3.19 Jurnal Otomatis (legend-9pz9, legend-o9q9), cloud only:
          // sales, refunds, gateway receipts and payouts post their journal in
          // a savepoint; expected accounting failures park for the sweep and
          // never fail this delivery.
          if (postsInventoryGl)
            await deliverAutoJournalEvent(context, event, tx);
          // legend-111j (WS-08 member loyalty), cloud only: a paid order earns
          // points for its attached member, a refund or final-order void
          // reverses them, in a savepoint under the profile lock.
          if (postsInventoryGl)
            await deliverLoyaltyEarnEvent(context, event, tx);
          // legend-fjk5 (WS-09 F25), cloud only: a paid order issues package
          // and min-spend facility entitlements, a refund cancels what is
          // left of them (savepoint, replay is a no-op).
          if (postsInventoryGl)
            await deliverFacilityEntitlementEvent(context, event, tx);
          // legend-kmd3 (WS-09 Wi-Fi quota), cloud only: paid money and
          // refunds of a member's order move the daily Wi-Fi quota of the
          // account (ledger row + recompute of its open sessions) in a savepoint.
          if (postsInventoryGl) await deliverWifiQuotaEvent(context, event, tx);
          // PRD §3.19 (legend-w1vo), cloud only: stock.moved of a count, waste
          // or sale posts its GL journal in a savepoint; a closed period or a
          // missing mapping parks the source for the sweep, never fails this.
          if (postsInventoryGl)
            await deliverInventoryGlEvent(context, event, tx);
          // WS-07 (legend-4n3r), cloud only: payroll lock/paid/reversal, kasbon
          // and cash reimbursement post their GL journals; errors retry.
          if (postsInventoryGl) await deliverPayrollGlEvent(context, event, tx);
          // WS-08 (legend-5bn3), cloud only: 86 and menu/price changes reach
          // the open delivery channels through their adapters. A platform
          // failure never fails this event: the channel is marked error/stale
          // for the delivery sync sweep below.
          if (postsInventoryGl)
            await deliverDeliveryChannelEvent(context, event, tx);
          // INV-02/KDS-07 (legend-db6): a paid order, a remake/comp and the
          // day close deduct recipe stock in this consumption transaction.
          await deliverRecipeDeductionEvent(context, event, tx);
          // AUTH-06 (legend-obh5): a phone-approved POS override settles from
          // the approval chain re-read under its row lock.
          await handleApprovalResolved(context, event);
          // PRD §3.18 (legend-9yz): a decided purchasing chain settles its PR/PO
          // from the chain re-read under the row lock; replays are no-ops.
          await handlePurchasingApprovalResolved(context, event);
          // PAY-04 (legend-hvvn): an approved refund chain settles the refund;
          // the payout itself runs from the approve call or the payout sweep.
          await handleRefundApprovalResolved(context, event);
          // PAY recon (PRD §3.7): an approved chain closes the reconciliation
          // case; rejected/expired reopens it, re-read under the case row lock.
          await handleReconciliationApprovalResolved(context, event);
          // WS-10 (legend-hggk): approved/rejected leave and overtime settle
          // from the chain outcome re-read under the request row lock.
          await handleHrisApprovalResolved(context, event);
          // Manual/recurring journals (legend-vmyg): settle from the chain.
          await handleJournalApprovalResolved(context, event);
          // Profit share (legend-33im6): distribution runs and recipient
          // changes settle from the chain outcome re-read under the row lock.
          await handleProfitShareApprovalResolved(context, event);
          // WS-12 (legend-zw9r): approved AI/MCP action requests execute as the requester.
          await handleAiActionApprovalResolved(context, event);
          // legend-iuvq (F8), cloud only: a menu/price/availability change marks
          // the outlet's printable menu dirty in this transaction; the sweep
          // below renders it once, debounced. Other events touch no outlet.
          if (postsInventoryGl) await menuPrintOutboxDeliver(event, key, tx);
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
  // 488 item 4 (cloud only): sweep the control-plane stream every tick, with
  // no tenant-status filter, claiming only the routed destination.
  controlPlaneRelay: postsInventoryGl
    ? async () => {
        const controlContext = await resolveContext(CONTROL_PLANE_TENANT_ID);
        await relayOutbox(
          db,
          controlContext,
          runtime.enqueue,
          async (gap) => {
            try {
              await handlers.requestMissing(controlContext, gap);
            } catch {
              console.error("Outbox gap request could not be recorded");
            }
          },
          { destinations: CONTROL_PLANE_RELAYED_DESTINATIONS },
        );
        try {
          await resolveFilledOutboxGaps(db, controlContext);
        } catch {
          console.error("Outbox gap resolution sweep failed");
        }
      }
    : undefined,
  listActiveTenantIds: async () =>
    (
      await registry.query<{ id: string }>(
        "SELECT id FROM app.active_tenant_registry",
      )
    ).rows.map((row) => row.id),
  resolveContext,
  // legend-z649: compose healthcheck reads this file's age.
  onProgress: () => touchHeartbeat(),
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
    if (sweepsCloudOwnedData) {
      try {
        await expireDueApprovalRequests(context);
      } catch {
        console.error("Approval deadline sweep failed");
      }
    }
    // legend-arj.1: leave accrual, carry-over and carry-over expiry once per
    // local day (idempotent through the ledger). Fail closed: an error leaves
    // no day marker, so the next tick retries, and never blocks the relay.
    if (sweepsCloudOwnedData) {
      try {
        await runScheduledLeaveJobs(context);
      } catch {
        console.error("Scheduled leave jobs failed");
      }
    }
    // legend-arj.6: exit clearance for offboardings past their last working
    // day, as the system actor. Same fail-closed rule: a failed employee leaves
    // no day marker, so the next tick retries; never blocks the relay.
    if (sweepsCloudOwnedData) {
      try {
        await runScheduledExitClearance(context);
      } catch {
        console.error("Scheduled exit clearance failed");
      }
    }
    // TEN-04: record lapsed support-access sessions exactly once.
    if (sweepsCloudOwnedData) {
      try {
        await expireDueSupportAccessGrants(context);
      } catch {
        console.error("Support access expiry sweep failed");
      }
    }
    // legend-132mw: an edge sale or void refused for a transient reason (lock
    // timeout, deadlock) is parked but never redelivered; run its ingest again.
    // Idempotent, bounded per tick (200 per kind, 5 s lock timeout per order),
    // tenant-scoped. Cloud only; a sweep error never blocks the relay.
    if (sweepsCloudOwnedData) {
      try {
        await redriveEdgeOrderRefusalsForTenant(context);
      } catch {
        console.error("Edge order redrive sweep failed");
      }
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
    // FAC-02 (legend-ke4z): a notified queue guest who did not claim the unit
    // in time expires and the next guest is notified.
    try {
      await withTenant(db, context, (tx) =>
        expireStaleQueueNotifications(tx, context),
      );
    } catch {
      console.error("Facility queue claim expiry sweep failed");
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
    // legend-jm5c: cloud only; on an edge it would write payment_refunds rows
    // that nothing there ever pays out.
    if (sweepsRefunds) {
      try {
        await retryPendingRefunds(context, new Date());
      } catch {
        console.error("Reservation refund retry sweep failed");
      }
      // RSV-03 (legend-lb3c): H-24 reminder with the guest kelola link.
      // Cloud only, like the refunds: an edge must not message guests.
      try {
        await sweepReservationReminders(context, new Date());
      } catch {
        console.error("Reservation reminder sweep failed");
      }
    }
    // §3.19 Aset Tetap (legend-hpgo): post last month's depreciation once per
    // legal entity (idempotent per entity+period and asset+period). Fail closed.
    // Cloud only (legend-rs2xy): the posting emits tenant-wide events.
    if (sweepsCloudOwnedData) {
      try {
        await runDueDepreciation(context, new Date());
      } catch {
        console.error("Depreciation job sweep failed");
      }
    }
    // Payroll payout GL (legend-pfk3q): settlements and bank fees that wait for
    // a mapping or source account no event will replay. Idempotent per batch,
    // fail closed; a sweep error never blocks the relay. Cloud only, like the
    // other sweeps of cloud-owned data.
    if (sweepsCloudOwnedData) {
      try {
        await runPayoutGlRecoverySweep(context, new Date());
      } catch {
        console.error("Payout GL recovery sweep failed");
      }
      // Payout proofs from before the stored-byte fingerprints (legend-8vcsg):
      // fills in their hashes so a re-upload is recognised; until it has, the
      // tenant refuses new proofs for returns (fail closed). Needs the object
      // storage; without STORAGE_* nothing runs and the tenants stay closed.
      try {
        await runPayoutEvidenceBackfillSweep(context, new Date(), {
          storage: payoutEvidenceStorage,
        });
      } catch {
        console.error("Payout evidence backfill sweep failed");
      }
      // Trusted payout boundary (legend-i01jp): once a day, re-checks every
      // corrected / overpaid / returned item and recorded posting source
      // against its attestations, audit rows, binding, proof file and journal;
      // a difference is flagged for finance. Read-only apart from the flag.
      try {
        await runPayoutTrustedReconSweep(context, new Date(), {
          storage: payoutEvidenceStorage,
        });
      } catch {
        console.error("Payout trusted recon sweep failed");
      }
      // Receipts of attested payout steps (legend-7gghu): each row of the
      // append-only approval log becomes one notification to the person whose
      // login made the step. Idempotent, bounded, fail closed.
      try {
        await runPayoutApprovalReceiptSweep(context, new Date());
      } catch {
        console.error("Payout approval receipt sweep failed");
      }
    }
    // PAY-02/03 (legend-b9i): settle pending intents whose DOIT webhook never
    // arrived and retry stored webhook events. Fail closed like the sweeps.
    try {
      await runPaymentGatewayPollJob(context, new Date());
    } catch {
      console.error("Payment gateway poll sweep failed");
    }
    // legend-yhia9 (D-04): close QRIS holds on provider proof only. Cloud and
    // edge; fail closed like the sweeps (a hold stays frozen on any error).
    try {
      await runPosQrisHoldCheckJob(context, new Date());
    } catch {
      console.error("QRIS hold check sweep failed");
    }
    // legend-adiov (so-879): keep asking the provider about every force
    // released QRIS until it answers for good; found money is parked once.
    try {
      await runPosQrisReleaseReconJob(context, new Date());
    } catch {
      console.error("QRIS release reconciliation sweep failed");
    }
    // legend-5wn1e: the same for every VA code staff released without a
    // provider-final answer; found money is parked once, never settles the bill.
    try {
      await runPaymentVaReleaseReconJob(context, new Date());
    } catch {
      console.error("VA release reconciliation sweep failed");
    }
    // legend-jf4i (PRD §3.13 Siklus Pembayaran): expire pending intents whose
    // time is up and emit payment.expired, so a code lapses without a guest
    // request. A code the gateway issued is left to the poller above (money may
    // land late); it times out there after 24 h. Idempotent and capped per
    // run; a sweep error never blocks the relay.
    try {
      await expireDueIntents(context, new Date(), 200, {
        leaveGatewayReconciling: true,
      });
    } catch {
      console.error("Payment intent expiry sweep failed");
    }
    // PRD §3.19 (legend-w1vo), cloud only: retry stock sources whose journal
    // was blocked (closed period, missing mapping). Retry only, never another
    // period. A sweep error never blocks the relay.
    if (postsInventoryGl) {
      // A temporary entity lock must not leave a guest claim parked forever.
      // Failure keeps its remaining lifetime frozen and retries next tick.
      try {
        await runLoyaltyClaimRecoverySweep(context, new Date());
      } catch {
        console.error("Loyalty claim recovery failed");
      }
      try {
        await retryBlockedInventoryGl(context, new Date());
      } catch {
        console.error("Inventory GL retry sweep failed");
      }
    }
    // WS-08 (legend-5bn3), cloud only: trailing edge of the delivery menu
    // debounce. Pushes open channels left stale/error (menu change inside the
    // window, refused 86, reopened store). A sweep error never blocks the relay.
    if (postsInventoryGl) {
      try {
        await syncStaleDeliveryChannels(context, new Date());
      } catch {
        console.error("Delivery channel sync sweep failed");
      }
      // legend-r7vxn: resend platform status steps whose outcome was unknown.
      try {
        await retryDeliveryPlatformIntents(context, new Date());
      } catch {
        console.error("Delivery platform retry sweep failed");
      }
    }
    // §3.19 (legend-9pz9), cloud only: retry parked auto-journals (mapping
    // missing, period closed race). A sweep error never blocks the relay.
    if (postsInventoryGl) {
      try {
        await retryParkedAutoJournals(context, new Date());
      } catch {
        console.error("Auto-journal retry sweep failed");
      }
    }
    // §3.19 Jurnal Berulang (legend-vmyg): post due occurrences of approved
    // templates, one transaction per period. Fail closed, next tick resumes.
    // Cloud only (legend-rs2xy): posting and its approval emit tenant-wide events.
    if (sweepsCloudOwnedData) {
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
    // §17 HPP menu costs follow ingredient cost changes within 5 minutes
    // (legend-2qq); self-throttled to once a minute per tenant.
    try {
      await runHppRecomputeJob(context);
    } catch {
      console.error("HPP recompute sweep failed");
    }
    // Parked staff PIN / POS override edge rows of outlets that never send
    // another live access event (legend-0q3r); self-throttled.
    try {
      await sweepParkedAccessEvents(context);
    } catch {
      console.error("Parked access drain sweep failed");
    }
    // Probe the payment gateway of outlets with an open failover incident, so
    // a recovery is recorded without guest traffic and a long outage does not
    // alert again (legend-5ffks). Started, not awaited: probes can wait on the
    // gateway for seconds and must not hold up the relay. Self-throttled.
    void startGatewayProbeSweep(context);
    // WS-12 AI-07 rule-based forecast, next 7 days per outlet (legend-hkd4);
    // self-throttled, never blocks the relay.
    try {
      await runAiForecastJob(context);
    } catch {
      console.error("AI forecast sweep failed");
    }
    // WS-12 AI-09 anomaly alerts + AI-10 daily summary for the previous
    // business day (legend-lely); idempotent via unique keys.
    try {
      await runAiAnomalyJob(context);
    } catch {
      console.error("AI anomaly sweep failed");
    }
    try {
      await runAiDailySummaryJob(context);
    } catch {
      console.error("AI daily summary sweep failed");
    }
    try {
      await runMetricsDailyJob(context);
    } catch {
      console.error("Metrics daily sweep failed");
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
    // legend-111j (LOY-02), cloud only: after 02:00 Asia/Jakarta compare every
    // member balance with its ledger sum, once per tenant per day. A mismatch
    // writes a `balance_mismatch` anomaly; a sweep error never blocks the relay.
    if (postsInventoryGl) {
      try {
        await runLoyaltyBalanceCheckSweep(context, new Date());
      } catch {
        console.error("Loyalty balance check failed");
      }
      // legend-m4p5: settle pending reward redemptions past their expiry
      // (restore points and stock), once per tenant per day. Never blocks the relay.
      try {
        await runRedemptionExpirySweep(context, new Date());
      } catch {
        console.error("Redemption expiry sweep failed");
      }
      // legend-ts50: rebuild saved segment members once per tenant per day.
      try {
        await runSegmentMaterializeSweep(context, new Date());
      } catch {
        console.error("Segment materialize sweep failed");
      }
      // legend-3zd1: nightly tier evaluation first (the birthday bonus reads the
      // tier), then expire due points + birthday bonus, once per tenant per day.
      // Never blocks the relay.
      try {
        await runLoyaltyTierSweep(context, new Date());
      } catch {
        console.error("Loyalty tier sweep failed");
      }
      try {
        await runLoyaltyExpirySweep(context, new Date());
      } catch {
        console.error("Loyalty expiry sweep failed");
      }
    }
    // PRD §3 F11 e-receipt (legend-v3vo): send queued receipt emails. The
    // sealed address is opened only inside the job; nothing is logged here.
    // Cloud only: the public receipt link resolves on the cloud, and a token
    // minted on an edge exists only in the edge database, so an edge would
    // mail a dead link. Edge rows stay queued (follow-up bead).
    if (sendsReceiptEmails) {
      try {
        await runPosReceiptEmailJob([context], {
          email: handlers.notificationDelivery?.email ?? null,
        });
      } catch {
        console.error("POS receipt email sweep failed");
      }
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
    // OPS-04 (legend-o032): remind the outlet supervisors once per due date
    // when a maintenance schedule is within 7 days of service. Fail closed
    // like the other sweeps.
    try {
      await withTenant(db, context, (tx) =>
        sweepEquipmentServiceReminders(tx, context),
      );
    } catch {
      console.error("Equipment service reminder sweep failed");
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
    // oa0qk (owner Q43): send paid ticket breakfast orders to the kitchen at
    // fire_at and cancel unpaid ones. Only a `paid` order is ever fired.
    try {
      await fireDueBreakfastOrders(context, new Date());
    } catch {
      console.error("Facility breakfast sweep failed");
    }
    // ORD-07 (legend-7qg): escalate waiter calls / bill requests left open
    // past SERVICE_REQUEST_OVERDUE_SECONDS, once each. The relay ticks every
    // minute, so an escalation fires 180-240 s after the call.
    try {
      await sweepOverdueServiceRequests(new Date(), context);
    } catch {
      console.error("Service request overdue sweep failed");
    }
    // legend-cqrw (PRD §3 F43): alert the zone waiters of open-bill sessions
    // idle past the outlet's limit, once per idle spell. Same fail-closed rule.
    try {
      await sweepInactiveOpenBillSessions(new Date(), context);
    } catch {
      console.error("Open bill inactivity sweep failed");
    }
    // legend-1am2 (PRD §8 Ketersediaan): lift every 86 whose soldOutUntil
    // passed and broadcast item.restored (system actor) even with no staff
    // board open. Idempotent; same fail-closed rule as the sweeps above.
    try {
      await withTenant(db, context, (tx) =>
        restoreExpiredSoldOut(tx, context, {
          actorUserId: null,
          now: new Date(),
        }),
      );
    } catch {
      console.error("Item 86 deadline sweep failed");
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
// legend-iuvq: renders dirty printable menus every 30 s. Needs object storage,
// so it is built after the storage runtime and stays null without STORAGE_*.
let menuPrintSweep: ReturnType<typeof createMenuPrintSweepLoopIfEnabled> = null;
try {
  await runtime.start();
  if (maintenancePool) {
    // Fail the start on a wrong maintenance login (pool verify guard runs on
    // this first connection); the catch below cleans up.
    await probeMaintenanceConnection(maintenancePool);
    await registerAuditRetentionJob({ boss, pool: maintenancePool });
  }
  // legend-33mj: on-demand re-seal of HRIS PII after a key rotation.
  await registerHrisPiiResealJob({
    boss,
    database: db,
    log: consoleLikeLog(logger),
  });
  // legend-rg8yl: daily re-seal of integration and AI keys left on an old data key.
  await registerDataKeyRotationJob({
    boss,
    database: db,
    log: consoleLikeLog(logger),
  });
  // legend-tetyr: weekly re-seal of sealSecret columns without a key version column.
  await registerSealedSecretResealJob({
    boss,
    database: db,
    log: consoleLikeLog(logger),
  });
  // w8dfz.2: WhatsApp messages (90 days) and finished challenges (30 days);
  // service-scoped tables, so it runs on the app connection, not the maintenance login.
  await registerWaInboundRetentionJob({ boss, log: consoleLikeLog(logger) });
  // legend-n039: on-demand rebuild of blind indexes after a version change.
  await registerBlindIndexRebuildJob({
    boss,
    database: db,
    log: consoleLikeLog(logger),
  });
  // legend-dzh9q: the selfie purge deletes objects, so it needs the object
  // storage. Without STORAGE_* the worker still starts, with the job off.
  const storageRuntime = createStorageRuntimeFromEnv(
    process.env,
    db,
    consoleLikeLog(logger),
  );
  if (storageRuntime) {
    payoutEvidenceStorage = storageRuntime.storage;
    await registerAttendanceSelfiePurgeJob({
      boss,
      storage: storageRuntime.storage,
      database: db,
      log: consoleLikeLog(logger),
    });
    // legend-0wvoz: the orphan sweep of received edge selfies deletes objects too.
    await registerEdgeSelfieOrphanSweepJob({
      boss,
      storage: storageRuntime.storage,
      database: db,
      log: consoleLikeLog(logger),
    });
    // Sweep loop renders due outlets with the pdf-lib menu renderer; the
    // outbox consumer marks outlets dirty.
    if (postsInventoryGl)
      menuPrintSweep = createMenuPrintSweepLoopIfEnabled(
        {
          listTenantIds: async () =>
            (
              await registry.query<{ id: string }>(
                "SELECT id FROM app.active_tenant_registry",
              )
            ).rows.map((row) => row.id),
          resolveContext,
          deps: {
            storage: storageRuntime.storage,
            scanner: storageRuntime.scanner,
            renderer: createMenuPdfRenderer(),
          },
          onError: (message, tenantId) =>
            logger.error({ job: "menu_print_sweep", tenantId }, message),
          onRound: (result) => {
            if (result.failed > 0)
              logger.warn(
                { job: "menu_print_sweep", ...result },
                "menu print sweep round had failures",
              );
          },
        },
        (message) => logger.info({ job: "menu_print_sweep" }, message),
      );
  } else
    logger.warn(
      "Object storage is not configured (STORAGE_*): attendance selfie purge and edge selfie orphan sweep jobs not registered.",
    );
  await relay.start();
  if (sweepsRefunds) {
    scheduleRefundPayoutRound();
  }
  menuPrintSweep?.start();
} catch (error) {
  refundSweepStopped = true;
  await menuPrintSweep?.stop().catch(() => {});
  await runtime.stop().catch(() => {});
  await maintenancePool?.end().catch(() => {});
  await registry.end();
  throw error;
}
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await stopRefundPayoutSweep();
  await menuPrintSweep?.stop();
  await relay.stop();
  await runtime.stop();
  await maintenancePool?.end();
  await registry.end();
  await pool.end();
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
