// Brief 1120 (bead legend-cq0u7): order recovery routes must check the OUTLET of
// the target against the outlet of a cashier PIN token (X-Acting-Staff).
//
// Routes (order-recovery-charge.routes.ts and order-recovery.routes.ts):
//  - POST /api/order-issue-charges/:id/waive | expire | refund | manual-refund
//    | collect-at-pos
//  - POST /api/order-items/:id/issues (report item)
//  - POST /api/order-issues/:id/resolve
//
// Contract (docs/briefs/1120-shared-context.md):
//  - A cashier staffed at outlets A and B, signed in on outlet A's shared
//    tablet (token outlet = A), hitting a target of outlet B: 403
//    ACTING_STAFF_OUTLET_MISMATCH. The outlet of the target is looked up on the
//    server, never taken from the body.
//  - A target of outlet A is NOT refused with that code (other rules decide).
//  - A personal login (no token) is unchanged: never answered with the code,
//    even for a target of the other outlet the user is staffed at.
//  - A target that cannot be found, with a token: refused 403 with the same
//    code (fail closed: not 404, not 200).
//
// Assumptions (spec silent):
//  - The check runs before the permission guard and the service, so refused
//    cases need no valid body state; bodies are still valid per the shared
//    validators and existing tests so a 422 never hides the answer.
//  - A target "of outlet B" is made by moving the outlet_id of the order, its
//    items, its issue and its charge to outlet B in SQL, so whichever of those
//    the server consults says B.
//  - The control (target of A) asserts only "not OUTLET_MISMATCH": on the
//    shared tablet the money rules or permissions may still refuse it.
//  - refund and manual-refund are money-out screens that are already closed on
//    a shared tablet (403 SHARED_DEVICE_SCREEN_CLOSED, answered before the
//    outlet check). Refusing is what matters (403, nothing changes), so for
//    those two routes either 403 code is accepted. The other routes must
//    answer ACTING_STAFF_OUTLET_MISMATCH exactly.
//  - Resolve bodies carry a resolution; on a shared tablet that may be closed
//    by another rule, so only the outlet answer is asserted for target B.
//  - waive and expire are about to be closed on a shared tablet as well (CTO
//    decision, another agent edits the allowlist), so on the SHARED-device
//    variants they accept MISMATCH or SCREEN_CLOSED like refund/manual-refund.
//
// Unflagged device block (architect P2/P3): on a registered device that is NOT
// shared_mode no earlier rule answers SCREEN_CLOSED, so the outlet check is
// proven on its own for ALL 7 routes: a cashier token of outlet A on a target
// of outlet B (or an unknown id) must answer exactly 403
// ACTING_STAFF_OUTLET_MISMATCH, state unchanged. The control there (target of
// outlet A) must succeed (200, 201 for report item) for waive, expire, report
// item and collect-at-pos. Needs for those successes, set up here from the
// spec: the cashier also holds pos.payment.accept at outlet A (own role) and
// has an open shift on the unflagged device (seeded like the till tests); the
// report-item control uses a fresh item with no open issue. resolve (swap needs
// an approval), refund and manual-refund (the charge is still open, nothing
// paid) may stay "not MISMATCH": their business rules legitimately refuse.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { tenantIdSchema, ulidToUuid, uuidToUlid } from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { ACTING_STAFF_ERROR_CODES } from "@starter/shared/pos/acting-staff";
import { signDeviceToken } from "../lib/device-token.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import { createWorld, type World } from "./order-recovery-helpers.ts";
import { owner, type Staff } from "./floor-test-helpers.ts";

const ACTING_HEADER = "X-Acting-Staff";
const PIN = "582914";
const REASON = "Tamu komplain, dicatat kasir";
const DIFFERENCE = 6_000;
const SERVICE = 300;
const PBJT = 630;
const AMOUNT = DIFFERENCE + SERVICE + PBJT;
const MISMATCH = ACTING_STAFF_ERROR_CODES.OUTLET_MISMATCH;

