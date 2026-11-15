// legend-zff37 (SO-879 second opinion, card A): a hold must not be closed, and
// its tender must not be voided, when the provider payment commits between the
// release's first look and the moment it takes the order lock.
//
// Written from docs/briefs/so-879-qris-hold-fix.md (CTO decision) and
// docs/qa/second-opinion-qris-hold.md (first finding), not from the code:
// "release (manual and job) re-read intent status + allocated evidence under
//  the order/hold/link/intent locks inside the release transaction. Evidence of
//  payment: release refused, payment completed (captured once), no tender void,
//  no refund."
//
// Barrier (no sleeps, no fake timers). The real webhook needs the order lock
// too, so it cannot commit while the test holds that lock. Instead:
//  1. the payment is recorded for real (confirmPayment, consumer withheld) and
//     the rows it wrote are snapshotted (evidence, intent and link changes,
//     outbox events), then put back to the state before the payment;
//  2. a separate connection C takes the order row lock;
//  3. the release (or the hold check job) starts and the test waits until
//     PostgreSQL reports it blocked by C: everything it read before needing the
//     order lock shows NO payment (stale);
//  4. inside C's own transaction the snapshotted rows are written back (the
//     payment "commits") and C commits, which frees the lock.
// The request then continues and must see the payment under its lock.
//
// Assumptions:
// - A refused release is 409 (CoreError CONFLICT), per the brief.
// - The consumer (`handlePosPaymentPaid`) runs only after the race, twice
//   (replay), and captures the payment once.
// - Manager release goes through an approved pos-overrides row of action "void"
//   (same assumption as pos-qris-hold-anomaly.test.ts).
// - The payment time is before the QR's original expiry (the provider took the
//   money in time; only its notice is late).
// - The job scenario needs an "expired" answer that contradicts the payment
//   (stale answer): the gateway says DOIT `expired` although the money is in.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { tenantIdSchema, ulidToUuid, userIdSchema } from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import { setStaffPin } from "../services/device-pin.service.ts";
import { createPosOverride } from "../services/staff-override.service.ts";
import { owner } from "./floor-test-helpers.ts";
import { agent, signUp } from "./helpers.ts";
import {
  HOLD_CLOSE_MARGIN_S,
  HOLD_RELEASE_AFTER_MIN,
  assertInvariants,
  capturedIdr,
  holdFixture,
  issueQris,
  newSubmittedOrder,
  payNotice,
  postCancel,
  postRelease,
  readHold,
  refundsOfIntent,
  resetHoldPorts,
  runHoldCheck,
  tenderStatuses,
  unallocatedFunds,
  type HoldFixture,
  type IssuedQris,
  type ManagerApproval,
} from "./pos-qris-hold-test-helpers.ts";

const BILL_IDR = 33_000;
const SUPERVISOR_PIN = "582914";
vi.setConfig({ testTimeout: 120_000 });

let fx: HoldFixture;
beforeAll(async () => {
  fx = await holdFixture("qris-hold-so879-zff37");
});
afterAll(async () => {
  resetHoldPorts();
  await owner.end();
});

// ------------------------------------------------------------------ barrier

type Row = Record<string, unknown>;
type PaymentRows = {
  intentBefore: Row;
  intentAfter: Row;
  linkBefore: Row;
  linkAfter: Row;
  evidence: Row[];
  outbox: Row[];
};

const asParam = (value: unknown) =>
  value !== null &&
  typeof value === "object" &&
  !(value instanceof Date) &&
  !Array.isArray(value)
    ? JSON.stringify(value)
    : value;

async function selectRow(table: string, id: unknown) {
  const { rows } = await owner.query(
    `SELECT * FROM ${table} WHERE tenant_id=$1 AND id=$2`,
    [fx.tenant.tenantId, id],
  );
  return rows[0] as Row;
}

async function insertRow(
  client: { query: (text: string, params?: unknown[]) => Promise<unknown> },
  table: string,
  row: Row,
) {
  const cols = Object.keys(row);
  await client.query(
    `INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(",")})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")})`,
    cols.map((c) => asParam(row[c])),
  );
}

