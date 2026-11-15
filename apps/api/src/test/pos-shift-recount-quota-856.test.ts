// Recount quota credit after a supervisor decision (bead legend-9me96, card B of
// batch 856; tier K: money). Written from the card brief, not the service code.
//
// Rule under test: the cashier may submit 3 counts per shift (forced=false,
// SHIFT_COUNT_LIMIT on the 4th). A supervisor decision (approved or rejected)
// on a held cash out of the same shift is a drawer event: counts the cashier
// submitted BEFORE that decision no longer use up the quota, so the cashier
// can recount. Counts submitted AFTER the decision are still charged. An
// 'expired' outcome (written by the system, no decider) gives no credit.
// SHIFT_COUNT_STALE on close and the variance rules stay as they are.
//
// Assumptions (the brief leaves them open):
//  - "Before" and "after" the decision are judged by time: a count whose
//    submittedAt is earlier than the outcome's decidedAt is not charged.
//  - Count amounts do not matter for the quota, so the earlier counts use
//    arbitrary multiples of Rp1.000.
//  - The 'expired' outcome row is written directly (decided_by NULL), as the
//    system writes it when a shift closes with the cash out still held.
//  - A refused decision (403, 409) stores no outcome, so it gives no credit.
//
// Fail-first: the credit tests fail today because the 4th count is refused with
// 409 SHIFT_COUNT_LIMIT. The guard tests (expired, other shift, refused
// decisions, STALE) pass today and must keep passing.

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { posShiftCountReceiptSchema } from "@starter/shared/pos";
import { createApp } from "../app.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { registerTestDevice } from "./device-seed.ts";
import { setDeviceOutletResolver } from "../services/device-pin.service.ts";
import { pinOverrideFixtureFingerprint } from "./pos-override-fixture.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const FLOAT_IDR = 100_000;
const HELD_IDR = 150_000;
const SALE_IDR = 100_000;
/** Drawer with the sale and before the approval: float + sale. */
const DRAWER_IDR = FLOAT_IDR + SALE_IDR;
/** Drawer after the held cash out is approved. */
const DRAWER_AFTER_APPROVE_IDR = DRAWER_IDR - HELD_IDR;
const LIMIT_MESSAGE =
  "Batas hitung ulang tercapai. Minta supervisor menutup shift.";

const roleIds = {
  cashier: randomUUID(),
  /** Records AND may approve: the self-decision case. */
  operator: randomUUID(),
  supervisor: randomUUID(),
};

let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };

type Member = { client: ReturnType<typeof agent>; userId: string };
type Cashier = Member & { deviceId: string };
let supervisor: Member;

const registeredDevices = new Map<string, string>();

// ---- Fixtures --------------------------------------------------------------------------

async function asOwnerTenant<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
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

async function memberOf(roleId: string, label: string): Promise<Member> {
  const client = agent(app);
  await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, roleId],
  );
  return { client, userId };
}

async function newCashier(
  label = "Kasir",
  roleId = roleIds.cashier,
): Promise<Cashier> {
  const base = await memberOf(roleId, label);
  const deviceId = randomUUID();
  registeredDevices.set(`${tenant.tenantId}:${deviceId}`, tenant.outletId);
  await registerTestDevice(owner, {
    tenantId: tenant.tenantId,
    outletId: tenant.outletId,
    deviceId,
  });
  return { ...base, deviceId };
}

function deviceHeader(deviceId: string): string {
  return signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: tenant.tenantId,
    brandId: null,
    deviceId,
  });
}

const SHIFTS = () =>
  `/api/outlets/${encodeURIComponent(tenant.outletId)}/pos/shifts`;

type Shift = { id: string; businessDate: string };

async function openShift(cashier: Cashier): Promise<Shift> {
  const response = await cashier.client
    .post(SHIFTS())
    .set(headers)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, deviceHeader(cashier.deviceId))
    .send({ openingFloatIdr: FLOAT_IDR, idempotencyKey: randomUUID() });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data as Shift;
}

function move(who: Member, shiftId: string, body: Record<string, unknown>) {
  return who.client
    .post(`${SHIFTS()}/${shiftId}/cash-movements`)
    .set(headers)
    .set(originHeader)
    .send({
      type: "cash_out",
      amountIdr: HELD_IDR,
      reasonNote: "Beli gas elpiji",
      idempotencyKey: randomUUID(),
      ...body,
    });
}

