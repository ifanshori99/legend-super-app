// legend-ykk88 (SO Codex 535 P2), fail-first. Chain approval path.
// A refund approval-chain decision (decideApprovalRequest, source module
// payment_refund) is a money fact of the bill (tagihan) like a POS refund: its
// decision time must be taken AFTER the bill lock and be monotonic against every
// fact already committed on the bill, whatever clock the request read before it
// waited for the lock. Same rule as refund-fact-time-monotonic.test.ts, which
// covers the POS path (refundPosOrder).
//
// Scenario (two real transactions): refund B is a pending refund whose approval
// chain is open. An approver decides it with an injected app clock T0 (the
// "now" read before the lock wait). While that decision is queued on the bill's
// pos_orders row lock, refund A (supervisor-approved Rp150000, ceiling Rp200000)
// is decided at T1 > T0 under the lock and committed. B then commits.
// Q63: A's payout is re-validated "as of its decision time" counting only facts
// at or before decided_at. B's approval stamped with the stale T0 lands BEFORE
// A and is wrongly counted against A's approver (150000 + 100000 > 200000), so a
// legitimate refund A is quarantined. Fix: B's decided_at/updated_at/event time
// are >= T1 + 1 ms.
//
// Written from docs/briefs/fix-ykk88-c79uy.md (section A and A+), the Q63 notes
// in docs/release-notes-pos-refund-ceilings.md and the public exports of the
// approval and refund services; fixtures follow refund-fact-time-monotonic.test.ts
// and payment-refund-system-chain.test.ts.
//
// Assumptions:
// - The bill lock is the pos_orders row of the bill's order (the lock POS writers
//   take); a held transaction on that row queues the chain decision, proven by
//   waitForLockWaiters, never by sleeping.
// - The stale clock is injected as `options.now` of decideApprovalRequest (T0 is
//   set 5 s in the past so T0 < T1 holds whatever the clocks' jitter).
// - "decidedAt >= T1 + 1ms" is checked on the approval request row, its
//   updated_at, and the approval.resolved event's occurredAt (strictly after T1
//   in SQL too, since T1 has microseconds).
// - After the resolved event is handled (as the worker does), B is approved and
//   its chain decision counts toward A's historical authority. The payout
//   re-validation primitive is `refundApprovalWithinLimit(..., { historical:
//   true, approvedBefore: decidedAt })`, called as the payout step does.
// - Control: a supervisor deciding B behind the same A would push the cumulative
//   total over Rp200000 after the lock, so the decision is refused (any error)
//   and the chain request stays pending; the exact error code is not asserted.
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createUlid,
  tenantIdSchema,
  outletIdSchema,
  ulidToUuid,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { eventEnvelopeSchema } from "@starter/shared/events";
import { db } from "../db";
import { paymentRefunds } from "../db/schema/index";
import { withTenant } from "../db/tenant";
import { createApp } from "../app";
import { outletContext } from "../services/device-pin-support";
import { refundApprovalWithinLimit } from "../services/payment-refund-approval-limits";
import {
  handleRefundApprovalResolved,
  openRefundChainAtRequest,
} from "../services/payment-refund.service";
import { decideApprovalRequest } from "../services/platform-approval.service";
import { agent, setRole, signUp, verifySessionMfa } from "./helpers";
import {
  owner,
  seededOutletA,
  seededTenantId,
  waitForLockWaiters,
} from "./floor-test-helpers";

type Level = "supervisor" | "outlet_manager";
type Sale = { orderId: string; intentId: string; paid: number };

const app = createApp();
const approvers = new Map<Level, string>();
const users: string[] = [];
const orderUuids: string[] = [];
const intentIds: string[] = [];
const linkIds: string[] = [];
const refundIds: string[] = [];
let savedPolicies: Record<string, unknown>[] = [];

const sessionTenant = establishTenantContext({
  tenantId: tenantIdSchema.parse(seededTenantId),
  brandId: null,
  source: "session",
});
const workerContext = establishScopedTenantContext(
  establishTenantContext({
    tenantId: tenantIdSchema.parse(seededTenantId),
    brandId: null,
    source: "job",
  }),
  { kind: "tenant" },
);

async function asOwner<T>(
  run: (client: PoolClient) => Promise<T>,
  replica = false,
) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    // Final pos_orders rows are immutable by trigger; cleanup bypasses it the way
    // refund-fact-time-monotonic.test.ts does (session_replication_role = replica).
    if (replica)
      await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [seededTenantId],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** A completed POS sale paid in full by one paid payment intent linked to the order. */
