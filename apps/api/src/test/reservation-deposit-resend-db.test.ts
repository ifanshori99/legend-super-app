// Staff resend of the DP link (bead legend-gbkw; PRD v1.7 §3.22 "DP &
// Kebijakan"; RSV-02), against PostgreSQL. Real booking, deposit port and
// routes; only the payment gateway is a test double.
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outletIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  cancelReservationInputSchema,
  createReservationInputSchema,
} from "@starter/shared/reservation";
import { createPaymentIntentInputSchema } from "@starter/shared/payment";
import { createApp } from "../app";
import {
  setPaymentGateway,
  type GatewayIntent,
  type GatewayIntentRequest,
  type PaymentGatewayPort,
} from "../services/payment-gateway.ts";
import { confirmPayment, createIntent } from "../services/payment.service.ts";
import { createReservation, linkAad } from "../services/reservation-booking.ts";
import { sealSecret } from "../lib/secrets.ts";
import { createPaymentReservationDepositPort } from "../services/reservation-deposit-payment.ts";
import { resendReservationDepositLink } from "../services/reservation-deposit-resend.ts";
import { cancelReservation } from "../services/reservation-lifecycle.ts";
import { zonedInstant } from "../services/reservation-plan.ts";
import {
  depositUnavailable,
  setReservationDepositPort,
} from "../services/reservation-ports.ts";
import { originHeader } from "./helpers";
import {
  createIsolatedTenant,
  dropFloorRows,
  dropIsolatedTenant,
  owner,
  seededOutletA,
  seededOutletB,
  seededTenantId,
  staffOfIsolatedTenant,
  staffWithRole,
  createTable,
  createZone,
  type IsolatedTenant,
  type Staff,
} from "./floor-test-helpers";

const WIB = "Asia/Jakarta";
const outletA = outletIdSchema.parse(seededOutletA);

const tenantScope = () =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: seededTenantId,
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );

async function asOwner<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
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

/** Provider double: one code per idempotency key; health is switchable. */
class FakeGateway implements PaymentGatewayPort {
  readonly provider = "doit";
  healthValue: "available" | "degraded" | "down" = "available";
  readonly calls: string[] = [];
  private readonly byKey = new Map<string, GatewayIntent>();
  async health() {
    return { status: this.healthValue };
  }
  async createIntent(input: GatewayIntentRequest): Promise<GatewayIntent> {
    this.calls.push(input.idempotencyKey);
    const cached = this.byKey.get(input.idempotencyKey);
    if (cached) return cached;
    const created: GatewayIntent = {
      providerRef: `FAKE-DP-${randomUUID()}`,
      instructions: {
        method: "qris",
        qrPayload: "00020101021226FAKEDP",
        issuer: null,
      },
      expiresAt: input.expiresAt,
    };
    this.byKey.set(input.idempotencyKey, created);
    return created;
  }
  async getStatus(input: { providerRef: string }) {
    return {
      status: "pending" as const,
      providerRef: input.providerRef,
      amountIdr: null,
    };
  }
  async channels() {
    return [];
  }
}

let app: ReturnType<typeof createApp>;
let staff: Staff;
let gateway: FakeGateway;
let isolated: IsolatedTenant | undefined;
const zoneIds: string[] = [];
const tableIds: string[] = [];

async function setPolicy(requirement: "none" | "required", amount = 0) {
  await asOwner(async (client) => {
    await client.query(
      "DELETE FROM reservation_policies WHERE tenant_id = $1 AND outlet_id = $2",
      [seededTenantId, seededOutletA],
    );
    await client.query(
      `INSERT INTO reservation_policies
         (tenant_id, outlet_id, version, deposit_requirement, deposit_amount_idr, payment_window_minutes,
          free_cancellation_hours, late_cancellation_refund_bp, no_show_refund_bp, minimum_spend_idr,
          default_duration_minutes, slot_interval_minutes, is_active)
       VALUES ($1, $2, $3, $4, $5, 60, 24, 5000, 0, 0, 90, 30, true)`,
      [
        seededTenantId,
        seededOutletA,
        `dp-test-${requirement}`,
        requirement,
        amount,
      ],
    );
  });
}

