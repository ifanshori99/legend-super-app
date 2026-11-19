// Acting staff wave 4 (brief 1094, founder Q29): reservation cancel stays open
// on a shared tablet. Lock: the cashier's cancel cannot steer the DP refund.
//
// Spec:
//  - The cancel body schema is strict: only `reason`. Any destination, payee,
//    amount or account like field is refused and nothing is written. The API
//    answers 422 VALIDATION_ERROR for a strict-schema failure (not 400).
//  - After a valid cancel by a cashier PIN token the refund request targets the
//    original DP payment (payment_intent_id), by the system actor, pending and
//    unapproved, and never exceeds what was paid.
//  - A cashier token of outlet A used on an outlet B reservation is refused and
//    creates no refund.
//
// Assumptions (spec silent):
//  - payment_refunds has no free form destination column: "recorded
//    destination" is the payment_intent_id (the original DP payment) plus the
//    same outlet.
//  - The paid DP is seeded in SQL (paid intent and evidence on the booking's
//    DP link), like reservation-deposit-refund-guard.test.ts; the close flow
//    links it. Policy: DP 100000, 24h free window, 50% late refund.
//  - Late cancel is forced by moving reserved_for inside the free window.

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outletIdSchema, tenantIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import {
  cancelReservationInputSchema,
  createReservationInputSchema,
} from "@starter/shared/reservation";
import { createApp } from "../app.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import { createReservation } from "../services/reservation-booking.ts";
import {
  setReservationDepositPort,
  type ReservationDepositPort,
} from "../services/reservation-ports.ts";
import { RESERVATION_SYSTEM_ACTOR } from "../services/reservation-deposit-payment.ts";
import { zonedInstant } from "../services/reservation-plan.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  fixtures,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const ACTING_HEADER = "X-Acting-Staff";
const PIN = "582914";
const WIB = "Asia/Jakarta";
const DEPOSIT = 100_000;
const role = randomUUID();
const sharedDevices = new Set<string>();

type Client = ReturnType<typeof agent>;
type Member = { client: Client; userId: string };
let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
let sessionOwner: Member;
let cashier: Member;
let outletB = "";
let zoneId = "";
let dayCounter = 0;

const scope = () =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );

async function member(label: string): Promise<Member> {
  const client = agent(app);
  await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, role],
  );
  return { client, userId };
}

const tokenOf = (deviceId: string) =>
  signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: tenant.tenantId,
    brandId: null,
    deviceId,
  });

async function sharedTablet(): Promise<string> {
  const id = randomUUID();
  sharedDevices.add(id);
  await owner.query(
    `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at, shared_mode)
     VALUES ($1, $2, $3, 'pos', $4, now() - interval '1 minute', true)`,
    [id, tenant.tenantId, tenant.outletId, `Kasir Batal ${id.slice(0, 6)}`],
  );
  return id;
}

/** A new login on a new shared tablet, with a live cashier PIN token. */
async function tabletWithCashier() {
  const who = await member(`Sesi ${randomUUID().slice(0, 6)}`);
  const deviceId = await sharedTablet();
  await setStaffPin(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    cashier.userId,
    { outletId: tenant.outletId, userId: cashier.userId },
    { pin: PIN },
  );
  const response = await who.client
    .post("/api/staff-pins/pos-session")
    .set(headers)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, tokenOf(deviceId))
    .send({ userId: cashier.userId, pin: PIN });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return { who, deviceId, token: response.body.data.token as string };
}

type Tablet = Awaited<ReturnType<typeof tabletWithCashier>>;

function cancel(
  tablet: Tablet,
  reservationId: string,
  body: Record<string, unknown>,
  options: { outletId?: string; key?: string } = {},
) {
  return tablet.who.client
    .post(
      `/api/outlets/${options.outletId ?? tenant.outletId}/reservations/${reservationId}/cancel`,
    )
    .set(headers)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, tokenOf(tablet.deviceId))
    .set(ACTING_HEADER, tablet.token)
    .set("Idempotency-Key", options.key ?? `w4-cancel-${randomUUID()}`)
    .send(body);
}