async function sale(paid: number): Promise<Sale> {
  const orderId = createUlid();
  const orderUuid = ulidToUuid(orderId);
  const intentId = randomUUID();
  const linkId = randomUUID();
  orderUuids.push(orderUuid);
  intentIds.push(intentId);
  linkIds.push(linkId);
  await asOwner(async (client) => {
    await client.query(
      `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type,
         payment_mode, subtotal_idr, discount_idr, service_charge_idr, tax_idr,
         rounding_idr, total_idr, status, business_date, placed_at)
       VALUES ($1, $2, $3, $4, 'pos', 'takeaway', 'pay_first', $5, 0, 0, 0, 0, $5,
         'completed', '2031-03-16', now())`,
      [orderUuid, seededTenantId, seededOutletA, `YKC-${orderId}`, paid],
    );
    await client.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, submitted_at, completed_at)
       VALUES ($1, $2, $3, 'pos', now(), now())`,
      [orderUuid, seededTenantId, seededOutletA],
    );
    await client.query(
      `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference,
         subtotal_idr, total_idr, paid_idr, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 'ykk88-chain-test')`,
      [
        linkId,
        seededTenantId,
        seededOutletA,
        randomUUID().replaceAll("-", "").padEnd(64, "0"),
        `YKC-${linkId.slice(0, 8)}`,
        paid,
      ],
    );
    await client.query(
      `INSERT INTO payment_intents (id, tenant_id, outlet_id, payment_link_id,
         order_id, method, provider, amount_idr, idempotency_key, status, paid_at,
         instructions, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'qris', 'doit', $6, $7, 'paid', now(),
         '{"method":"qris","qrPayload":"test","issuer":null}', now() + interval '1 hour')`,
      [
        intentId,
        seededTenantId,
        seededOutletA,
        linkId,
        orderUuid,
        paid,
        randomUUID(),
      ],
    );
    await client.query(
      `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider,
         provider_ref, method, source, amount_idr, received_at)
       VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
      [seededTenantId, seededOutletA, intentId, `evidence-${intentId}`, paid],
    );
  });
  return { orderId, intentId, paid };
}