async function floor(count: number) {
  const zone = await createZone(staff.client);
  zoneIds.push(zone.id);
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const table = await createTable(staff.client, { zoneId: zone.id });
    tableIds.push(table.id);
    ids.push(table.id);
  }
  return { zoneId: zone.id as string, tableIds: ids };
}

const dayAt = (date: string, time: string) => zonedInstant(date, time, WIB);
const key = () => `rsv-resend-${randomUUID()}`;

function booking(zoneId: string, date: string) {
  return createReservationInputSchema.parse({
    reservedFor: dayAt(date, "19:00").toISOString(),
    pax: 2,
    zoneId,
    guestName: "Tamu Kirim Ulang",
    contactPhone: "081234567890",
  });
}

async function book(date: string) {
  await setPolicy("required", 100_000);
  const f = await floor(1);
  return createReservation(
    tenantScope(),
    outletA,
    booking(f.zoneId, date),
    key(),
  );
}

async function reservationRow(id: string) {
  const { rows } = await asOwner((client) =>
    client.query<{
      status: string;
      deposit_payment_link_id: string | null;
      deposit_link_sealed: string | null;
      deposit_link_expires_at: Date | null;
    }>("SELECT * FROM reservations WHERE id = $1", [id]),
  );
  return rows[0]!;
}

function resend(
  reservationId: string,
  outletId = seededOutletA,
  idempotencyKey: string | null = key(),
  client = staff.client,
) {
  const req = client
    .post(`/api/outlets/${outletId}/reservations/${reservationId}/deposit-link`)
    .set(originHeader);
  if (idempotencyKey !== null) req.set("Idempotency-Key", idempotencyKey);
  return req.send({});
}

/** The guest opens the hosted page and creates a QRIS code on the DP link. */
async function openIntent(created: Awaited<ReturnType<typeof book>>) {
  const token = created.deposit!.paymentPath.slice("/bayar/".length);
  const intent = await createIntent(
    tenantScope(),
    token,
    createPaymentIntentInputSchema.parse({
      method: "qris",
      channelCode: null,
      idempotencyKey: `rsv-resend-pay-${created.reservation.id}`,
    }),
  );
  return intent.id;
}

/** The stored link lapsed (its own expiry), the booking window is still open. */
async function expireLink(reservationId: string) {
  await asOwner((client) =>
    client.query(
      "UPDATE reservations SET deposit_link_expires_at = now() - interval '1 minute' WHERE id = $1",
      [reservationId],
    ),
  );
}

async function auditCount(reservationId: string) {
  const { rows } = await asOwner((client) =>
    client.query(
      "SELECT 1 FROM audit_logs WHERE tenant_id = $1 AND event->>'objectId' = $2 AND event->>'action' = 'reservation.deposit_link_resent'",
      [seededTenantId, reservationId],
    ),
  );
  return rows.length;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  staff = await staffWithRole(app, { template: "owner", label: "Rsv Resend" });
  gateway = new FakeGateway();
  setPaymentGateway(gateway);
  setReservationDepositPort(createPaymentReservationDepositPort());
});

