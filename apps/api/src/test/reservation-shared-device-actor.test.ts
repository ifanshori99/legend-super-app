// Brief 1177 area A, beads legend-5f6is and legend-jvaqa: reservation staff
// routes on a shared tablet record the PIN cashier, never the tablet login.
//
// Spec (docs/briefs/sub-1177-tablet-reservasi-aktor.md, CTO decision 18 Nov):
//  - legend-jvaqa: POST .../reservations/:id/seat and PATCH .../:id/tables
//    open on a shared (flagged) tablet. Without a cashier PIN token they are
//    refused (uniform refusal, nothing written); with a live token they work.
//  - legend-5f6is: with a token, the cashier is the recorded actor and the
//    cashier's own permissions decide: a cashier without `reservation.manage`
//    (or `reservation.view` for list/get) is refused 403 PERMISSION_DENIED even
//    when the tablet login owner holds the permission. No access escalation.
//  - A private (unflagged) device behaves as before: the session owner acts.
//  - A cashier token of outlet A used on outlet B is 403 ACTING_STAFF_OUTLET_MISMATCH.
//
// Assumptions (spec silent):
//  - Without a PIN the answer is 401 ACTING_STAFF_REQUIRED, as in the 1094
//    reference tests (the brief's "403" is read as "uniform refusal").
//  - Actor evidence = audit_logs `event->>'actorId'` rows appended by the call
//    plus actor-ish columns of the reservation, its table links and the opened
//    table session.
//  - List/get and GET .../deposit-remainder on a shared tablet carry the
//    cashier token like the other reservation actions. The deposit-remainder
//    path has no typed endpoint; it is GET .../reservations/:id/deposit-remainder.
//    The booking here has no DP, so the permitted cashier only has to get
//    past the guards (not 401/403, not a server error).
//  - A cashier token issued on a private device (PIN session) is accepted for
//    list/get there; the token is bound to the device it was issued on.
//  - The tablet login owner and the good cashier hold the same permissions, so
//    only the cashier's own permission set can refuse the limited cashier.

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outletIdSchema, tenantIdSchema } from "@starter/shared/core";
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
const roles = { till: randomUUID(), limited: randomUUID() };
const sharedDevices = new Set<string>();
const privateDevices = new Set<string>();

type Client = ReturnType<typeof agent>;
type Member = { client: Client; userId: string };
let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
let sessionOwner: Member;
let cashier: Member;
let limited: Member;
let outletB = "";
let zoneId = "";
let dayCounter = 0;
let tableCounter = 0;

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
    `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at, shared_mode)
     VALUES ($1, $2, $3, 'pos', $4, now() - interval '1 minute', $5)`,
    [
      id,
      tenant.tenantId,
      tenant.outletId,
      `Kasir Rsv ${id.slice(0, 6)}`,
      shared,
    ],
  );
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

type Method = "get" | "post" | "patch";
function call(
  who: Member,
  method: Method,
  path: string,
  deviceId: string | null,
  acting: string | null,
  body: Record<string, unknown> = {},
) {
  let request = who.client[method](path).set(headers).set(originHeader);
  if (deviceId) request = request.set(DEVICE_TOKEN_HEADER, tokenOf(deviceId));
  if (acting) request = request.set(ACTING_HEADER, acting);
  if (method === "get") return request;
  return request.set("Idempotency-Key", `1177-${randomUUID()}`).send(body);
}

const codeOf = (r: { body: unknown }) =>
  (r.body as { error?: { code?: string } }).error?.code ?? "";

function expectError(
  response: { status: number; body: unknown },
  status: number,
  code: string,
) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  expect(codeOf(response), JSON.stringify(response.body)).toBe(code);
}

const base = (outletId = tenant.outletId) => `/api/outlets/${outletId}`;
const rsvPath = (id: string, action: string, outletId = tenant.outletId) =>
  `${base(outletId)}/reservations/${id}/${action}`;

