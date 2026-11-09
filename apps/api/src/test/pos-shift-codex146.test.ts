// Reproduction of the Codex 146 findings F1-F4 on the shift close (bead
// legend-q7jj, tier K; PRD v1.7 §3 F8 "Shift Kasir", §3.7 approval matrix).
// Acceptance (same IDs as pos-shift.test.ts / pos-shift-db.test.ts):
//   POS-03  "Tutup shift memakai blind count; selisih kas tidak dapat
//           disembunyikan atau diubah setelah disetujui"
// Each test asserts the CORRECT behaviour, so each one fails before the fix.
//
// Fixtures are copied (trimmed) from pos-shift.test.ts: everything goes
// through the real Express app, Better Auth, RBAC and PostgreSQL with RLS in a
// fresh isolated tenant that has no approval policy unless a test adds one.
//
// Assumptions (the finding text leaves them open):
//  - F1: a close that names a count that is stale (any cash mutation after the
//    count, whatever the net effect and whether the movement was held) answers
//    409 SHIFT_COUNT_STALE, before any approval is judged. The test asserts
//    that the normal and the held path answer the SAME status and code, and
//    that the answer is the stale one.
//  - F2 (decided, legend-y9bf): a held cash movement is not disbursed; it
//    expires at the close with its cash still in the drawer. Closing with an
//    unpaid held cash out of Rp150.000 (counted = expected) needs no note,
//    books differenceIdr 0 and the auto-journal consumer posts NO journal for
//    the shift and parks nothing. A control close with a real over posts, so
//    the test cannot pass because the accounting setup is broken.
//  - F3: the refusal of an over-cap cash out is a 400 VALIDATION_ERROR, like
//    the existing "second held cash out past the safe integer" refusal. Held
//    and normal refunds are seeded straight into pos_order_refunds with
//    shift_id = the shift and cash lines {method:'cash',...} (what the refund
//    writer stores), on a cash sale of the same shift. Voids are seeded into
//    pos_order_voids on a cash sale. The refusal through the real refund and
//    void writers lives in pos-cash-guard.test.ts (it has their fixtures).
//  - F1: a count whose cash_watermark is NULL (made before the column) is
//    stale: 409 SHIFT_COUNT_STALE on close and force close, recount closes.
//  - F4: an old chain opened with an amount, or with a payload whose valueIdr
//    is missing / a string / null, is refused with 403 after the shift-close
//    policy rows are deleted (the existing tests use 403 for the same chains
//    while a policy exists).

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  tenantIdSchema,
  userIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import {
  posShiftCountReceiptSchema,
  posShiftCountSchema,
} from "@starter/shared/pos";
import { eventEnvelopeSchema } from "@starter/shared/events";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { deliverAutoJournalEvent } from "../services/accounting-auto-journal-consumer.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import { createPosOverride } from "../services/staff-override.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const PIN = "582914";
const FLOAT_IDR = 100_000;
const HELD_IDR = 150_000;

const roleIds = { cashier: randomUUID(), supervisor: randomUUID() };

let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };

type Member = { client: ReturnType<typeof agent>; userId: string };
type Cashier = Member & { deviceId: string };
let supervisor: Member;

const registeredDevices = new Map<string, string>();

// ---- Fixtures (trimmed copies of pos-shift.test.ts) --------------------------------

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

function tenantContextOf(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
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

async function openShift(
  cashier: Cashier,
): Promise<{ id: string; businessDate: string }> {
  const response = await cashier.client
    .post(SHIFTS())
    .set(headers)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, deviceHeader(cashier.deviceId))
    .send({ openingFloatIdr: FLOAT_IDR, idempotencyKey: randomUUID() });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data as { id: string; businessDate: string };
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

function forceClose(
  who: Member,
  shiftId: string,
  body: Record<string, unknown>,
) {
  return who.client
    .post(`${SHIFTS()}/${shiftId}/force-close`)
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

function listCounts(who: Member, shiftId: string) {
  return who.client
    .get(`${SHIFTS()}/${shiftId}/counts`)
    .set(headers)
    .set(originHeader);
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

async function countRow(countId: string) {
  const { rows } = await owner.query<{ variance: number }>(
    "SELECT variance_idr::int AS variance FROM pos_shift_counts WHERE tenant_id = $1 AND id = $2",
    [tenant.tenantId, countId],
  );
  return rows[0];
}

/** An approved `supervisor_pin` override row for closing with count `countId`. */
async function approvalFor(
  cashier: Member,
  countId: string,
): Promise<{ approvedBy: string; approvalRequestId: string }> {
  const id = randomUUID();
  const valueIdr = Math.abs((await countRow(countId))?.variance ?? 0);
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
        randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
      ],
    ),
  );
  return { approvedBy: supervisor.userId, approvalRequestId: id };
}

