// Acting staff wave 3, reservation + order-recovery-adjacent money routes
// (beads i0ipj / m05vx). Reservation part.
//
// Contract (docs/CONTRACT.md acting-staff + shared `ACTING_STAFF_ERROR_CODES`):
// the four reservation mutations honor `X-Acting-Staff` (token from POST
// /api/staff-pins/pos-session) and fail closed on a shared tablet:
//   POST /api/outlets/:outletId/reservations/:id/cancel
//   POST /api/outlets/:outletId/reservations/:id/deposit-link
//   POST /api/outlets/:outletId/reservations/:id/no-show
//   POST /api/outlets/:outletId/reservation-customer-credit/apply
// - shared tablet (devices.shared_mode) without a token -> 401, nothing changes.
// - with a live cashier token -> allowed, the cashier is the recorded actor.
// - private (unflagged) device or no device -> unchanged, the session owner acts.
// - another tenant never reaches the reservation.
// - credit apply: same Idempotency-Key never debits twice.
//
// Assumptions:
//  - The brief names the code SHARED_DEVICE_REQUIRED; the shared constants and
//    the sibling floor tests use ACTING_STAFF_REQUIRED (401) for "flagged
//    device, no token". Assert that code, and accept either name.
//  - Actor evidence = audit_logs `event->>'actorId'` rows appended by the call
//    plus actor-ish columns (cancelled_by, actor...) of the reservation row.
//  - deposit-link needs a DP booking and a payment gateway; the guard cases
//    only prove the guard (401 before, and "not an acting-staff code" after).
//  - A no-show on a booking may be refused by the domain (e.g. time not yet
//    reached); the guard cases only need "not a guard error" then.

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { idr, outletIdSchema, tenantIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createReservationInputSchema } from "@starter/shared/reservation";
import { createApp } from "../app.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import { createReservation } from "../services/reservation-booking.ts";
import { zonedInstant } from "../services/reservation-plan.ts";
import {
  openOrJoinTableSession,
  setTableSessionSettlementLookup,
} from "../services/table-session.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  staffWithRole,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const ACTING_HEADER = "X-Acting-Staff";
const PIN = "582914";
const WIB = "Asia/Jakarta";
const roles = { till: randomUUID(), limited: randomUUID() };
const sharedDevices = new Set<string>();
const privateDevices = new Set<string>();
const settlements = new Map<string, { total: number; paid: number }>();

type Client = ReturnType<typeof agent>;
type Member = { client: Client; userId: string };
let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
let sessionOwner: Member;
let cashierB: Member;
let limited: Member;
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

async function member(label: string, roleId: string): Promise<Member> {
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

const tokenOf = (deviceId: string) =>
  signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: tenant.tenantId,
    brandId: null,
    deviceId,
  });

/** A new login per test: shared-device marks live on the session (max 8). */
const fresh = () => member(`Sesi ${randomUUID().slice(0, 6)}`, roles.till);

async function newDevice(shared: boolean): Promise<string> {
  const id = randomUUID();
  (shared ? sharedDevices : privateDevices).add(id);
  await owner.query(
    `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
     VALUES ($1, $2, $3, 'pos', $4, now() - interval '1 minute')`,
    [id, tenant.tenantId, tenant.outletId, `Kasir Rsv ${id.slice(0, 6)}`],
  );
  if (shared)
    await owner.query("UPDATE devices SET shared_mode = true WHERE id = $1", [
      id,
    ]);
  return id;
}

async function cashierToken(
  who: Member,
  staff: Member,
  deviceId: string,
): Promise<string> {
  await setStaffPin(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    staff.userId,
    { outletId: tenant.outletId, userId: staff.userId },
    { pin: PIN },
  );
  const response = await who.client
    .post("/api/staff-pins/pos-session")
    .set(headers)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, tokenOf(deviceId))
    .send({ userId: staff.userId, pin: PIN });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data.token as string;
}