async function ensureZone() {
  if (zoneId) return;
  const z = await sessionOwner.client
    .post("/api/floor/zones")
    .set(headers)
    .set(originHeader)
    .send({
      name: `Zona Batal ${randomUUID().slice(0, 6)}`,
      paymentMode: "pay_first",
      serviceChargeBp: 500,
      minimumSpendIdr: 0,
      hours: [
        { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "08:00", end: "22:00" },
      ],
    });
  expect(z.status, JSON.stringify(z.body)).toBe(201);
  zoneId = z.body.data.id as string;
  const t = await sessionOwner.client
    .post("/api/floor/tables")
    .set(headers)
    .set(originHeader)
    .send({
      zoneId,
      code: `B-${randomUUID().slice(0, 6)}`.toUpperCase(),
      capacity: 4,
      type: "regular",
      layout: {
        x: 10,
        y: 10,
        width: 60,
        height: 60,
        rotation: 0,
        shape: "rect",
      },
    });
  expect(t.status, JSON.stringify(t.body)).toBe(201);
}

/** Opens only the DP payment link (the guest never pays through it here). */
const depositPort: ReservationDepositPort = {
  async assertReady() {},
  async openDeposit(input) {
    const linkId = randomUUID();
    await owner.query(
      `INSERT INTO payment_links
         (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6, 'w4-test')`,
      [
        linkId,
        tenant.tenantId,
        input.outletId,
        randomUUID().replaceAll("-", "").padEnd(64, "0"),
        `W4-${linkId.slice(0, 8)}`,
        input.amountIdr,
      ],
    );
    return {
      paymentLinkId: linkId,
      paymentPath: `/bayar/${linkId}`,
      expiresAt: new Date(
        input.now.getTime() + input.expiresInMinutes * 60_000,
      ).toISOString(),
    };
  },
};

/**
 * A booking whose DP of DEPOSIT is paid (intent, link, evidence). The
 * policy gives a full refund (free window) or 50% (`late`).
 */
async function bookWithPaidDeposit(late = false) {
  await ensureZone();
  dayCounter += 1;
  const day = new Date(Date.UTC(2027, 2, 1 + dayCounter))
    .toISOString()
    .slice(0, 10);
  const created = await createReservation(
    scope(),
    outletIdSchema.parse(tenant.outletId),
    createReservationInputSchema.parse({
      reservedFor: zonedInstant(day, "19:00", WIB).toISOString(),
      pax: 2,
      zoneId,
      guestName: "Pembayar DP Asli",
      contactPhone: "081234567890",
    }),
    `w4-book-${randomUUID()}`,
  );
  const reservationId = created.reservation.id as string;
  const linkId = created.deposit!.paymentLinkId as string;
  const intentId = randomUUID();
  await owner.query(
    `INSERT INTO payment_intents
       (id, tenant_id, outlet_id, payment_link_id, reservation_id, method, provider,
        amount_idr, idempotency_key, status, instructions, expires_at, paid_at)
     VALUES ($1, $2, $3, $4, $5, 'qris', 'doit', $6, $7, 'paid',
       '{"method":"qris","qrPayload":"00020101021226TEST","issuer":null}',
       now() + interval '1 hour', now())`,
    [
      intentId,
      tenant.tenantId,
      tenant.outletId,
      linkId,
      reservationId,
      DEPOSIT,
      `w4-pay-${intentId}`,
    ],
  );
  await owner.query(
    "UPDATE payment_links SET paid_idr = total_idr WHERE id = $1",
    [linkId],
  );
  await owner.query(
    `INSERT INTO payment_evidence
       (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
    [
      tenant.tenantId,
      tenant.outletId,
      intentId,
      `w4-evidence-${intentId}`,
      DEPOSIT,
    ],
  );
  if (late)
    await owner.query(
      "UPDATE reservations SET reserved_for = now() + interval '2 hours' WHERE id = $1",
      [reservationId],
    );
  return { reservationId, intentId };
}

type RefundRow = {
  id: string;
  payment_intent_id: string;
  outlet_id: string;
  amount: string;
  status: string;
  requested_by: string;
  approved_by: string | null;
};

async function refundsOfTenant(): Promise<RefundRow[]> {
  const { rows } = await owner.query<RefundRow>(
    `SELECT id, payment_intent_id, outlet_id, amount_idr::text AS amount, status,
            requested_by, approved_by
       FROM payment_refunds WHERE tenant_id = $1`,
    [tenant.tenantId],
  );
  return rows;
}

const refundsOf = async (intentId: string) =>
  (await refundsOfTenant()).filter((r) => r.payment_intent_id === intentId);

async function reservationRow(id: string) {
  const { rows } = await owner.query<{
    status: string;
    refund_status: string;
    refund_payment_refund_id: string | null;
    deposit_refund_idr: string | null;
  }>(
    `SELECT status, refund_status, refund_payment_refund_id,
            deposit_refund_idr::text AS deposit_refund_idr
       FROM reservations WHERE id = $1`,
    [id],
  );
  return rows[0]!;
}

beforeAll(async () => {
  app = createApp();
  tenant = await createIsolatedTenant(`rcan-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  setDeviceOutletResolver(async ({ tenantId, deviceId }) =>
    tenantId === tenant.tenantId && sharedDevices.has(deviceId)
      ? tenant.outletId
      : null,
  );
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Batal Kasir', false, NULL, $3, false, '["tenant"]')`,
    [
      role,
      tenant.tenantId,
      JSON.stringify([
        "order.view",
        "floor.table.view",
        "floor.table.operate",
        "floor.table.manage",
        "reservation.view",
        "reservation.manage",
      ]),
    ],
  );
  await owner.query(
    `INSERT INTO reservation_policies
       (tenant_id, outlet_id, version, deposit_requirement, deposit_amount_idr, payment_window_minutes,
        free_cancellation_hours, late_cancellation_refund_bp, no_show_refund_bp, minimum_spend_idr,
        default_duration_minutes, slot_interval_minutes, is_active)
     VALUES ($1, $2, 'w4-dp', 'required', $3, 60, 24, 5000, 0, 0, 90, 30, true)`,
    [tenant.tenantId, tenant.outletId, DEPOSIT],
  );
  setReservationDepositPort(depositPort);
  sessionOwner = await member("Sesi Batal");
  cashier = await member("Kasir Batal");
  outletB = randomUUID();
  const { rows } = await owner.query<{
    brand_id: string;
    legal_entity_id: string;
  }>("SELECT brand_id, legal_entity_id FROM outlets WHERE id = $1", [
    tenant.outletId,
  ]);
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet B Batal', 'Jl. Uji 4', 'Asia/Jakarta', $6, 'active')`,
    [
      outletB,
      tenant.tenantId,
      rows[0]!.brand_id,
      rows[0]!.legal_entity_id,
      `RCB-${randomUUID().slice(0, 6)}`.toUpperCase(),
      JSON.stringify(fixtures.outlets[0].openingHours),
    ],
  );
});