/** Count `countedIdr`, approve that count, and close with it. */
async function closeShift(
  cashier: Member,
  shiftId: string,
  countedIdr: number,
  extra: Record<string, unknown> = {},
) {
  const count = await countDrawer(cashier, shiftId, countedIdr);
  const approval = await approvalFor(cashier, count.id);
  return close(cashier, shiftId, { countId: count.id, ...approval, ...extra });
}

async function shiftRow(shiftId: string) {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM pos_shifts WHERE tenant_id = $1 AND id = $2",
    [tenant.tenantId, shiftId],
  );
  return rows[0];
}

/** A completed sale on the shift paid by `method` (cash lands in the shift's drawer). */
async function seedSale(
  shift: { id: string; businessDate: string },
  cashier: Cashier,
  totalIdr: number,
  method: "cash" | "qris" = "qris",
): Promise<string> {
  const orderId = randomUUID();
  const tax = Math.round(totalIdr / 11);
  const cash = method === "cash";
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
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'captured', now(), now(), $9, $10)`,
      [
        tenant.tenantId,
        tenant.outletId,
        orderId,
        method,
        cash ? "manual" : "doit",
        totalIdr,
        cash ? totalIdr : null,
        cash ? 0 : null,
        cashier.userId,
        cash ? shift.id : null,
      ],
    );
  });
  return orderId;
}

/**
 * A cash refund of the order, charged to `shiftId`: one cash line, as the
 * refund writer stores it (method, amountIdr, reference). Held by default.
 */
async function seedHeldRefund(
  shiftId: string,
  orderId: string,
  cashier: Member,
  amountIdr: number,
  needsApproval = true,
): Promise<void> {
  await asOwnerTenant(tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO pos_order_refunds
         (tenant_id, outlet_id, order_id, amount_idr, reason, reason_note, lines,
          requested_by, approved_by, approval_request_id, refunded_at, shift_id, needs_approval)
       VALUES ($1, $2, $3, $4, 'quality_complaint', 'Minuman tumpah', $5::jsonb,
               $6, $7, $8, now(), $9, $10)`,
      [
        tenant.tenantId,
        tenant.outletId,
        orderId,
        amountIdr,
        JSON.stringify([{ method: "cash", amountIdr, reference: null }]),
        cashier.userId,
        supervisor.userId,
        randomUUID(),
        shiftId,
        needsApproval,
      ],
    ),
  );
}