let w: World;
/** Tablet login of the current test (fresh per test, a flagged call marks it). */
let session: Staff;
/** Cashier staffed at BOTH outlets: the token is for A, the user serves A and B. */
let cashierAB: Staff;
let sharedDevice: string;
/** Registered POS device WITHOUT shared_mode (outlet A). */
let plainDevice: string;

const outletA = () => w.tenant.outletId;
const outletB = () => w.ids.otherOutlet;

type Response = { status: number; body: unknown };

async function userAt(outletIds: string[], label: string): Promise<Staff> {
  const client = agent(w.app);
  const email = await signUp(client, label);
  const me = await client.get("/api/auth/get-session");
  const userId = me.body.user.id as string;
  for (const outletId of outletIds)
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 minute', $2)`,
      [w.tenant.tenantId, userId, w.ids.outletRole, outletId],
    );
  return { client, userId, email };
}

beforeAll(async () => {
  w = await createWorld();
  cashierAB = await userAt([outletA(), outletB()], "Kasir Pulih A+B");
  sharedDevice = randomUUID();
  plainDevice = randomUUID();
  setDeviceOutletResolver(async ({ tenantId, deviceId }) =>
    tenantId === w.tenant.tenantId &&
    (deviceId === sharedDevice || deviceId === plainDevice)
      ? outletA()
      : null,
  );
  await owner.query(
    `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at, shared_mode)
     VALUES ($1, $2, $3, 'pos', 'Kasir Biasa 1120', now() - interval '1 minute', false)`,
    [plainDevice, w.tenant.tenantId, outletA()],
  );
  // Till permission at outlet A, so collect-at-pos can succeed on target A.
  const tillRole = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Kasir Kas Uji 1120', false, NULL, $3, false, '["tenant","outlet"]')`,
    [tillRole, w.tenant.tenantId, JSON.stringify(["pos.payment.accept"])],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 minute', $2)`,
    [w.tenant.tenantId, cashierAB.userId, tillRole, outletA()],
  );
  await owner.query(
    `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at, shared_mode)
     VALUES ($1, $2, $3, 'pos', 'Tablet 1120', now() - interval '1 minute', true)`,
    [sharedDevice, w.tenant.tenantId, outletA()],
  );
}, 120_000);

beforeEach(async () => {
  session = await userAt([outletA()], "Login Tablet Pulih");
});

afterAll(async () => {
  setDeviceOutletResolver(null);
  await w.teardown();
});

const tokenOf = (deviceId: string) =>
  signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: w.tenant.tenantId,
    brandId: null,
    deviceId,
  });

/** The two-outlet cashier signs in with a PIN on outlet A's shared tablet. */
async function cashierToken(deviceId: string = sharedDevice): Promise<string> {
  await setStaffPin(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(w.tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    cashierAB.userId,
    { outletId: outletA(), userId: cashierAB.userId },
    { pin: PIN },
  );
  const response = await session.client
    .post("/api/staff-pins/pos-session")
    .set(w.headers)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, tokenOf(deviceId))
    .send({ userId: cashierAB.userId, pin: PIN });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data.token as string;
}

// ---- fixtures ----------------------------------------------------------------

type Target = {
  orderUlid: string;
  itemUlid: string;
  issueId: string;
  chargeId: string;
};