async function ensureZone() {
  if (zoneId) return;
  const z = await sessionOwner.client
    .post("/api/floor/zones")
    .set(headers)
    .set(originHeader)
    .send({
      name: `Zona Aktor ${randomUUID().slice(0, 6)}`,
      paymentMode: "pay_first",
      serviceChargeBp: 500,
      minimumSpendIdr: 0,
      hours: [
        { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "08:00", end: "22:00" },
      ],
    });
  expect(z.status, JSON.stringify(z.body)).toBe(201);
  zoneId = z.body.data.id as string;
}

/** A new free table in the zone. */
async function newTable(): Promise<string> {
  await ensureZone();
  tableCounter += 1;
  const t = await sessionOwner.client
    .post("/api/floor/tables")
    .set(headers)
    .set(originHeader)
    .send({
      zoneId,
      code: `A-${randomUUID().slice(0, 6)}`.toUpperCase(),
      capacity: 4,
      type: "regular",
      layout: {
        x: 10 + tableCounter * 80,
        y: 10,
        width: 60,
        height: 60,
        rotation: 0,
        shape: "rect",
      },
    });
  expect(t.status, JSON.stringify(t.body)).toBe(201);
  return t.body.data.id as string;
}

/** A fresh future booking (distinct day), no DP, and one free table. */
async function book(): Promise<{
  id: string;
  tableId: string;
  initial: string[];
}> {
  await ensureZone();
  const tableId = await newTable();
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
      guestName: "Tamu Aktor",
      contactPhone: "081234567890",
    }),
    `1177-book-${randomUUID()}`,
  );
  // Booking may auto-assign a table: tests compare against this baseline.
  const id = created.reservation.id as string;
  return { id, tableId, initial: await linkedTables(id) };
}

async function statusOf(id: string): Promise<string> {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM reservations WHERE id = $1",
    [id],
  );
  return rows[0]!.status;
}

async function linkedTables(id: string): Promise<string[]> {
  const { rows } = await owner.query<{ table_id: string }>(
    "SELECT table_id FROM reservation_tables WHERE reservation_id = $1",
    [id],
  );
  return rows.map((r) => r.table_id);
}

async function sessionCount(tableId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM table_sessions WHERE table_id = $1",
    [tableId],
  );
  return Number(rows[0]!.n);
}

const ACTORISH =
  /(cancelled_by|actor|updated_by|changed_by|marked_by|created_by|opened_by|seated_by|assigned_by)/i;

/** Runs a call and returns every actor-ish value it wrote (audit + row columns). */
async function actorEvidence(
  reservationId: string,
  tableId: string,
  run: () => Promise<{ status: number; body: unknown }>,
) {
  const auditRows = async () =>
    (
      await owner.query<{ t: string }>(
        "SELECT a.id::text || '|' || coalesce(a.event->>'actorId', '') AS t FROM audit_logs a WHERE tenant_id = $1",
        [tenant.tenantId],
      )
    ).rows.map((r) => r.t);
  const outboxRows = async () =>
    (
      await owner.query<{ t: string }>(
        "SELECT o.id::text || '|' || coalesce(o.event->'actor'->>'id', '') AS t FROM domain_event_outbox o WHERE tenant_id = $1",
        [tenant.tenantId],
      )
    ).rows.map((r) => r.t);
  const before = new Set([...(await auditRows()), ...(await outboxRows())]);
  const response = await run();
  expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
  const fresh = [...(await auditRows()), ...(await outboxRows())].filter(
    (r) => !before.has(r),
  );
  const columns: string[] = [];
  for (const [sql, param] of [
    [
      "SELECT to_jsonb(t) AS row FROM reservations t WHERE id = $1",
      reservationId,
    ],
    [
      "SELECT to_jsonb(t) AS row FROM reservation_tables t WHERE reservation_id = $1",
      reservationId,
    ],
    [
      "SELECT to_jsonb(t) AS row FROM table_sessions t WHERE table_id = $1",
      tableId,
    ],
  ] as const) {
    const { rows } = await owner.query<{ row: Record<string, unknown> }>(sql, [
      param,
    ]);
    for (const r of rows)
      for (const [k, v] of Object.entries(r.row))
        if (ACTORISH.test(k) && v !== null) columns.push(String(v));
  }
  return [...fresh, ...columns].join("\n");
}