/** A void of the (cash) order, charged to `shiftId`; its captured cash left the drawer. */
async function seedVoid(
  shiftId: string,
  orderId: string,
  cashier: Member,
  needsApproval = false,
): Promise<void> {
  await asOwnerTenant(tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO pos_order_voids
         (tenant_id, outlet_id, order_id, receipt_number, amount_idr, reason, reason_note,
          requested_by, approved_by, override_id, voided_at, shift_id, needs_approval)
       VALUES ($1, $2, $3, $4, 11000, 'customer_cancelled', 'Pelanggan salah pesan',
               $5, $6, $7, now(), $8, $9)`,
      [
        tenant.tenantId,
        tenant.outletId,
        orderId,
        `SH-V-${orderId.slice(0, 8)}`,
        cashier.userId,
        supervisor.userId,
        randomUUID(),
        shiftId,
        needsApproval,
      ],
    ),
  );
}

async function pinOverride(caller: Member, countId: string) {
  const { override } = await createPosOverride(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    caller.userId,
    {
      outletId: tenant.outletId,
      action: "cash_shift_close",
      valueIdr: 0,
      reason: "Hitung kas akhir shift",
      objectType: "pos_shift_count",
      objectId: countId,
      approval: {
        method: "supervisor_pin",
        approverUserId: userIdSchema.parse(supervisor.userId),
        pin: PIN,
      },
    } as Parameters<typeof createPosOverride>[2],
    { idempotencyKey: randomUUID() },
  );
  return override;
}

/** Shift-close matrix rows, inserted for the duration of `run` only, then deleted. */
async function withShiftClosePolicies(
  rows: { thresholdIdr: number | null; roleId: string; level: number }[],
  run: () => Promise<void>,
): Promise<void> {
  const ids: string[] = [];
  try {
    for (const row of rows) {
      const { rows: inserted } = await owner.query<{ id: string }>(
        `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
         VALUES ($1, 'cash_shift_close', $2, $3, $4) RETURNING id`,
        [tenant.tenantId, row.thresholdIdr, row.roleId, row.level],
      );
      ids.push(inserted[0]!.id);
    }
    await run();
  } finally {
    await owner.query(
      "DELETE FROM approval_policies WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.tenantId, ids],
    );
  }
}

/**
 * An approved `supervisor_phone` chain written as the owner (what a decision in
 * the inbox stores). `chainAmountIdr` builds an old chain opened for an amount;
 * `payloadValueIdr` (when the key is present) is the payload's valueIdr, with
 * `undefined` leaving it out.
 */
async function phoneApprovalFor(
  cashier: Member,
  countId: string,
  options: { chainAmountIdr?: number | null; payloadValueIdr?: unknown } = {},
): Promise<{ approvedBy: string; approvalRequestId: string }> {
  const chainId = randomUUID();
  const overrideId = randomUUID();
  const valueIdr = Math.abs((await countRow(countId))?.variance ?? 0);
  const snapshot = [{ level: 1, approverRoleIds: [roleIds.supervisor] }];
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO approval_requests
         (id, tenant_id, outlet_id, chain_id, source_module, action_type, object_type, object_id,
          payload, requested_by, source, level, required_levels, required_steps, amount_idr, status,
          decided_by, decided_at, reason, request_reason, deadline_at, created_at)
       VALUES ($1, $2, $3, $1, 'pos_override', 'cash_shift_close', 'pos_override', $4,
               $5::jsonb, $6, 'user', 1, 1, $7::jsonb, $8, 'approved',
               $9, $10, 'Disetujui lewat ponsel', 'Hitung kas akhir shift',
               now() + interval '1 hour', now() - interval '6 seconds')`,
      [
        chainId,
        tenant.tenantId,
        tenant.outletId,
        overrideId,
        JSON.stringify({
          action: "cash_shift_close",
          objectId: countId,
          valueIdr:
            "payloadValueIdr" in options ? options.payloadValueIdr : valueIdr,
        }),
        cashier.userId,
        JSON.stringify(snapshot),
        options.chainAmountIdr ?? null,
        supervisor.userId,
        new Date(Date.now() - 4_000),
      ],
    );
    await client.query(
      `INSERT INTO pos_overrides
         (id, tenant_id, outlet_id, action, method, status, requested_by, approved_by,
          reason, value_idr, object_type, object_id, approval_request_id, request_fingerprint,
          created_at, resolved_at)
       VALUES ($1, $2, $3, 'cash_shift_close', 'supervisor_phone', 'approved', $4, $5,
               'Hitung kas akhir shift', $6, 'pos_shift_count', $7, $8, $9,
               now() - interval '6 seconds', now() - interval '4 seconds')`,
      [
        overrideId,
        tenant.tenantId,
        tenant.outletId,
        cashier.userId,
        supervisor.userId,
        valueIdr,
        countId,
        chainId,
        randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
      ],
    );
  });
  return { approvedBy: supervisor.userId, approvalRequestId: chainId };
}

beforeAll(async () => {
  app = createApp();
  tenant = await createIsolatedTenant(`codex146-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  setDeviceOutletResolver(
    async ({ tenantId, deviceId }) =>
      registeredDevices.get(`${tenantId}:${deviceId}`) ?? null,
  );
  const roles: [string, string, string[]][] = [
    [roleIds.cashier, "Kasir Codex 146", ["shift.cash.operate"]],
    [roleIds.supervisor, "Supervisor Codex 146", ["shift.cash.approve_close"]],
  ];
  for (const [id, name, permissions] of roles)
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant"]')`,
      [id, tenant.tenantId, name, JSON.stringify(permissions)],
    );
  supervisor = await member(roleIds.supervisor, "Supervisor");
  await setStaffPin(
    tenantContextOf(tenant.tenantId).tenant,
    supervisor.userId,
    { outletId: tenant.outletId, userId: supervisor.userId },
    { pin: PIN },
  );
});