/** One tier for every amount, decided by `level`, in a single approval step. */
async function usePolicy(level: Level) {
  const role = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [seededTenantId, level],
  );
  await owner.query(
    "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
    [seededTenantId],
  );
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
     VALUES ($1, 'refund', NULL, $2, 1, true)`,
    [seededTenantId, role.rows[0]!.id],
  );
}

/** Refund B: pending, with its approval chain opened (as a system refund's creation does). */
async function pendingChainRefund(bill: Sale, amountIdr: number) {
  const refundId = randomUUID();
  refundIds.push(refundId);
  await owner.query(
    `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id,
       amount_idr, reason, status, requested_by)
     VALUES ($1, $2, $3, $4, $5, 'Pengembalian rantai ykk88', 'pending', 'system:pos')`,
    [refundId, seededTenantId, seededOutletA, bill.intentId, amountIdr],
  );
  const context = outletContext(
    sessionTenant,
    outletIdSchema.parse(seededOutletA),
  );
  const opened = await withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(paymentRefunds)
      .where(
        and(
          eq(paymentRefunds.tenantId, seededTenantId),
          eq(paymentRefunds.id, refundId),
        ),
      );
    if (!row) throw new Error("refund row missing");
    return openRefundChainAtRequest(tx, context, row, new Date());
  });
  const request = await owner.query<{ id: string }>(
    `SELECT id FROM approval_requests
      WHERE tenant_id = $1 AND object_type = 'payment_refund' AND object_id = $2`,
    [seededTenantId, refundId],
  );
  return {
    refundId,
    chainId: opened.approvalChainId!,
    requestId: request.rows[0]!.id,
  };
}

const decide = (actorId: string, requestId: string, now?: Date) =>
  decideApprovalRequest(
    sessionTenant,
    actorId,
    requestId,
    { decision: "approved", reason: "Sesuai bukti pengembalian." },
    { mfaVerified: true, idempotencyKey: null, now },
  );

/**
 * Two real transactions. A held transaction locks the bill's pos_orders row; the
 * chain decision of B (app clock `staleNow`, read before the wait) queues on it;
 * then refund A (Rp150000, approved by the supervisor, decided at T1 = DB clock)
 * is written and committed. Returns the settled decision of B and A's id.
 */
async function decisionQueuedBehindSupervisorRefund(
  bill: Sale,
  requestId: string,
  approverId: string,
) {
  const aId = randomUUID();
  refundIds.push(aId);
  const holder = await owner.connect();
  let pending: ReturnType<typeof decide> | undefined;
  try {
    await holder.query("BEGIN");
    await holder.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [seededTenantId],
    );
    await holder.query(
      "SELECT 1 FROM pos_orders WHERE tenant_id = $1 AND order_id = $2 FOR UPDATE",
      [seededTenantId, ulidToUuid(bill.orderId)],
    );
    const t0 = new Date(Date.now() - 5_000); // stale app clock read before the wait
    pending = decide(approverId, requestId, t0);
    pending.catch(() => undefined); // surfaced by the settle below
    await waitForLockWaiters(1);
    // T1: refund A decided while B's decision is queued.
    await holder.query(
      `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id,
         amount_idr, reason, status, requested_by, approved_by, decided_at, completed_at)
       VALUES ($1, $2, $3, $4, 150000, 'Riwayat refund supervisor', 'completed',
         'ykk88-admin', $5, clock_timestamp(), clock_timestamp())`,
      [
        aId,
        seededTenantId,
        seededOutletA,
        bill.intentId,
        approvers.get("supervisor")!,
      ],
    );
    await holder.query("COMMIT");
  } catch (error) {
    await holder.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    holder.release();
  }
  const [outcome] = await Promise.allSettled([pending!]);
  return { outcome: outcome!, aId };
}

async function decidedAtOf(refundId: string) {
  const { rows } = await owner.query<{ decided_at: Date }>(
    "SELECT decided_at FROM payment_refunds WHERE tenant_id = $1 AND id = $2",
    [seededTenantId, refundId],
  );
  return rows[0]!.decided_at;
}

/** Strictly-after checks in SQL (microsecond precision), request vs refund A. */
async function requestStampedAfter(requestId: string, aId: string) {
  const { rows } = await owner.query<{
    decided: Date;
    decided_after: boolean;
    updated_after: boolean;
  }>(
    `SELECT q.decided_at AS decided,
            q.decided_at > a.decided_at AS decided_after,
            q.updated_at > a.decided_at AS updated_after
       FROM approval_requests q, payment_refunds a
      WHERE q.tenant_id = $1 AND q.id = $2 AND a.tenant_id = $1 AND a.id = $3`,
    [seededTenantId, requestId, aId],
  );
  return rows[0]!;
}

async function requestStatus(requestId: string) {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM approval_requests WHERE tenant_id = $1 AND id = $2",
    [seededTenantId, requestId],
  );
  return rows[0]!.status;
}

async function refundStatus(refundId: string) {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM payment_refunds WHERE tenant_id = $1 AND id = $2",
    [seededTenantId, refundId],
  );
  return rows[0]!.status;
}

async function resolvedEventOfChain(chainId: string) {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND destination = 'cloud-sync'
        AND event->>'name' = 'approval.resolved'
        AND event->'payload'->>'chainId' = $2`,
    [seededTenantId, chainId],
  );
  expect(rows).toHaveLength(1);
  return eventEnvelopeSchema.parse(rows[0]!.event);
}

/** Refund amounts on the bill that are not failed or cancelled, in rupiah. */
async function committedRefundTotal(bill: Sale) {
  const { rows } = await owner.query<{ total: string }>(
    `SELECT coalesce(sum(amount_idr), 0)::text AS total FROM payment_refunds
      WHERE tenant_id = $1 AND payment_intent_id = $2
        AND status IN ('approved', 'completed', 'processing')`,
    [seededTenantId, bill.intentId],
  );
  return Number(rows[0]!.total);
}

/** The payout step's question: is the approver of A still within the ceiling at A's decision time? */
async function revalidatesWithinLimit(refundId: string, approver: string) {
  const context = outletContext(
    sessionTenant,
    outletIdSchema.parse(seededOutletA),
  );
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(paymentRefunds)
      .where(
        and(
          eq(paymentRefunds.tenantId, seededTenantId),
          eq(paymentRefunds.id, refundId),
        ),
      );
    if (!row) throw new Error("Missing refund");
    const decidedAt = row.decidedAt ?? new Date();
    return refundApprovalWithinLimit(tx, context, approver, row, decidedAt, {
      historical: true,
      approvedBefore: decidedAt,
    });
  });
}