beforeAll(async () => {
  app = createApp();
  tenant = await createIsolatedTenant(`rsva-${randomUUID().slice(0, 6)}`);
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
    [roles.till, "Aktor Kasir Aktif", perms],
    [roles.limited, "Aktor Terbatas", ["order.view"]],
  ] as const)
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant"]')`,
      [id, tenant.tenantId, name, JSON.stringify(permissions)],
    );
  sessionOwner = await member("Sesi Aktor", roles.till);
  cashier = await member("Kasir Aktor", roles.till);
  limited = await member("Staf Aktor Terbatas", roles.limited);
  await owner.query(
    "DELETE FROM reservation_policies WHERE tenant_id = $1 AND outlet_id = $2",
    [tenant.tenantId, tenant.outletId],
  );
  await owner.query(
    `INSERT INTO reservation_policies
       (tenant_id, outlet_id, version, deposit_requirement, deposit_amount_idr, payment_window_minutes,
        free_cancellation_hours, late_cancellation_refund_bp, no_show_refund_bp, minimum_spend_idr,
        default_duration_minutes, slot_interval_minutes, is_active)
     VALUES ($1, $2, '1177-none', 'none', 0, 60, 24, 5000, 0, 0, 90, 30, true)`,
    [tenant.tenantId, tenant.outletId],
  );
  outletB = randomUUID();
  const { rows } = await owner.query<{
    brand_id: string;
    legal_entity_id: string;
  }>("SELECT brand_id, legal_entity_id FROM outlets WHERE id = $1", [
    tenant.outletId,
  ]);
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet B Aktor', 'Jl. Uji 5', 'Asia/Jakarta', $6, 'active')`,
    [
      outletB,
      tenant.tenantId,
      rows[0]!.brand_id,
      rows[0]!.legal_entity_id,
      `RSVA-${randomUUID().slice(0, 6)}`.toUpperCase(),
      JSON.stringify(fixtures.outlets[0].openingHours),
    ],
  );
});

