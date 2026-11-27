// Brief 530 / Q63: POS approval authority covers the whole order, including
// admin refunds. Real PostgreSQL, role resolver, PIN override consumption and
// refund service; physical EDC tenders avoid a fake cash drawer or provider.
import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createUlid,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  userIdSchema,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { posOverrideIdSchema } from "@starter/shared/access/override";
import { createApp } from "../app";
import { refundPosOrder } from "../services/pos-order-corrections";
import { agent, signUp } from "./helpers";
import {
  owner,
  seededOutletA,
  seededOutletB,
  seededTenantId,
  staffWithRole,
  type Staff,
} from "./floor-test-helpers";
import { pinOverrideFixtureFingerprint } from "./pos-override-fixture";

type Level = "supervisor" | "outlet_manager" | "general_manager" | "owner";
type Sale = { orderId: string; intentId: string; paid: number };
const LIMITS = [
  ["supervisor", 200_000],
  ["outlet_manager", 1_000_000],
  ["general_manager", 5_000_000],
] as const;
const app = createApp();
const approvers = new Map<Level, string>();
const users: string[] = [];
const orderUuids: string[] = [];
const intentIds: string[] = [];
const linkIds: string[] = [];
const overrideUuids: string[] = [];
const mirrorKeys: string[] = [];
const customRoleIds: string[] = [];
const fundIds: string[] = [];
let cashier: Staff;

const scope = () =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(seededTenantId),
      brandId: null,
      source: "session",
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

async function sale(
  paid: number,
  method: "edc_card" | "qris" | "points" | "cash" = "edc_card",
): Promise<Sale> {
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
      [orderUuid, seededTenantId, seededOutletA, `Q63-${orderId}`, paid],
    );
    await client.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, submitted_at, completed_at)
       VALUES ($1, $2, $3, 'pos', now(), now())`,
      [orderUuid, seededTenantId, seededOutletA],
    );
    await client.query(
      `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference,
         subtotal_idr, total_idr, paid_idr, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $6, $7)`,
      [
        linkId,
        seededTenantId,
        seededOutletA,
        randomBytes(32).toString("hex"),
        `Q63-${linkId}`,
        paid,
        cashier.userId,
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
      `INSERT INTO pos_order_tenders (tenant_id, outlet_id, order_id, method, provider,
         amount_idr, status, reference, requested_at, resolved_at, points_used,
         received_idr, change_idr, payment_intent_id, payment_link_id, payment_link_token_sealed)
       VALUES ($1, $2, $3, $4, $5, $6, 'captured', $7, now(), now(), $8,
         $9, $10, $11, $12, $13)`,
      [
        seededTenantId,
        seededOutletA,
        orderUuid,
        method,
        method === "edc_card" ? "edc" : method === "qris" ? "doit" : "manual",
        paid,
        `BANK-${orderId}`,
        method === "points" ? paid : null,
        method === "cash" ? paid : null,
        method === "cash" ? 0 : null,
        method === "qris" ? intentId : null,
        method === "qris" ? linkId : null,
        method === "qris" ? "sealed-test-token" : null,
      ],
    );
    if (method === "qris")
      await client.query(
        `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id,
           provider, provider_ref, method, source, amount_idr, received_at)
         VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
        [seededTenantId, seededOutletA, intentId, `evidence-${intentId}`, paid],
      );
  });
  return { orderId, intentId, paid };
}

async function approval(bill: Sale, amountIdr: number, approvedBy: string) {
  const overrideId = createUlid();
  overrideUuids.push(ulidToUuid(overrideId));
  const reason = "Pengembalian batas Q63";
  await asOwner((client) =>
    client.query(
      `INSERT INTO pos_overrides (id, tenant_id, outlet_id, action, method, status,
       requested_by, approved_by, reason, value_idr, object_type, object_id,
       request_fingerprint, created_at, resolved_at)
     VALUES ($1, $2, $3, 'refund', 'supervisor_pin', 'approved', $4, $5, $6,
       $7, 'order', $8, $9, now(), now())`,
      [
        ulidToUuid(overrideId),
        seededTenantId,
        seededOutletA,
        cashier.userId,
        approvedBy,
        reason,
        amountIdr,
        bill.orderId,
        pinOverrideFixtureFingerprint({
          requestedBy: cashier.userId,
          outletId: seededOutletA,
          action: "refund",
          valueIdr: amountIdr,
          reason,
          objectType: "order",
          objectId: bill.orderId,
          approverUserId: approvedBy,
        }),
      ],
    ),
  );
  return {
    overrideId: posOverrideIdSchema.parse(overrideId),
    approvedBy: userIdSchema.parse(approvedBy),
  };
}