/** POST as `who` from `deviceId` (null = browser without device identity). */
function post(
  who: Member,
  path: string,
  deviceId: string | null,
  acting: string | null,
  body: Record<string, unknown> = {},
  idempotencyKey: string | null = `w3-${randomUUID()}`,
) {
  let request = who.client.post(path).set(headers).set(originHeader);
  if (deviceId) request = request.set(DEVICE_TOKEN_HEADER, tokenOf(deviceId));
  if (acting) request = request.set(ACTING_HEADER, acting);
  if (idempotencyKey) request = request.set("Idempotency-Key", idempotencyKey);
  return request.send(body);
}

function expectError(
  response: { status: number; body: unknown },
  status: number,
  codes: string[],
) {
  const body = response.body as { error?: { code?: string } };
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  expect(codes, JSON.stringify(response.body)).toContain(body.error?.code);
}

const GUARD_CODES = ["ACTING_STAFF_REQUIRED", "SHARED_DEVICE_REQUIRED"];
const codeOf = (r: { body: unknown }) =>
  (r.body as { error?: { code?: string } }).error?.code ?? "";
const isGuardCode = (code: string) =>
  /^(ACTING_STAFF_|SHARED_DEVICE_)/.test(code);

async function setPolicy() {
  await owner.query(
    "DELETE FROM reservation_policies WHERE tenant_id = $1 AND outlet_id = $2",
    [tenant.tenantId, tenant.outletId],
  );
  await owner.query(
    `INSERT INTO reservation_policies
       (tenant_id, outlet_id, version, deposit_requirement, deposit_amount_idr, payment_window_minutes,
        free_cancellation_hours, late_cancellation_refund_bp, no_show_refund_bp, minimum_spend_idr,
        default_duration_minutes, slot_interval_minutes, is_active)
     VALUES ($1, $2, 'w3-none', 'none', 0, 60, 24, 5000, 0, 0, 90, 30, true)`,
    [tenant.tenantId, tenant.outletId],
  );
}

let zoneId = "";
/** A fresh future booking (distinct day) in the isolated tenant's outlet. */
async function book(): Promise<string> {
  if (!zoneId) {
    const z = await sessionOwner.client
      .post("/api/floor/zones")
      .set(headers)
      .set(originHeader)
      .send({
        name: `Zona Rsv ${randomUUID().slice(0, 6)}`,
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
        code: `R-${randomUUID().slice(0, 6)}`.toUpperCase(),
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
      guestName: "Tamu Acting",
      contactPhone: "081234567890",
    }),
    `w3-book-${randomUUID()}`,
  );
  return created.reservation.id;
}

async function statusOf(id: string): Promise<string> {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM reservations WHERE id = $1",
    [id],
  );
  return rows[0]!.status;
}

async function actorEvidence(
  reservationId: string,
  run: () => Promise<{ status: number; body: unknown }>,
) {
  const rowsOf = async () =>
    (
      await owner.query<{ t: string }>(
        "SELECT a.id::text || '|' || coalesce(a.event->>'actorId', '') AS t FROM audit_logs a WHERE tenant_id = $1",
        [tenant.tenantId],
      )
    ).rows.map((r) => r.t);
  const before = new Set(await rowsOf());
  const response = await run();
  expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
  const fresh = (await rowsOf()).filter((r) => !before.has(r));
  const { rows } = await owner.query<{ row: Record<string, unknown> }>(
    "SELECT to_jsonb(t) AS row FROM reservations t WHERE id = $1",
    [reservationId],
  );
  const columns = Object.entries(rows[0]?.row ?? {})
    .filter(([k]) =>
      /(cancelled_by|actor|updated_by|changed_by|marked_by)/i.test(k),
    )
    .map(([, v]) => String(v));
  return [...fresh, ...columns].join("\n");
}

