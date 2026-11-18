// Kartu A legend-4wu4 (brief 974, tier K: money): the cashier must not be able
// to learn the drawer content by probing cash out / drop / cash in. Written
// from docs/briefs/974-pos-laci-inklusif.md (Kartu A) and the CTO decision that
// the "held" mechanism (legend-67dt, 3l4q, ym2kr: supervisor-only, identical
// cashier response) stays. Fixtures are trimmed copies of
// pos-shift-cash-approval.test.ts.
//
// Rules under test:
//   Proof 1: a cash out, drop or cash in answers the same way whatever the
//     drawer holds: 201, the same body shape, and no flag or figure about
//     holding (needsApproval, outcome, heldCashOutIdr) anywhere the cashier
//     reads. Raising the amount a little at a time, each try covered by a cash
//     in, is never refused.
//   Negative expected (legend-4wu4): the expected drawer may be negative. The
//     calculation does not throw, the shared contracts (count, shift-closed
//     event) accept it and the database stores it on counts and closed shifts.
//   Proof 2: on the normal path (expected >= 0) the difference stays recorded
//     and the close needs a real supervisor approval.
//
// Assumptions (the brief leaves them open):
//  - The record response is `data` of posCashMovementSchema; "no flag" means
//    the keys needsApproval, outcome and heldCashOutIdr are absent.
//  - A negative expected drawer is seeded straight into the database (the API
//    cannot reach it): float 100.000 - cash out 150.000 = -50.000; counting 0
//    gives variance +50.000 (counted - expected).
//  - Closing with an unknown approvalRequestId is refused with a 4xx that is
//    not a 422 (the id is well formed), and leaves the shift open.
//  - Closing a shift with a non-zero difference carries a varianceNote.
//  - The direct closed-shift update sets cash_out_idr = 150.000 without a
//    matching cash_movements row; this assumes no trigger cross-checks it.
//  - Cash refund/void without a drawer oracle is pinned by the legend-utqr
//    tests in pos-cash-guard.test.ts and is not repeated here.

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { idr } from "@starter/shared/core";
import {
  cashierShiftClosedPayloadSchema,
  posShiftCountReceiptSchema,
  posShiftCountSchema,
  shiftExpectedCashIdr,
} from "@starter/shared/pos";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { setDeviceOutletResolver } from "../services/device-pin.service.ts";
import { pinOverrideFixtureFingerprint } from "./pos-override-fixture.ts";
import { registerTestDevice } from "./device-seed.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const FLOAT_IDR = 100_000;

const roleIds = {
  cashier: randomUUID(),
  supervisor: randomUUID(),
};

let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };

type Member = { client: ReturnType<typeof agent>; userId: string };
type Cashier = Member & { deviceId: string };
let supervisor: Member;

const registeredDevices = new Map<string, string>();

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