async function refund(bill: Sale, amountIdr: number, level: Level) {
  const verified = await approval(bill, amountIdr, approvers.get(level)!);
  return refundPosOrder(
    scope(),
    {
      userId: userIdSchema.parse(cashier.userId),
      deviceId: null,
      expectedVersion: null,
    },
    outletIdSchema.parse(seededOutletA),
    bill.orderId,
    {
      idempotencyKey: randomUUID(),
      amountIdr,
      reason: "quality_complaint",
      reasonNote: "Pengembalian batas Q63",
      ...verified,
    },
  );
}

async function adminRefund(
  bill: Sale,
  amountIdr: number,
  requestedBy = "q63-admin",
  status: "completed" | "pending" = "completed",
) {
  const id = randomUUID();
  await asOwner((client) =>
    client.query(
      `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id,
       amount_idr, reason, status, requested_by, approved_by, decided_at, completed_at)
     VALUES ($1, $2, $3, $4, $5, 'Riwayat refund admin', $6::varchar, $7, $8,
       CASE WHEN $6::varchar = 'completed' THEN now() ELSE NULL END,
       CASE WHEN $6::varchar = 'completed' THEN now() ELSE NULL END)`,
      [
        id,
        seededTenantId,
        seededOutletA,
        bill.intentId,
        amountIdr,
        status,
        requestedBy,
        status === "completed" ? approvers.get("owner")! : null,
      ],
    ),
  );
  return id;
}

/**
 * The payer sent more than the bill: the surplus sits in an unallocated fund and
 * was already refunded to the payer (fund refund, not a refund of the sale).
 */
async function overpaymentRefunded(bill: Sale, amountIdr: number) {
  const fundId = randomUUID();
  fundIds.push(fundId);
  await owner.query(
    `INSERT INTO payment_unallocated_funds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason)
     VALUES ($1, $2, $3, $4, $5, 'overpayment')`,
    [fundId, seededTenantId, seededOutletA, bill.intentId, amountIdr],
  );
  await owner.query(
    `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id,
       amount_idr, reason, status, requested_by, approved_by, decided_at,
       completed_at, unallocated_fund_id)
     VALUES ($1, $2, $3, $4, $5, 'Kembalikan kelebihan bayar', 'completed',
       'system:test', $6, now(), now(), $7)`,
    [
      randomUUID(),
      seededTenantId,
      seededOutletA,
      bill.intentId,
      amountIdr,
      approvers.get("owner")!,
      fundId,
    ],
  );
}

async function nativeTotal(bill: Sale) {
  const result = await owner.query<{ total: string }>(
    "SELECT coalesce(sum(amount_idr), 0)::text AS total FROM pos_order_refunds WHERE tenant_id = $1 AND order_id = $2",
    [seededTenantId, ulidToUuid(bill.orderId)],
  );
  return Number(result.rows[0]!.total);
}

async function namedActor(label: string) {
  const client = agent(app);
  await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const id = session.body.user.id as string;
  users.push(id);
  return id;
}

async function refundByActor(bill: Sale, amountIdr: number, actor: string) {
  const verified = await approval(bill, amountIdr, actor);
  return refundPosOrder(
    scope(),
    {
      userId: userIdSchema.parse(cashier.userId),
      deviceId: null,
      expectedVersion: null,
    },
    outletIdSchema.parse(seededOutletA),
    bill.orderId,
    {
      idempotencyKey: randomUUID(),
      amountIdr,
      reason: "quality_complaint",
      reasonNote: "Pemeriksaan peran penyetuju",
      ...verified,
    },
  );
}

