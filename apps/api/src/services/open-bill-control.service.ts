// Open-bill controls (PRD v1.7 §3 F43 "Kontrol Open Bill", ORD-10; bead
// legend-cqrw): a bill value limit per session, and a waiter alert when an
// open-bill session sits idle. The policy is per outlet
// (`outlet_open_bill_policies`); PRD v1.7 gives no numbers, so a missing row
// falls back to the named defaults below. A missing policy never means "no
// limit".
//
// Bill-request SLO: an unhandled bill request is escalated by the existing
// `service_request.overdue` sweep (service-request.service.ts, 180 s). It is
// not duplicated here; the policy column `bill_request_slo_seconds` is stored
// for that sweep to read later.
//
// Alerts go to the zone's waiters through the same notification path as a
// waiter call (`zone_waiter_assignments`, `waiter_call` category, pg_notify at
// commit). They are never service_request rows.

import { and, eq, inArray, ne, notInArray, sql } from "drizzle-orm";
import { maskAuditChanges } from "@starter/shared/audit";
import {
  assertOutletInScope,
  createUlid,
  idr,
  outletIdSchema,
  toIsoDateTime,
  type Idr,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import { eventEnvelopeSchema } from "@starter/shared/events";
import {
  openBillErrorHttpStatus,
  openBillErrorMessages,
  openBillEvents,
  openBillPolicySchema,
  QR_ORDER_OPEN_BILL_LIMIT,
  upsertOpenBillPolicyInputSchema,
  type OpenBillPolicy,
  type UpsertOpenBillPolicyInput,
} from "@starter/shared/qr-order";
import { db } from "../db";
import { tableSessions, tables } from "../db/schema/floor";
import { outletOpenBillPolicies } from "../db/schema/open-bill";
import { paymentLinks } from "../db/schema/payment";
import { posOrderTenders } from "../db/schema/pos-order";
import { orders } from "../db/schema/qr-order";
import { zoneWaiterAssignments } from "../db/schema/service-request";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import { recordAudit } from "./core-audit";
import { appendOutbox } from "./core-outbox";
import { createNotificationConsumer } from "./notification-consumer";
import { remainingIdr } from "./pos-order-support";
import { depositCreditFor } from "./qr-order-ports";
import {
  buildRecipients,
  SERVICE_REQUEST_OVERDUE_SECONDS,
} from "./service-request.service";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Default bill limit per open-bill session: Rp 3.000.000 (decision, PRD silent). */
export const OPEN_BILL_DEFAULT_MAX_BILL_VALUE_IDR = 3_000_000;
/** Default idle time before the zone waiters are alerted: 45 minutes. */
export const OPEN_BILL_DEFAULT_INACTIVITY_MINUTES = 45;
/** Default bill-request SLO: the existing overdue sweep threshold (180 s). */
export const OPEN_BILL_DEFAULT_BILL_REQUEST_SLO_SECONDS =
  SERVICE_REQUEST_OVERDUE_SECONDS;

const EVENT_DESTINATION = "cloud-sync";
/** Sessions an inactivity sweep alerts per tenant per run (one tx each). */
const SWEEP_BATCH = 50;
const AUDIT_SAFE_FIELDS = [
  "id",
  "outletId",
  "sessionId",
  "tableId",
  "zoneId",
  "cartVersion",
  "currentBillIdr",
  "attemptedOrderIdr",
  "maxBillValueIdr",
  "policyIsDefault",
  "inactivityMinutes",
  "billRequestSloSeconds",
] as const;

function defaultPolicy(
  context: ScopedTenantContext,
  outletId: string,
): OpenBillPolicy {
  return openBillPolicySchema.parse({
    tenantId: context.tenant.tenantId,
    outletId,
    maxBillValueIdr: OPEN_BILL_DEFAULT_MAX_BILL_VALUE_IDR,
    inactivityMinutes: OPEN_BILL_DEFAULT_INACTIVITY_MINUTES,
    billRequestSloSeconds: OPEN_BILL_DEFAULT_BILL_REQUEST_SLO_SECONDS,
    isDefault: true,
  });
}

async function policyIn(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
): Promise<OpenBillPolicy> {
  const [row] = await tx
    .select()
    .from(outletOpenBillPolicies)
    .where(
      and(
        eq(outletOpenBillPolicies.tenantId, context.tenant.tenantId),
        eq(outletOpenBillPolicies.outletId, outletIdSchema.parse(outletId)),
      ),
    );
  if (!row) return defaultPolicy(context, outletId);
  return openBillPolicySchema.parse({
    tenantId: row.tenantId,
    outletId: row.outletId,
    maxBillValueIdr: row.maxBillValueIdr,
    inactivityMinutes: row.inactivityMinutes,
    billRequestSloSeconds: row.billRequestSloSeconds,
    isDefault: false,
  });
}

/** The outlet's policy, or the named defaults when none is stored. */
export function getOpenBillPolicy(
  context: ScopedTenantContext,
  outletId: string,
): Promise<OpenBillPolicy> {
  assertOutletInScope(context.outletScope, outletId);
  return withTenant(db, context, (tx) => policyIn(tx, context, outletId));
}

/** Create or replace the outlet's policy; audited. */
export async function upsertOpenBillPolicy(
  context: ScopedTenantContext,
  outletId: string,
  rawInput: UpsertOpenBillPolicyInput,
  actorUserId: string,
  now = new Date(),
): Promise<OpenBillPolicy> {
  assertOutletInScope(context.outletScope, outletId);
  const input = upsertOpenBillPolicyInputSchema.parse(rawInput);
  return withTenant(db, context, async (tx) => {
    const before = await policyIn(tx, context, outletId);
    // Validate the merged policy before it reaches the table.
    const next = openBillPolicySchema.parse({
      ...before,
      ...input,
      isDefault: false,
    });
    const tenantId = context.tenant.tenantId;
    const [row] = await tx
      .insert(outletOpenBillPolicies)
      .values({
        tenantId,
        outletId: outletIdSchema.parse(outletId),
        maxBillValueIdr: next.maxBillValueIdr,
        inactivityMinutes: next.inactivityMinutes,
        billRequestSloSeconds: next.billRequestSloSeconds,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          outletOpenBillPolicies.tenantId,
          outletOpenBillPolicies.outletId,
        ],
        set: {
          maxBillValueIdr: next.maxBillValueIdr,
          inactivityMinutes: next.inactivityMinutes,
          billRequestSloSeconds: next.billRequestSloSeconds,
          updatedAt: now,
        },
      })
      .returning({ id: outletOpenBillPolicies.id });
    if (!row) throw new Error("Open-bill policy upsert returned no row");
    await recordAudit(
      tx,
      context,
      {
        id: createUlid(now.getTime()),
        tenantId,
        outletId,
        actorType: "user",
        actorId: actorUserId,
        deviceId: null,
        action: "open_bill.policy_updated",
        objectType: "outlet_open_bill_policy",
        objectId: row.id,
        reason: null,
        maskedChanges: {
          before: maskAuditChanges(
            {
              maxBillValueIdr: before.maxBillValueIdr,
              inactivityMinutes: before.inactivityMinutes,
              billRequestSloSeconds: before.billRequestSloSeconds,
            },
            AUDIT_SAFE_FIELDS,
          ),
          after: maskAuditChanges(
            {
              maxBillValueIdr: next.maxBillValueIdr,
              inactivityMinutes: next.inactivityMinutes,
              billRequestSloSeconds: next.billRequestSloSeconds,
            },
            AUDIT_SAFE_FIELDS,
          ),
        },
        ipHash: null,
        sensitiveAccess: false,
        retentionClass: "audit_2y",
        createdAt: toIsoDateTime(now),
      },
      AUDIT_SAFE_FIELDS,
    );
    return next;
  });
}