const path = (
  reservationId: string,
  action: string,
  outletId = tenant.outletId,
) => `/api/outlets/${outletId}/reservations/${reservationId}/${action}`;
const CANCEL_BODY = { reason: "Tamu batal lewat telepon" };

beforeAll(async () => {
  app = createApp();
  tenant = await createIsolatedTenant(`actr-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  setDeviceOutletResolver(async ({ tenantId, deviceId }) =>
    tenantId === tenant.tenantId &&
    (sharedDevices.has(deviceId) || privateDevices.has(deviceId))
      ? tenant.outletId
      : null,
  );
  const perms = [
    "order.view",
    "floor.table.view",
    "floor.table.operate",
    "floor.table.manage",
    "reservation.view",
    "reservation.manage",
  ];
  for (const [id, name, permissions] of [
    [roles.till, "Rsv Kasir Aktif", perms],
    [roles.limited, "Rsv Terbatas", ["order.view"]],
  ] as const)
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant"]')`,
      [id, tenant.tenantId, name, JSON.stringify(permissions)],
    );
  sessionOwner = await member("Sesi Reservasi", roles.till);
  cashierB = await member("Kasir Reservasi B", roles.till);
  limited = await member("Staf Reservasi Terbatas", roles.limited);
  await setPolicy();
  setTableSessionSettlementLookup(async ({ sessionId }) => {
    const s = settlements.get(sessionId);
    return s ? { billTotalIdr: idr(s.total), paidIdr: idr(s.paid) } : null;
  });
});