function close(who: Member, shiftId: string, body: Record<string, unknown>) {
  return who.client
    .post(`${SHIFTS()}/${shiftId}/close`)
    .set(headers)
    .set(originHeader)
    .send({ idempotencyKey: randomUUID(), ...body });
}

function submitCount(
  who: Member,
  shiftId: string,
  body: Record<string, unknown>,
) {
  return who.client
    .post(`${SHIFTS()}/${shiftId}/counts`)
    .set(headers)
    .set(originHeader)
    .send({ idempotencyKey: randomUUID(), ...body });
}

type CountReceipt = { id: string; sequence: number; countedIdr: number };

function countsFor(
  totalIdr: number,
): { denominationIdr: number; quantity: number }[] {
  let rest = totalIdr;
  const lines: { denominationIdr: number; quantity: number }[] = [];
  for (const denominationIdr of [
    100_000, 50_000, 20_000, 10_000, 5_000, 1_000,
  ]) {
    const quantity = Math.floor(rest / denominationIdr);
    if (quantity > 0) lines.push({ denominationIdr, quantity });
    rest -= quantity * denominationIdr;
  }
  if (rest !== 0) throw new Error("countsFor needs a multiple of 1000");
  if (lines.length === 0) lines.push({ denominationIdr: 1_000, quantity: 0 });
  return lines;
}

async function countDrawer(
  who: Member,
  shiftId: string,
  countedIdr: number,
): Promise<CountReceipt> {
  const response = await submitCount(who, shiftId, {
    counts: countsFor(countedIdr),
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return posShiftCountReceiptSchema.parse(response.body.data) as CountReceipt;
}

/** `n` cashier counts, each a different amount (the amount is irrelevant to the quota). */
async function countTimes(
  who: Member,
  shiftId: string,
  n: number,
  startSequence: number,
): Promise<CountReceipt[]> {
  const receipts: CountReceipt[] = [];
  for (let i = 0; i < n; i++) {
    const receipt = await countDrawer(
      who,
      shiftId,
      DRAWER_IDR - (i + 1) * 1_000,
    );
    expect(receipt.sequence).toBe(startSequence + i);
    receipts.push(receipt);
  }
  return receipts;
}

/** The refused answer of a count past the quota. */
async function expectLimit(who: Member, shiftId: string): Promise<void> {
  const refused = await submitCount(who, shiftId, {
    counts: countsFor(DRAWER_IDR),
  });
  expect(refused.status, JSON.stringify(refused.body)).toBe(409);
  expect(refused.body.error.code).toBe("SHIFT_COUNT_LIMIT");
  expect(refused.body.error.message).toBe(LIMIT_MESSAGE);
}

async function countRows(shiftId: string): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM pos_shift_counts WHERE tenant_id = $1 AND shift_id = $2",
    [tenant.tenantId, shiftId],
  );
  return rows[0]!.n;
}

async function countRow(countId: string) {
  const { rows } = await owner.query<{ variance: number; expected: number }>(
    `SELECT variance_idr::int AS variance, expected_idr::int AS expected
       FROM pos_shift_counts WHERE tenant_id = $1 AND id = $2`,
    [tenant.tenantId, countId],
  );
  return rows[0]!;
}