/** A paid order with a reported item and an open swap charge, all at `outletId`. */
async function target(outletId: string): Promise<Target> {
  const paid = await w.paidOrder();
  const reported = await w.report(paid.roti.id);
  expect(reported.status, JSON.stringify(reported.body)).toBe(201);
  const issueId = reported.body.data.id as string;
  const chargeId = randomUUID();
  await owner.query(
    `INSERT INTO order_issue_charges
       (id, tenant_id, outlet_id, order_issue_id, order_id, table_session_id, route, status,
        difference_idr, gross_sales_idr, service_charge_idr, pbjt_idr, amount_idr)
     VALUES ($1, $2, $3, $4, $5, $6, 'qr_link', 'open', $7, $7, $8, $9, $10)`,
    [
      chargeId,
      w.tenant.tenantId,
      outletId,
      issueId,
      ulidToUuid(paid.order.id),
      paid.guest.sessionId,
      DIFFERENCE,
      SERVICE,
      PBJT,
      AMOUNT,
    ],
  );
  if (outletId !== outletA()) {
    await owner.query(
      "UPDATE order_issues SET outlet_id = $3 WHERE tenant_id = $1 AND id::text = $2",
      [w.tenant.tenantId, issueId, outletId],
    );
    await owner.query(
      "UPDATE order_items SET outlet_id = $3 WHERE tenant_id = $1 AND order_id = $2",
      [w.tenant.tenantId, ulidToUuid(paid.order.id), outletId],
    );
    await owner.query(
      "UPDATE orders SET outlet_id = $3 WHERE tenant_id = $1 AND id = $2",
      [w.tenant.tenantId, ulidToUuid(paid.order.id), outletId],
    );
  }
  return {
    orderUlid: paid.order.id,
    itemUlid: paid.roti.id,
    issueId,
    chargeId,
  };
}

let shiftOpen = false;
/** The cashier's one open shift on the unflagged device (till tests pattern). */
async function openShiftOnPlainDevice(orderUlid: string) {
  if (shiftOpen) return;
  shiftOpen = true;
  const { rows } = await owner.query<{ d: string }>(
    "SELECT business_date::text AS d FROM orders WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, ulidToUuid(orderUlid)],
  );
  await owner.query(
    `INSERT INTO pos_shifts
       (id, tenant_id, outlet_id, device_id, cashier_id, business_date, status,
        opened_at, opening_float_idr, open_key, open_fingerprint)
     VALUES ($1, $2, $3, $4, $5, $6, 'open', now() - interval '1 hour', 100000, $7, $8)`,
    [
      randomUUID(),
      w.tenant.tenantId,
      outletA(),
      plainDevice,
      cashierAB.userId,
      rows[0]!.d,
      randomUUID(),
      "b".repeat(64),
    ],
  );
}

const unknownTarget = (): Target => ({
  orderUlid: uuidToUlid(randomUUID()),
  itemUlid: uuidToUlid(randomUUID()),
  issueId: randomUUID(), // resolve route params need a UUID, not a ULID
  chargeId: randomUUID(),
});

type Route = {
  name: string;
  /** Route closed on a shared tablet: SCREEN_CLOSED may answer first there. */
  closedOnTablet?: boolean;
  /** Control on the unflagged device, target of outlet A (see header). */
  control: "success" | "not-mismatch";
  /** Status a successful control answers. */
  okStatus?: number;
  path: (t: Target) => string;
  body: () => Record<string, unknown>;
};

const ROUTES: Route[] = [
  {
    name: "waive",
    closedOnTablet: true,
    control: "success",
    path: (t) => `/api/order-issue-charges/${t.chargeId}/waive`,
    body: () => ({ reason: REASON }),
  },
  {
    name: "expire",
    closedOnTablet: true,
    control: "success",
    path: (t) => `/api/order-issue-charges/${t.chargeId}/expire`,
    body: () => ({ reason: REASON }),
  },
  {
    name: "refund",
    closedOnTablet: true,
    control: "not-mismatch",
    path: (t) => `/api/order-issue-charges/${t.chargeId}/refund`,
    body: () => ({ amountIdr: AMOUNT, reason: REASON }),
  },
  {
    name: "manual-refund",
    closedOnTablet: true,
    control: "not-mismatch",
    path: (t) => `/api/order-issue-charges/${t.chargeId}/manual-refund`,
    body: () => ({ amountIdr: AMOUNT, reason: REASON, method: "cash" }),
  },
  {
    name: "collect-at-pos",
    control: "success",
    path: (t) => `/api/order-issue-charges/${t.chargeId}/collect-at-pos`,
    body: () => ({
      idempotencyKey: randomUUID(),
      method: "cash",
      receivedIdr: AMOUNT,
    }),
  },
  {
    name: "report item",
    control: "success",
    okStatus: 201,
    path: (t) => `/api/order-items/${t.itemUlid}/issues`,
    body: () => ({
      type: "unfulfillable",
      reason: "out_of_stock",
      reasonNote: "Roti habis di dapur",
    }),
  },
  {
    name: "resolve",
    control: "not-mismatch",
    path: (t) => `/api/order-issues/${t.issueId}/resolve`,
    body: () => ({ resolution: "swap", replacementItemId: w.ids.teh }),
  },
];