afterAll(async () => {
  setReservationDepositPort(null);
  setPaymentGateway(null);
  await asOwner(async (client) => {
    const rsv = `(SELECT id FROM reservations WHERE tenant_id = $1 AND zone_id = ANY($2))`;
    const links = (
      await client.query<{ id: string }>(
        "SELECT deposit_payment_link_id AS id FROM reservations WHERE tenant_id = $1 AND zone_id = ANY($2) AND deposit_payment_link_id IS NOT NULL",
        [seededTenantId, zoneIds],
      )
    ).rows.map((row) => row.id);
    for (const table of [
      "reservation_deposit_allocations",
      "reservation_tables",
    ])
      await client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND reservation_id IN ${rsv}`,
        [seededTenantId, zoneIds],
      );
    await client.query(
      `DELETE FROM reservation_idempotency WHERE tenant_id = $1 AND (reservation_id IN ${rsv} OR reservation_id IS NULL)`,
      [seededTenantId, zoneIds],
    );
    await client.query(
      "DELETE FROM reservations WHERE tenant_id = $1 AND zone_id = ANY($2)",
      [seededTenantId, zoneIds],
    );
    await client.query(
      "DELETE FROM reservation_policies WHERE tenant_id = $1 AND outlet_id = $2",
      [seededTenantId, seededOutletA],
    );
    const intents = `(SELECT id FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[]))`;
    for (const table of [
      "payment_refunds",
      "payment_evidence",
      "payment_unallocated_funds",
    ])
      await client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND payment_intent_id IN ${intents}`,
        [seededTenantId, links],
      );
    await client.query(
      "DELETE FROM payment_admin_idempotency WHERE tenant_id = $1 AND key LIKE 'reservation-refund:%'",
      [seededTenantId],
    );
    await client.query(
      "DELETE FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[])",
      [seededTenantId, links],
    );
    await client.query(
      "DELETE FROM payment_links WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [seededTenantId, links],
    );
  });
  await dropFloorRows({ tenantId: seededTenantId, zoneIds, tableIds });
  if (isolated) await dropIsolatedTenant(isolated);
  await owner.end();
});