beforeAll(async () => {
  for (const level of ["supervisor", "outlet_manager"] as const) {
    const client = agent(app);
    const email = await signUp(client, `YKK88 chain ${level}`);
    await setRole(email, null);
    const session = await client.get("/api/auth/get-session");
    const id = session.body.user.id as string;
    users.push(id);
    approvers.set(level, id);
    await verifySessionMfa(email);
    const roles = await owner.query<{ id: string }>(
      "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
      [seededTenantId, level],
    );
    if (!roles.rows[0]) throw new Error(`Missing role ${level}`);
    await owner.query(
      `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
      [seededTenantId, id, roles.rows[0].id, seededOutletA],
    );
  }
  savedPolicies = (
    await owner.query(
      "SELECT * FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
      [seededTenantId],
    )
  ).rows;
});

afterAll(async () => {
  await owner.query(
    "DELETE FROM approval_requests WHERE object_type = 'payment_refund' AND object_id = ANY($1::text[])",
    [refundIds],
  );
  await asOwner(async (client) => {
    await client.query(
      "DELETE FROM payment_refunds WHERE payment_intent_id = ANY($1::uuid[])",
      [intentIds],
    );
    await client.query(
      "DELETE FROM payment_evidence WHERE payment_intent_id = ANY($1::uuid[])",
      [intentIds],
    );
    await client.query(
      "DELETE FROM payment_intents WHERE id = ANY($1::uuid[])",
      [intentIds],
    );
    await client.query("DELETE FROM payment_links WHERE id = ANY($1::uuid[])", [
      linkIds,
    ]);
    await client.query(
      "DELETE FROM pos_orders WHERE tenant_id = $1 AND order_id = ANY($2::uuid[])",
      [seededTenantId, orderUuids],
    );
    await client.query("DELETE FROM orders WHERE id = ANY($1::uuid[])", [
      orderUuids,
    ]);
  }, true);
  await owner.query(
    "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
    [seededTenantId],
  );
  for (const row of savedPolicies)
    await owner.query(
      `INSERT INTO approval_policies (id, tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        row.id,
        row.tenant_id,
        row.action_type,
        row.threshold_idr,
        row.approver_role_id,
        row.levels,
        row.requires_distinct_actor,
      ],
    );
  await owner.query(
    "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
    [seededTenantId, users],
  );
  await owner.end();
});

describe("POS-04 legend-ykk88 refund chain approval fact time is monotonic after the bill lock", () => {
  it("a chain approval of refund B (stale clock T0) committing after refund A (T1) is stamped after T1, so A's supervisor payout is not quarantined", async () => {
    await usePolicy("outlet_manager");
    const bill = await sale(400_000);
    const b = await pendingChainRefund(bill, 100_000);
    const { outcome, aId } = await decisionQueuedBehindSupervisorRefund(
      bill,
      b.requestId,
      approvers.get("outlet_manager")!,
    );
    expect(
      outcome.status,
      String((outcome as { reason?: unknown }).reason),
    ).toBe("fulfilled");
    expect(await requestStatus(b.requestId)).toBe("approved");

    // Persistence: decidedAt and updatedAt follow commit order (after T1), never T0.
    const t1 = await decidedAtOf(aId);
    const stamped = await requestStampedAfter(b.requestId, aId);
    expect(stamped.decided_after).toBe(true);
    expect(stamped.updated_after).toBe(true);
    expect(stamped.decided.getTime()).toBeGreaterThanOrEqual(t1.getTime() + 1);

    // Event: approval.resolved carries the same later fact time.
    const event = await resolvedEventOfChain(b.chainId);
    expect(new Date(event.occurredAt).getTime()).toBeGreaterThanOrEqual(
      t1.getTime() + 1,
    );

    // The worker applies B (approved), so B's chain decision is a fact of the bill.
    await handleRefundApprovalResolved(workerContext, event);
    expect(await refundStatus(b.refundId)).toBe("approved");

    // A (Rp150000 <= Rp200000 supervisor ceiling) must not count B, which came after it.
    expect(
      await revalidatesWithinLimit(aId, approvers.get("supervisor")!),
    ).toBe(true);
    // Money: both refunds together stay within what was paid.
    expect(await committedRefundTotal(bill)).toBe(250_000);
    expect(await committedRefundTotal(bill)).toBeLessThanOrEqual(bill.paid);
  });

  it("control: a supervisor chain approval of Rp100000 queued behind the same Rp150000 supervisor refund is refused after the lock (Rp250000 > Rp200000); the request stays pending", async () => {
    await usePolicy("supervisor");
    const bill = await sale(400_000);
    const b = await pendingChainRefund(bill, 100_000);
    const { outcome } = await decisionQueuedBehindSupervisorRefund(
      bill,
      b.requestId,
      approvers.get("supervisor")!,
    );
    expect(outcome.status).toBe("rejected");
    expect(await requestStatus(b.requestId)).toBe("pending");
    expect(await refundStatus(b.refundId)).toBe("pending");
    // Only A (Rp150000) is committed; nothing is paid beyond the ceiling or the bill.
    expect(await committedRefundTotal(bill)).toBe(150_000);
    expect(await committedRefundTotal(bill)).toBeLessThanOrEqual(bill.paid);
  });
});