afterAll(async () => {
  setDeviceOutletResolver(null);
  // Audit rows and closed shifts are append-only, so the isolated tenant stays
  // in the disposable database; give it a valid creator.
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

// ---- F1 ----------------------------------------------------------------------------

describe("POS-03 legend-q7jj F1: a stale count is no balance oracle", () => {
  it("after a count, cash out X then cash in X answers the same SHIFT_COUNT_STALE whether the cash out was normal or held, with or without a valid approval", async () => {
    // Normal: Rp10.000 fits the drawer. Held: Rp150.000 is over the drawer.
    // Both nets are zero for the expected cash of a normal drawer, so only the
    // held path used to look stale (409) while the normal one asked for the
    // approval (403): the difference tells the cashier the drawer balance.
    const answers: { status: number; code: string }[] = [];
    for (const amountIdr of [10_000, HELD_IDR]) {
      const cashier = await newCashier();
      const shift = await openShift(cashier);
      const count = await countDrawer(cashier, shift.id, FLOAT_IDR);
      const out = await move(cashier, shift.id, {
        type: "cash_out",
        amountIdr,
        reasonNote: "Beli gas elpiji",
      });
      expect(out.status, JSON.stringify(out.body)).toBe(201);
      const back = await move(cashier, shift.id, {
        type: "cash_in",
        amountIdr,
      });
      expect(back.status, JSON.stringify(back.body)).toBe(201);

      // No valid approval: the approval id was never issued.
      const refused = await close(cashier, shift.id, {
        countId: count.id,
        approvedBy: supervisor.userId,
        approvalRequestId: randomUUID(),
      });
      answers.push({
        status: refused.status,
        code: refused.body?.error?.code as string,
      });
      expect((await shiftRow(shift.id))?.status).toBe("open");
    }
    expect(answers[1], JSON.stringify(answers)).toEqual(answers[0]);
    expect(answers[0], JSON.stringify(answers)).toEqual({
      status: 409,
      code: "SHIFT_COUNT_STALE",
    });
  });
});

// ---- F1 (more) ---------------------------------------------------------------------

describe("POS-03 legend-q7jj F1: force close and legacy counts", () => {
  const note = "Kasir gagal menghitung kas tiga kali";

  it("force close after a forced count, cash out X then cash in X answers the same SHIFT_COUNT_STALE whether the cash out was normal or held", async () => {
    const answers: { status: number; code: string }[] = [];
    for (const amountIdr of [10_000, HELD_IDR]) {
      const cashier = await newCashier();
      const caller = await member(roleIds.supervisor, "Supervisor Paksa");
      const shift = await openShift(cashier);
      const forced = await submitCount(caller, shift.id, {
        counts: countsFor(FLOAT_IDR),
      });
      expect(forced.status, JSON.stringify(forced.body)).toBe(201);
      const forcedCount = posShiftCountReceiptSchema.parse(forced.body.data);
      const out = await move(cashier, shift.id, {
        type: "cash_out",
        amountIdr,
        reasonNote: "Beli gas elpiji",
      });
      expect(out.status, JSON.stringify(out.body)).toBe(201);
      const back = await move(cashier, shift.id, {
        type: "cash_in",
        amountIdr,
      });
      expect(back.status, JSON.stringify(back.body)).toBe(201);

      // No valid witness approval: the stale answer comes first either way.
      const refused = await forceClose(caller, shift.id, {
        countId: forcedCount.id,
        note,
        approvedBy: supervisor.userId,
        approvalRequestId: randomUUID(),
      });
      answers.push({
        status: refused.status,
        code: refused.body?.error?.code as string,
      });
      expect((await shiftRow(shift.id))?.status).toBe("open");
    }
    expect(answers[1], JSON.stringify(answers)).toEqual(answers[0]);
    expect(answers[0], JSON.stringify(answers)).toEqual({
      status: 409,
      code: "SHIFT_COUNT_STALE",
    });
  });

  /**
   * A count row as written before the cash_watermark column existed: counts
   * are append-only (a trigger refuses updates), so the legacy row is inserted
   * with a NULL watermark, nothing else different from a real count.
   */
  async function legacyCount(
    shiftId: string,
    submittedBy: string,
    forced: boolean,
    // legend-y9bf: a count made between 0142 and 0143 has a watermark but
    // no held_correction_idr (left NULL here in every case).
    cashWatermark: number | null = null,
  ): Promise<string> {
    const id = randomUUID();
    await asOwnerTenant(tenant.tenantId, (client) =>
      client.query(
        `INSERT INTO pos_shift_counts
           (id, tenant_id, outlet_id, shift_id, sequence, counts, counts_fingerprint,
            counted_idr, expected_idr, variance_idr, submitted_by, submitted_at, forced,
            idempotency_key, request_fingerprint, cash_watermark)
         VALUES ($1, $2, $3, $4, 1, $5::jsonb, $6, $7, $7, 0, $8, now(), $9, $10, $6, $11)`,
        [
          id,
          tenant.tenantId,
          tenant.outletId,
          shiftId,
          JSON.stringify(countsFor(FLOAT_IDR)),
          randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
          FLOAT_IDR,
          submittedBy,
          forced,
          randomUUID(),
          cashWatermark,
        ],
      ),
    );
    return id;
  }

  it("legend-y9bf: a count with a watermark but no held correction (made before 0143) is stale; a recount closes", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    // No cash row yet, so the watermark 0 is current: only the missing held
    // correction makes it stale.
    const countId = await legacyCount(shift.id, cashier.userId, false, 0);
    const stale = await close(cashier, shift.id, {
      countId,
      ...(await approvalFor(cashier, countId)),
    });
    expect(stale.status, JSON.stringify(stale.body)).toBe(409);
    expect(stale.body.error.code).toBe("SHIFT_COUNT_STALE");
    expect((await shiftRow(shift.id))?.status).toBe("open");
    const closed = await closeShift(cashier, shift.id, FLOAT_IDR);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
  });

  it("a count without a cash watermark (made before the column) is stale for close and for force close; a recount closes", async () => {
    // Close: nothing moved since the count, but its watermark is unknown.
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    const countId = await legacyCount(shift.id, cashier.userId, false);
    const stale = await close(cashier, shift.id, {
      countId,
      ...(await approvalFor(cashier, countId)),
    });
    expect(stale.status, JSON.stringify(stale.body)).toBe(409);
    expect(stale.body.error.code).toBe("SHIFT_COUNT_STALE");
    expect((await shiftRow(shift.id))?.status).toBe("open");
    // A recount carries a watermark and closes.
    const closed = await closeShift(cashier, shift.id, FLOAT_IDR);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect((await shiftRow(shift.id))?.status).toBe("closed");

    // Force close: the same on a supervisor's forced legacy count.
    const other = await newCashier();
    const caller = await member(roleIds.supervisor, "Supervisor Lama");
    const otherShift = await openShift(other);
    const forcedId = await legacyCount(otherShift.id, caller.userId, true);
    const staleForce = await forceClose(caller, otherShift.id, {
      countId: forcedId,
      note,
      approvedBy: supervisor.userId,
      approvalRequestId: randomUUID(),
    });
    expect(staleForce.status, JSON.stringify(staleForce.body)).toBe(409);
    expect(staleForce.body.error.code).toBe("SHIFT_COUNT_STALE");
    expect((await shiftRow(otherShift.id))?.status).toBe("open");
  });
});

// ---- F2 ----------------------------------------------------------------------------

const ACCOUNTING_CHART: [string, string, string, string, string][] = [
  ["cash_on_hand", "1101", "Kas", "asset", "current_asset"],
  [
    "gateway_clearing",
    "1201",
    "Kliring Payment Gateway",
    "asset",
    "current_asset",
  ],
  ["edc_clearing", "1202", "Kliring EDC", "asset", "current_asset"],
  [
    "loyalty_liability",
    "2105",
    "Liabilitas Poin",
    "liability",
    "current_liability",
  ],
  ["tax_payable_pbjt", "2104", "Utang PBJT", "liability", "current_liability"],
  [
    "customer_deposit",
    "2107",
    "Uang Muka Pelanggan",
    "liability",
    "current_liability",
  ],
  ["sales_revenue", "4101", "Penjualan", "revenue", "revenue"],
  ["sales_discount", "4102", "Diskon Penjualan", "revenue", "revenue"],
  ["service_charge", "4103", "Service Charge", "revenue", "revenue"],
  ["rounding", "4104", "Pembulatan", "revenue", "revenue"],
  [
    "deposit_forfeit_income",
    "4201",
    "Pendapatan DP Hangus",
    "revenue",
    "other_income",
  ],
  ["cash_over_short", "6108", "Selisih Kas", "expense", "operating_expense"],
];

/** Accounting module on, a mapped chart of accounts and open periods for the test tenant. */
async function enableAccounting(businessDate: string): Promise<void> {
  await owner.query(
    "UPDATE tenants SET feature_flags = $2::jsonb WHERE id = $1",
    [
      tenant.tenantId,
      JSON.stringify({
        modules: ["qr_order", "accounting"],
        integrationProviders: [],
      }),
    ],
  );
  const { rows: have } = await owner.query(
    "SELECT 1 FROM account_mappings WHERE tenant_id = $1 AND legal_entity_id = $2",
    [tenant.tenantId, tenant.legalEntityId],
  );
  if (have.length === 0)
    for (const [role, code, name, type, group] of ACCOUNTING_CHART) {
      const { rows } = await owner.query<{ id: string }>(
        `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [tenant.tenantId, tenant.legalEntityId, code, name, type, group],
      );
      await owner.query(
        `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
         VALUES ($1, $2, $3, $4)`,
        [tenant.tenantId, tenant.legalEntityId, role, rows[0]!.id],
      );
    }
  const months = new Set([
    businessDate.slice(0, 7),
    new Date().toISOString().slice(0, 7),
  ]);
  for (const period of months)
    await owner.query(
      `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
       VALUES ($1, $2, $3) ON CONFLICT (tenant_id, legal_entity_id, period) DO NOTHING`,
      [tenant.tenantId, tenant.legalEntityId, period],
    );
}

/** The stored `cashier_shift.closed` event of the shift, handed to the auto-journal consumer. */
async function deliverClosedEvent(shiftId: string) {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = 'cashier_shift.closed'
        AND event->'payload'->>'shiftId' = $2`,
    [tenant.tenantId, shiftId],
  );
  expect(rows).toHaveLength(1);
  const event = eventEnvelopeSchema.parse(rows[0]!.event);
  const context = establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "domain",
    }),
    { kind: "tenant" },
  );
  return withTenant(db, context, (tx) =>
    deliverAutoJournalEvent(
      context,
      event,
      tx,
      new Date(Date.now() + 60 * 60 * 1000),
    ),
  );
}