async function setColumns(
  client: { query: (text: string, params?: unknown[]) => Promise<unknown> },
  table: string,
  id: unknown,
  from: Row,
  to: Row,
) {
  const changed = Object.keys(to).filter(
    (c) => JSON.stringify(from[c]) !== JSON.stringify(to[c]),
  );
  if (changed.length === 0) return;
  await client.query(
    `UPDATE ${table} SET ${changed.map((c, i) => `"${c}"=$${i + 3}`).join(",")}
      WHERE tenant_id=$1 AND id=$2`,
    [fx.tenant.tenantId, id, ...changed.map((c) => asParam(to[c]))],
  );
}

/** Records the payment for real, snapshots what it wrote, then puts the
 * database back to the state before the payment (no evidence, no event). */
async function recordThenUndoPayment(
  qr: IssuedQris,
  paidAt: Date,
): Promise<PaymentRows> {
  const intentBefore = await selectRow("payment_intents", qr.intentId);
  const linkId = intentBefore.payment_link_id as string;
  const linkBefore = await selectRow("payment_links", linkId);
  const outboxBefore = await owner.query<{ id: string }>(
    `SELECT id::text FROM domain_event_outbox
      WHERE tenant_id=$1 AND event->'payload'->>'intentId'=$2`,
    [fx.tenant.tenantId, qr.intentId],
  );
  await payNotice(fx, qr.intentId, BILL_IDR, paidAt, qr.providerRef!, {
    deliveries: 0,
  });
  const intentAfter = await selectRow("payment_intents", qr.intentId);
  const linkAfter = await selectRow("payment_links", linkId);
  const evidence = (
    await owner.query(
      `SELECT * FROM payment_evidence WHERE tenant_id=$1 AND payment_intent_id=$2`,
      [fx.tenant.tenantId, qr.intentId],
    )
  ).rows as Row[];
  const known = new Set(outboxBefore.rows.map((r) => r.id));
  const outbox = (
    (
      await owner.query(
        `SELECT * FROM domain_event_outbox
          WHERE tenant_id=$1 AND event->'payload'->>'intentId'=$2`,
        [fx.tenant.tenantId, qr.intentId],
      )
    ).rows as Row[]
  ).filter((r) => !known.has(String(r.id)));
  expect(evidence, "the payment wrote evidence").toHaveLength(1);
  expect(outbox.length, "the payment wrote its event").toBeGreaterThan(0);

  const undo = await owner.connect();
  try {
    await undo.query("BEGIN");
    await undo.query("SET LOCAL session_replication_role = replica");
    await undo.query(
      `DELETE FROM domain_event_outbox WHERE tenant_id=$1 AND id = ANY($2::uuid[])`,
      [fx.tenant.tenantId, outbox.map((r) => r.id)],
    );
    await undo.query(
      `DELETE FROM payment_evidence WHERE tenant_id=$1 AND payment_intent_id=$2`,
      [fx.tenant.tenantId, qr.intentId],
    );
    await setColumns(
      undo,
      "payment_intents",
      qr.intentId,
      intentAfter,
      intentBefore,
    );
    await setColumns(undo, "payment_links", linkId, linkAfter, linkBefore);
    await undo.query("COMMIT");
  } catch (error) {
    await undo.query("ROLLBACK");
    throw error;
  } finally {
    undo.release();
  }
  return { intentBefore, intentAfter, linkBefore, linkAfter, evidence, outbox };
}