afterAll(async () => {
  setTableSessionSettlementLookup(null);
  setDeviceOutletResolver(null);
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

type RouteCase = {
  name: string;
  action: "cancel" | "no-show" | "deposit-link";
  body: Record<string, unknown>;
  /** Mutating routes whose success we can force in this setup. */
  succeeds: boolean;
  after?: string;
};
const routeCases: RouteCase[] = [
  {
    name: "reservation-cancel",
    action: "cancel",
    body: CANCEL_BODY,
    succeeds: true,
    after: "cancelled",
  },
  { name: "reservation-no-show", action: "no-show", body: {}, succeeds: false },
  {
    name: "reservation-deposit-link",
    action: "deposit-link",
    body: {},
    succeeds: false,
  },
];

describe("acting staff on reservation mutations (wave 3)", () => {
  for (const c of routeCases) {
    describe(c.name, () => {
      it("shared tablet without a PIN token is 401 and the booking is untouched", async () => {
        const who = await fresh();
        const id = await book();
        const deviceId = await newDevice(true);
        const before = await statusOf(id);
        const response = await post(
          who,
          path(id, c.action),
          deviceId,
          null,
          c.body,
        );
        expectError(response, 401, GUARD_CODES);
        expect(await statusOf(id)).toBe(before);
        // A replay without the device header (cookie only) is refused too.
        const stripped = await post(
          who,
          path(id, c.action),
          null,
          null,
          c.body,
        );
        expectError(stripped, 401, GUARD_CODES);
        expect(await statusOf(id)).toBe(before);
      });

      it("a garbage token on a shared tablet is ACTING_STAFF_INVALID, never the owner", async () => {
        const who = await fresh();
        const id = await book();
        const deviceId = await newDevice(true);
        const response = await post(
          who,
          path(id, c.action),
          deviceId,
          "pas_garbage-token",
          c.body,
        );
        expectError(response, 401, ["ACTING_STAFF_INVALID"]);
        expect(await statusOf(id)).toBe("confirmed");
      });

      it("a live cashier token passes the guard", async () => {
        const who = await fresh();
        const id = await book();
        const deviceId = await newDevice(true);
        const token = await cashierToken(who, cashierB, deviceId);
        const response = await post(
          who,
          path(id, c.action),
          deviceId,
          token,
          c.body,
        );
        if (c.succeeds) {
          expect(response.status, JSON.stringify(response.body)).toBe(200);
          expect(await statusOf(id)).toBe(c.after);
        } else {
          // Domain may refuse (e.g. no deposit to resend); never a guard code.
          expect(
            isGuardCode(codeOf(response)),
            JSON.stringify(response.body),
          ).toBe(false);
          expect(codeOf(response), JSON.stringify(response.body)).not.toBe(
            "PERMISSION_DENIED",
          );
        }
      });

      it("acting staff without reservation.manage is 403 PERMISSION_DENIED", async () => {
        const who = await fresh();
        const id = await book();
        const deviceId = await newDevice(true);
        const token = await cashierToken(who, limited, deviceId);
        const response = await post(
          who,
          path(id, c.action),
          deviceId,
          token,
          c.body,
        );
        expectError(response, 403, ["PERMISSION_DENIED"]);
        expect(await statusOf(id)).toBe("confirmed");
      });

      it("a private (unflagged) device keeps working as the session owner", async () => {
        const who = await fresh();
        const id = await book();
        const deviceId = await newDevice(false);
        const response = await post(
          who,
          path(id, c.action),
          deviceId,
          null,
          c.body,
        );
        expect(
          isGuardCode(codeOf(response)),
          JSON.stringify(response.body),
        ).toBe(false);
        if (c.succeeds) {
          expect(response.status, JSON.stringify(response.body)).toBe(200);
          expect(await statusOf(id)).toBe(c.after);
        }
      });

      it("another tenant's staff cannot reach the booking", async () => {
        const id = await book();
        const other = await staffWithRole(app, { template: "owner" });
        const response = await other.client
          .post(path(id, c.action))
          .set(originHeader)
          .set("Idempotency-Key", `w3-${randomUUID()}`)
          .send(c.body);
        expect(response.status, JSON.stringify(response.body)).not.toBe(200);
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.status).toBeLessThan(500);
        expect(await statusOf(id)).toBe("confirmed");
      });
    });
  }

  it("reservation-cancel: no header, the session owner is the recorded actor (calibration)", async () => {
    const id = await book();
    const evidence = await actorEvidence(id, () =>
      post(sessionOwner, path(id, "cancel"), null, null, CANCEL_BODY),
    );
    expect(evidence).toContain(sessionOwner.userId);
    expect(evidence).not.toContain(cashierB.userId);
  });

  it("reservation-cancel: with a cashier token the cashier is the recorded actor, not the session owner", async () => {
    const who = await fresh();
    const id = await book();
    const deviceId = await newDevice(true);
    const token = await cashierToken(who, cashierB, deviceId);
    const evidence = await actorEvidence(id, () =>
      post(who, path(id, "cancel"), deviceId, token, CANCEL_BODY),
    );
    expect(evidence).toContain(cashierB.userId);
    expect(evidence).not.toContain(who.userId);
  });
});

// ---- reservation-customer-credit-apply --------------------------------------
describe("reservation-customer-credit-apply (acting staff, idempotent)", () => {
  const applyPath = () =>
    `/api/outlets/${tenant.outletId}/reservation-customer-credit/apply`;
  const DEPOSIT = 100_000;
  const CREDIT = 40_000; // unused part of the DP, after 60_000 applied to the source bill
  const BILL = 30_000;

  async function openSession(): Promise<string> {
    const zone = await sessionOwner.client
      .post("/api/floor/zones")
      .set(headers)
      .set(originHeader)
      .send({
        name: `Zona Kredit ${randomUUID().slice(0, 6)}`,
        paymentMode: "pay_first",
        serviceChargeBp: 0,
        minimumSpendIdr: 0,
        hours: [
          { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "08:00", end: "22:00" },
        ],
      });
    expect(zone.status, JSON.stringify(zone.body)).toBe(201);
    const table = await sessionOwner.client
      .post("/api/floor/tables")
      .set(headers)
      .set(originHeader)
      .send({
        zoneId: zone.body.data.id,
        code: `K-${randomUUID().slice(0, 6)}`.toUpperCase(),
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
    expect(table.status, JSON.stringify(table.body)).toBe(201);
    const qr = await sessionOwner.client
      .post(`/api/tables/${table.body.data.id}/qr`)
      .set(headers)
      .set(originHeader);
    expect(qr.status, JSON.stringify(qr.body)).toBe(200);
    const opened = await openOrJoinTableSession(scope(), {
      qrToken: qr.body.data.token,
      pax: 2,
      deviceHash: `w3-${randomUUID()}`,
    });
    return opened.session.id;
  }

  /** The original DP receipt journal (customer_deposit), as the close flow expects. */
  async function seedReceipt(intentId: string, amount: number) {
    const accounts = [randomUUID(), randomUUID()];
    for (const [i, type, group] of [
      [0, "asset", "current_asset"],
      [1, "liability", "current_liability"],
    ] as const)
      await owner.query(
        `INSERT INTO chart_of_accounts(id,tenant_id,legal_entity_id,code,name,type,report_group)
         VALUES($1,$2,$3,$4,'W3 DP receipt',$5,$6)`,
        [
          accounts[i],
          tenant.tenantId,
          tenant.legalEntityId,
          `93${Math.floor(Math.random() * 1e6)}.${i + 1}`,
          type,
          group,
        ],
      );
    const period = new Date().toISOString().slice(0, 7);
    await owner.query(
      `INSERT INTO fiscal_periods(tenant_id,legal_entity_id,period) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
      [tenant.tenantId, tenant.legalEntityId, period],
    );
    const periodId = (
      await owner.query(
        "SELECT id FROM fiscal_periods WHERE tenant_id=$1 AND legal_entity_id=$2 AND period=$3",
        [tenant.tenantId, tenant.legalEntityId, period],
      )
    ).rows[0].id;
    const journalId = randomUUID();
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO journal_entries(id,tenant_id,legal_entity_id,outlet_id,entry_date,fiscal_period_id,source_type,source_id,description,idempotency_key,request_fingerprint)
         VALUES($1,$2,$3,$4,$5,$6,'customer_deposit',$7,'Penerimaan DP uji w3',$8,$9)`,
        [
          journalId,
          tenant.tenantId,
          tenant.legalEntityId,
          tenant.outletId,
          new Date().toISOString().slice(0, 10),
          periodId,
          intentId,
          `aj:receipt:${intentId}`,
          "0".repeat(64),
        ],
      );
      await client.query(
        `INSERT INTO journal_lines(tenant_id,entry_id,account_id,line_no,debit_idr,credit_idr,outlet_id)
         VALUES($1,$2,$3,1,$5,0,$6),($1,$2,$4,2,0,$5,$6)`,
        [
          tenant.tenantId,
          journalId,
          accounts[0],
          accounts[1],
          amount,
          tenant.outletId,
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** A customer with CREDIT liquid credit and a target bill of BILL. */
  async function seedCredit() {
    const profileId = randomUUID();
    await owner.query(
      `INSERT INTO customer_profiles (id, tenant_id, name, membership_status, whatsapp_verified_at)
       VALUES ($1, $2, 'Pelanggan Kredit', 'active', now())`,
      [profileId, tenant.tenantId],
    );
    const sourceSession = await openSession();
    const reservationId = randomUUID();
    const intentId = randomUUID();
    const linkId = randomUUID();
    await owner.query(
      `INSERT INTO reservations
         (id, tenant_id, outlet_id, customer_profile_id, guest_name, reserved_for,
          duration_minutes, pax, zone_id, deposit_idr, policy_snapshot, status,
          source, seated_at, table_session_id)
       VALUES ($1, $2, $3, $4, 'Pembayar DP', now(), 90, 2, $5, $6, $7, 'seated', 'staff', now(), $8)`,
      [
        reservationId,
        tenant.tenantId,
        tenant.outletId,
        profileId,
        zoneId ||
          (
            await owner.query(
              "SELECT id FROM floor_zones WHERE tenant_id = $1 LIMIT 1",
              [tenant.tenantId],
            )
          ).rows[0].id,
        DEPOSIT,
        JSON.stringify({
          version: "w3",
          depositRequirement: "required",
          depositAmountIdr: DEPOSIT,
          paymentWindowMinutes: 60,
          freeCancellationHours: 24,
          lateCancellationRefundBp: 0,
          noShowRefundBp: 0,
          minimumSpendIdr: 0,
          capturedAt: new Date().toISOString(),
        }),
        sourceSession,
      ],
    );
    await owner.query(
      `INSERT INTO payment_links
         (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 'w3-test')`,
      [
        linkId,
        tenant.tenantId,
        tenant.outletId,
        randomUUID().replaceAll("-", "").padEnd(64, "0"),
        `W3-${linkId.slice(0, 8)}`,
        DEPOSIT,
      ],
    );
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
        `w3-pay-${intentId}`,
      ],
    );
    await owner.query(
      `INSERT INTO payment_evidence
         (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
       VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
      [
        tenant.tenantId,
        tenant.outletId,
        intentId,
        `w3-evidence-${intentId}`,
        DEPOSIT,
      ],
    );
    await owner.query(
      `UPDATE reservations SET deposit_payment_id = $2, deposit_payment_link_id = $3 WHERE id = $1`,
      [reservationId, intentId, linkId],
    );
    await owner.query(
      `INSERT INTO reservation_deposit_allocations
         (tenant_id, outlet_id, reservation_id, table_session_id, payment_intent_id, amount_idr)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        tenant.tenantId,
        tenant.outletId,
        reservationId,
        sourceSession,
        intentId,
        DEPOSIT,
      ],
    );
    await owner.query(
      `INSERT INTO orders
         (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
          subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr,
          total_idr, deposit_applied_idr, status, business_date, placed_at,
          table_session_id, customer_profile_id)
       VALUES ($1, $2, $3, $4, 'pos', 'dine_in', 'pay_first', 60000, 0, 0, 0, 0,
               60000, 60000, 'sent', '2026-11-12', now(), $5, $6)`,
      [
        randomUUID(),
        tenant.tenantId,
        tenant.outletId,
        `W3S-${randomUUID().slice(0, 8)}`,
        sourceSession,
        profileId,
      ],
    );
    await seedReceipt(intentId, DEPOSIT);
    await owner.query(
      `INSERT INTO reservation_deposit_remainders
         (id, tenant_id, outlet_id, reservation_id, table_session_id, payment_intent_id,
          customer_profile_id, amount_idr, remaining_idr, kind)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, 'customer_credit')`,
      [
        randomUUID(),
        tenant.tenantId,
        tenant.outletId,
        reservationId,
        sourceSession,
        intentId,
        profileId,
        CREDIT,
      ],
    );
    await owner.query(
      `UPDATE table_sessions SET status = 'closed', closed_at = now(), closed_reason = 'paid_and_cleaned' WHERE id = $1`,
      [sourceSession],
    );
    const target = await openSession();
    await owner.query(
      `INSERT INTO orders
         (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
          subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr,
          total_idr, deposit_applied_idr, status, business_date, placed_at,
          table_session_id, customer_profile_id)
       VALUES ($1, $2, $3, $4, 'pos', 'dine_in', 'pay_first', $5, 0, 0, 0, 0,
               $5, 0, 'sent', '2026-11-12', now(), $6, $7)`,
      [
        randomUUID(),
        tenant.tenantId,
        tenant.outletId,
        `W3-${randomUUID().slice(0, 8)}`,
        BILL,
        target,
        profileId,
      ],
    );
    settlements.set(target, { total: BILL, paid: 0 });
    return { profileId, target };
  }

  async function spent(sessionId: string): Promise<number> {
    const { rows } = await owner.query<{ amount: string }>(
      "SELECT coalesce(sum(amount_idr), 0)::text AS amount FROM reservation_customer_credit_uses WHERE tenant_id = $1 AND table_session_id = $2",
      [tenant.tenantId, sessionId],
    );
    return Number(rows[0]!.amount);
  }

  const bodyOf = (s: { profileId: string; target: string }, amount = BILL) => ({
    customerProfileId: s.profileId,
    tableSessionId: s.target,
    amountIdr: amount,
  });

  it("shared tablet without a PIN token is 401 and no credit is spent", async () => {
    const who = await fresh();
    const s = await seedCredit();
    const deviceId = await newDevice(true);
    const response = await post(who, applyPath(), deviceId, null, bodyOf(s));
    expectError(response, 401, GUARD_CODES);
    expect(await spent(s.target)).toBe(0);
  });

  it("with a cashier token the credit is applied once, with the cashier as actor", async () => {
    const who = await fresh();
    const s = await seedCredit();
    const deviceId = await newDevice(true);
    const token = await cashierToken(who, cashierB, deviceId);
    const rowsOf = async () =>
      (
        await owner.query<{ t: string }>(
          "SELECT a.id::text || '|' || coalesce(a.event->>'actorId', '') AS t FROM audit_logs a WHERE tenant_id = $1",
          [tenant.tenantId],
        )
      ).rows.map((r) => r.t);
    const before = new Set(await rowsOf());
    const response = await post(who, applyPath(), deviceId, token, bodyOf(s));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(await spent(s.target)).toBe(BILL);
    const evidence = (await rowsOf()).filter((r) => !before.has(r)).join("\n");
    expect(evidence).toContain(cashierB.userId);
    expect(evidence).not.toContain(who.userId);
  });

  it("the same Idempotency-Key replayed never debits credit twice", async () => {
    const who = await fresh();
    const s = await seedCredit();
    const deviceId = await newDevice(true);
    const token = await cashierToken(who, cashierB, deviceId);
    const key = `w3-credit-${randomUUID()}`;
    const first = await post(who, applyPath(), deviceId, token, bodyOf(s), key);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const second = await post(
      who,
      applyPath(),
      deviceId,
      token,
      bodyOf(s),
      key,
    );
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(await spent(s.target)).toBe(BILL);
    const { rows } = await owner.query<{ remaining: string }>(
      "SELECT coalesce(sum(remaining_idr), 0)::text AS remaining FROM reservation_deposit_remainders WHERE tenant_id = $1 AND customer_profile_id = $2",
      [tenant.tenantId, s.profileId],
    );
    expect(Number(rows[0]!.remaining)).toBe(CREDIT - BILL);
  });

  it("acting staff without reservation.manage is 403 and no credit is spent", async () => {
    const who = await fresh();
    const s = await seedCredit();
    const deviceId = await newDevice(true);
    const token = await cashierToken(who, limited, deviceId);
    const response = await post(who, applyPath(), deviceId, token, bodyOf(s));
    expectError(response, 403, ["PERMISSION_DENIED"]);
    expect(await spent(s.target)).toBe(0);
  });

  it("a private device keeps working as the session owner", async () => {
    const who = await fresh();
    const s = await seedCredit();
    const deviceId = await newDevice(false);
    const response = await post(who, applyPath(), deviceId, null, bodyOf(s));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(await spent(s.target)).toBe(BILL);
  });

  it("another tenant's staff cannot spend this credit", async () => {
    const s = await seedCredit();
    const other = await staffWithRole(app, { template: "owner" });
    const response = await other.client
      .post(applyPath())
      .set(originHeader)
      .set("Idempotency-Key", `w3-${randomUUID()}`)
      .send(bodyOf(s));
    expect(
      response.status,
      JSON.stringify(response.body),
    ).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(await spent(s.target)).toBe(0);
  });
});