async function journalCount(): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM journal_entries WHERE tenant_id = $1",
    [tenant.tenantId],
  );
  return rows[0]!.n;
}

describe("POS-03 legend-q7jj F2 (decided, legend-y9bf): a held cash out that was never paid out", () => {
  // The unpaid held Rp150.000 expires at the close and never becomes a
  // Rp150.000 cash debit: the close event books differenceIdr 0, and the
  // auto-journal consumer ignores it (nothing posted, nothing parked).
  it("legend-q7jj F2 (decided, legend-y9bf): closing with an unpaid held cash out of Rp150.000 needs no note, books differenceIdr 0 and posts nothing for that shift, while a plain Rp5.000 over does post", async () => {
    const control = await newCashier("Kasir Kontrol");
    const controlShift = await openShift(control);
    await enableAccounting(controlShift.businessDate);

    // Control: a real cash over of Rp5.000 posts, so the accounting setup works.
    const over = await closeShift(control, controlShift.id, FLOAT_IDR + 5_000, {
      varianceNote: "Kelebihan kas dicek supervisor",
    });
    expect(over.status, JSON.stringify(over.body)).toBe(200);
    const posted = await deliverClosedEvent(controlShift.id);
    expect(posted.status, JSON.stringify(posted)).toBe("posted");
    const afterControl = await journalCount();
    expect(afterControl).toBeGreaterThan(0);

    // The held cash out never left the drawer: counted = expected = the float.
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    const held = await move(cashier, shift.id, {
      type: "cash_out",
      amountIdr: HELD_IDR,
      reasonNote: "Beli gas elpiji",
    });
    expect(held.status, JSON.stringify(held.body)).toBe(201);
    const closed = await closeShift(cashier, shift.id, FLOAT_IDR);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.data).toMatchObject({
      status: "closed",
      expectedIdr: FLOAT_IDR,
      countedIdr: FLOAT_IDR,
      varianceIdr: 0,
      varianceNote: null,
    });

    const result = await deliverClosedEvent(shift.id);
    expect(result.status, JSON.stringify(result)).toBe("ignored");
    expect(await journalCount()).toBe(afterControl);
  });
});