/** Connection C: holds the order row lock until `commitPayment`. */
async function lockOrderRow(orderId: string) {
  const client = await owner.connect();
  await client.query("BEGIN");
  await client.query(
    "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
    [fx.tenant.tenantId],
  );
  await client.query(
    "SELECT 1 FROM orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
    [fx.tenant.tenantId, ulidToUuid(orderId)],
  );
  const { rows } = await client.query<{ pid: number }>(
    "SELECT pg_backend_pid() AS pid",
  );
  let done = false;
  const finish = async (work: () => Promise<void>) => {
    if (done) return;
    done = true;
    try {
      await work();
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };
  return {
    pid: rows[0]!.pid,
    /** The payment commits inside C's own transaction, then C commits. */
    commitPayment: (payment: PaymentRows, intentId: string) =>
      finish(async () => {
        const linkId = payment.intentBefore.payment_link_id;
        await setColumns(
          client,
          "payment_intents",
          intentId,
          payment.intentBefore,
          payment.intentAfter,
        );
        await setColumns(
          client,
          "payment_links",
          linkId,
          payment.linkBefore,
          payment.linkAfter,
        );
        for (const row of payment.evidence)
          await insertRow(client, "payment_evidence", row);
        for (const row of payment.outbox)
          await insertRow(client, "domain_event_outbox", row);
      }),
    /** Frees the lock without a payment (cleanup when the test fails early). */
    abort: () => finish(async () => undefined),
  };
}

/** Waits (bounded) until some backend waits for a lock held by `pid`. */
async function waitUntilBlockedBy(pid: number, what: string, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const { rows } = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE $1::int = ANY(pg_blocking_pids(pid))`,
      [pid],
    );
    if (rows[0]!.n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `${what} never waited for the order lock (barrier not reached)`,
  );
}

// -------------------------------------------------------------- manager flow

let supervisorUserId: string | null = null;
async function supervisor(): Promise<string> {
  if (supervisorUserId) return supervisorUserId;
  const client = agent(fx.app);
  await signUp(client, "Manajer Rilis QRIS zff37");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Manajer QRIS zff37', true, 'supervisor', $3, false, '["tenant"]')`,
    [
      roleId,
      fx.tenant.tenantId,
      JSON.stringify(["order.view", "pos.void.approve"]),
    ],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [fx.tenant.tenantId, userId, roleId],
  );
  await setStaffPin(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(fx.tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    userId,
    { outletId: fx.tenant.outletId, userId },
    { pin: SUPERVISOR_PIN },
  );
  supervisorUserId = userId;
  return userId;
}

async function managerApproval(orderId: string): Promise<ManagerApproval> {
  const approver = await supervisor();
  const { override } = await createPosOverride(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(fx.tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    fx.staff.userId,
    {
      outletId: fx.tenant.outletId,
      action: "void",
      valueIdr: BILL_IDR,
      reason: "Penyedia QRIS tidak merespons",
      objectType: "order",
      objectId: orderId,
      approval: {
        method: "supervisor_pin",
        approverUserId: userIdSchema.parse(approver),
        pin: SUPERVISOR_PIN,
      },
    } as Parameters<typeof createPosOverride>[2],
    { idempotencyKey: randomUUID() },
  );
  expect(override.status).toBe("approved");
  return { approvedBy: approver, overrideId: override.id };
}

async function backdateExpiry(qr: IssuedQris, minutesAgo: number) {
  await owner.query(
    `UPDATE payment_intents SET expires_at = now() - $3::int * interval '1 minute'
      WHERE tenant_id=$1 AND id=$2`,
    [fx.tenant.tenantId, qr.intentId, minutesAgo],
  );
}

async function evidenceRows(intentId: string) {
  const { rows } = await owner.query<{ n: number; sum: number }>(
    `SELECT count(*)::int AS n, coalesce(sum(amount_idr),0)::int AS sum
       FROM payment_evidence WHERE tenant_id=$1 AND payment_intent_id=$2`,
    [fx.tenant.tenantId, intentId],
  );
  return rows[0]!;
}

/** The customer paid once and the outlet got it once: the money outcome that
 * must hold after the race, whichever way the engineer completes the payment. */
async function expectPaidExactlyOnce(orderId: string, qr: IssuedQris) {
  expect(await capturedIdr(fx, orderId), "outlet receives the bill once").toBe(
    BILL_IDR,
  );
  expect((await tenderStatuses(fx, orderId)).map((t) => t.status)).toEqual([
    "captured",
  ]);
  expect(await evidenceRows(qr.intentId)).toEqual({ n: 1, sum: BILL_IDR });
  expect(
    await refundsOfIntent(fx, qr.intentId),
    "no refund: the customer paid exactly the bill",
  ).toEqual([]);
  expect(
    await unallocatedFunds(fx, qr.intentId),
    "nothing parked: the payment belongs to the bill",
  ).toEqual([]);
  const hold = await readHold(fx, orderId);
  expect(hold?.state).toBe("paid");
  expect(hold?.closeReason).toBe("provider_paid");
  await assertInvariants(fx, orderId);
}

// -------------------------------------------------------------------- tests

describe("legend-zff37 release re-reads the payment under the order lock", () => {
  it("legend-zff37 manual release: the payment commits after the release's first look -> release is refused (409), tender stays, payment captured once, no refund", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const qr = await issueQris(fx, order.id);
    expect(qr.amountIdr).toBe(BILL_IDR);
    const paidAt = new Date(qr.expiresAt.getTime() - 30_000);
    const payment = await recordThenUndoPayment(qr, paidAt);
    await backdateExpiry(qr, HOLD_RELEASE_AFTER_MIN + 1);
    const approval = await managerApproval(order.id);

    const lock = await lockOrderRow(order.id);
    let releasing: Promise<Awaited<ReturnType<typeof postRelease>>>;
    try {
      releasing = (async () => postRelease(fx, order.id, approval))();
      await waitUntilBlockedBy(lock.pid, "the release");
      await lock.commitPayment(payment, qr.intentId);
    } finally {
      await lock.abort();
    }
    const released = await releasing;

    expect(
      released.status,
      `release must be refused once the payment is recorded: ${JSON.stringify(released.body)}`,
    ).toBe(409);
    const afterRelease = await readHold(fx, order.id);
    expect(
      afterRelease?.state,
      "hold must not be closed by the release",
    ).not.toBe("closed");
    expect(afterRelease?.closeReason).not.toBe("force_released");
    expect(
      (await tenderStatuses(fx, order.id)).map((t) => t.status),
      "the tender must not be voided",
    ).not.toContain("voided");

    // The consumer now sees the payment (twice: replay) and captures it once.
    await payNotice(fx, qr.intentId, BILL_IDR, paidAt, qr.providerRef!, {
      deliveries: 2,
    });
    await expectPaidExactlyOnce(order.id, qr);
  });

  it("legend-zff37 hold check job: a stale 'expired' answer while the payment commits -> the job does not close the hold or void the tender; payment captured once", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const qr = await issueQris(fx, order.id);
    expect(qr.amountIdr).toBe(BILL_IDR);
    const paidAt = new Date(qr.expiresAt.getTime() - 30_000);
    const payment = await recordThenUndoPayment(qr, paidAt);
    const cancel = await postCancel(fx, order.id);
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(202);
    // The provider answer is stale: it says expired although the money is in.
    fx.gateway.script(qr.intentId, { status: "expired" });
    const jobAt = new Date(
      qr.expiresAt.getTime() + (HOLD_CLOSE_MARGIN_S + 1) * 1000,
    );

    const lock = await lockOrderRow(order.id);
    let running: Promise<unknown>;
    try {
      running = (async () => runHoldCheck(fx, jobAt))();
      await waitUntilBlockedBy(lock.pid, "the hold check job");
      await lock.commitPayment(payment, qr.intentId);
    } finally {
      await lock.abort();
    }
    await running;

    const afterJob = await readHold(fx, order.id);
    expect(
      afterJob?.state,
      "the job must not close a hold whose payment is recorded",
    ).not.toBe("closed");
    expect(afterJob?.closeReason ?? "").not.toMatch(
      /^provider_(expired|failed)$/,
    );
    expect(
      (await tenderStatuses(fx, order.id)).map((t) => t.status),
      "the tender must not be voided",
    ).not.toContain("voided");

    await payNotice(fx, qr.intentId, BILL_IDR, paidAt, qr.providerRef!, {
      deliveries: 2,
    });
    await expectPaidExactlyOnce(order.id, qr);
  });

  it("legend-zff37 control: with no payment, release after 30 min still closes the hold (force_released) and voids the tender", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const qr = await issueQris(fx, order.id);
    await backdateExpiry(qr, HOLD_RELEASE_AFTER_MIN + 1);
    const released = await postRelease(
      fx,
      order.id,
      await managerApproval(order.id),
    );
    expect(released.status, JSON.stringify(released.body)).toBeLessThan(300);
    const hold = await readHold(fx, order.id);
    expect(hold?.state).toBe("closed");
    expect(hold?.closeReason).toBe("force_released");
    expect((await tenderStatuses(fx, order.id)).map((t) => t.status)).toEqual([
      "voided",
    ]);
    expect(await capturedIdr(fx, order.id)).toBe(0);
    expect(await refundsOfIntent(fx, qr.intentId)).toEqual([]);
    expect(await unallocatedFunds(fx, qr.intentId)).toEqual([]);
    await assertInvariants(fx, order.id);
  });
});