async function lockSessionEvents(
  tx: Tx,
  tenantId: string,
  sessionId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`open-bill-events:${tenantId}:${sessionId}`}, 0))`,
  );
}

async function nextSequence(
  tx: Tx,
  tenantId: string,
  aggregateId: string,
): Promise<number> {
  const result = await tx.execute(
    sql`SELECT coalesce(max(sequence), 0) AS last FROM domain_event_outbox
        WHERE tenant_id = ${tenantId}::uuid AND destination = ${EVENT_DESTINATION}
          AND aggregate_type = 'open_bill' AND aggregate_id = ${aggregateId}::uuid`,
  );
  return Number(result.rows[0]?.last ?? 0) + 1;
}

/** Append an `open_bill.*` event for one session to the outbox, same tx. */
async function appendOpenBillEvent(
  tx: Tx,
  context: ScopedTenantContext,
  name: keyof typeof openBillEvents,
  input: { sessionId: string; outletId: string; payload: unknown; now: Date },
) {
  const definition = openBillEvents[name];
  // Breach records and idle alerts share one aggregate (the session) and one
  // max+1 sequence, but not one row lock: serialize them per session.
  await lockSessionEvents(tx, context.tenant.tenantId, input.sessionId);
  const sequence = await nextSequence(
    tx,
    context.tenant.tenantId,
    input.sessionId,
  );
  const event = eventEnvelopeSchema.parse(
    definition.envelopeSchema.parse({
      id: createUlid(input.now.getTime()),
      tenantId: context.tenant.tenantId,
      outletId: input.outletId,
      name,
      version: definition.version,
      aggregateType: definition.entry.aggregateType,
      aggregateId: input.sessionId,
      sequence,
      occurredAt: toIsoDateTime(input.now),
      actor: { type: "system" },
      deviceId: null,
      idempotencyKey: `${name}:${input.sessionId}:${sequence}`,
      payloadSchemaRef: definition.payloadSchemaRef,
      payload: input.payload,
    }),
  );
  await appendOutbox(tx, context, {
    id: createUlid(input.now.getTime()),
    event,
    destination: EVENT_DESTINATION,
    direction: null,
    peerId: null,
  });
  return event;
}

// ---- Place-order limit ----------------------------------------------------------

/**
 * What the session owes and has not paid: per live order (not voided, draft
 * or completed), its total minus the reservation deposit applied to it, the
 * captured cashier tenders (cash, EDC, QRIS, points; `pos_order_tenders`)
 * and what verified payments allocated to its WS-05 link, floored at 0
 * (`remainingIdr`, the POS payment panel's balance). The limit is credit
 * exposure, so any payment frees room for the next order. A `completed`
 * order was settled in full at the cashier and is left out; a POS-04 refund
 * only ever targets a completed sale, so it never reopens exposure.
 */
async function unpaidExposureOfSession(
  tx: Tx,
  context: ScopedTenantContext,
  sessionId: string,
): Promise<Idr> {
  const tenantId = context.tenant.tenantId;
  const live = await tx
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, tenantId),
        eq(orders.tableSessionId, sessionId),
        notInArray(orders.status, ["voided", "draft", "completed"]),
      ),
    );
  if (live.length === 0) return idr(0);
  const orderIds = live.map((row) => row.id);
  const tenders = await tx
    .select()
    .from(posOrderTenders)
    .where(
      and(
        eq(posOrderTenders.tenantId, tenantId),
        inArray(posOrderTenders.orderId, orderIds),
      ),
    );
  const linkIds = [
    ...new Set(
      live
        .map((row) => row.paymentLinkId)
        .filter((id): id is string => id !== null),
    ),
  ];
  const links = linkIds.length
    ? await tx
        .select({ id: paymentLinks.id, paidIdr: paymentLinks.paidIdr })
        .from(paymentLinks)
        .where(
          and(
            eq(paymentLinks.tenantId, tenantId),
            inArray(paymentLinks.id, linkIds),
          ),
        )
    : [];
  const linkPaid = new Map(links.map((row) => [row.id, row.paidIdr]));
  const exposure = live.reduce((sum, order) => {
    const ofOrder = tenders.filter((tender) => tender.orderId === order.id);
    const viaLink =
      order.paymentLinkId === null
        ? 0
        : (linkPaid.get(order.paymentLinkId) ?? 0);
    return sum + Math.max(0, remainingIdr(order, ofOrder) - viaLink);
  }, 0);
  return idr(exposure);
}

/**
 * Reservation DP credit (WS-08) no order of the session has applied yet: the
 * credit minus what live orders took (`deposit_applied_idr`, the same used
 * sum as the QR pay-first checkout and the POS bill). An open-bill QR order
 * applies no deposit itself; the bill settles against the session credit, so
 * the unused part is already paid and offsets the exposure, the new order
 * included (`assertOpenBillWithinLimit`). Read without the
 * deposit lock: this check runs before the promo redeem, and the lock order
 * is promo, then deposit (legend-94qt).
 */
async function unusedDepositOfSession(
  tx: Tx,
  tenantId: TenantId,
  sessionId: string,
): Promise<number> {
  const credit = await depositCreditFor(tx, tenantId, sessionId);
  if (credit <= 0) return 0;
  const [used] = await tx
    .select({
      used: sql<string>`coalesce(sum(${orders.depositAppliedIdr}), 0)::text`,
    })
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, tenantId),
        eq(orders.tableSessionId, sessionId),
        ne(orders.status, "voided"),
      ),
    );
  return Math.max(0, credit - Number(used?.used ?? 0));
}

export type OpenBillPlacement = {
  sessionId: string;
  outletId: string;
  tableId: string;
  zoneId: string;
  paymentMode: string;
  /** Version of the cart being checked out (recorded on the breach). */
  cartVersion: number;
  /** Total the order being placed adds to the bill. */
  orderTotalIdr: number;
  now: Date;
};

type OpenBillBreach = {
  placement: OpenBillPlacement;
  currentBillIdr: Idr;
  maxBillValueIdr: Idr;
  policyIsDefault: boolean;
};

/**
 * Internal control flow, like the sold-out marker in qr-order.service.ts: the
 * caller's transaction rolls back (stock reservations included), then
 * `refuseOpenBillBreach` records the breach in a fresh transaction.
 */
export class OpenBillLimitExceeded extends Error {
  constructor(readonly breach: OpenBillBreach) {
    super(QR_ORDER_OPEN_BILL_LIMIT);
  }
}

/**
 * Throws `OpenBillLimitExceeded` when an open-bill order would push the
 * session over its bill value limit (pay-first sessions are not limited
 * here). Writes nothing, so it holds no second connection while the caller
 * keeps the session row locked.
 */
export async function assertOpenBillWithinLimit(
  tx: Tx,
  context: ScopedTenantContext,
  placement: OpenBillPlacement,
): Promise<void> {
  if (placement.paymentMode !== "open_bill") return;
  const policy = await policyIn(tx, context, placement.outletId);
  const owed = await unpaidExposureOfSession(tx, context, placement.sessionId);
  const credit = await unusedDepositOfSession(
    tx,
    context.tenant.tenantId,
    placement.sessionId,
  );
  // The unused deposit pays the bill first, the new order included.
  const current = idr(Math.max(0, owed - credit));
  const creditLeft = Math.max(0, credit - owed);
  const added = Math.max(0, placement.orderTotalIdr - creditLeft);
  if (current + added <= policy.maxBillValueIdr) return;
  throw new OpenBillLimitExceeded({
    placement,
    currentBillIdr: current,
    maxBillValueIdr: policy.maxBillValueIdr,
    policyIsDefault: policy.isDefault,
  });
}

/**
 * Call after the checkout transaction rolled back with `OpenBillLimitExceeded`:
 * audits the breach and queues `open_bill.limit_exceeded` (at most one
 * record per session per minute, so a guest retrying, or editing the cart
 * and retrying, cannot grow the tables), then answers 409
 * `QR_ORDER_OPEN_BILL_LIMIT`.
 */
export async function refuseOpenBillBreach(
  context: ScopedTenantContext,
  error: OpenBillLimitExceeded,
): Promise<never> {
  const { placement, currentBillIdr, maxBillValueIdr, policyIsDefault } =
    error.breach;
  const payload = {
    sessionId: placement.sessionId,
    tableId: placement.tableId,
    zoneId: placement.zoneId,
    cartVersion: placement.cartVersion,
    currentBillIdr,
    attemptedOrderIdr: idr(placement.orderTotalIdr),
    maxBillValueIdr,
    policyIsDefault,
  };
  await withTenant(db, context, async (tx) => {
    // Lock first: the dedupe check and the sequence both read the outbox.
    await lockSessionEvents(tx, context.tenant.tenantId, placement.sessionId);
    const seen = await tx.execute(
      sql`SELECT 1 FROM domain_event_outbox
          WHERE tenant_id = ${context.tenant.tenantId}::uuid
            AND destination = ${EVENT_DESTINATION}
            AND aggregate_type = 'open_bill'
            AND aggregate_id = ${placement.sessionId}::uuid
            AND event->>'name' = 'open_bill.limit_exceeded'
            AND (event->>'occurredAt')::timestamptz
                > ${placement.now.toISOString()}::timestamptz - interval '1 minute'
          LIMIT 1`,
    );
    if (seen.rows.length > 0) return;
    await appendOpenBillEvent(tx, context, "open_bill.limit_exceeded", {
      sessionId: placement.sessionId,
      outletId: placement.outletId,
      payload,
      now: placement.now,
    });
    await recordAudit(
      tx,
      context,
      {
        id: createUlid(placement.now.getTime()),
        tenantId: context.tenant.tenantId,
        outletId: placement.outletId,
        actorType: "system",
        actorId: null,
        deviceId: null,
        action: "open_bill.limit_exceeded",
        objectType: "table_session",
        objectId: placement.sessionId,
        reason: null,
        maskedChanges: {
          before: null,
          after: maskAuditChanges(payload, AUDIT_SAFE_FIELDS),
        },
        ipHash: null,
        sensitiveAccess: false,
        retentionClass: "audit_2y",
        createdAt: toIsoDateTime(placement.now),
      },
      AUDIT_SAFE_FIELDS,
    );
  });
  throw new HttpError(
    openBillErrorHttpStatus.QR_ORDER_OPEN_BILL_LIMIT,
    QR_ORDER_OPEN_BILL_LIMIT,
    openBillErrorMessages.QR_ORDER_OPEN_BILL_LIMIT,
  );
}

// ---- Inactivity alert -----------------------------------------------------------

async function zoneWaiterIds(
  tx: Tx,
  tenantId: TenantId,
  zoneId: string,
): Promise<string[]> {
  const rows = await tx
    .select({ userId: zoneWaiterAssignments.userId })
    .from(zoneWaiterAssignments)
    .where(
      and(
        eq(zoneWaiterAssignments.tenantId, tenantId),
        eq(zoneWaiterAssignments.zoneId, zoneId),
      ),
    );
  return [...new Set(rows.map((row) => row.userId))];
}

/**
 * Alerts the zone waiters of every confirmed open-bill session idle past its
 * outlet's inactivity limit, once per idle spell (new activity starts a new
 * spell). Run per tenant by the worker; returns the alerted session ids.
 * Sessions still waiting for confirmation or already asking for the bill are
 * not idle: the first has a waiter task, the second the bill-request sweep.
 */
export async function sweepInactiveOpenBillSessions(
  now: Date,
  context: ScopedTenantContext,
): Promise<string[]> {
  const tenantId = context.tenant.tenantId;
  const selectDue = (
    tx: Tx,
    options: { sessionId?: string; lock: boolean },
  ) => {
    const query = tx
      .select({
        id: tableSessions.id,
        outletId: tableSessions.outletId,
        tableId: tableSessions.tableId,
        zoneId: tables.zoneId,
        tableCode: tables.code,
        lastActivityAt: tableSessions.lastActivityAt,
        inactivityMinutes: outletOpenBillPolicies.inactivityMinutes,
      })
      .from(tableSessions)
      .innerJoin(
        tables,
        and(
          eq(tables.tenantId, tableSessions.tenantId),
          eq(tables.id, tableSessions.tableId),
        ),
      )
      .leftJoin(
        outletOpenBillPolicies,
        and(
          eq(outletOpenBillPolicies.tenantId, tableSessions.tenantId),
          eq(outletOpenBillPolicies.outletId, tableSessions.outletId),
        ),
      )
      .where(
        and(
          eq(tableSessions.tenantId, tenantId),
          eq(tableSessions.paymentMode, "open_bill"),
          eq(tableSessions.status, "open"),
          options.sessionId
            ? eq(tableSessions.id, options.sessionId)
            : undefined,
          sql`${tableSessions.lastActivityAt} <= ${now.toISOString()}::timestamptz - coalesce(${outletOpenBillPolicies.inactivityMinutes}, ${OPEN_BILL_DEFAULT_INACTIVITY_MINUTES}) * interval '1 minute'`,
          sql`${tableSessions.inactivityAlertedActivityAt} IS DISTINCT FROM ${tableSessions.lastActivityAt}`,
        ),
      )
      .orderBy(tableSessions.lastActivityAt)
      .limit(SWEEP_BATCH);
    return options.lock
      ? query.for("update", { of: tableSessions, skipLocked: true })
      : query;
  };

  // Scan without locks, then alert each session in its own short transaction
  // that re-checks the session under its row lock (a concurrent sweep, or new
  // guest activity, makes the re-check come back empty).
  const candidates = await withTenant(db, context, (tx) =>
    selectDue(tx, { lock: false }),
  );
  const alerted: string[] = [];
  for (const candidate of candidates) {
    const done = await withTenant(db, context, async (tx) => {
      const [row] = await selectDue(tx, {
        sessionId: candidate.id,
        lock: true,
      });
      if (!row) return false;
      const threshold =
        row.inactivityMinutes ?? OPEN_BILL_DEFAULT_INACTIVITY_MINUTES;
      const idleMinutes = Math.floor(
        (now.getTime() - row.lastActivityAt.getTime()) / 60_000,
      );
      await tx
        .update(tableSessions)
        .set({
          inactivityAlertedActivityAt: sql`${tableSessions.lastActivityAt}`,
        })
        .where(
          and(
            eq(tableSessions.tenantId, tenantId),
            eq(tableSessions.id, row.id),
          ),
        );
      const event = await appendOpenBillEvent(
        tx,
        context,
        "open_bill.inactive",
        {
          sessionId: row.id,
          outletId: row.outletId,
          payload: {
            sessionId: row.id,
            tableId: row.tableId,
            zoneId: row.zoneId,
            lastActivityAt: toIsoDateTime(row.lastActivityAt),
            idleMinutes,
            thresholdMinutes: threshold,
          },
          now,
        },
      );
      const recipients = await buildRecipients(
        tx,
        tenantId,
        await zoneWaiterIds(tx, tenantId, row.zoneId),
        {
          title: "Sesi open bill tidak aktif",
          body: `Meja ${row.tableCode} tidak ada aktivitas selama ${idleMinutes} menit. Mohon cek apakah tamu perlu bantuan atau tagihan.`,
        },
        now,
      );
      if (recipients.length > 0)
        await createNotificationConsumer(context, async () => recipients)(
          event,
          event.idempotencyKey,
          tx,
        );
      return true;
    });
    if (done) alerted.push(candidate.id);
  }
  return alerted;
}