/** An approved `supervisor_pin` override row for closing with count `countId`. */
async function approvalFor(
  cashier: Member,
  countId: string,
): Promise<{ approvedBy: string; approvalRequestId: string }> {
  const id = randomUUID();
  const valueIdr = Math.abs((await countRow(countId)).variance);
  await asOwnerTenant(tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO pos_overrides
         (id, tenant_id, outlet_id, action, method, status, requested_by, approved_by,
          reason, value_idr, object_type, object_id, request_fingerprint, created_at, resolved_at)
       VALUES ($1, $2, $3, 'cash_shift_close', 'supervisor_pin', 'approved', $4, $5,
               'Hitung kas akhir shift', $6, 'pos_shift_count', $7, $8,
               now() - interval '5 seconds', now() - interval '5 seconds')`,
      [
        id,
        tenant.tenantId,
        tenant.outletId,
        cashier.userId,
        supervisor.userId,
        valueIdr,
        countId,
        pinOverrideFixtureFingerprint({
          requestedBy: cashier.userId,
          outletId: tenant.outletId,
          action: "cash_shift_close",
          valueIdr,
          reason: "Hitung kas akhir shift",
          objectType: "pos_shift_count",
          objectId: countId,
          approverUserId: supervisor.userId,
        }),
      ],
    ),
  );
  return { approvedBy: supervisor.userId, approvalRequestId: id };
}

/** A completed sale paid in cash on the shift (cash lands in the drawer). */
async function seedCashSale(
  shift: Shift,
  cashier: Cashier,
  totalIdr: number,
): Promise<void> {
  const orderId = randomUUID();
  const tax = Math.round(totalIdr / 11);
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO orders
         (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
          subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
          status, business_date, placed_at)
       VALUES ($1, $2, $3, $4, 'pos', 'takeaway', 'pay_first', $5, 0, 0, $6, 0, $7,
               'completed', $8, now())`,
      [
        orderId,
        tenant.tenantId,
        tenant.outletId,
        `SH-${orderId.slice(0, 8)}`,
        totalIdr - tax,
        tax,
        totalIdr,
        shift.businessDate,
      ],
    );
    await client.query(
      `INSERT INTO pos_orders
         (order_id, tenant_id, outlet_id, channel, shift_id, device_id, cashier_id, submitted_at, completed_at)
       VALUES ($1, $2, $3, 'pos', $4, $5, $6, now(), now())`,
      [
        orderId,
        tenant.tenantId,
        tenant.outletId,
        shift.id,
        cashier.deviceId,
        cashier.userId,
      ],
    );
    await client.query(
      `INSERT INTO pos_order_tenders
         (tenant_id, outlet_id, order_id, method, provider, amount_idr, received_idr, change_idr,
          status, requested_at, resolved_at, captured_by, shift_id)
       VALUES ($1, $2, $3, 'cash', 'manual', $4, $4, 0, 'captured', now(), now(), $5, $6)`,
      [
        tenant.tenantId,
        tenant.outletId,
        orderId,
        totalIdr,
        cashier.userId,
        shift.id,
      ],
    );
  });
}

type Held = { cashier: Cashier; shift: Shift; movementId: string };

/**
 * A Rp150.000 cash out held on a fresh shift (Rp100.000 float). With
 * `drawerCoversIt` a Rp100.000 cash sale lets the drawer (Rp200.000) cover it,
 * so a supervisor can approve it.
 */
async function heldCashOut(
  options: {
    drawerCoversIt?: boolean;
    label?: string;
    roleId?: ReturnType<typeof randomUUID>;
  } = {},
): Promise<Held> {
  const { drawerCoversIt = true, label = "Kasir", roleId } = options;
  const cashier = await newCashier(label, roleId);
  const shift = await openShift(cashier);
  const recorded = await move(cashier, shift.id, {});
  expect(recorded.status, JSON.stringify(recorded.body)).toBe(201);
  if (drawerCoversIt) await seedCashSale(shift, cashier, SALE_IDR);
  const { rows } = await owner.query<{ id: string; needs_approval: boolean }>(
    "SELECT id, needs_approval FROM cash_movements WHERE tenant_id = $1 AND shift_id = $2",
    [tenant.tenantId, shift.id],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]!.needs_approval).toBe(true);
  return { cashier, shift, movementId: rows[0]!.id };
}

function decide(
  who: Member,
  held: { shift: { id: string }; movementId: string },
  decision: "approved" | "rejected",
) {
  return who.client
    .post(
      `/api/outlets/${encodeURIComponent(tenant.outletId)}/pos/shifts/${encodeURIComponent(held.shift.id)}/cash-movements/${encodeURIComponent(held.movementId)}/decision`,
    )
    .set(headers)
    .set(originHeader)
    .send({ decision });
}

async function decideOk(
  held: Held,
  decision: "approved" | "rejected",
): Promise<void> {
  const response = await decide(supervisor, held, decision);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body.data.outcome).toBe(decision);
}

async function outcomesOf(shiftId: string) {
  const { rows } = await owner.query<{
    outcome: string;
    decided_by: string | null;
  }>(
    `SELECT outcome, decided_by FROM cash_movement_outcomes
      WHERE tenant_id = $1 AND shift_id = $2`,
    [tenant.tenantId, shiftId],
  );
  return rows;
}