afterAll(async () => {
  setReservationDepositPort(null);
  setDeviceOutletResolver(null);
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

const STEERING_FIELDS: Record<string, unknown> = {
  destination: "cash",
  refundTo: "kasir",
  payee: "Kasir Nakal",
  payeeName: "Kasir Nakal",
  recipient: "08123456789",
  amountIdr: 1,
  refundIdr: DEPOSIT,
  depositRefundIdr: DEPOSIT,
  refundAmountIdr: DEPOSIT,
  refundMethod: "cash",
  method: "cash",
  accountNumber: "1234567890",
  bankAccount: { bank: "BCA", number: "1234567890" },
  paymentIntentId: randomUUID(),
  paymentId: randomUUID(),
  depositPaymentId: randomUUID(),
  refundPaymentRefundId: randomUUID(),
  refundStatus: "requested",
  outletId: randomUUID(),
  tenantId: randomUUID(),
  cashTendered: true,
};

describe("reservation cancel on a shared tablet cannot steer the DP refund (Q29)", () => {
  describe("(a) the body schema is strict", () => {
    it("accepts only a reason", () => {
      expect(
        cancelReservationInputSchema.safeParse({ reason: "Tamu batal" })
          .success,
      ).toBe(true);
      expect(Object.keys(cancelReservationInputSchema.shape)).toEqual([
        "reason",
      ]);
      expect(cancelReservationInputSchema.safeParse({}).success).toBe(false);
    });

    for (const [field, value] of Object.entries(STEERING_FIELDS))
      it(`rejects ${field} in the schema`, () => {
        expect(
          cancelReservationInputSchema.safeParse({
            reason: "Tamu batal",
            [field]: value,
          }).success,
        ).toBe(false);
      });

    it("over HTTP every destination, payee, amount or account field is refused (422 VALIDATION_ERROR) and nothing changes", async () => {
      const tablet = await tabletWithCashier();
      const { reservationId, intentId } = await bookWithPaidDeposit();
      for (const [field, value] of Object.entries(STEERING_FIELDS)) {
        const response = await cancel(tablet, reservationId, {
          reason: "Tamu batal lewat telepon",
          [field]: value,
        });
        expect(
          response.status,
          `${field}: ${JSON.stringify(response.body)}`,
        ).toBe(422);
        expect(
          (response.body as { error?: { code?: string } }).error?.code,
        ).toBe("VALIDATION_ERROR");
      }
      const row = await reservationRow(reservationId);
      expect(row.status).toBe("pending_deposit");
      expect(row.refund_payment_refund_id).toBeNull();
      expect(await refundsOf(intentId)).toHaveLength(0);
    });
  });

  describe("(b) the refund goes to the original payment", () => {
    it("free cancel: one pending refund on the original DP payment, full amount, system actor, not approved", async () => {
      const tablet = await tabletWithCashier();
      const { reservationId, intentId } = await bookWithPaidDeposit();
      const response = await cancel(tablet, reservationId, {
        reason: "Tamu batal lewat telepon",
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const refunds = await refundsOf(intentId);
      expect(refunds).toHaveLength(1);
      const [refund] = refunds;
      expect(refund!.payment_intent_id).toBe(intentId);
      expect(refund!.outlet_id).toBe(tenant.outletId);
      expect(Number(refund!.amount)).toBe(DEPOSIT);
      expect(Number(refund!.amount)).toBeLessThanOrEqual(DEPOSIT);
      expect(refund!.status).toBe("pending");
      expect(refund!.requested_by).toBe(RESERVATION_SYSTEM_ACTOR);
      expect(refund!.requested_by).not.toBe(cashier.userId);
      expect(refund!.approved_by).toBeNull();
      const row = await reservationRow(reservationId);
      expect(row.status).toBe("cancelled");
      expect(row.refund_status).toBe("requested");
      expect(row.refund_payment_refund_id).toBe(refund!.id);
      expect(Number(row.deposit_refund_idr)).toBe(DEPOSIT);
    });

    it("late cancel: the refund is the policy share (50%), never above what was paid", async () => {
      const tablet = await tabletWithCashier();
      const { reservationId, intentId } = await bookWithPaidDeposit(true);
      const response = await cancel(tablet, reservationId, {
        reason: "Tamu batal mendadak",
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const refunds = await refundsOf(intentId);
      expect(refunds).toHaveLength(1);
      expect(refunds[0]!.payment_intent_id).toBe(intentId);
      expect(Number(refunds[0]!.amount)).toBe(DEPOSIT / 2);
      expect(Number(refunds[0]!.amount)).toBeLessThanOrEqual(DEPOSIT);
    });

    it("the same Idempotency-Key replayed, and a second cancel, never add a second refund", async () => {
      const tablet = await tabletWithCashier();
      const { reservationId, intentId } = await bookWithPaidDeposit();
      const key = `w4-cancel-${randomUUID()}`;
      const body = { reason: "Tamu batal lewat telepon" };
      const first = await cancel(tablet, reservationId, body, { key });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      const replay = await cancel(tablet, reservationId, body, { key });
      expect(replay.status, JSON.stringify(replay.body)).toBe(200);
      const again = await cancel(tablet, reservationId, body);
      expect(again.status, JSON.stringify(again.body)).toBeGreaterThanOrEqual(
        400,
      );
      const refunds = await refundsOf(intentId);
      expect(refunds).toHaveLength(1);
      const total = refunds.reduce((sum, r) => sum + Number(r.amount), 0);
      expect(total).toBeLessThanOrEqual(DEPOSIT);
    });
  });

  describe("(c) outlet binding", () => {
    it("a cashier token of outlet A cancelling through outlet B is refused and creates no refund", async () => {
      const tablet = await tabletWithCashier();
      const { reservationId, intentId } = await bookWithPaidDeposit();
      const response = await cancel(
        tablet,
        reservationId,
        { reason: "Tamu batal lewat telepon" },
        { outletId: outletB },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(403);
      expect((response.body as { error?: { code?: string } }).error?.code).toBe(
        "ACTING_STAFF_OUTLET_MISMATCH",
      );
      const row = await reservationRow(reservationId);
      expect(row.status).toBe("pending_deposit");
      expect(row.refund_payment_refund_id).toBeNull();
      expect(await refundsOf(intentId)).toHaveLength(0);
    });
  });
});
