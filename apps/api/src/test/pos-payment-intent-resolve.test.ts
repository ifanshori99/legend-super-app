// 1268 W2 review: POST .../payment-intents/resolve. A supervisor settles a
// payment request whose answer never reached the till. Money rule: whatever
// arrives first, the late send or the resolve, one bill is paid at most once
// and a closed request can never be recorded afterwards.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { tenantIdSchema, ulidToUuid } from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import { setStaffPin } from "../services/device-pin.service.ts";
import { asCashierTenant } from "./pos-cashier-test-helpers.ts";
import { owner } from "./floor-test-helpers.ts";
import { agent, signUp } from "./helpers.ts";
import {
  attachDeposit,
  capturedIdr,
  HOLD_RELEASE_AFTER_MIN,
  holdFixture,
  issueQris,
  newSubmittedOrder,
  payNotice,
  postCancel,
  postRelease,
  resetHoldPorts,
  tenderStatuses,
  unallocatedFunds,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";
import { createPosOverride } from "../services/staff-override.service.ts";
import { userIdSchema } from "@starter/shared/core";

vi.setConfig({ testTimeout: 180_000 });

const PIN = "582914";
const BILL_IDR = 33_000;
let fx: HoldFixture;
let supervisor: string;
let outsider: string;

const tenantContext = () =>
  establishTenantContext({
    tenantId: tenantIdSchema.parse(fx.tenant.tenantId),
    brandId: null,
    source: "session",
  });

async function staff(name: string, permissions: string[]) {
  const client = agent(fx.app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant"]')`,
    [roleId, fx.tenant.tenantId, name, JSON.stringify(permissions)],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [fx.tenant.tenantId, userId, roleId],
  );
  await setStaffPin(
    tenantContext(),
    userId,
    { outletId: fx.tenant.outletId, userId },
    { pin: PIN },
  );
  return userId;
}

beforeAll(async () => {
  fx = await holdFixture("intent-resolve");
  supervisor = await staff("Supervisor Resolve", [
    "order.view",
    "pos.void.approve",
    "pos.edc_standalone.approve",
  ]);
  outsider = await staff("Kasir Lain Resolve", ["order.view"]);
});
afterAll(async () => {
  resetHoldPorts();
  await owner.end();
});

type Order = { id: string; status: string };

const resolve = (
  order: Order,
  key: string | null,
  over: Record<string, unknown> = {},
) =>
  fx.post(`${fx.base}/${order.id}/payment-intents/resolve`, {
    key,
    reason: "Kasir awal sudah pulang",
    approverUserId: supervisor,
    pin: PIN,
    ...over,
  });

const cash = (order: Order, key: string, over: Record<string, unknown> = {}) =>
  fx.post(`${fx.base}/${order.id}/tenders`, {
    method: "cash",
    receivedIdr: 50_000,
    expectedStatus: order.status,
    idempotencyKey: key,
    ...over,
  });

const cashKey = () => `cash:${randomUUID()}`;
const versionOf = async (order: Order) => {
  const read = await fx.get(`${fx.base}/${order.id}`);
  expect(read.status).toBe(200);
  return read.body.data.version as number;
};
const audits = async (order: Order) => {
  const { rows } = await owner.query<{ event: Record<string, unknown> }>(
    `SELECT event FROM audit_logs WHERE tenant_id=$1
       AND event->>'action' = 'pos_order.payment_intent_resolved'
       AND event::text LIKE $2`,
    [fx.tenant.tenantId, `%${order.id}%`],
  );
  return rows;
};

describe("who may resolve", () => {
  it("needs a right PIN, the approval permission, another person and a reason; nothing closes otherwise", async () => {
    const order = await newSubmittedOrder(fx);
    const key = cashKey();
    const wrong = await resolve(order, key, { pin: "111111" });
    expect(wrong.status, JSON.stringify(wrong.body)).toBe(401);
    expect(wrong.body.error.code).toBe("PIN_INVALID");
    expect(
      (await resolve(order, key, { approverUserId: outsider })).status,
    ).toBe(403);
    expect(
      (await resolve(order, key, { approverUserId: fx.staff.userId })).body
        .error.code,
    ).toBe("APPROVER_IS_REQUESTER");
    expect((await resolve(order, key, { reason: "  " })).status).toBe(422);
    expect((await resolve(order, "complete:abcdefgh")).status).toBe(422);
    expect(await audits(order)).toHaveLength(0);
    // The key is still free.
    expect((await cash(order, key)).status).toBe(201);
  });

  it("never answers for a bill of another outlet", async () => {
    const order = await newSubmittedOrder(fx);
    const base = fx.base.replace(fx.tenant.outletId, randomUUID());
    const answer = await fx.post(
      `${base}/${order.id}/payment-intents/resolve`,
      { key: cashKey(), reason: "uji", approverUserId: supervisor, pin: PIN },
    );
    expect([403, 404]).toContain(answer.status);
  });
});

describe("a readable request", () => {
  it("recorded: loads the result and changes nothing", async () => {
    const order = await newSubmittedOrder(fx);
    const key = cashKey();
    expect((await cash(order, key)).status).toBe(201);
    const version = await versionOf(order);
    const answer = await resolve(order, key);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(answer.body.data.outcome).toBe("recorded");
    expect(answer.body.data.order.tenders).toHaveLength(1);
    expect(await versionOf(order)).toBe(version);
    expect(await capturedIdr(fx, order.id)).toBe(BILL_IDR);
    // The cashier who sent it still gets the same answer.
    expect((await cash(order, key)).status).toBe(201);
    expect(await capturedIdr(fx, order.id)).toBe(BILL_IDR);
  });

  it("not recorded: closed, a late send is refused, another payment works", async () => {
    const order = await newSubmittedOrder(fx);
    const key = cashKey();
    const answer = await resolve(order, key);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(answer.body.data.outcome).toBe("closed");
    const late = await cash(order, key);
    expect(late.status, JSON.stringify(late.body)).toBe(409);
    expect(late.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await capturedIdr(fx, order.id)).toBe(0);
    // A repeated resolve (its own answer was lost) says the same.
    expect((await resolve(order, key)).body.data.outcome).toBe("closed");
    expect((await cash(order, cashKey())).status).toBe(201);
    expect(await capturedIdr(fx, order.id)).toBe(BILL_IDR);
    const rows = await audits(order);
    expect(rows).toHaveLength(2);
    const text = JSON.stringify(rows[0]!.event);
    expect(text).toContain("Kasir awal sudah pulang");
    expect(text).toContain(supervisor);
    expect(text).not.toContain(PIN);
  });

  it("a key of another bill is refused, recorded or closed", async () => {
    const first = await newSubmittedOrder(fx);
    const second = await newSubmittedOrder(fx);
    const recorded = cashKey();
    expect((await cash(first, recorded)).status).toBe(201);
    const closed = cashKey();
    expect((await resolve(first, closed)).status).toBe(200);
    for (const key of [recorded, closed]) {
      const answer = await resolve(second, key);
      expect(answer.status, JSON.stringify(answer.body)).toBe(409);
    }
  });

  it("a recorded QRIS stays locked by its hold", async () => {
    const order = await newSubmittedOrder(fx);
    const key = `qris:${randomUUID()}`;
    const sent = await fx.post(`${fx.base}/${order.id}/tenders`, {
      method: "qris",
      expectedStatus: order.status,
      idempotencyKey: key,
    });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    expect((await resolve(order, key)).body.data.outcome).toBe("recorded");
    const blocked = await cash(order, cashKey());
    expect(blocked.body.error.code).toBe("QRIS_HOLD_ACTIVE");
    expect(await capturedIdr(fx, order.id)).toBe(0);
  });

  it("repeated gateway failures: closed, then cash pays once", async () => {
    const order = await newSubmittedOrder(fx);
    const key = `qris:${randomUUID()}`;
    const body = {
      method: "qris",
      expectedStatus: order.status,
      idempotencyKey: key,
    };
    fx.gateway.failNextCreate(2);
    for (let i = 0; i < 2; i += 1) {
      const sent = await fx.post(`${fx.base}/${order.id}/tenders`, body);
      expect(sent.status, JSON.stringify(sent.body)).toBeGreaterThanOrEqual(
        500,
      );
    }
    expect((await resolve(order, key)).body.data.outcome).toBe("closed");
    const late = await fx.post(`${fx.base}/${order.id}/tenders`, body);
    expect(late.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect((await cash(order, cashKey())).status).toBe(201);
    expect(await capturedIdr(fx, order.id)).toBe(BILL_IDR);
    expect(
      (await tenderStatuses(fx, order.id)).map((tender) => tender.status),
    ).toEqual(["captured"]);
  });

  it("EDC not recorded needs the supervisor's statement about the card", async () => {
    const order = await newSubmittedOrder(fx);
    const key = `edc_standalone:${randomUUID()}`;
    const silent = await resolve(order, key);
    expect(silent.status, JSON.stringify(silent.body)).toBe(409);
    expect(silent.body.error.code).toBe(
      "PAYMENT_INTENT_CARD_STATEMENT_REQUIRED",
    );
    // Still open: nothing was closed by the refused resolve.
    const stated = await resolve(order, key, { card: "not_debited" });
    expect(stated.body.data.outcome).toBe("closed");
    expect(JSON.stringify(await audits(order))).toContain("not_debited");
  });
});

describe("late send against resolve", () => {
  it("in either order exactly one of them wins", async () => {
    const wins = new Set<string>();
    for (let i = 0; i < 6; i += 1) {
      const order = await newSubmittedOrder(fx);
      const key = cashKey();
      const [sent, answer] = await Promise.all(
        i % 2 === 0
          ? [cash(order, key), resolve(order, key)]
          : [resolve(order, key), cash(order, key)].reverse(),
      );
      expect(answer!.status, JSON.stringify(answer!.body)).toBe(200);
      const outcome = answer!.body.data.outcome as string;
      wins.add(outcome);
      if (outcome === "recorded") {
        expect(sent!.status).toBe(201);
        expect(await capturedIdr(fx, order.id)).toBe(BILL_IDR);
      } else {
        expect(sent!.status).toBe(409);
        expect(await capturedIdr(fx, order.id)).toBe(0);
      }
    }
    expect([...wins].every((w) => w === "recorded" || w === "closed")).toBe(
      true,
    );
  });

  it("a send in flight is waited for: resolve sees it recorded", async () => {
    const order = await newSubmittedOrder(fx);
    const key = cashKey();
    const blocker = await owner.connect();
    try {
      // Hold the order row: the send owns its key and waits here.
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [fx.tenant.tenantId],
      );
      await blocker.query("SELECT 1 FROM orders WHERE id = $1 FOR UPDATE", [
        ulidToUuid(order.id),
      ]);
      const sent = cash(order, key).then((r) => r);
      await waitForLockWaiters(1);
      const answer = resolve(order, key).then((r) => r);
      await waitForLockWaiters(2);
      await blocker.query("COMMIT");
      expect((await sent).status).toBe(201);
      expect((await answer).body.data.outcome).toBe("recorded");
      expect(await capturedIdr(fx, order.id)).toBe(BILL_IDR);
    } finally {
      blocker.release();
    }
  });

  it("a send that arrives during the resolve is refused", async () => {
    const order = await newSubmittedOrder(fx);
    const key = cashKey();
    const blocker = await owner.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [fx.tenant.tenantId],
      );
      await blocker.query("SELECT 1 FROM orders WHERE id = $1 FOR UPDATE", [
        ulidToUuid(order.id),
      ]);
      const answer = resolve(order, key).then((r) => r);
      await waitForLockWaiters(1);
      const sent = cash(order, key).then((r) => r);
      await waitForLockWaiters(2);
      await blocker.query("COMMIT");
      expect((await answer).body.data.outcome).toBe("closed");
      expect((await sent).body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
      expect(await capturedIdr(fx, order.id)).toBe(0);
    } finally {
      blocker.release();
    }
  });
});