/** `token` set = tablet call with the cashier token; unset = personal login. */
function call(
  route: Route,
  t: Target,
  mode: { token: string; deviceId?: string } | "personal",
) {
  if (mode === "personal")
    return cashierAB.client
      .post(route.path(t))
      .set(w.headers)
      .set(originHeader)
      .send(route.body()) as unknown as Promise<Response>;
  return session.client
    .post(route.path(t))
    .set(w.headers)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, tokenOf(mode.deviceId ?? sharedDevice))
    .set(ACTING_HEADER, mode.token)
    .send(route.body()) as unknown as Promise<Response>;
}

/** The refusal a cashier-token call must get for a foreign or unknown target. */
function expectOutletRefusal(route: Route, response: Response, strict = false) {
  expect(response.status, JSON.stringify(response.body)).toBe(403);
  const accepted: string[] =
    route.closedOnTablet && !strict
      ? [MISMATCH, ACTING_STAFF_ERROR_CODES.SCREEN_CLOSED]
      : [MISMATCH];
  expect(accepted, JSON.stringify(response.body)).toContain(
    errorCode(response),
  );
}

const errorCode = (response: Response) =>
  (response.body as { error?: { code?: string } }).error?.code;

async function chargeStatus(chargeId: string): Promise<string | null> {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM order_issue_charges WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, chargeId],
  );
  return rows[0]?.status ?? null;
}

async function issueStatus(issueId: string): Promise<string | null> {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM order_issues WHERE tenant_id = $1 AND id::text = $2",
    [w.tenant.tenantId, issueId],
  );
  return rows[0]?.status ?? null;
}

async function issueCountOfItem(itemUlid: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*) AS n FROM order_issues WHERE tenant_id = $1 AND order_item_id = $2",
    [w.tenant.tenantId, ulidToUuid(itemUlid)],
  );
  return Number(rows[0]!.n);
}

// ---- tests -------------------------------------------------------------------

describe("order recovery routes check the outlet of a cashier token (brief 1120)", () => {
  for (const route of ROUTES) {
    describe(route.name, () => {
      it("token of outlet A, target of outlet B: 403 ACTING_STAFF_OUTLET_MISMATCH, nothing changes", async () => {
        const t = await target(outletB());
        const token = await cashierToken();
        const issuesBefore = await issueCountOfItem(t.itemUlid);
        // Proves the count query sees the reported item (1), so "unchanged" means something.
        expect(issuesBefore).toBe(1);
        const response = await call(route, t, { token });
        expectOutletRefusal(route, response);
        expect(await chargeStatus(t.chargeId)).toBe("open");
        expect(await issueCountOfItem(t.itemUlid)).toBe(issuesBefore);
        expect(await issueStatus(t.issueId)).toBe("open");
      });

      it("token of outlet A, target of outlet A: not refused with OUTLET_MISMATCH", async () => {
        const t = await target(outletA());
        const token = await cashierToken();
        const response = await call(route, t, { token });
        expect(errorCode(response), JSON.stringify(response.body)).not.toBe(
          MISMATCH,
        );
      });

      it("personal login (no token), target of outlet B: never answered with OUTLET_MISMATCH", async () => {
        const t = await target(outletB());
        const response = await call(route, t, "personal");
        expect(errorCode(response), JSON.stringify(response.body)).not.toBe(
          MISMATCH,
        );
      });

      it("personal login (no token), target of outlet A: unchanged, not OUTLET_MISMATCH", async () => {
        const t = await target(outletA());
        const response = await call(route, t, "personal");
        expect(errorCode(response), JSON.stringify(response.body)).not.toBe(
          MISMATCH,
        );
      });

      it("token with an unknown id: refused 403 ACTING_STAFF_OUTLET_MISMATCH, not 404 or 200", async () => {
        const token = await cashierToken();
        const response = await call(route, unknownTarget(), { token });
        expectOutletRefusal(route, response);
      });
    });
  }
});