beforeAll(async () => {
  cashier = await staffWithRole(app, {
    template: "cashier",
    label: "Q63 POS cashier",
  });
  users.push(cashier.userId);
  for (const level of [
    "supervisor",
    "outlet_manager",
    "general_manager",
    "owner",
  ] as const) {
    const client = agent(app);
    await signUp(client, `Q63 POS ${level}`);
    const session = await client.get("/api/auth/get-session");
    const id = session.body.user.id as string;
    users.push(id);
    approvers.set(level, id);
    const roles = await owner.query<{ id: string }>(
      "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
      [seededTenantId, level],
    );
    if (!roles.rows[0]) throw new Error(`Missing role ${level}`);
    const outletScoped = level === "supervisor" || level === "outlet_manager";
    await owner.query(
      `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $2)`,
      [
        seededTenantId,
        id,
        roles.rows[0].id,
        outletScoped ? "outlet" : "tenant",
        outletScoped ? seededOutletA : null,
      ],
    );
  }
});

afterAll(async () => {
  await asOwner(async (client) => {
    for (const table of [
      "pos_order_refunds",
      "pos_order_tenders",
      "pos_order_approval_uses",
      "order_events",
      "pos_orders",
    ])
      await client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND order_id = ANY($2::uuid[])`,
        [seededTenantId, orderUuids],
      );
    await client.query("DELETE FROM pos_overrides WHERE id = ANY($1::uuid[])", [
      overrideUuids,
    ]);
    await client.query(
      "DELETE FROM payment_refunds WHERE payment_intent_id = ANY($1::uuid[])",
      [intentIds],
    );
    await client.query(
      "DELETE FROM payment_unallocated_funds WHERE id = ANY($1::uuid[])",
      [fundIds],
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
    await client.query("DELETE FROM orders WHERE id = ANY($1::uuid[])", [
      orderUuids,
    ]);
    await client.query(
      "DELETE FROM payment_admin_idempotency WHERE tenant_id = $1 AND key = ANY($2::text[])",
      [seededTenantId, mirrorKeys],
    );
    await client.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [seededTenantId, users],
    );
    await client.query("DELETE FROM roles WHERE id = ANY($1::uuid[])", [
      customRoleIds,
    ]);
  }, true);
  await owner.end();
});

describe("POS-04 Q63 cumulative refund ceilings (brief 530)", () => {
  for (const [level, ceiling] of LIMITS) {
    it(`${level} can refund exactly Rp${ceiling} and leaves the paid balance intact`, async () => {
      const bill = await sale(ceiling + 10);
      const result = await refund(bill, ceiling, level);
      expect(Number(result.amountIdr)).toBe(ceiling);
      expect(await nativeTotal(bill)).toBe(ceiling);
      expect(bill.paid - (await nativeTotal(bill))).toBe(10);
    });
    it(`${level} cannot refund Rp1 above Rp${ceiling}; no money is committed`, async () => {
      const bill = await sale(ceiling + 10);
      await expect(refund(bill, ceiling + 1, level)).rejects.toMatchObject({
        code: "REFUND_APPROVAL_LIMIT_EXCEEDED",
      });
      expect(await nativeTotal(bill)).toBe(0);
    });
  }

  it("owner can approve above Rp5 million while still respecting what was paid", async () => {
    const bill = await sale(6_000_001);
    const result = await refund(bill, 6_000_001, "owner");
    expect(Number(result.amountIdr)).toBe(6_000_001);
    expect(bill.paid - (await nativeTotal(bill))).toBe(0);
    await expect(refund(bill, 1, "owner")).rejects.toBeDefined();
    expect(await nativeTotal(bill)).toBe(bill.paid);
  });

  it("admin Rp150000 plus POS Rp100000 cannot bypass the supervisor ceiling", async () => {
    const bill = await sale(400_000);
    await adminRefund(bill, 150_000);
    await expect(refund(bill, 100_000, "supervisor")).rejects.toMatchObject({
      code: "REFUND_APPROVAL_LIMIT_EXCEEDED",
    });
    expect(await nativeTotal(bill)).toBe(0);
    expect(bill.paid - 150_000 - (await nativeTotal(bill))).toBe(250_000);
  });

  it("multiple POS refunds consume cumulative authority rather than restarting the ceiling", async () => {
    const bill = await sale(400_000);
    await refund(bill, 150_000, "supervisor");
    await refund(bill, 50_000, "supervisor");
    await expect(refund(bill, 1, "supervisor")).rejects.toMatchObject({
      code: "REFUND_APPROVAL_LIMIT_EXCEEDED",
    });
    expect(await nativeTotal(bill)).toBe(200_000);
    expect(bill.paid - (await nativeTotal(bill))).toBe(200_000);
  });

  it("a native refund and its gateway mirror count once, allowing exactly Rp200000", async () => {
    const bill = await sale(400_000);
    const first = await refund(bill, 100_000, "supervisor");
    const mirrorId = await adminRefund(bill, 100_000, "system:pos");
    const mirrorKey = `pos-refund-gateway:${first.id}:${bill.intentId}`;
    mirrorKeys.push(mirrorKey);
    await owner.query(
      `INSERT INTO payment_admin_idempotency (tenant_id, key, fingerprint, response)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        seededTenantId,
        mirrorKey,
        "a".repeat(64),
        JSON.stringify({ refundId: mirrorId }),
      ],
    );
    const second = await refund(bill, 100_000, "supervisor");
    expect(Number(second.amountIdr)).toBe(100_000);
    expect(await nativeTotal(bill)).toBe(200_000);
    expect(bill.paid - (await nativeTotal(bill))).toBe(200_000);
  });

  it("concurrent POS refunds cannot spend the same supervisor authority twice", async () => {
    const bill = await sale(400_000);
    const attempts = await Promise.allSettled([
      refund(bill, 150_000, "supervisor"),
      refund(bill, 100_000, "supervisor"),
    ]);
    expect(
      attempts.filter((attempt) => attempt.status === "fulfilled"),
    ).toHaveLength(1);
    const refused = attempts.find((attempt) => attempt.status === "rejected");
    expect(refused).toMatchObject({
      status: "rejected",
      reason: { code: "REFUND_APPROVAL_LIMIT_EXCEEDED" },
    });
    expect(await nativeTotal(bill)).toBeLessThanOrEqual(200_000);
    const uses = await owner.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM pos_order_approval_uses WHERE tenant_id = $1 AND order_id = $2",
      [seededTenantId, ulidToUuid(bill.orderId)],
    );
    expect(uses.rows[0]!.count).toBe(1);
    expect(bill.paid - (await nativeTotal(bill))).toBeGreaterThanOrEqual(
      200_000,
    );
  });

  it("qris refunds share the same supervisor ceiling and cannot overpay", async () => {
    const bill = await sale(300_000, "qris");
    await refund(bill, 200_000, "supervisor");
    await expect(refund(bill, 1, "supervisor")).rejects.toMatchObject({
      code: "REFUND_APPROVAL_LIMIT_EXCEEDED",
    });
    expect(await nativeTotal(bill)).toBe(200_000);
    expect(bill.paid - (await nativeTotal(bill))).toBe(100_000);
  });

  // 1272 V1 P3 (27ed51038): a points tender is never money the guest paid in,
  // so a points-only bill has nothing a POS refund can pay out.
  it("points refunds cannot pay out cash for a points tender", async () => {
    const bill = await sale(300_000, "points");
    await expect(refund(bill, 200_000, "supervisor")).rejects.toMatchObject({
      code: "REFUND_EXCEEDS_PAID",
    });
    await expect(refund(bill, 1, "supervisor")).rejects.toMatchObject({
      code: "REFUND_EXCEEDS_PAID",
    });
    expect(await nativeTotal(bill)).toBe(0);
  });

  it("cash refunds above the ceiling are refused before accessing the drawer", async () => {
    const bill = await sale(300_000, "cash");
    await expect(refund(bill, 200_001, "supervisor")).rejects.toMatchObject({
      code: "REFUND_APPROVAL_LIMIT_EXCEEDED",
    });
    expect(await nativeTotal(bill)).toBe(0);
  });

  for (const status of ["completed", "pending"] as const) {
    it(`owner cannot spend money already ${status === "pending" ? "reserved" : "refunded"} by admin`, async () => {
      const bill = await sale(200_000);
      await adminRefund(bill, 150_000, "q63-admin", status);
      await expect(refund(bill, 100_000, "owner")).rejects.toBeDefined();
      expect(await nativeTotal(bill)).toBe(0);
      expect(bill.paid - 150_000 - (await nativeTotal(bill))).toBe(50_000);
    });
  }

  it("a custom refund permission cannot grant the authority of a named Q63 role", async () => {
    const bill = await sale(100_000);
    const actor = await namedActor("Q63 custom permission only");
    const roleId = randomUUID();
    customRoleIds.push(roleId);
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key,
         permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, 'Custom refund authority', false, NULL,
         '["pos.refund.approve"]', false, '["tenant"]')`,
      [roleId, seededTenantId],
    );
    await owner.query(
      `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type,
         scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 hour', $2)`,
      [seededTenantId, actor, roleId],
    );
    await expect(refundByActor(bill, 1, actor)).rejects.toMatchObject({
      code: "REFUND_APPROVAL_LIMIT_EXCEEDED",
    });
    expect(await nativeTotal(bill)).toBe(0);
  });

  it("an owner role in another outlet cannot lift this outlet's supervisor ceiling", async () => {
    const bill = await sale(400_000);
    const actor = await namedActor("Q63 supervisor with other outlet owner");
    for (const [template, outletId] of [
      ["supervisor", seededOutletA],
      ["owner", seededOutletB],
    ] as const) {
      const assignment = await owner.query(
        `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type,
           scope_id, valid_from, assigned_by)
         SELECT $1, $2, id, 'outlet', $3, now() - interval '1 hour', $2
           FROM roles WHERE tenant_id = $1 AND template_key = $4`,
        [seededTenantId, actor, outletId, template],
      );
      expect(assignment.rowCount).toBe(1);
    }
    await expect(refundByActor(bill, 200_001, actor)).rejects.toMatchObject({
      code: "REFUND_APPROVAL_LIMIT_EXCEEDED",
    });
    expect(await nativeTotal(bill)).toBe(0);
  });

  it("an old approved override cannot confer authority after its approver role expires", async () => {
    const bill = await sale(100_000);
    const actor = approvers.get("supervisor")!;
    const verified = await approval(bill, 50_000, actor);
    await owner.query(
      "UPDATE role_assignments SET valid_until = now() - interval '1 minute' WHERE tenant_id = $1 AND user_id = $2",
      [seededTenantId, actor],
    );
    try {
      await expect(
        refundPosOrder(
          scope(),
          {
            userId: userIdSchema.parse(cashier.userId),
            deviceId: null,
            expectedVersion: null,
          },
          outletIdSchema.parse(seededOutletA),
          bill.orderId,
          {
            idempotencyKey: randomUUID(),
            amountIdr: 50_000,
            reason: "quality_complaint",
            reasonNote: "Batas peran aktual",
            ...verified,
          },
        ),
      ).rejects.toMatchObject({ code: "REFUND_APPROVAL_LIMIT_EXCEEDED" });
      expect(await nativeTotal(bill)).toBe(0);
    } finally {
      await owner.query(
        "UPDATE role_assignments SET valid_until = NULL WHERE tenant_id = $1 AND user_id = $2",
        [seededTenantId, actor],
      );
    }
  });

  // Brief 532 A2: money returned for an overpayment is not a refund of the
  // sale, so it must not eat the order's refundable balance.
  it("QRIS Rp100000 with Rp20000 overpayment already refunded: a Rp100000 POS refund still passes", async () => {
    const bill = await sale(100_000, "qris");
    await overpaymentRefunded(bill, 20_000);
    const result = await refund(bill, 100_000, "supervisor");
    expect(Number(result.amountIdr)).toBe(100_000);
    expect(await nativeTotal(bill)).toBe(100_000);
  });

  it("the same order still refuses a POS refund of Rp100001 (never pays more than the sale)", async () => {
    const bill = await sale(100_000, "qris");
    await overpaymentRefunded(bill, 20_000);
    await expect(refund(bill, 100_001, "supervisor")).rejects.toBeDefined();
    expect(await nativeTotal(bill)).toBe(0);
  });

  it("an overpayment refund does not let a second POS refund exceed the paid amount", async () => {
    const bill = await sale(100_000, "qris");
    await overpaymentRefunded(bill, 20_000);
    await refund(bill, 100_000, "supervisor");
    await expect(refund(bill, 1, "supervisor")).rejects.toBeDefined();
    expect(await nativeTotal(bill)).toBe(bill.paid);
  });

  it("a late-payment refund (pos-late-payment-refund:) does not eat the refundable balance of the sale", async () => {
    // Real shape (1127): the guest paid LATE on a separate intent whose tender was
    // voided (the bill had closed); the sale's own captured tender intent carries no
    // late key. The late money is parked: it neither lifts nor eats the sale's balance.
    const bill = await sale(100_000, "qris");
    const lateIntentId = randomUUID();
    const lateLinkId = randomUUID();
    intentIds.push(lateIntentId);
    linkIds.push(lateLinkId);
    await asOwner(async (client) => {
      await client.query(
        `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference,
           subtotal_idr, total_idr, paid_idr, created_by)
         VALUES ($1, $2, $3, $4, $5, 30000, 30000, 30000, $6)`,
        [
          lateLinkId,
          seededTenantId,
          seededOutletA,
          randomBytes(32).toString("hex"),
          `Q27-${lateLinkId}`,
          cashier.userId,
        ],
      );
      await client.query(
        `INSERT INTO payment_intents (id, tenant_id, outlet_id, payment_link_id,
           method, provider, amount_idr, idempotency_key, status, paid_at,
           instructions, expires_at)
         VALUES ($1, $2, $3, $4, 'qris', 'doit', 30000, $5, 'paid', now(),
           '{"method":"qris","qrPayload":"test","issuer":null}', now() + interval '1 hour')`,
        [lateIntentId, seededTenantId, seededOutletA, lateLinkId, randomUUID()],
      );
      await client.query(
        `INSERT INTO pos_order_tenders (tenant_id, outlet_id, order_id, method, provider,
           amount_idr, status, requested_at, resolved_at, payment_intent_id,
           payment_link_id, payment_link_token_sealed)
         VALUES ($1, $2, $3, 'qris', 'doit', 30000, 'voided', now(), now(), $4, $5,
           'sealed-test-token')`,
        [
          seededTenantId,
          seededOutletA,
          ulidToUuid(bill.orderId),
          lateIntentId,
          lateLinkId,
        ],
      );
      await client.query(
        `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id,
           provider, provider_ref, method, source, amount_idr, received_at)
         VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', 30000, now())`,
        [
          seededTenantId,
          seededOutletA,
          lateIntentId,
          `evidence-${lateIntentId}`,
        ],
      );
    });
    const lateId = await adminRefund(
      { ...bill, intentId: lateIntentId },
      30_000,
      "system:pos",
      "pending",
    );
    const lateKey = `pos-late-payment-refund:${lateIntentId}`;
    mirrorKeys.push(lateKey);
    await owner.query(
      `INSERT INTO payment_admin_idempotency (tenant_id, key, fingerprint, response)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        seededTenantId,
        lateKey,
        "b".repeat(64),
        JSON.stringify({ refundId: lateId }),
      ],
    );
    const result = await refund(bill, 100_000, "supervisor");
    expect(Number(result.amountIdr)).toBe(100_000);
    expect(await nativeTotal(bill)).toBe(100_000);
    await expect(refund(bill, 1, "supervisor")).rejects.toBeDefined();
    expect(await nativeTotal(bill)).toBe(100_000);
  });
});