afterAll(async () => {
  setDeviceOutletResolver(null);
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

type Action = {
  name: string;
  method: "post" | "patch";
  action: "seat" | "tables";
  /** Reservation status after a successful call. */
  after: string;
  /** Table links after a successful call. */
  links: boolean;
};
const actions: Action[] = [
  {
    name: "seat",
    method: "post",
    action: "seat",
    after: "seated",
    links: true,
  },
  {
    name: "tables",
    method: "patch",
    action: "tables",
    after: "confirmed",
    links: true,
  },
];

describe("legend-jvaqa: seat and PATCH tables are open on a shared tablet with the cashier PIN", () => {
  for (const a of actions) {
    describe(`reservation ${a.name}`, () => {
      it("without a cashier PIN token it is refused (401/403, not the closed-screen answer) and nothing is written", async () => {
        const who = await fresh();
        const { id, tableId, initial } = await book();
        const deviceId = await newDevice(true);
        const before = await statusOf(id);
        const response = await call(
          who,
          a.method,
          rsvPath(id, a.action),
          deviceId,
          null,
          { tableIds: [tableId] },
        );
        expectError(response, 401, "ACTING_STAFF_REQUIRED");
        expect(await statusOf(id)).toBe(before);
        expect(await linkedTables(id)).toEqual(initial);
        expect(await sessionCount(tableId)).toBe(0);
        // A cookie-only replay without the device header is refused as well.
        const stripped = await call(
          who,
          a.method,
          rsvPath(id, a.action),
          null,
          null,
          { tableIds: [tableId] },
        );
        expectError(stripped, 401, "ACTING_STAFF_REQUIRED");
        expect(await statusOf(id)).toBe(before);
        expect(await linkedTables(id)).toEqual(initial);
      });

      it("a garbage token is ACTING_STAFF_INVALID, never the tablet login", async () => {
        const who = await fresh();
        const { id, tableId, initial } = await book();
        const deviceId = await newDevice(true);
        const response = await call(
          who,
          a.method,
          rsvPath(id, a.action),
          deviceId,
          "pas_garbage-token",
          { tableIds: [tableId] },
        );
        expectError(response, 401, "ACTING_STAFF_INVALID");
        expect(await linkedTables(id)).toEqual(initial);
      });

      it("with a live cashier token it succeeds and the table link / session is written", async () => {
        const who = await fresh();
        const { id, tableId } = await book();
        const deviceId = await newDevice(true);
        const token = await cashierToken(who, cashier, deviceId);
        const response = await call(
          who,
          a.method,
          rsvPath(id, a.action),
          deviceId,
          token,
          { tableIds: [tableId] },
        );
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        expect(await statusOf(id)).toBe(a.after);
        expect(await linkedTables(id)).toContain(tableId);
        if (a.action === "seat") expect(await sessionCount(tableId)).toBe(1);
      });

      it("a cashier token of outlet A used on outlet B is 403 ACTING_STAFF_OUTLET_MISMATCH", async () => {
        const who = await fresh();
        const { id, tableId, initial } = await book();
        const deviceId = await newDevice(true);
        const token = await cashierToken(who, cashier, deviceId);
        const response = await call(
          who,
          a.method,
          rsvPath(id, a.action, outletB),
          deviceId,
          token,
          { tableIds: [tableId] },
        );
        expectError(response, 403, "ACTING_STAFF_OUTLET_MISMATCH");
        expect(await linkedTables(id)).toEqual(initial);
      });
    });
  }
});

describe("legend-5f6is: the cashier, not the session owner, is the actor and the permission holder", () => {
  for (const a of actions) {
    describe(`reservation ${a.name}`, () => {
      // Actor evidence is asserted for seat only: PATCH tables leaves no
      // actor column, audit or outbox row on a private device (calibration
      // came back empty), so the cashier as actor there is proven through
      // the permission test below (the cashier's own set decides).
      if (a.action === "seat") {
        it("calibration: on a private device the session owner is the recorded actor", async () => {
          const { id, tableId } = await book();
          const deviceId = await newDevice(false);
          const evidence = await actorEvidence(id, tableId, () =>
            call(
              sessionOwner,
              a.method,
              rsvPath(id, a.action),
              deviceId,
              null,
              {
                tableIds: [tableId],
              },
            ),
          );
          expect(evidence).toContain(sessionOwner.userId);
          expect(evidence).not.toContain(cashier.userId);
        });

        it("on a shared tablet the cashier is the recorded actor, not the tablet login", async () => {
          const who = await fresh();
          const { id, tableId } = await book();
          const deviceId = await newDevice(true);
          const token = await cashierToken(who, cashier, deviceId);
          const evidence = await actorEvidence(id, tableId, () =>
            call(who, a.method, rsvPath(id, a.action), deviceId, token, {
              tableIds: [tableId],
            }),
          );
          expect(evidence).toContain(cashier.userId);
          expect(evidence).not.toContain(who.userId);
        });
      }

      it("a cashier without reservation.manage is 403 PERMISSION_DENIED even though the tablet login holds it", async () => {
        const who = await fresh();
        const { id, tableId, initial } = await book();
        const deviceId = await newDevice(true);
        const token = await cashierToken(who, limited, deviceId);
        const response = await call(
          who,
          a.method,
          rsvPath(id, a.action),
          deviceId,
          token,
          { tableIds: [tableId] },
        );
        expectError(response, 403, "PERMISSION_DENIED");
        expect(await statusOf(id)).toBe("confirmed");
        expect(await linkedTables(id)).toEqual(initial);
        expect(await sessionCount(tableId)).toBe(0);
      });

      it("a private device whose login lacks reservation.manage stays refused (unchanged)", async () => {
        const { id, tableId, initial } = await book();
        const deviceId = await newDevice(false);
        const response = await call(
          limited,
          a.method,
          rsvPath(id, a.action),
          deviceId,
          null,
          { tableIds: [tableId] },
        );
        expectError(response, 403, "PERMISSION_DENIED");
        expect(await linkedTables(id)).toEqual(initial);
      });
    });
  }

  describe("list and get", () => {
    it("a cashier with reservation.view reads the list and one booking on a shared tablet", async () => {
      const who = await fresh();
      const { id } = await book();
      const deviceId = await newDevice(true);
      const token = await cashierToken(who, cashier, deviceId);
      const list = await call(
        who,
        "get",
        `${base()}/reservations`,
        deviceId,
        token,
      );
      expect(list.status, JSON.stringify(list.body)).toBe(200);
      const one = await call(
        who,
        "get",
        `${base()}/reservations/${id}`,
        deviceId,
        token,
      );
      expect(one.status, JSON.stringify(one.body)).toBe(200);
      expect(one.body.data.reservation?.id ?? one.body.data.id).toBe(id);
    });

    it("list and get on a shared tablet without a PIN token are 401 ACTING_STAFF_REQUIRED", async () => {
      const who = await fresh();
      const { id } = await book();
      const deviceId = await newDevice(true);
      expectError(
        await call(who, "get", `${base()}/reservations`, deviceId, null),
        401,
        "ACTING_STAFF_REQUIRED",
      );
      expectError(
        await call(who, "get", `${base()}/reservations/${id}`, deviceId, null),
        401,
        "ACTING_STAFF_REQUIRED",
      );
    });

    it("a cashier token on a private device is accepted for list and get", async () => {
      const who = await fresh();
      const { id } = await book();
      const deviceId = await newDevice(false);
      const token = await cashierToken(who, cashier, deviceId);
      const list = await call(
        who,
        "get",
        `${base()}/reservations`,
        deviceId,
        token,
      );
      expect(list.status, JSON.stringify(list.body)).toBe(200);
      const one = await call(
        who,
        "get",
        `${base()}/reservations/${id}`,
        deviceId,
        token,
      );
      expect(one.status, JSON.stringify(one.body)).toBe(200);
    });

    it("a cashier without reservation.view is 403 PERMISSION_DENIED even though the tablet login holds it", async () => {
      const who = await fresh();
      const { id } = await book();
      const deviceId = await newDevice(true);
      const token = await cashierToken(who, limited, deviceId);
      expectError(
        await call(who, "get", `${base()}/reservations`, deviceId, token),
        403,
        "PERMISSION_DENIED",
      );
      expectError(
        await call(who, "get", `${base()}/reservations/${id}`, deviceId, token),
        403,
        "PERMISSION_DENIED",
      );
    });
  });
});

describe("legend-5f6is: GET deposit-remainder on a shared tablet", () => {
  const remainder = (id: string) =>
    `${base()}/reservations/${id}/deposit-remainder`;

  it("without a PIN token it is 401 ACTING_STAFF_REQUIRED", async () => {
    const who = await fresh();
    const { id } = await book();
    const deviceId = await newDevice(true);
    expectError(
      await call(who, "get", remainder(id), deviceId, null),
      401,
      "ACTING_STAFF_REQUIRED",
    );
  });

  it("a cashier without reservation.view is 403 PERMISSION_DENIED even though the tablet login holds it", async () => {
    const who = await fresh();
    const { id } = await book();
    const deviceId = await newDevice(true);
    const token = await cashierToken(who, limited, deviceId);
    expectError(
      await call(who, "get", remainder(id), deviceId, token),
      403,
      "PERMISSION_DENIED",
    );
  });

  it("a cashier with reservation.view gets past the guards (not 401/403, no server error)", async () => {
    const who = await fresh();
    const { id } = await book();
    const deviceId = await newDevice(true);
    const token = await cashierToken(who, cashier, deviceId);
    const response = await call(who, "get", remainder(id), deviceId, token);
    expect([401, 403], JSON.stringify(response.body)).not.toContain(
      response.status,
    );
    expect(response.status, JSON.stringify(response.body)).toBeLessThan(500);
  });
});