describe("order recovery outlet check on an UNFLAGGED device (brief 1120, strict)", () => {
  /** Tablet call on the registered device that is not shared_mode. */
  const plainCall = (route: Route, t: Target, token: string) =>
    call(route, t, { token, deviceId: plainDevice });

  for (const route of ROUTES) {
    describe(route.name, () => {
      it("token of outlet A, target of outlet B: exactly 403 ACTING_STAFF_OUTLET_MISMATCH, nothing changes", async () => {
        const t = await target(outletB());
        const token = await cashierToken(plainDevice);
        const issuesBefore = await issueCountOfItem(t.itemUlid);
        // Proves the count query sees the reported item (1), so "unchanged" means something.
        expect(issuesBefore).toBe(1);
        const response = await plainCall(route, t, token);
        expectOutletRefusal(route, response, true);
        expect(errorCode(response), JSON.stringify(response.body)).toBe(
          MISMATCH,
        );
        expect(await chargeStatus(t.chargeId)).toBe("open");
        expect(await issueCountOfItem(t.itemUlid)).toBe(issuesBefore);
        expect(await issueStatus(t.issueId)).toBe("open");
      });

      it("token with an unknown id: exactly 403 ACTING_STAFF_OUTLET_MISMATCH, not 404 or 200", async () => {
        const token = await cashierToken(plainDevice);
        const response = await plainCall(route, unknownTarget(), token);
        expectOutletRefusal(route, response, true);
        expect(errorCode(response), JSON.stringify(response.body)).toBe(
          MISMATCH,
        );
      });

      it(
        route.control === "success"
          ? "token of outlet A, target of outlet A: succeeds"
          : "token of outlet A, target of outlet A: not refused with OUTLET_MISMATCH",
        async () => {
          let t: Target;
          if (route.name === "report item") {
            // A fresh item: the shared fixture already carries an open issue.
            const paid = await w.paidOrder();
            t = { ...unknownTarget(), itemUlid: paid.roti.id };
          } else {
            t = await target(outletA());
          }
          if (route.name === "collect-at-pos")
            await openShiftOnPlainDevice(t.orderUlid);
          const token = await cashierToken(plainDevice);
          const countBefore = await issueCountOfItem(t.itemUlid);
          expect(countBefore).toBe(route.name === "report item" ? 0 : 1);
          const response = await plainCall(route, t, token);
          expect(errorCode(response), JSON.stringify(response.body)).not.toBe(
            MISMATCH,
          );
          if (route.control === "success") {
            expect(response.status, JSON.stringify(response.body)).toBe(
              route.okStatus ?? 200,
            );
            if (route.name === "waive")
              expect(await chargeStatus(t.chargeId)).toBe("waived");
            if (route.name === "expire")
              expect(await chargeStatus(t.chargeId)).toBe("expired");
            if (route.name === "collect-at-pos")
              expect(await chargeStatus(t.chargeId)).toBe("paid");
            if (route.name === "report item")
              expect(await issueCountOfItem(t.itemUlid)).toBe(1);
          }
        },
      );
    });
  }
});
