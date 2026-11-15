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
// Barrier (no sleeps, no fake timers): the test holds the order row lock from
// its own connection, starts the release (or the hold check job) and waits until
// PostgreSQL reports that request as blocked by that lock. The request has then
// done everything it does before it needs the order lock, so whatever it read
// without the lock is stale. Only then the "webhook" commits (confirmPayment,
// consumer withheld), the lock is dropped and the request continues.
//
// Assumptions:
// - A refused release is 409 (CoreError CONFLICT), per the brief.
// - "Webhook commit" = confirmPayment with the consumer (`handlePosPaymentPaid`)
//   withheld (`deliveries: 0`); the consumer runs afterwards, twice (replay).
// - Manager release goes through an approved pos-overrides row of action "void"
//   (same assumption as pos-qris-hold-anomaly.test.ts).
// - The webhook's payment time is before the QR's original expiry (the provider
//   took the money in time; only its notice is late).
// - The job scenario needs an "expired" answer that contradicts the payment
//   (stale answer): the gateway says DOIT `expired` while the webhook commits.
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

/** Holds the row lock of the order from a separate connection. */
async function lockOrderRow(orderId: string) {
  const client = await owner.connect();
  await client.query("BEGIN");
  await client.query(
    "SELECT 1 FROM orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
    [fx.tenant.tenantId, ulidToUuid(orderId)],
  );
  const { rows } = await client.query<{ pid: number }>(
    "SELECT pg_backend_pid() AS pid",
  );
  let done = false;
  return {
    pid: rows[0]!.pid,
    async drop() {
      if (done) return;
      done = true;
      try {
        await client.query("COMMIT");
      } finally {
        client.release();
      }
    },
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

/** Runs `work` and fails with a clear message when it is stuck behind the lock. */
async function within<T>(ms: number, what: string, work: Promise<T>) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} did not finish within ${ms} ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  it("legend-zff37 manual release: the webhook commits after the release's first look -> release is refused (409), tender stays, payment captured once, no refund", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const qr = await issueQris(fx, order.id);
    expect(qr.amountIdr).toBe(BILL_IDR);
    const paidAt = new Date(qr.expiresAt.getTime() - 30_000);
    await backdateExpiry(qr, HOLD_RELEASE_AFTER_MIN + 1);
    const approval = await managerApproval(order.id);

    const lock = await lockOrderRow(order.id);
    let releasing: ReturnType<typeof postRelease> extends PromiseLike<infer R>
      ? Promise<R>
      : never;
    try {
      releasing = (async () => postRelease(fx, order.id, approval))();
      await waitUntilBlockedBy(lock.pid, "the release");
      // The provider payment commits now; the consumer is held back.
      await within(
        15_000,
        "the webhook commit",
        payNotice(fx, qr.intentId, BILL_IDR, paidAt, qr.providerRef!, {
          deliveries: 0,
        }),
      );
    } finally {
      await lock.drop();
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

  it("legend-zff37 hold check job: a stale 'expired' answer while the webhook commits -> the job does not close the hold or void the tender; payment captured once", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const qr = await issueQris(fx, order.id);
    expect(qr.amountIdr).toBe(BILL_IDR);
    const cancel = await postCancel(fx, order.id);
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(202);
    // The provider answer is stale: it says expired although the money is in.
    fx.gateway.script(qr.intentId, { status: "expired" });
    const jobAt = new Date(
      qr.expiresAt.getTime() + (HOLD_CLOSE_MARGIN_S + 1) * 1000,
    );
    const paidAt = new Date(qr.expiresAt.getTime() - 30_000);

    const lock = await lockOrderRow(order.id);
    let running: Promise<unknown>;
    try {
      running = (async () => runHoldCheck(fx, jobAt))();
      await waitUntilBlockedBy(lock.pid, "the hold check job");
      await within(
        15_000,
        "the webhook commit",
        payNotice(fx, qr.intentId, BILL_IDR, paidAt, qr.providerRef!, {
          deliveries: 0,
        }),
      );
    } finally {
      await lock.drop();
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