/** The outcome the system writes when a shift closes with the cash out still held. */
function insertExpiredOutcome(held: Held) {
  return asOwnerTenant(tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO cash_movement_outcomes
         (tenant_id, outlet_id, shift_id, movement_id, outcome, decided_by, decided_at)
       VALUES ($1, $2, $3, $4, 'expired', NULL, now())`,
      [tenant.tenantId, tenant.outletId, held.shift.id, held.movementId],
    ),
  );
}

async function shiftFigures(shiftId: string) {
  const { rows } = await owner.query<{
    status: string;
    expected: string;
    counted: string;
    variance: string;
  }>(
    `SELECT status, expected_idr::text AS expected, counted_idr::text AS counted,
            variance_idr::text AS variance
       FROM pos_shifts WHERE tenant_id = $1 AND id = $2`,
    [tenant.tenantId, shiftId],
  );
  return rows[0]!;
}

beforeAll(async () => {
  app = createApp();
  tenant = await createIsolatedTenant(
    `recount-quota-${randomUUID().slice(0, 6)}`,
  );
  headers = { Host: tenant.hostname };
  setDeviceOutletResolver(
    async ({ tenantId, deviceId }) =>
      registeredDevices.get(`${tenantId}:${deviceId}`) ?? null,
  );
  const roles: [string, string, string[]][] = [
    [roleIds.cashier, "Kasir Kuota", ["shift.cash.operate"]],
    [
      roleIds.operator,
      "Penyelia Kas Kuota",
      ["shift.cash.operate", "shift.cash.approve_close"],
    ],
    [roleIds.supervisor, "Supervisor Kuota", ["shift.cash.approve_close"]],
  ];
  for (const [id, name, permissions] of roles)
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant"]')`,
      [id, tenant.tenantId, name, JSON.stringify(permissions)],
    );
  supervisor = await memberOf(roleIds.supervisor, "Supervisor Kuota");
});