describe("legend-gbkw staff resend of the DP link", () => {
  it("reuses the stored link while it is valid, audits it, and a replay returns the same link", async () => {
    const created = await book("2027-06-01");
    const k = key();
    const first = await resend(created.reservation.id, seededOutletA, k);
    expect(first.status).toBe(200);
    expect(first.body.data).toEqual(created.deposit);
    const replay = await resend(created.reservation.id, seededOutletA, k);
    expect(replay.status).toBe(200);
    expect(replay.body.data).toEqual(created.deposit);
    expect(await auditCount(created.reservation.id)).toBe(1);
    // The idempotency record holds no link (a guest credential).
    const { rows } = await asOwner((client) =>
      client.query<{ response: unknown }>(
        "SELECT response FROM reservation_idempotency WHERE tenant_id = $1 AND idempotency_key = $2",
        [seededTenantId, k],
      ),
    );
    expect(JSON.stringify(rows[0]!.response)).not.toContain("/bayar/");
  });

  it("opens and stores a new link when none is attached, inside the window", async () => {
    const created = await book("2027-06-02");
    const id = created.reservation.id;
    await asOwner((client) =>
      client.query(
        "UPDATE reservations SET deposit_payment_link_id = NULL, deposit_link_sealed = NULL, deposit_link_expires_at = NULL WHERE id = $1",
        [id],
      ),
    );
    const res = await resend(id);
    expect(res.status).toBe(200);
    expect(res.body.data.paymentPath).toMatch(/^\/bayar\/pl_/);
    expect(res.body.data.paymentPath).not.toBe(created.deposit!.paymentPath);
    expect(res.body.data.paymentLinkId).not.toBe(
      created.deposit!.paymentLinkId,
    );
    expect(res.body.data.amountIdr).toBe(100_000);
    const row = await reservationRow(id);
    expect(row.deposit_payment_link_id).toBe(res.body.data.paymentLinkId);
    expect(row.deposit_link_sealed).not.toContain("/bayar/");
    // The next resend reuses the link just stored instead of opening a third.
    const again = await resend(id);
    expect(again.body.data).toEqual(res.body.data);
    expect(await auditCount(id)).toBe(2);
  });

  it("409 for a booking that is not pending_deposit", async () => {
    const created = await book("2027-06-03");
    await cancelReservation(
      tenantScope(),
      staff.userId,
      outletA,
      created.reservation.id,
      cancelReservationInputSchema.parse({ reason: "Tamu batal" }),
      key(),
    );
    const res = await resend(created.reservation.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("RESERVATION_DEPOSIT_NOT_PENDING");
  });

  it("409 once the frozen payment window has ended", async () => {
    const created = await book("2027-06-04");
    await asOwner((client) =>
      client.query(
        "UPDATE reservations SET created_at = now() - interval '3 hours', deposit_payment_link_id = NULL, deposit_link_sealed = NULL, deposit_link_expires_at = NULL WHERE id = $1",
        [created.reservation.id],
      ),
    );
    const res = await resend(created.reservation.id);
    expect(res.status).toBe(409);
  });

  it("404 for another outlet, 404 for another tenant", async () => {
    const created = await book("2027-06-05");
    const otherOutlet = await resend(created.reservation.id, seededOutletB);
    expect(otherOutlet.status).toBe(404);
    expect(otherOutlet.body.error.code).toBe("RESERVATION_NOT_FOUND");

    isolated = await createIsolatedTenant(`rsv-rs-${randomUUID().slice(0, 6)}`);
    const other = await staffOfIsolatedTenant(app, isolated);
    const otherScope = establishScopedTenantContext(
      establishTenantContext({
        tenantId: isolated.tenantId,
        brandId: null,
        source: "session",
      }),
      { kind: "tenant" },
    );
    await expect(
      resendReservationDepositLink(
        otherScope,
        other.userId,
        outletIdSchema.parse(isolated.outletId),
        created.reservation.id,
        key(),
      ),
    ).rejects.toSatisfy((error: { status?: number }) =>
      [403, 404].includes(error.status ?? 0),
    );
    const row = await reservationRow(created.reservation.id);
    expect(row.deposit_payment_link_id).toBe(created.deposit!.paymentLinkId);
  });

  it("refuses a missing Idempotency-Key (422) and a caller without reservation.manage (403)", async () => {
    const created = await book("2027-06-06");
    const missing = await resend(created.reservation.id, seededOutletA, null);
    expect(missing.status).toBe(422);
    const waiter = await staffWithRole(app, {
      template: "waiter",
      label: "Rsv Resend Waiter",
    });
    const denied = await resend(
      created.reservation.id,
      seededOutletA,
      key(),
      waiter.client,
    );
    expect(denied.status).toBe(403);
  });
  it("a replay is refused (409) once the booking left pending_deposit", async () => {
    const created = await book("2027-06-07");
    const k = key();
    expect(
      (await resend(created.reservation.id, seededOutletA, k)).status,
    ).toBe(200);
    await cancelReservation(
      tenantScope(),
      staff.userId,
      outletA,
      created.reservation.id,
      cancelReservationInputSchema.parse({ reason: "Tamu batal" }),
      key(),
    );
    const replay = await resend(created.reservation.id, seededOutletA, k);
    expect(replay.status).toBe(409);
    expect(replay.body.error.code).toBe("RESERVATION_DEPOSIT_NOT_PENDING");
  });

  it("expired link with a pending intent: 409, the old link is kept (no orphaned payment)", async () => {
    const created = await book("2027-06-08");
    const id = created.reservation.id;
    const intentId = await openIntent(created);
    await expireLink(id);
    await asOwner((client) =>
      client.query(
        "UPDATE payment_intents SET expires_at = now() + interval '20 minutes' WHERE id = $1",
        [intentId],
      ),
    );
    const res = await resend(id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("RESERVATION_DEPOSIT_PAYMENT_PENDING");
    const row = await reservationRow(id);
    expect(row.status).toBe("pending_deposit");
    expect(row.deposit_payment_link_id).toBe(created.deposit!.paymentLinkId);
    expect(await auditCount(id)).toBe(0);
  });

  it("settled intent on the old link: the booking is confirmed and no new link is opened", async () => {
    const created = await book("2027-06-09");
    const id = created.reservation.id;
    const intentId = await openIntent(created);
    await confirmPayment(tenantScope(), intentId, {
      source: "verified_webhook",
      method: "qris",
      amountIdr: 100_000,
      providerRef: `PAID-${intentId}`,
      at: new Date().toISOString(),
    });
    await expireLink(id);
    const res = await resend(id);
    expect(res.status).toBe(409);
    const row = await reservationRow(id);
    expect(row.status).toBe("confirmed");
    expect(row.deposit_payment_link_id).toBe(created.deposit!.paymentLinkId);
    expect(await auditCount(id)).toBe(0);
  });
  it("a re-minted link never outlives the frozen window (rounded down)", async () => {
    const created = await book("2027-06-10");
    const id = created.reservation.id;
    await asOwner((client) =>
      client.query(
        "UPDATE reservations SET created_at = now() - interval '49.5 minutes', deposit_payment_link_id = NULL, deposit_link_sealed = NULL, deposit_link_expires_at = NULL WHERE id = $1",
        [id],
      ),
    );
    const res = await resend(id);
    expect(res.status).toBe(200);
    const { rows } = await asOwner((client) =>
      client.query<{ window_end: Date; link_end: Date }>(
        "SELECT created_at + interval '60 minutes' AS window_end, deposit_link_expires_at AS link_end FROM reservations WHERE id = $1",
        [id],
      ),
    );
    expect(rows[0]!.link_end.getTime()).toBeLessThanOrEqual(
      rows[0]!.window_end.getTime(),
    );
  });

  it("409 with the window-closed code when under a minute is left", async () => {
    const created = await book("2027-06-11");
    const id = created.reservation.id;
    await asOwner((client) =>
      client.query(
        "UPDATE reservations SET created_at = now() - interval '59.5 minutes', deposit_payment_link_id = NULL, deposit_link_sealed = NULL, deposit_link_expires_at = NULL WHERE id = $1",
        [id],
      ),
    );
    const res = await resend(id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("RESERVATION_DEPOSIT_WINDOW_CLOSED");
    expect((await reservationRow(id)).deposit_payment_link_id).toBeNull();
  });

  it("a booking whose own link attempt fails keeps the link a resend stored meanwhile", async () => {
    await setPolicy("required", 100_000);
    const f = await floor(1);
    const real = createPaymentReservationDepositPort();
    const sealedTables: string[] = [];
    setReservationDepositPort({
      assertReady: real.assertReady,
      // The resend wins the race: its link is stored, then this attempt fails.
      async openDeposit(input) {
        const opened = await real.openDeposit(input);
        await asOwner((client) =>
          client.query(
            `UPDATE reservations SET deposit_payment_link_id = $2, deposit_link_sealed = $3, deposit_link_expires_at = $4 WHERE id = $1`,
            [
              input.reservationId,
              opened.paymentLinkId,
              sealSecret(
                opened.paymentPath,
                linkAad(seededTenantId, input.reservationId),
              ),
              opened.expiresAt,
            ],
          ),
        );
        sealedTables.push(input.reservationId);
        throw depositUnavailable();
      },
    });
    try {
      const created = await createReservation(
        tenantScope(),
        outletA,
        booking(f.zoneId, "2027-06-12"),
        key(),
      );
      expect(sealedTables).toEqual([created.reservation.id]);
      expect(created.reservation.status).toBe("pending_deposit");
      expect(created.deposit?.paymentPath).toMatch(/^\/bayar\/pl_/);
      const row = await reservationRow(created.reservation.id);
      expect(row.status).toBe("pending_deposit");
      expect(row.deposit_payment_link_id).toBe(created.deposit!.paymentLinkId);
      const { rows } = await asOwner((client) =>
        client.query(
          "SELECT 1 FROM reservation_tables WHERE reservation_id = $1 AND released_at IS NULL",
          [created.reservation.id],
        ),
      );
      expect(rows).toHaveLength(1);
    } finally {
      setReservationDepositPort(createPaymentReservationDepositPort());
    }
  });
});