// ---- F3 ----------------------------------------------------------------------------

async function storedCashMovements(shiftId: string): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM cash_movements WHERE tenant_id = $1 AND shift_id = $2",
    [tenant.tenantId, shiftId],
  );
  return rows[0]!.n;
}

describe("POS-03 legend-q7jj F3: the outflow cap counts refunds and voids too", () => {
  it("with a held cash refund of Rp1.000 on the shift, a cash out of MAX_SAFE_INTEGER is refused (400), and the shift can still be counted, listed, force counted and force closed", async () => {
    const cashier = await newCashier();
    const caller = await member(roleIds.supervisor, "Supervisor Batas");
    const shift = await openShift(cashier);
    const orderId = await seedSale(shift, cashier, 11_000, "cash");
    await seedHeldRefund(shift.id, orderId, cashier, 1_000);
    const drawerIdr = FLOAT_IDR + 11_000;

    const huge = await move(cashier, shift.id, {
      type: "cash_out",
      amountIdr: Number.MAX_SAFE_INTEGER,
      reasonNote: "Beli gas elpiji",
    });
    expect(huge.status, JSON.stringify(huge.body)).toBe(400);
    expect(huge.body.error.code).toBe("VALIDATION_ERROR");
    expect(await storedCashMovements(shift.id)).toBe(0);

    // The shift is still usable: blind count, supervisor trail, forced count, force close.
    await countDrawer(cashier, shift.id, drawerIdr);
    const trail = await listCounts(supervisor, shift.id);
    expect(trail.status, JSON.stringify(trail.body)).toBe(200);
    expect(
      (trail.body.data as unknown[]).map(
        (row) => posShiftCountSchema.parse(row).heldCashOutIdr,
      ),
    ).toEqual([1_000]);

    const forced = await submitCount(caller, shift.id, {
      counts: countsFor(drawerIdr),
    });
    expect(forced.status, JSON.stringify(forced.body)).toBe(201);
    const forcedCount = posShiftCountReceiptSchema.parse(forced.body.data);
    await pinOverride(caller, forcedCount.id);
    const closed = await forceClose(caller, shift.id, {
      countId: forcedCount.id,
      note: "Kasir gagal menghitung kas tiga kali",
      approvedBy: supervisor.userId,
      approvalRequestId: randomUUID(),
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect((await shiftRow(shift.id))?.status).toBe("closed");
  });

  it("the cap does not depend on the held flag: a normal (not held) cash refund of Rp1.000 gives the same refusal, and the cap boundary is exact", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    const orderId = await seedSale(shift, cashier, 11_000, "cash");
    await seedHeldRefund(shift.id, orderId, cashier, 1_000, false);

    const huge = await move(cashier, shift.id, {
      type: "cash_out",
      amountIdr: Number.MAX_SAFE_INTEGER,
      reasonNote: "Beli gas elpiji",
    });
    expect(huge.status, JSON.stringify(huge.body)).toBe(400);
    expect(huge.body.error.code).toBe("VALIDATION_ERROR");
    expect(await storedCashMovements(shift.id)).toBe(0);

    // Exactly at the cap (refund 1.000 + cash out) is accepted, one more is refused.
    const atCap = await move(cashier, shift.id, {
      type: "cash_out",
      amountIdr: Number.MAX_SAFE_INTEGER - 1_000,
      reasonNote: "Setoran besar ke bank",
    });
    expect(atCap.status, JSON.stringify(atCap.body)).toBe(201);
    const over = await move(cashier, shift.id, {
      type: "cash_out",
      amountIdr: 1_000,
      reasonNote: "Beli gas elpiji",
    });
    expect(over.status, JSON.stringify(over.body)).toBe(400);
    expect(over.body.error.code).toBe("VALIDATION_ERROR");
    expect(await storedCashMovements(shift.id)).toBe(1);
    // Cash in is no outflow: it is still accepted at the cap.
    const cashIn = await move(cashier, shift.id, {
      type: "cash_in",
      amountIdr: 1_000,
    });
    expect(cashIn.status, JSON.stringify(cashIn.body)).toBe(201);
  });

  it("a held void of a Rp11.000 cash sale counts toward the cap: a cash out of MAX_SAFE_INTEGER - Rp10.000 is refused, MAX_SAFE_INTEGER - Rp11.000 is accepted, and the shift can still be counted", async () => {
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    const orderId = await seedSale(shift, cashier, 11_000, "cash");
    await seedVoid(shift.id, orderId, cashier, true);

    const over = await move(cashier, shift.id, {
      type: "cash_out",
      amountIdr: Number.MAX_SAFE_INTEGER - 10_000,
      reasonNote: "Setoran besar ke bank",
    });
    expect(over.status, JSON.stringify(over.body)).toBe(400);
    expect(over.body.error.code).toBe("VALIDATION_ERROR");
    expect(await storedCashMovements(shift.id)).toBe(0);

    const atCap = await move(cashier, shift.id, {
      type: "cash_out",
      amountIdr: Number.MAX_SAFE_INTEGER - 11_000,
      reasonNote: "Setoran besar ke bank",
    });
    expect(atCap.status, JSON.stringify(atCap.body)).toBe(201);
    // Held total = exactly MAX_SAFE_INTEGER: the count still answers (no 500).
    const counted = await submitCount(cashier, shift.id, {
      counts: countsFor(FLOAT_IDR),
    });
    expect(counted.status, JSON.stringify(counted.body)).toBe(201);
  });
});

// ---- F4 ----------------------------------------------------------------------------

describe("POS-03 legend-q7jj F4: an old approval chain is refused when the matrix is empty", () => {
  it("after the cash_shift_close policy rows are deleted, a close naming an approved chain that has an amount, or a payload without a numeric valueIdr, is refused (403) and the shift stays open", async () => {
    // The policy exists while the chain is opened, then the admin deletes it.
    await withShiftClosePolicies(
      [{ thresholdIdr: 50_000, roleId: roleIds.supervisor, level: 1 }],
      async () => undefined,
    );
    const cashier = await newCashier();
    const shift = await openShift(cashier);
    const count = await countDrawer(cashier, shift.id, FLOAT_IDR + 1_000);
    const note = { varianceNote: "Selisih dicek supervisor" };

    const cases: [string, Parameters<typeof phoneApprovalFor>[2]][] = [
      ["chain opened with an amount", { chainAmountIdr: 1_000 }],
      ["payload without valueIdr", { payloadValueIdr: undefined }],
      ["payload with a string valueIdr", { payloadValueIdr: "1000" }],
      ["payload with a null valueIdr", { payloadValueIdr: null }],
    ];
    for (const [label, options] of cases) {
      const refused = await close(cashier, shift.id, {
        countId: count.id,
        ...(await phoneApprovalFor(cashier, count.id, options)),
        ...note,
      });
      expect(refused.status, `${label}: ${JSON.stringify(refused.body)}`).toBe(
        403,
      );
      expect((await shiftRow(shift.id))?.status, label).toBe("open");
    }
  });

  // legend-ccpn (Q28): the default matrix is one cash_shift_close row, threshold
  // 0, level 1, supervisor role. The shape checks added for F4 must not break
  // the two honest paths: PIN at the cashier, and a phone chain with no amount
  // whose payload valueIdr is the variance. Same with an empty matrix.
  const matrices: [
    string,
    { thresholdIdr: number | null; roleId: string; level: number }[],
  ][] = [
    ["an empty matrix", []],
    [
      "the default matrix (threshold 0, level 1, supervisor)",
      [{ thresholdIdr: 0, roleId: roleIds.supervisor, level: 1 }],
    ],
  ];
  it.each(matrices)(
    "the PIN path and a valid amountless phone chain close with %s",
    async (_label, rows) => {
      await withShiftClosePolicies(rows, async () => {
        const note = { varianceNote: "Selisih dicek supervisor" };

        const pinCashier = await newCashier();
        const pinShift = await openShift(pinCashier);
        const pinClosed = await closeShift(
          pinCashier,
          pinShift.id,
          FLOAT_IDR + 1_000,
          note,
        );
        expect(pinClosed.status, JSON.stringify(pinClosed.body)).toBe(200);
        expect((await shiftRow(pinShift.id))?.status).toBe("closed");

        const phoneCashier = await newCashier();
        const phoneShift = await openShift(phoneCashier);
        const count = await countDrawer(
          phoneCashier,
          phoneShift.id,
          FLOAT_IDR + 1_000,
        );
        const phoneClosed = await close(phoneCashier, phoneShift.id, {
          countId: count.id,
          ...(await phoneApprovalFor(phoneCashier, count.id)),
          ...note,
        });
        expect(phoneClosed.status, JSON.stringify(phoneClosed.body)).toBe(200);
        expect((await shiftRow(phoneShift.id))?.status).toBe("closed");
      });
    },
  );
});