afterAll(async () => {
  setDeviceOutletResolver(null);
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

// ---- The credit ----------------------------------------------------------------------

describe("legend-9me96 a supervisor decision gives the cashier their recount quota back", () => {
  it("legend-9me96: after 3 counts and an APPROVED held cash out, the cashier can count again (4th count is 201, sequence 4)", async () => {
    const held = await heldCashOut();
    await countTimes(held.cashier, held.shift.id, 3, 1);
    await decideOk(held, "approved");

    const recount = await submitCount(held.cashier, held.shift.id, {
      counts: countsFor(DRAWER_AFTER_APPROVE_IDR),
    });

    expect(recount.status, JSON.stringify(recount.body)).toBe(201);
    expect(recount.body.data.sequence).toBe(4);
    expect(await countRows(held.shift.id)).toBe(4);
  });

  it("legend-9me96: after 3 counts and a REJECTED held cash out, the cashier can count again (4th count is 201, sequence 4)", async () => {
    const held = await heldCashOut();
    await countTimes(held.cashier, held.shift.id, 3, 1);
    await decideOk(held, "rejected");

    const recount = await submitCount(held.cashier, held.shift.id, {
      counts: countsFor(DRAWER_IDR),
    });

    expect(recount.status, JSON.stringify(recount.body)).toBe(201);
    expect(recount.body.data.sequence).toBe(4);
    expect(await countRows(held.shift.id)).toBe(4);
  });

  it("legend-9me96: the credit is a one-time reset, not a free pass: counts AFTER an approved decision are still charged, so the 4th charged count is 409 SHIFT_COUNT_LIMIT", async () => {
    const held = await heldCashOut();
    await countTimes(held.cashier, held.shift.id, 3, 1);
    await decideOk(held, "approved");

    // Three counts after the decision use the quota (sequence 4, 5, 6) ...
    await countTimes(held.cashier, held.shift.id, 3, 4);
    // ... so the 4th one after it is refused.
    await expectLimit(held.cashier, held.shift.id);
    expect(await countRows(held.shift.id)).toBe(6);
  });

  it("legend-9me96: same after a REJECTED decision: 3 counts after it are charged, the 4th is SHIFT_COUNT_LIMIT", async () => {
    const held = await heldCashOut();
    await countTimes(held.cashier, held.shift.id, 3, 1);
    await decideOk(held, "rejected");

    await countTimes(held.cashier, held.shift.id, 3, 4);
    await expectLimit(held.cashier, held.shift.id);
    expect(await countRows(held.shift.id)).toBe(6);
  });

  it("legend-9me96: only the counts BEFORE the decision are credited: 2 counts, decision, then 3 charged counts is fine and the next one is SHIFT_COUNT_LIMIT", async () => {
    const held = await heldCashOut();
    await countTimes(held.cashier, held.shift.id, 2, 1);
    await decideOk(held, "approved");

    await countTimes(held.cashier, held.shift.id, 3, 3);
    await expectLimit(held.cashier, held.shift.id);
    expect(await countRows(held.shift.id)).toBe(5);
  });

  it("legend-9me96: a count made right after the decision is charged even when 3 earlier counts were credited (post-decision count 1 of 3, then 2 more, then the limit)", async () => {
    const held = await heldCashOut();
    await countTimes(held.cashier, held.shift.id, 3, 1);
    await decideOk(held, "rejected");
    await countTimes(held.cashier, held.shift.id, 1, 4);

    // Two charged slots are left, not three.
    await countTimes(held.cashier, held.shift.id, 2, 5);
    await expectLimit(held.cashier, held.shift.id);
  });
});

// ---- No credit ----------------------------------------------------------------------

describe("legend-9me96 what gives no recount credit", () => {
  it("legend-9me96: an EXPIRED outcome gives no credit: after 3 counts the 4th is still SHIFT_COUNT_LIMIT", async () => {
    const held = await heldCashOut({ drawerCoversIt: false });
    await countTimes(held.cashier, held.shift.id, 3, 1);
    await insertExpiredOutcome(held);
    expect(await outcomesOf(held.shift.id)).toEqual([
      { outcome: "expired", decided_by: null },
    ]);

    await expectLimit(held.cashier, held.shift.id);
    expect(await countRows(held.shift.id)).toBe(3);
  });

  it("legend-9me96: no decision at all (the cash out stays held) gives no credit", async () => {
    const held = await heldCashOut();
    await countTimes(held.cashier, held.shift.id, 3, 1);

    await expectLimit(held.cashier, held.shift.id);
  });

  it("legend-9me96: a decision on ANOTHER shift gives no credit on this one", async () => {
    const here = await heldCashOut({
      drawerCoversIt: false,
      label: "Kasir A",
    });
    const there = await heldCashOut({ label: "Kasir B" });
    await countTimes(here.cashier, here.shift.id, 3, 1);
    await countTimes(there.cashier, there.shift.id, 3, 1);
    await decideOk(there, "approved");

    await expectLimit(here.cashier, here.shift.id);
    // Control: the decided shift's own cashier is credited (same rule, other shift).
    const credited = await countDrawer(
      there.cashier,
      there.shift.id,
      DRAWER_AFTER_APPROVE_IDR,
    );
    expect(credited.sequence).toBe(4);
  });

  it("legend-9me96: a cashier cannot buy credit by deciding: a cashier without the approve permission gets 403, stores no outcome and the 4th count is SHIFT_COUNT_LIMIT", async () => {
    const held = await heldCashOut();
    await countTimes(held.cashier, held.shift.id, 3, 1);

    const refused = await decide(held.cashier, held, "approved");

    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(await outcomesOf(held.shift.id)).toEqual([]);
    await expectLimit(held.cashier, held.shift.id);
  });

  it("legend-9me96: the person who recorded the cash out cannot decide it even with the approve permission: 403, no outcome, no credit", async () => {
    const held = await heldCashOut({
      label: "Penyelia Sendiri",
      roleId: roleIds.operator,
    });
    await countTimes(held.cashier, held.shift.id, 3, 1);

    const refused = await decide(held.cashier, held, "approved");

    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(await outcomesOf(held.shift.id)).toEqual([]);
    await expectLimit(held.cashier, held.shift.id);
  });

  it("legend-9me96: a refused approval (the drawer cannot cover it, 409) stores no outcome and gives no credit", async () => {
    const held = await heldCashOut({ drawerCoversIt: false });
    await countTimes(held.cashier, held.shift.id, 3, 1);

    const refused = await decide(supervisor, held, "approved");

    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(await outcomesOf(held.shift.id)).toEqual([]);
    await expectLimit(held.cashier, held.shift.id);
  });

  it("legend-9me96: a repeated decision does not credit again: after the credit and 3 charged counts the next count is SHIFT_COUNT_LIMIT", async () => {
    const held = await heldCashOut();
    await countTimes(held.cashier, held.shift.id, 3, 1);
    await decideOk(held, "approved");
    await countTimes(held.cashier, held.shift.id, 3, 4);

    // Repeating the same decision is a no-op (200); it must not reset the quota.
    const again = await decide(supervisor, held, "approved");
    expect(again.status, JSON.stringify(again.body)).toBe(200);

    await expectLimit(held.cashier, held.shift.id);
    expect(await outcomesOf(held.shift.id)).toHaveLength(1);
  });
});

// ---- Close rules stay as they are -------------------------------------------------------

describe("legend-9me96 close rules are unchanged by the credit", () => {
  it("legend-9me96: a count taken before an APPROVED decision is stale on close (409 SHIFT_COUNT_STALE); a recount is allowed and then closes", async () => {
    const held = await heldCashOut();
    const counts = await countTimes(held.cashier, held.shift.id, 3, 1);
    const beforeDecision = counts[2]!;
    await decideOk(held, "approved");

    const stale = await close(held.cashier, held.shift.id, {
      countId: beforeDecision.id,
      ...(await approvalFor(held.cashier, beforeDecision.id)),
    });
    expect(stale.status, JSON.stringify(stale.body)).toBe(409);
    expect(stale.body.error.code).toBe("SHIFT_COUNT_STALE");
    expect((await shiftFigures(held.shift.id)).status).toBe("open");

    // The credit lets the cashier recount; the fresh count closes.
    const recount = await countDrawer(
      held.cashier,
      held.shift.id,
      DRAWER_AFTER_APPROVE_IDR,
    );
    expect(recount.sequence).toBe(4);
    const closed = await close(held.cashier, held.shift.id, {
      countId: recount.id,
      ...(await approvalFor(held.cashier, recount.id)),
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(await shiftFigures(held.shift.id)).toMatchObject({
      status: "closed",
      expected: String(DRAWER_AFTER_APPROVE_IDR),
      counted: String(DRAWER_AFTER_APPROVE_IDR),
      variance: "0",
    });
  });

  it("legend-9me96: the credit does not hide a shortage: a recount short by Rp10.000 after the decision closes with the real variance", async () => {
    const held = await heldCashOut();
    await countTimes(held.cashier, held.shift.id, 3, 1);
    await decideOk(held, "approved");

    const shortIdr = DRAWER_AFTER_APPROVE_IDR - 10_000;
    const recount = await countDrawer(held.cashier, held.shift.id, shortIdr);
    expect(recount.sequence).toBe(4);
    expect(await countRow(recount.id)).toEqual({
      expected: DRAWER_AFTER_APPROVE_IDR,
      variance: -10_000,
    });
    const closed = await close(held.cashier, held.shift.id, {
      countId: recount.id,
      ...(await approvalFor(held.cashier, recount.id)),
      varianceNote: "Uang kembalian kurang",
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(await shiftFigures(held.shift.id)).toMatchObject({
      status: "closed",
      expected: String(DRAWER_AFTER_APPROVE_IDR),
      counted: String(shortIdr),
      variance: "-10000",
    });
  });

  it("legend-9me96: after a REJECTED decision the drawer is unchanged (rejecting pays nothing): the credited recount closes with zero variance", async () => {
    const held = await heldCashOut();
    await countTimes(held.cashier, held.shift.id, 3, 1);
    await decideOk(held, "rejected");

    const recount = await countDrawer(held.cashier, held.shift.id, DRAWER_IDR);
    expect(recount.sequence).toBe(4);
    const closed = await close(held.cashier, held.shift.id, {
      countId: recount.id,
      ...(await approvalFor(held.cashier, recount.id)),
    });

    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(await shiftFigures(held.shift.id)).toMatchObject({
      status: "closed",
      expected: String(DRAWER_IDR),
      counted: String(DRAWER_IDR),
      variance: "0",
    });
  });
});