async function member(roleId: string, label: string): Promise<Member> {
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

async function newCashier(label = "Kasir"): Promise<Cashier> {
  const base = await member(roleIds.cashier, label);
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

async function openShift(cashier: Cashier): Promise<{ id: string }> {
  const response = await cashier.client
    .post(SHIFTS())
    .set(headers)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, deviceHeader(cashier.deviceId))
    .send({ openingFloatIdr: FLOAT_IDR, idempotencyKey: randomUUID() });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data as { id: string };
}

function move(who: Member, shiftId: string, body: Record<string, unknown>) {
  return who.client
    .post(`${SHIFTS()}/${shiftId}/cash-movements`)
    .set(headers)
    .set(originHeader)
    .send({
      type: "cash_in",
      amountIdr: 20_000,
      reasonNote: "Tambah uang kembalian",
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

async function countDrawer(who: Member, shiftId: string, countedIdr: number) {
  const response = await who.client
    .post(`${SHIFTS()}/${shiftId}/counts`)
    .set(headers)
    .set(originHeader)
    .send({ idempotencyKey: randomUUID(), counts: countsFor(countedIdr) });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return posShiftCountReceiptSchema.parse(response.body.data);
}

async function countRow(countId: string) {
  const { rows } = await owner.query<{
    variance: number;
    expected: number;
    counted: number;
    held: number;
  }>(
    `SELECT variance_idr::int AS variance, expected_idr::int AS expected,
            counted_idr::int AS counted, held_cash_out_idr::int AS held
       FROM pos_shift_counts WHERE tenant_id = $1 AND id = $2`,
    [tenant.tenantId, countId],
  );
  return rows[0]!;
}

/** A stored count row with the given figures, straight into the database. */
async function seedCount(
  shiftId: string,
  cashierId: string,
  figures: { counted: number; expected: number },
): Promise<string> {
  const id = randomUUID();
  await asOwnerTenant(tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO pos_shift_counts
         (id, tenant_id, outlet_id, shift_id, sequence, counts, counts_fingerprint,
          counted_idr, expected_idr, variance_idr, submitted_by, submitted_at, forced,
          idempotency_key, request_fingerprint)
       VALUES ($1, $2, $3, $4, 1, '[]'::jsonb, $5, $6, $7, $8, $9, now(), false, $10, $5)`,
      [
        id,
        tenant.tenantId,
        tenant.outletId,
        shiftId,
        "b".repeat(64),
        figures.counted,
        figures.expected,
        figures.counted - figures.expected,
        cashierId,
        randomUUID(),
      ],
    ),
  );
  return id;
}

async function shiftRow(shiftId: string) {
  const { rows } = await owner.query<{
    status: string;
    difference: string | null;
  }>(
    `SELECT status, difference_idr::text AS difference
       FROM pos_shifts WHERE tenant_id = $1 AND id = $2`,
    [tenant.tenantId, shiftId],
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

/** Key structure of a record response, with the values dropped. */
const keysOf = (body: { data: Record<string, unknown> }) =>
  Object.keys(body.data).sort();

beforeAll(async () => {
  app = createApp();
  tenant = await createIsolatedTenant(
    `drawer-blind-${randomUUID().slice(0, 6)}`,
  );
  headers = { Host: tenant.hostname };
  setDeviceOutletResolver(
    async ({ tenantId, deviceId }) =>
      registeredDevices.get(`${tenantId}:${deviceId}`) ?? null,
  );
  const roles: [string, string, string[]][] = [
    [roleIds.cashier, "Kasir Laci Buta", ["shift.cash.operate"]],
    [roleIds.supervisor, "Supervisor Laci Buta", ["shift.cash.approve_close"]],
  ];
  for (const [id, name, permissions] of roles)
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant"]')`,
      [id, tenant.tenantId, name, JSON.stringify(permissions)],
    );
  supervisor = await member(roleIds.supervisor, "Supervisor");
});

afterAll(async () => {
  setDeviceOutletResolver(null);
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

// ---- Proof 1: no drawer oracle ---------------------------------------------------

const HOLD_KEYS = ["needsApproval", "outcome", "heldCashOutIdr"] as const;
const DRAWER_WORDS = /laci|drawer|expected|held|approval/i;

function expectNoHoldSignal(body: { data: Record<string, unknown> }) {
  for (const key of HOLD_KEYS) expect(body.data).not.toHaveProperty(key);
  expect(JSON.stringify(body)).not.toMatch(DRAWER_WORDS);
}

describe("legend-4wu4 proof 1: cash out, drop and cash in reveal nothing about the drawer", () => {
  it.each(["cash_out", "drop"] as const)(
    "legend-4wu4: a %s far over the drawer answers 201 like one that fits, with the same body shape and no hold signal",
    async (type) => {
      const cashier = await newCashier();
      const shift = await openShift(cashier);

      const fits = await move(cashier, shift.id, {
        type,
        amountIdr: 10_000,
        reasonNote: "Belanja kecil",
      });
      const over = await move(cashier, shift.id, {
        type,
        amountIdr: 5_000_000,
        reasonNote: "Belanja besar",
      });

      expect(fits.status, JSON.stringify(fits.body)).toBe(201);
      expect(over.status, JSON.stringify(over.body)).toBe(201);
      expect(keysOf(over.body)).toEqual(keysOf(fits.body));
      expectNoHoldSignal(fits.body);
      expectNoHoldSignal(over.body);
    },
  );

  it("legend-4wu4: a cash in answers the same whatever the drawer holds", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    const small = await move(cashier, shift.id, { amountIdr: 1_000 });
    await move(cashier, shift.id, {
      type: "cash_out",
      amountIdr: 400_000,
      reasonNote: "Belanja besar",
    });
    const afterOver = await move(cashier, shift.id, { amountIdr: 1_000 });
    expect(small.status, JSON.stringify(small.body)).toBe(201);
    expect(afterOver.status, JSON.stringify(afterOver.body)).toBe(201);
    expect(keysOf(afterOver.body)).toEqual(keysOf(small.body));
    expectNoHoldSignal(afterOver.body);
  });

  it("legend-4wu4: the cashier cannot probe the drawer by raising the amount a little at a time, each try covered by a cash in: every attempt is accepted with the same body shape", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    const baseline = await move(cashier, shift.id, {
      type: "cash_out",
      amountIdr: 10_000,
      reasonNote: "Belanja kecil",
    });
    expect(baseline.status, JSON.stringify(baseline.body)).toBe(201);
    const shape = keysOf(baseline.body);

    for (const amountIdr of [120_000, 140_000, 160_000, 180_000]) {
      const out = await move(cashier, shift.id, {
        type: "cash_out",
        amountIdr,
        reasonNote: "Coba nominal",
      });
      expect(out.status, JSON.stringify(out.body)).toBe(201);
      expect(keysOf(out.body)).toEqual(shape);
      expectNoHoldSignal(out.body);
      const back = await move(cashier, shift.id, {
        type: "cash_in",
        amountIdr,
        reasonNote: "Tutup percobaan",
      });
      expect(back.status, JSON.stringify(back.body)).toBe(201);
    }

    // The cashier's own count receipt stays blind (strict schema: no expected,
    // variance or held figure can appear).
    const count = await countDrawer(cashier, shift.id, 0);
    expect(count).not.toHaveProperty("expectedIdr");
    expect(count).not.toHaveProperty("heldCashOutIdr");
  });
});

// ---- Negative expected drawer ----------------------------------------------------

describe("legend-4wu4 the expected drawer may be negative", () => {
  it("legend-4wu4: shiftExpectedCashIdr returns a negative figure instead of throwing", () => {
    const input = {
      openingFloatIdr: idr(100_000),
      cashSalesIdr: idr(0),
      cashRefundsIdr: idr(0),
      cashInIdr: idr(0),
      cashOutIdr: idr(150_000),
      cashDropIdr: idr(0),
    };
    expect(Number(shiftExpectedCashIdr(input))).toBe(-50_000);
    expect(
      Number(
        shiftExpectedCashIdr({
          ...input,
          cashOutIdr: idr(0),
          cashDropIdr: idr(170_000),
        }),
      ),
    ).toBe(-70_000);
  });

  it("legend-4wu4: the stored count contract accepts a negative expected and variance, never a negative counted", () => {
    expect(
      posShiftCountSchema.shape.expectedIdr.safeParse(-50_000).success,
    ).toBe(true);
    expect(posShiftCountSchema.shape.countedIdr.safeParse(-1_000).success).toBe(
      false,
    );
  });

  it("legend-4wu4: the cashier_shift.closed payload accepts a negative expected (difference = counted - expected)", () => {
    const payload = {
      shiftId: randomUUID(),
      outletId: tenant.outletId,
      deviceId: randomUUID(),
      cashierId: randomUUID(),
      businessDate: "2026-10-15",
      openingFloatIdr: 100_000,
      cashSalesIdr: 0,
      cashRefundsIdr: 0,
      cashInIdr: 0,
      cashOutIdr: 150_000,
      cashDropIdr: 0,
      expectedIdr: -50_000,
      countedIdr: 0,
      differenceIdr: 50_000,
      varianceNote: "Selisih kas keluar belanja",
      approvedBy: randomUUID(),
      approvalRequestId: randomUUID(),
      closedAt: "2026-10-15T10:00:00.000Z",
    };
    const parsed = cashierShiftClosedPayloadSchema.safeParse(payload);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    // The identity still holds: a wrong difference is refused.
    expect(
      cashierShiftClosedPayloadSchema.safeParse({
        ...payload,
        differenceIdr: -50_000,
      }).success,
    ).toBe(false);
  });

  it("legend-4wu4: the database stores a negative expected on a count", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    const countId = await seedCount(shift.id, cashier.userId, {
      counted: 0,
      expected: -50_000,
    });
    expect(await countRow(countId)).toEqual({
      expected: -50_000,
      counted: 0,
      held: 0,
      variance: 50_000,
    });
  });

  it("legend-4wu4: the database stores a negative expected on a closed shift", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    const countId = await seedCount(shift.id, cashier.userId, {
      counted: 0,
      expected: -50_000,
    });
    const approval = await approvalFor(cashier, countId);
    await asOwnerTenant(tenant.tenantId, (client) =>
      client.query(
        `UPDATE pos_shifts SET status = 'closed', cash_out_idr = 150000,
            expected_idr = -50000, counted_idr = 0, variance_idr = 50000,
            variance_note = 'Selisih kas keluar belanja', counts = '[]'::jsonb,
            count_id = $3, approved_by = $4, approval_request_id = $5,
            approval_override_id = $6, approved_at = now(), closed_at = now(),
            closed_by = $7, close_key = $8, close_fingerprint = $9,
            version = version + 1
          WHERE tenant_id = $1 AND id = $2`,
        [
          tenant.tenantId,
          shift.id,
          countId,
          approval.approvedBy,
          approval.approvalRequestId,
          randomUUID(),
          cashier.userId,
          randomUUID(),
          "c".repeat(64),
        ],
      ),
    );
    const { rows } = await owner.query<{
      status: string;
      expected: number;
      variance: number;
    }>(
      `SELECT status, expected_idr::int AS expected, variance_idr::int AS variance
         FROM pos_shifts WHERE tenant_id = $1 AND id = $2`,
      [tenant.tenantId, shift.id],
    );
    expect(rows[0]).toEqual({
      status: "closed",
      expected: -50_000,
      variance: 50_000,
    });
  });
});

// ---- Proof 2: the difference is recorded and needs approval at close -------------

describe("legend-4wu4 proof 2: the difference stays on record and the close needs a supervisor", () => {
  it("legend-4wu4: a count short of expected records the difference and the close is refused without a real approval", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    const out = await move(cashier, shift.id, {
      type: "cash_out",
      amountIdr: 30_000,
      reasonNote: "Beli es batu",
    });
    expect(out.status, JSON.stringify(out.body)).toBe(201);

    // Expected 100.000 - 30.000 = 70.000; the cashier counts 50.000.
    const count = await countDrawer(cashier, shift.id, 50_000);
    expect(await countRow(count.id)).toEqual({
      expected: 70_000,
      counted: 50_000,
      held: 0,
      variance: -20_000,
    });

    const refused = await close(cashier, shift.id, {
      countId: count.id,
      approvedBy: supervisor.userId,
      approvalRequestId: randomUUID(),
      varianceNote: "Selisih kas keluar belanja",
    });
    expect(refused.status, JSON.stringify(refused.body)).toBeGreaterThanOrEqual(
      400,
    );
    expect(refused.status).toBeLessThan(500);
    expect(
      refused.status,
      "refused for the missing approval, not validation",
    ).not.toBe(422);
    expect((await shiftRow(shift.id)).status).toBe("open");
  });

  it("legend-4wu4: with the supervisor approval the shift closes and the difference stays recorded on the shift", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    await move(cashier, shift.id, {
      type: "cash_out",
      amountIdr: 30_000,
      reasonNote: "Beli es batu",
    });
    const count = await countDrawer(cashier, shift.id, 50_000);
    const closed = await close(cashier, shift.id, {
      countId: count.id,
      ...(await approvalFor(cashier, count.id)),
      varianceNote: "Selisih kas keluar belanja",
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    const row = await shiftRow(shift.id);
    expect(row.status).toBe("closed");
    expect(Number(row.difference)).toBe(-20_000);
  });

  it("legend-4wu4: a drawer that matches the count has no difference", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    await move(cashier, shift.id, {
      type: "cash_out",
      amountIdr: 30_000,
      reasonNote: "Beli es batu",
    });
    const count = await countDrawer(cashier, shift.id, 70_000);
    expect(await countRow(count.id)).toMatchObject({
      expected: 70_000,
      variance: 0,
    });
  });
});
