// Alur H (PRD v1.7 section 4, "Alur Reservasi dengan DP", WS-08) told as a story:
// tamu -> kebijakan DP -> bayar DP lewat tautan -> reservasi terkonfirmasi dan
// meja terkunci -> host membuka sesi -> DP dialokasikan ke tagihan.
// Criteria: RSV-01 (no overlapping table), RSV-02 (paid DP is a deposit that is
// allocated on arrival), RSV-03 (cancellation follows the policy taken at booking).
//
// Real Express app (`createApp()` + supertest), real PostgreSQL with RLS and the
// seeded Cafe Legend tenant. Only the payment gateway is a test double
// (`FakeGateway` through `setPaymentGateway`). Guest steps use the public
// routes with the tenant host; host steps use a signed-in owner.
//
// Assumptions (PRD does not fix them):
// - A.1 PRD step 2 says the system "shows the policy". There is no separate
//   public policy endpoint, so the policy the guest sees is the snapshot on the
//   booking confirmation (`reservation.policy`).
// - A.2 The DOIT webhook is simulated by `confirmPayment(... "verified_webhook")`
//   plus the `payment.paid` consumer; the real webhook route lands with
//   `ws/doit-provider` (see az-a-qr-order-pay.test.ts).
// - A.3 "DP dialokasikan ke tagihan": the bill is the table session. The credit
//   is observed through the deposit allocation row and `depositCreditForSession`,
//   the lookup the POS and QR order bill read (wired in app.ts). A POS order on
//   top of it is covered by pos-order-deposit-lock.test.ts.
// - A.4 The reminder (step 4 "pengingat") is a separate channel feature and is
//   not asserted here.
// - A.5 Refusals are asserted by the contract status and code
//   (`@starter/shared/reservation` errors: 409 RESERVATION_SLOT_UNAVAILABLE,
//   409 RESERVATION_DEPOSIT_UNPAID).
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenantIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { eventEnvelopeSchema } from "@starter/shared/events";
import { createApp } from "../../app";
import { db } from "../../db";
import { withTenant } from "../../db/tenant";
import {
  setPaymentGateway,
  type GatewayIntent,
  type GatewayIntentRequest,
  type PaymentGatewayPort,
} from "../../services/payment-gateway.ts";
import { confirmPayment } from "../../services/payment.service.ts";
import { handlePaymentPaid } from "../../services/reservation-consumers.ts";
import { createPaymentReservationDepositPort } from "../../services/reservation-deposit-payment.ts";
import { depositCreditForSession } from "../../services/reservation-lifecycle.ts";
import { zonedInstant } from "../../services/reservation-plan.ts";
import { setReservationDepositPort } from "../../services/reservation-ports.ts";
import { agent, originHeader } from "../helpers";
import {
  createTable,
  createZone,
  dropFloorRows,
  owner,
  seededHostname,
  seededOutletA,
  seededTenantId,
  staffWithRole,
  type Staff,
} from "../floor-test-helpers";

const WIB = "Asia/Jakarta";
const HOUR = 3_600_000;
const DP_IDR = 100_000;
const tenantId = tenantIdSchema.parse(seededTenantId);

const tenantScope = () =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
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