/** Waits until `count` sessions of this database wait for a lock. */
async function waitForLockWaiters(count: number) {
  await vi.waitFor(
    async () => {
      const { rows } = await owner.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      expect(rows[0]!.n).toBeGreaterThanOrEqual(count);
    },
    { timeout: 15_000, interval: 50 },
  );
}

describe("an unreadable request", () => {
  const card = { card: "not_debited" };

  it("needs the card statement too: it may have been an EDC payment", async () => {
    const order = await newSubmittedOrder(fx);
    const version = await versionOf(order);
    const silent = await resolve(order, null);
    expect(silent.body.error.code).toBe(
      "PAYMENT_INTENT_CARD_STATEMENT_REQUIRED",
    );
    // Without the request there is no slip to record the payment from.
    const recording = await resolve(order, null, { card: "recording" });
    expect(recording.body.error.code).toBe(
      "PAYMENT_INTENT_CARD_STATEMENT_REQUIRED",
    );
    expect(await versionOf(order)).toBe(version);
  });

  it("clean: the version moves, so a late send made before is refused", async () => {
    const order = await newSubmittedOrder(fx);
    const version = await versionOf(order);
    const answer = await resolve(order, null, card);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(answer.body.data.outcome).toBe("fenced");
    expect(answer.body.data.order.version).toBe(version + 1);
    const late = await cash(order, cashKey(), { expectedVersion: version });
    expect(late.status, JSON.stringify(late.body)).toBe(412);
    expect(await capturedIdr(fx, order.id)).toBe(0);
    expect(
      (await cash(order, cashKey(), { expectedVersion: version + 1 })).status,
    ).toBe(201);
    expect(await capturedIdr(fx, order.id)).toBe(BILL_IDR);
  });

  it("paid: loads the paid bill without moving it", async () => {
    const order = await newSubmittedOrder(fx);
    expect((await cash(order, cashKey())).status).toBe(201);
    const version = await versionOf(order);
    const answer = await resolve(order, null, card);
    expect(answer.body.data.outcome).toBe("recorded");
    expect(await versionOf(order)).toBe(version);
  });

  it("refused while a QR can still be paid", async () => {
    const order = await newSubmittedOrder(fx);
    await issueQris(fx, order.id);
    const answer = await resolve(order, null, card);
    expect(answer.status, JSON.stringify(answer.body)).toBe(409);
    expect(answer.body.error.code).toBe("QRIS_HOLD_ACTIVE");
    await postCancel(fx, order.id);
    expect((await resolve(order, null, card)).body.error.code).toBe(
      "QRIS_HOLD_ACTIVE",
    );
  });

  it.each(["pending", "unknown"])(
    "refused while an EDC request is %s",
    async (status) => {
      const order = await newSubmittedOrder(fx);
      const terminal = randomUUID();
      await asCashierTenant(fx.tenant.tenantId, async (client) => {
        await client.query(
          `INSERT INTO payment_edc_terminals
             (id, tenant_id, outlet_id, bank_code, terminal_id, merchant_id, model,
              connection, ip_address, supported_methods, status)
           VALUES ($1, $2, $3, 'bca', $4, 'MID-IR', 'Test EDC', 'lan',
                   '10.0.0.9', ARRAY['card'], 'active')`,
          [
            terminal,
            fx.tenant.tenantId,
            fx.tenant.outletId,
            `TID-${terminal.slice(0, 8)}`,
          ],
        );
        await client.query(
          `INSERT INTO edc_transactions
             (id, tenant_id, outlet_id, terminal_id, bank, reference, idempotency_key,
              request_fingerprint, amount_idr, method, status, type, mode, trace,
              needs_reconciliation)
           SELECT $1, $2, $3, $4, 'bca', o.number, $5, 'fp', $6, 'card', $7, 'sale',
                  'ecr', $8, false FROM orders o WHERE o.id = $9`,
          [
            randomUUID(),
            fx.tenant.tenantId,
            fx.tenant.outletId,
            terminal,
            randomUUID(),
            BILL_IDR,
            status,
            randomUUID().slice(0, 12),
            ulidToUuid(order.id),
          ],
        );
      });
      const answer = await resolve(order, null, card);
      expect(answer.status, JSON.stringify(answer.body)).toBe(409);
      expect(answer.body.error.code).toBe("EDC_REQUEST_OPEN");
    },
  );

  it("refused while guest money of an earlier QR sits parked", async () => {
    const order = await newSubmittedOrder(fx);
    const qr = await issueQris(fx, order.id);
    expect((await postCancel(fx, order.id)).status).toBe(202);
    await owner.query(
      `UPDATE payment_intents SET expires_at = now() - $3::int * interval '1 minute'
        WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, qr.intentId, HOLD_RELEASE_AFTER_MIN + 1],
    );
    const { override } = await createPosOverride(
      tenantContext(),
      fx.staff.userId,
      {
        outletId: fx.tenant.outletId,
        action: "void",
        valueIdr: BILL_IDR,
        reason: "Penyedia QRIS tidak merespons",
        objectType: "order",
        objectId: order.id,
        approval: {
          method: "supervisor_pin",
          approverUserId: userIdSchema.parse(supervisor),
          pin: PIN,
        },
      } as Parameters<typeof createPosOverride>[2],
      { idempotencyKey: randomUUID() },
    );
    const released = await postRelease(fx, order.id, {
      approvedBy: supervisor,
      overrideId: override.id,
    });
    expect(released.status, JSON.stringify(released.body)).toBeLessThan(300);
    await attachDeposit(fx, order.id, 10_000);
    await payNotice(
      fx,
      qr.intentId,
      BILL_IDR,
      new Date(),
      qr.providerRef!,
    ).catch(() => null);
    expect(await unallocatedFunds(fx, qr.intentId)).toHaveLength(1);
    const version = await versionOf(order);
    const answer = await resolve(order, null, card);
    expect(answer.status, JSON.stringify(answer.body)).toBe(409);
    expect(answer.body.error.code).toBe("FUNDS_UNRESOLVED");
    expect(await versionOf(order)).toBe(version);
  });

  it("refused while a tender is authorized without a hold", async () => {
    const order = await newSubmittedOrder(fx);
    const qr = await issueQris(fx, order.id);
    // Only the hold is gone (a state no route makes): the tender still waits.
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [fx.tenant.tenantId],
      );
      await client.query(
        `UPDATE pos_qris_holds SET state = 'closed', closed_at = now(), close_reason = 'provider_expired'
          WHERE tenant_id = $1 AND payment_intent_id = $2`,
        [fx.tenant.tenantId, qr.intentId],
      );
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const answer = await resolve(order, null, card);
    expect(answer.status, JSON.stringify(answer.body)).toBe(409);
    expect(answer.body.error.code).toBe("CONFLICT");
  });
});