/** Gateway double: one payable QRIS code per idempotency key. */
class FakeGateway implements PaymentGatewayPort {
  readonly provider = "doit";
  private readonly byKey = new Map<string, GatewayIntent>();
  async health() {
    return { status: "available" as const };
  }
  async createIntent(input: GatewayIntentRequest): Promise<GatewayIntent> {
    const cached = this.byKey.get(input.idempotencyKey);
    if (cached) return cached;
    const created: GatewayIntent = {
      providerRef: `FAKE-AZH-${randomUUID()}`,
      instructions: {
        method: "qris",
        qrPayload: "00020101021226FAKEAZH",
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
let host: Staff;
let cashier: Staff;
const zoneIds: string[] = [];
const tableIds: string[] = [];
const linkIds: string[] = [];
let phoneCounter = 0;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  // The host who seats guests holds reservation.view / reservation.manage.
  host = await staffWithRole(app, { template: "owner", label: "AZ-H Host" });
  // A cashier holds neither, so the host-only steps are refused for them.
  cashier = await staffWithRole(app, {
    template: "cashier",
    label: "AZ-H Kasir",
  });
  setPaymentGateway(new FakeGateway());
  setReservationDepositPort(createPaymentReservationDepositPort());
});

afterAll(async () => {
  setReservationDepositPort(null);
  setPaymentGateway(null);
  await asOwner(async (client) => {
    const rsv = `(SELECT id FROM reservations WHERE tenant_id = $1 AND zone_id = ANY($2))`;
    const fromRows = (
      await client.query<{ id: string }>(
        "SELECT deposit_payment_link_id AS id FROM reservations WHERE tenant_id = $1 AND zone_id = ANY($2) AND deposit_payment_link_id IS NOT NULL",
        [seededTenantId, zoneIds],
      )
    ).rows.map((row) => row.id);
    const links = [...new Set([...linkIds, ...fromRows])];
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
  await owner.end();
});

// --- fixtures and small helpers ------------------------------------------------

type PolicySeed = {
  version: string;
  requirement: "none" | "required";
  amount?: number;
  freeHours?: number;
  lateBp?: number;
};

/** The outlet's reservation policy, as the owner configured it. */
async function setPolicy(seed: PolicySeed) {
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
       VALUES ($1, $2, $3, $4, $5, 60, $6, $7, 0, 0, 90, 30, true)`,
      [
        seededTenantId,
        seededOutletA,
        seed.version,
        seed.requirement,
        seed.amount ?? 0,
        seed.freeHours ?? 24,
        seed.lateBp ?? 0,
      ],
    );
  });
}

/** A zone with `count` 4-seat tables created through the floor API. */
async function floor(count: number) {
  const zone = await createZone(host.client);
  zoneIds.push(zone.id);
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const table = await createTable(host.client, { zoneId: zone.id });
    tableIds.push(table.id);
    ids.push(table.id);
  }
  return { zoneId: zone.id as string, tableIds: ids };
}

const key = () => `az-h-${randomUUID()}`;
const at = (date: string, time: string) =>
  zonedInstant(date, time, WIB).toISOString();
const phone = () => `0812${String(10_000_000 + phoneCounter++).slice(-8)}`;
const staffPath = (suffix = "") =>
  `/api/outlets/${seededOutletA}/reservations${suffix}`;

/** The guest on the public reservation page (tenant from the host). */
const guest = {
  availability: (date: string, zoneId: string, pax = 2) =>
    agent(app)
      .get(`/api/public/outlets/${seededOutletA}/reservation-availability`)
      .set("Host", seededHostname)
      .query({ date, pax, zoneId }),
  book: (body: Record<string, unknown>) =>
    agent(app)
      .post(`/api/public/outlets/${seededOutletA}/reservations`)
      .set("Host", seededHostname)
      .set("Idempotency-Key", key())
      .send({
        pax: 2,
        guestName: "Tamu Alur H",
        contactPhone: phone(),
        ...body,
      }),
  paymentPage: (token: string) =>
    agent(app).get(`/api/payments/links/${token}`),
  payQris: (token: string) =>
    agent(app)
      .post(`/api/payments/links/${token}/intents`)
      .send({ method: "qris", channelCode: null, idempotencyKey: key() }),
};

/** The host's calls on the reservation board. */
const hostCalls = {
  detail: (id: string) => host.client.get(staffPath(`/${id}`)),
  assign: (id: string, ids: string[]) =>
    host.client
      .patch(staffPath(`/${id}/tables`))
      .set(originHeader)
      .set("Idempotency-Key", key())
      .send({ tableIds: ids }),
  seat: (id: string, ids: string[], idempotencyKey = key()) =>
    host.client
      .post(staffPath(`/${id}/seat`))
      .set(originHeader)
      .set("Idempotency-Key", idempotencyKey)
      .send({ tableIds: ids }),
  cancel: (id: string, reason: string) =>
    host.client
      .post(staffPath(`/${id}/cancel`))
      .set(originHeader)
      .set("Idempotency-Key", key())
      .send({ reason }),
};

function tokenOf(paymentPath: string) {
  expect(paymentPath.startsWith("/bayar/")).toBe(true);
  return paymentPath.slice("/bayar/".length);
}

/** The gateway tells us the QRIS code was paid (simulated verified webhook). */
async function gatewayConfirmsPaid(intentId: string, amountIdr: number) {
  await confirmPayment(tenantScope(), intentId, {
    source: "verified_webhook",
    method: "qris",
    amountIdr,
    providerRef: `PAID-${intentId}`,
    at: new Date().toISOString(),
  });
  const { rows } = await asOwner((client) =>
    client.query<{ event: unknown }>(
      "SELECT event FROM domain_event_outbox WHERE tenant_id = $1 AND aggregate_id = $2 AND event->>'name' = 'payment.paid'",
      [seededTenantId, intentId],
    ),
  );
  await handlePaymentPaid(
    tenantScope(),
    eventEnvelopeSchema.parse(rows[0]!.event),
  );
}

/** Moves a booking close to now so it falls inside the free-cancellation window. */
async function moveReservedFor(id: string, to: Date) {
  await asOwner((client) =>
    client.query("UPDATE reservations SET reserved_for = $2 WHERE id = $1", [
      id,
      to,
    ]),
  );
}

type BookedWithDp = {
  id: string;
  zoneId: string;
  tableIds: string[];
  intentId: string;
  linkId: string;
};

/** Guest books and pays the DP, start to finish, on the given date. */
async function bookAndPayDp(date: string): Promise<BookedWithDp> {
  const f = await floor(1);
  const booked = await guest.book({
    reservedFor: at(date, "19:00"),
    zoneId: f.zoneId,
  });
  expect(booked.status, JSON.stringify(booked.body)).toBe(201);
  const deposit = booked.body.data.deposit;
  linkIds.push(deposit.paymentLinkId);
  const intent = await guest.payQris(tokenOf(deposit.paymentPath));
  expect(intent.status, JSON.stringify(intent.body)).toBe(201);
  await gatewayConfirmsPaid(intent.body.data.id, deposit.amountIdr);
  return {
    id: booked.body.data.reservation.id,
    zoneId: f.zoneId,
    tableIds: f.tableIds,
    intentId: intent.body.data.id,
    linkId: deposit.paymentLinkId,
  };
}

// --- the story ---------------------------------------------------------------------

describe("Alur H RSV-01 RSV-02: tamu memesan dengan DP, DP dibayar, host menyambut, DP masuk tagihan", () => {
  // Shared across the ordered steps of one story.
  const date = "2027-05-14";
  let zoneId = "";
  let tableId = "";
  let reservationId = "";
  let payToken = "";
  let intentId = "";
  let tableSessionId = "";

  beforeAll(async () => {
    await setPolicy({
      version: "az-h-1",
      requirement: "required",
      amount: DP_IDR,
      freeHours: 24,
      lateBp: 5000,
    });
    const f = await floor(1);
    zoneId = f.zoneId;
    tableId = f.tableIds[0]!;
  });

  it("RSV-01 tamu memilih tanggal, jam, jumlah tamu dan zona, lalu melihat slot 19:00 tersedia", async () => {
    const response = await guest.availability(date, zoneId);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const slot = response.body.data.slots.find(
      (s: { startsAt: string }) => s.startsAt === at(date, "19:00"),
    );
    expect(slot, "slot 19:00 harus ditawarkan").toBeDefined();
    expect(slot.tableIds).toEqual([tableId]);
  });

  it("RSV-02 tamu memesan: reservasi menunggu DP, kebijakan DP dan pembatalan terlihat, meja belum terkonfirmasi", async () => {
    const response = await guest.book({
      reservedFor: at(date, "19:00"),
      zoneId,
      guestName: "Budi Tamu",
      note: "Dekat jendela",
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const { reservation, deposit } = response.body.data;
    reservationId = reservation.id;

    expect(reservation.status).toBe("pending_deposit");
    expect(reservation.depositIdr).toBe(DP_IDR);
    expect(reservation.pax).toBe(2);
    expect(reservation.zoneId).toBe(zoneId);
    expect(reservation.note).toBe("Dekat jendela");
    // The policy the guest sees: DP, cancellation window and refund share (A.1).
    expect(reservation.policy).toMatchObject({
      depositRequirement: "required",
      depositAmountIdr: DP_IDR,
      freeCancellationHours: 24,
      lateCancellationRefundBp: 5000,
    });
    // The DP is a payment link served by the hosted payment page.
    expect(deposit.amountIdr).toBe(DP_IDR);
    linkIds.push(deposit.paymentLinkId);
    payToken = tokenOf(deposit.paymentPath);
    // The booking response never exposes the guest's phone number.
    expect(JSON.stringify(response.body)).not.toContain("0812");
  });

  it("RSV-02 sebelum DP lunas host tidak dapat membuka sesi meja", async () => {
    const assigned = await hostCalls.assign(reservationId, [tableId]);
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    expect(assigned.body.data.status).toBe("pending_deposit");

    const seat = await hostCalls.seat(reservationId, [tableId]);
    expect(seat.status).toBe(409);
    expect(seat.body.error.code).toBe("RESERVATION_DEPOSIT_UNPAID");
    const after = await hostCalls.detail(reservationId);
    expect(after.body.data.reservation.status).toBe("pending_deposit");
  });

  it("RSV-02 tamu membuka halaman pembayaran: tagihan Rp100.000 dan QRIS tersedia, lalu membuat kode QRIS", async () => {
    const page = await guest.paymentPage(payToken);
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    expect(page.body.data.bill.totals.outstandingIdr).toBe(DP_IDR);
    expect(page.body.data.bill.totals.paidIdr).toBe(0);
    const qris = page.body.data.methods.find(
      (m: { method: string }) => m.method === "qris",
    );
    expect(qris?.enabled).toBe(true);

    const intent = await guest.payQris(payToken);
    expect(intent.status, JSON.stringify(intent.body)).toBe(201);
    expect(intent.body.data.amountIdr).toBe(DP_IDR);
    expect(intent.body.data.status).toBe("pending");
    expect(intent.body.data.instructions.method).toBe("qris");
    intentId = intent.body.data.id;

    // Scanning does not confirm anything: the reservation still waits for the DP.
    const detail = await hostCalls.detail(reservationId);
    expect(detail.body.data.reservation.status).toBe("pending_deposit");
  });

  it("RSV-02 gateway menandai DP lunas: reservasi terkonfirmasi dan tercatat sebagai uang muka", async () => {
    await gatewayConfirmsPaid(intentId, DP_IDR);

    const detail = await hostCalls.detail(reservationId);
    expect(detail.status).toBe(200);
    const { reservation } = detail.body.data;
    expect(reservation.status).toBe("confirmed");
    expect(reservation.depositStatus).toBe("paid");
    expect(reservation.depositPaymentId).toBe(intentId);
    expect(reservation.depositIdr).toBe(DP_IDR);

    // The guest's payment page now shows the DP as settled.
    const page = await guest.paymentPage(payToken);
    expect(page.body.data.bill.totals.outstandingIdr).toBe(0);
    expect(page.body.data.activeIntent.status).toBe("paid");
  });

  it("RSV-01 meja terkunci: slot hilang dari ketersediaan dan tamu lain ditolak pada slot yang bertumpuk", async () => {
    const availability = await guest.availability(date, zoneId);
    expect(
      availability.body.data.slots.find(
        (s: { startsAt: string }) => s.startsAt === at(date, "19:00"),
      ),
    ).toBeUndefined();
    // A booking that starts at 20:30 begins when ours ends (90 minutes): still free.
    expect(
      availability.body.data.slots.find(
        (s: { startsAt: string }) => s.startsAt === at(date, "20:30"),
      ),
    ).toBeDefined();

    // Overlapping start (19:30 is inside 19:00-20:30): refused, nothing written.
    const rival = await guest.book({
      reservedFor: at(date, "19:30"),
      zoneId,
      guestName: "Tamu Rebutan",
    });
    expect(rival.status).toBe(409);
    expect(rival.body.error.code).toBe("RESERVATION_SLOT_UNAVAILABLE");
    const list = await host.client.get(staffPath()).query({ date });
    expect(
      list.body.data.filter((r: { zoneId: string }) => r.zoneId === zoneId),
    ).toHaveLength(1);
  });

  it("RSV-02 hanya staf dengan izin reservasi yang dapat membuka sesi: kasir ditolak, tanpa sesi tercatat", async () => {
    const response = await cashier.client
      .post(staffPath(`/${reservationId}/seat`))
      .set(originHeader)
      .set("Idempotency-Key", key())
      .send({ tableIds: [tableId] });
    expect(response.status).toBe(403);
    const detail = await hostCalls.detail(reservationId);
    expect(detail.body.data.reservation.status).toBe("confirmed");
  });

  it("RSV-02 tamu datang: host membuka sesi meja dan permintaan ulang tidak membuat sesi kedua", async () => {
    const seatKey = key();
    const seated = await hostCalls.seat(reservationId, [tableId], seatKey);
    expect(seated.status, JSON.stringify(seated.body)).toBe(200);
    expect(seated.body.data.reservation.status).toBe("seated");
    tableSessionId = seated.body.data.tableSessionId;
    expect(tableSessionId).toBeTruthy();

    const replay = await hostCalls.seat(reservationId, [tableId], seatKey);
    expect(replay.status).toBe(200);
    expect(replay.body.data.tableSessionId).toBe(tableSessionId);

    const detail = await hostCalls.detail(reservationId);
    expect(detail.body.data.reservation).toMatchObject({
      status: "seated",
      tableSessionId,
    });
  });

  it("RSV-02 DP dialokasikan ke tagihan sesi: tepat sekali, sebesar Rp100.000", async () => {
    const { rows } = await asOwner((client) =>
      client.query<{ amount_idr: string; table_session_id: string }>(
        "SELECT amount_idr::text, table_session_id FROM reservation_deposit_allocations WHERE reservation_id = $1",
        [reservationId],
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      amount_idr: String(DP_IDR),
      table_session_id: tableSessionId,
    });
    // The credit the bill (POS / QR order) reads for this table session (A.3).
    const credit = await withTenant(db, tenantScope(), (tx) =>
      depositCreditForSession(tx, tenantId, tableSessionId as never),
    );
    expect(credit).toBe(DP_IDR);
  });

  it("RSV-02 reservasi yang sudah berjalan tidak dapat dibuka sesi lagi dengan kunci idempotensi baru (tidak ada alokasi ganda)", async () => {
    // A fresh Idempotency-Key is not a replay: the seated -> seated step is
    // refused by the reservation machine.
    const again = await hostCalls.seat(reservationId, [tableId]);
    expect(again.status, JSON.stringify(again.body)).toBe(409);
    expect(again.body.error.code).toBe("RESERVATION_TRANSITION_INVALID");
    const { rows } = await asOwner((client) =>
      client.query(
        "SELECT 1 FROM reservation_deposit_allocations WHERE reservation_id = $1",
        [reservationId],
      ),
    );
    expect(rows).toHaveLength(1);
  });
});

describe("Alur H RSV-02: reservasi tanpa DP dan DP belum dibayar", () => {
  it("RSV-02 kebijakan tanpa DP: reservasi langsung terkonfirmasi, tanpa tautan pembayaran, host dapat membuka sesi", async () => {
    await setPolicy({ version: "az-h-none", requirement: "none" });
    const f = await floor(1);
    const booked = await guest.book({
      reservedFor: at("2027-05-15", "19:00"),
      zoneId: f.zoneId,
    });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    expect(booked.body.data.deposit).toBeNull();
    expect(booked.body.data.reservation.status).toBe("confirmed");
    expect(booked.body.data.reservation.depositIdr).toBe(0);

    const id = booked.body.data.reservation.id;
    const seated = await hostCalls.seat(
      id,
      booked.body.data.reservation.tableIds,
    );
    expect(seated.status, JSON.stringify(seated.body)).toBe(200);
    expect(seated.body.data.reservation.status).toBe("seated");
    const { rows } = await asOwner((client) =>
      client.query(
        "SELECT 1 FROM reservation_deposit_allocations WHERE reservation_id = $1",
        [id],
      ),
    );
    expect(rows).toHaveLength(0);
  });

  it("RSV-02 RSV-03 batal sebelum DP dibayar: tidak ada yang direfund dan meja kembali tersedia", async () => {
    await setPolicy({
      version: "az-h-unpaid",
      requirement: "required",
      amount: DP_IDR,
    });
    const date = "2027-05-16";
    const f = await floor(1);
    const booked = await guest.book({
      reservedFor: at(date, "19:00"),
      zoneId: f.zoneId,
    });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    linkIds.push(booked.body.data.deposit.paymentLinkId);
    const id = booked.body.data.reservation.id;

    const cancelled = await hostCalls.cancel(id, "Tamu berubah pikiran");
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.data.reservation.status).toBe("cancelled");
    expect(cancelled.body.data.depositOutcome).toMatchObject({
      resolution: "nothing_paid",
      refundIdr: 0,
      forfeitedIdr: 0,
    });

    const availability = await guest.availability(date, f.zoneId);
    expect(
      availability.body.data.slots.find(
        (s: { startsAt: string }) => s.startsAt === at(date, "19:00"),
      ),
    ).toBeDefined();
  });
});

describe("Alur H RSV-03: pembatalan mengikuti kebijakan saat reservasi dibuat", () => {
  it("RSV-03 batal di luar jendela gratis: DP dikembalikan penuh", async () => {
    await setPolicy({
      version: "az-h-full",
      requirement: "required",
      amount: DP_IDR,
      freeHours: 24,
      lateBp: 5000,
    });
    const paid = await bookAndPayDp("2027-05-17");
    const cancelled = await hostCalls.cancel(paid.id, "Jadwal bentrok");
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.data.reservation.status).toBe("cancelled");
    expect(cancelled.body.data.depositOutcome).toMatchObject({
      resolution: "refund_full",
      refundIdr: DP_IDR,
      forfeitedIdr: 0,
      policyVersion: "az-h-full",
    });
  });

  it("RSV-03 batal di dalam jendela: refund sebesar persentase kebijakan lama, bukan kebijakan baru", async () => {
    await setPolicy({
      version: "az-h-old",
      requirement: "required",
      amount: DP_IDR,
      freeHours: 24,
      lateBp: 5000,
    });
    const paid = await bookAndPayDp("2027-05-18");
    // The outlet later becomes more generous (full refund at any time). The
    // booking was made under the old policy, so the old policy decides.
    await setPolicy({
      version: "az-h-new",
      requirement: "required",
      amount: DP_IDR,
      freeHours: 0,
      lateBp: 10_000,
    });
    // Two hours before the table time is inside the 24-hour window.
    await moveReservedFor(paid.id, new Date(Date.now() + 2 * HOUR));

    const cancelled = await hostCalls.cancel(paid.id, "Sakit mendadak");
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.data.reservation.status).toBe("cancelled");
    expect(cancelled.body.data.depositOutcome).toMatchObject({
      resolution: "refund_partial",
      refundIdr: DP_IDR / 2,
      forfeitedIdr: DP_IDR / 2,
      policyVersion: "az-h-old",
    });
  });

  it("RSV-03 reservasi yang sudah dibatalkan tidak dapat dibatalkan lagi dan tidak ada refund kedua", async () => {
    await setPolicy({
      version: "az-h-twice",
      requirement: "required",
      amount: DP_IDR,
    });
    const paid = await bookAndPayDp("2027-05-19");
    const first = await hostCalls.cancel(paid.id, "Batal pertama");
    expect(first.status, JSON.stringify(first.body)).toBe(200);

    const refundRows = () =>
      asOwner(async (client) => {
        const { rows } = await client.query<{ n: string }>(
          "SELECT count(*)::text AS n FROM payment_refunds WHERE tenant_id = $1 AND payment_intent_id = $2",
          [seededTenantId, paid.intentId],
        );
        return Number(rows[0]?.n);
      });
    const refundsAfterFirst = await refundRows();

    const second = await hostCalls.cancel(paid.id, "Batal kedua");
    expect(second.status, JSON.stringify(second.body)).toBe(409);
    expect(second.body.error.code).toBe("RESERVATION_TRANSITION_INVALID");
    expect(await refundRows()).toBe(refundsAfterFirst);
    const detail = await hostCalls.detail(paid.id);
    expect(detail.body.data.reservation.status).toBe("cancelled");
  });
});
