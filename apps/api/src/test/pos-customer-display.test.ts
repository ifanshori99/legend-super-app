// legend-yhia9 customer display backend (design qris.md D-08, §5 0370, §6,
// §7 cases 22-24, §8): QD-01 isolation, QD-02 QR only while the hold is open
// and equals the remaining amount, QD-03 cancel + customer pays in the gap,
// QD-04 pairing, QD-05 version / explicit selection / no client amount.
//
// Written from the design and the shared contract, not from any display
// implementation (none exists yet: every route here is red with 404 today).
//
// Assumptions (the design names routes and rules, not every status code):
// - Response bodies are wrapped like every other POS endpoint: `{ data }`.
// - Pairing code request, pair and selection use the founder-free defaults of
//   D-08: 6 digits, 5 min TTL, single use, one live code per display (a newer
//   code replaces the older one).
// - Wrong code, expired code, reused code, cross-tenant code: any 4xx except
//   429 (the design only fixes 429 for the throttle).
// - Throttle "5 per terminal per 5 min": attempts 1-4 are never 429, the 6th
//   (even with the right code) is 429. Outlet "20 per 5 min": attempts 1-19
//   are never 429, the next attempt from a fresh terminal (right code) is 429.
// - Revoke (DELETE pairings/:id) answers 200 or 204.
// - A display that is unpaired, revoked, of another outlet or of another
//   tenant gets 401 or 404 and no data of the bill; unpaired, revoked and
//   other-outlet answer the same status and error code ("no hint which").
// - `version` is stable across reads and across an idempotent selection replay.
// - Bill total comes from the cashier fixture (meal + 10% tax); numbers that
//   matter (DP 20,000, cash 5,000, DP change 5,000) are literal, the rest is
//   derived from the bill's own total.
import { createHash, randomUUID } from "node:crypto";
import type { Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidToUlid } from "@starter/shared/core";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import {
  customerDisplayPairingSchema,
  customerDisplayStateSchema,
} from "@starter/shared/pos";
import { signDeviceToken } from "../lib/device-token.ts";
import { setDeviceOutletResolver } from "../services/device-pin.service.ts";
import {
  createIsolatedTenant,
  owner,
  seedTenantOutlets,
  staffOfIsolatedTenant,
  type Staff,
} from "./floor-test-helpers.ts";
import { agent, originHeader } from "./helpers.ts";
import { asCashierTenant } from "./pos-cashier-test-helpers.ts";
import {
  HOLD_CLOSE_MARGIN_S,
  assertInvariants,
  capturedIdr,
  holdFixture,
  issueQris,
  newSubmittedOrder,
  payNotice,
  postCancel,
  rawSetDeposit,
  rawWrite,
  readHold,
  refundsOfIntent,
  resetHoldPorts,
  runHoldCheck,
  unallocatedFunds,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";

const QR_STRING = "00020101021226HOLDQRIS"; // fake gateway payload (helper)
const CODE_TTL_S = 5 * 60;
const CASHIER_PERMISSIONS = [
  "floor.table.view",
  "floor.table.operate",
  "floor.table.manage",
  "service_request.zone.manage",
  "order.view",
  "order.create",
  "pos.sale.create",
  "pos.payment.accept",
  "menu.item.view",
  "menu.price.view",
  "shift.cash.operate",
  "pos.discount.apply",
];

// ------------------------------------------------------------------ fixtures

type Device = {
  id: string;
  token: string;
  tenantId: string;
  outletId: string;
  host: string;
};
type Realm = {
  tenantId: string;
  host: string;
  staff: Staff;
};

let fx: HoldFixture;
let realmA: Realm;
let fxTerminal: Device;
const knownDevices = new Map<string, { tenantId: string; outletId: string }>();
let extraOutlets: string[] | null = null;
let tenantB:
  (Realm & { outletId: string; terminal: Device; display: Device }) | null =
  null;

beforeAll(async () => {
  fx = await holdFixture("customer-display");
  realmA = {
    tenantId: fx.tenant.tenantId,
    host: fx.tenant.hostname,
    staff: fx.staff,
  };
  // The fixture's own POS terminal: the device `fx.post` / `fx.tender` use.
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id::text AS id FROM devices WHERE tenant_id=$1 AND type='pos'",
    [fx.tenant.tenantId],
  );
  expect(rows, "the fixture registers exactly one POS terminal").toHaveLength(
    1,
  );
  fxTerminal = signedDevice(
    rows[0]!.id,
    fx.tenant.tenantId,
    fx.tenant.outletId,
    fx.tenant.hostname,
  );
  // Every device this file registers must resolve to its outlet (fail-closed
  // resolver, same as the fixture's own).
  setDeviceOutletResolver(async (input) => {
    const known = knownDevices.get(input.deviceId);
    return known && known.tenantId === input.tenantId ? known.outletId : null;
  });
});
afterAll(async () => {
  resetHoldPorts();
  await owner.end();
});

function signedDevice(
  id: string,
  tenantId: string,
  outletId: string,
  host: string,
): Device {
  knownDevices.set(id, { tenantId, outletId });
  return {
    id,
    tenantId,
    outletId,
    host,
    token: signDeviceToken({
      version: 1,
      issuedAt: Math.floor(Date.now() / 1000),
      tenantId,
      brandId: null,
      deviceId: id,
    }),
  };
}

async function registerDevice(
  tenantId: string,
  outletId: string,
  host: string,
  type: "pos" | "display",
): Promise<Device> {
  const id = randomUUID();
  await asCashierTenant(tenantId, (client) =>
    client.query(
      `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute')`,
      [id, tenantId, outletId, type, `${type} uji ${id.slice(0, 8)}`],
    ),
  );
  return signedDevice(id, tenantId, outletId, host);
}

const newTerminal = (outletId = fx.tenant.outletId) =>
  registerDevice(fx.tenant.tenantId, outletId, fx.tenant.hostname, "pos");
const newDisplay = (outletId = fx.tenant.outletId) =>
  registerDevice(fx.tenant.tenantId, outletId, fx.tenant.hostname, "display");

/** Three more outlets of the fixture tenant (seeded once; brand slug is unique). */
async function outlets() {
  extraOutlets ??= await seedTenantOutlets(fx.tenant.tenantId, 3);
  return extraOutlets;
}

/** A second tenant with its own cashier, terminal and display. */
async function otherTenant() {
  if (tenantB) return tenantB;
  const tenant = await createIsolatedTenant(
    `display-b-${randomUUID().slice(0, 6)}`,
  );
  await owner.query("UPDATE roles SET permissions = $2 WHERE id = $1", [
    tenant.roleId,
    JSON.stringify(CASHIER_PERMISSIONS),
  ]);
  const staff = await staffOfIsolatedTenant(fx.app, tenant);
  const terminal = await registerDevice(
    tenant.tenantId,
    tenant.outletId,
    tenant.hostname,
    "pos",
  );
  const display = await registerDevice(
    tenant.tenantId,
    tenant.outletId,
    tenant.hostname,
    "display",
  );
  tenantB = {
    tenantId: tenant.tenantId,
    host: tenant.hostname,
    staff,
    outletId: tenant.outletId,
    terminal,
    display,
  };
  return tenantB;
}

// ------------------------------------------------------------------- routes

const displayPath = (outletId: string, suffix = "") =>
  `/api/outlets/${outletId}/pos/customer-display${suffix}`;

/** The display screen: device token only, no cashier session. */
function displayGet(
  device: Device,
  at: { outletId?: string; host?: string } = {},
) {
  return agent(fx.app)
    .get(displayPath(at.outletId ?? device.outletId))
    .set("Host", at.host ?? device.host)
    .set(DEVICE_TOKEN_HEADER, device.token);
}
function displayPost(device: Device, suffix: string, body: object = {}) {
  return agent(fx.app)
    .post(displayPath(device.outletId, suffix))
    .set("Host", device.host)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, device.token)
    .send(body);
}
function displayPut(device: Device, suffix: string, body: object) {
  return agent(fx.app)
    .put(displayPath(device.outletId, suffix))
    .set("Host", device.host)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, device.token)
    .send(body);
}

/** The cashier on a POS terminal: staff session + terminal device token. */
function terminalPost(
  terminal: Device,
  suffix: string,
  body: object,
  realm: Realm = realmA,
) {
  return realm.staff.client
    .post(displayPath(terminal.outletId, suffix))
    .set("Host", realm.host)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, terminal.token)
    .send(body);
}
function terminalPut(
  terminal: Device,
  suffix: string,
  body: object,
  realm: Realm = realmA,
) {
  return realm.staff.client
    .put(displayPath(terminal.outletId, suffix))
    .set("Host", realm.host)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, terminal.token)
    .send(body);
}
function terminalDelete(
  terminal: Device,
  suffix: string,
  realm: Realm = realmA,
) {
  return realm.staff.client
    .delete(displayPath(terminal.outletId, suffix))
    .set("Host", realm.host)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, terminal.token);
}

const requestCode = (display: Device) => displayPost(display, "/pairing-codes");
const pairWith = (
  terminal: Device,
  code: string,
  realm: Realm = realmA,
  idempotencyKey: string = randomUUID(),
) => terminalPost(terminal, "/pair", { code, idempotencyKey }, realm);
const selectBill = (
  terminal: Device,
  orderId: string | null,
  idempotencyKey: string = randomUUID(),
) => terminalPut(terminal, "/selection", { orderId, idempotencyKey });

function codeOf(res: Response): { code: string; expiresAt: string } {
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const data = res.body.data as { code: string; expiresAt: string };
  expect(data.code).toMatch(/^\d{6}$/);
  return data;
}

/** A display paired to `terminal` (default: the fixture terminal). */
async function pairedDisplay(terminal: Device = fxTerminal) {
  const display = await newDisplay(terminal.outletId);
  const { code } = codeOf(await requestCode(display));
  const paired = await pairWith(terminal, code);
  expect([200, 201], JSON.stringify(paired.body)).toContain(paired.status);
  const pairing = customerDisplayPairingSchema.safeParse(paired.body.data);
  if (!pairing.success) throw new Error(pairing.error.message);
  expect(pairing.data).toMatchObject({
    status: "active",
    terminalDeviceId: terminal.id,
    displayDeviceId: display.id,
  });
  return { display, pairingId: pairing.data.id as string };
}

async function readState(display: Device) {
  const res = await displayGet(display);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const parsed = customerDisplayStateSchema.safeParse(res.body.data);
  if (!parsed.success)
    throw new Error(
      `display state breaks the contract: ${parsed.error.message}`,
    );
  return parsed.data;
}

const errorCode = (res: Response) =>
  (res.body as { error?: { code?: string }; code?: string })?.error?.code ??
  (res.body as { code?: string })?.code ??
  null;

/** 401 or 404 and nothing of the bill in the answer (QD-01). */
function expectRefusedWithoutLeak(res: Response, secrets: string[]) {
  expect([401, 404], `${res.status} ${JSON.stringify(res.body)}`).toContain(
    res.status,
  );
  const text = `${JSON.stringify(res.body)} ${res.text}`;
  for (const secret of secrets) expect(text).not.toContain(secret);
}

function expectClientRefusal(res: Response, label: string) {
  expect(
    res.status,
    `${label}: ${JSON.stringify(res.body)}`,
  ).toBeGreaterThanOrEqual(400);
  expect(res.status, label).toBeLessThan(500);
  expect(res.status, `${label} must not be the throttle`).not.toBe(429);
}

async function pairingRow(pairingId: string) {
  const { rows } = await owner.query<{
    status: string;
    revoked_at: Date | null;
    terminal_device_id: string;
    display_device_id: string;
  }>(
    `SELECT status, revoked_at, terminal_device_id::text AS terminal_device_id,
            display_device_id::text AS display_device_id
       FROM customer_display_pairings WHERE tenant_id=$1 AND id=$2`,
    [fx.tenant.tenantId, pairingId],
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------- QD-01

describe("QD-01 display of another tenant or outlet, unpaired or revoked, reads no bill", () => {
  it("QD-01 a display token of another tenant, another outlet, a forged token and no token all get 401/404 and no bill data", async () => {
    const { display } = await pairedDisplay();
    const order = await newSubmittedOrder(fx, 0);
    const qr = await issueQris(fx, order.id);
    const own = await readState(display);
    expect(own.orderId, "the paired display shows the bill (sanity)").toBe(
      order.id,
    );
    expect(own.qris?.amountIdr).toBe(order.totalIdr);
    const read = await fx.get(`${fx.base}/${order.id}`);
    const secrets = [
      order.id,
      read.body.data.orderNumber as string,
      "HOLDQRIS",
      fx.tenant.tenantId,
      qr.intentId,
    ];

    const b = await otherTenant();
    // Tenant B's display at tenant A's host and outlet.
    expectRefusedWithoutLeak(
      await displayGet(b.display, {
        outletId: fx.tenant.outletId,
        host: fx.tenant.hostname,
      }),
      secrets,
    );
    // Tenant B's display at tenant B's host but tenant A's outlet id.
    expectRefusedWithoutLeak(
      await displayGet(b.display, { outletId: fx.tenant.outletId }),
      secrets,
    );
    // Tenant A's paired display read through another outlet of the same tenant.
    const [otherOutlet] = await outlets();
    expectRefusedWithoutLeak(
      await displayGet(display, { outletId: otherOutlet! }),
      secrets,
    );
    // Forged token and no credentials at all.
    expectRefusedWithoutLeak(
      await agent(fx.app)
        .get(displayPath(fx.tenant.outletId))
        .set("Host", fx.tenant.hostname)
        .set(DEVICE_TOKEN_HEADER, "dv1.forged.token"),
      secrets,
    );
    expectRefusedWithoutLeak(
      await agent(fx.app)
        .get(displayPath(fx.tenant.outletId))
        .set("Host", fx.tenant.hostname),
      secrets,
    );
    // The legitimate display still works: nothing above changed the bill.
    expect((await readState(display)).qris?.amountIdr).toBe(order.totalIdr);
    await assertInvariants(fx, order.id);
  }, 60_000);

  it("QD-01 an unpaired display, a display of another outlet and a revoked display get the same 401/404 and no bill data", async () => {
    const { display, pairingId } = await pairedDisplay();
    const order = await newSubmittedOrder(fx, 0);
    await issueQris(fx, order.id);
    expect((await readState(display)).orderId).toBe(order.id);
    const secrets = [order.id, "HOLDQRIS", fx.tenant.tenantId];

    const unpaired = await newDisplay();
    const unpairedRes = await displayGet(unpaired);
    expectRefusedWithoutLeak(unpairedRes, secrets);

    const [otherOutlet] = await outlets();
    const otherOutletDisplay = await newDisplay(otherOutlet!);
    const crossOutletRes = await displayGet(otherOutletDisplay, {
      outletId: fx.tenant.outletId,
    });
    expectRefusedWithoutLeak(crossOutletRes, secrets);

    const revoked = await terminalDelete(
      fxTerminal,
      `/pairings/${encodeURIComponent(pairingId)}`,
    );
    expect([200, 204], JSON.stringify(revoked.body)).toContain(revoked.status);
    const revokedRes = await displayGet(display);
    expectRefusedWithoutLeak(revokedRes, secrets);

    // No hint which: same status and same error code for all three.
    expect(crossOutletRes.status).toBe(unpairedRes.status);
    expect(revokedRes.status).toBe(unpairedRes.status);
    expect(errorCode(crossOutletRes)).toBe(errorCode(unpairedRes));
    expect(errorCode(revokedRes)).toBe(errorCode(unpairedRes));
    await assertInvariants(fx, order.id);
  }, 60_000);
});

// ---------------------------------------------------------------------- QD-02

describe("QD-02 the display shows the QR only while the hold is open and equals the remaining amount", () => {
  it("QD-02 DP 20,000: no QR before issue, then QR for exactly total - 20,000, with remaining in Rupiah", async () => {
    const { display } = await pairedDisplay();
    const order = await newSubmittedOrder(fx, 20_000);
    expect(order.depositAppliedIdr).toBe(20_000);
    const selected = await selectBill(fxTerminal, order.id);
    expect(selected.status, JSON.stringify(selected.body)).toBe(200);

    const before = await readState(display);
    expect(before.orderId).toBe(order.id);
    expect(before.totalIdr).toBe(order.totalIdr);
    expect(before.depositAppliedIdr).toBe(20_000);
    expect(before.remainingIdr).toBe(order.totalIdr - 20_000);
    expect(before.qris, "no hold, no QR").toBeNull();

    const qr = await issueQris(fx, order.id);
    const due = order.totalIdr - 20_000;
    expect(qr.amountIdr).toBe(due);
    const shown = await readState(display);
    expect(shown.remainingIdr).toBe(due);
    expect(Number.isInteger(shown.remainingIdr)).toBe(true);
    expect(shown.qris).not.toBeNull();
    expect(shown.qris!.amountIdr).toBe(due);
    expect(shown.qris!.payload).toBe(QR_STRING);
    expect(new Date(shown.qris!.expiresAt).getTime()).toBe(
      qr.expiresAt.getTime(),
    );
    await assertInvariants(fx, order.id);
  }, 60_000);

  it("QD-02 DP 20,000 and cash 5,000 already captured: the QR is for total - 25,000, never the gross or the DP-only remainder", async () => {
    const { display } = await pairedDisplay();
    const order = await newSubmittedOrder(fx, 20_000);
    const cash = await fx.tender(order.id, order.status, "cash", 5_000);
    expect(cash.status, JSON.stringify(cash.body)).toBe(201);
    expect(await capturedIdr(fx, order.id)).toBe(5_000);

    const qr = await issueQris(fx, order.id);
    const due = order.totalIdr - 20_000 - 5_000;
    expect(qr.amountIdr).toBe(due);
    const shown = await readState(display);
    expect(shown.orderId).toBe(order.id);
    expect(shown.depositAppliedIdr).toBe(20_000);
    expect(shown.tenders.map((t) => t.amountIdr)).toEqual([5_000]);
    expect(shown.remainingIdr).toBe(due);
    expect(shown.qris?.amountIdr).toBe(due);
    expect(shown.qris?.amountIdr).not.toBe(order.totalIdr);
    expect(shown.qris?.amountIdr).not.toBe(order.totalIdr - 20_000);
    await assertInvariants(fx, order.id);
  }, 60_000);

  it("QD-02 the QR disappears when the cashier cancels, stays gone after the provider closes the hold, and the bill shows its full remainder again", async () => {
    const { display } = await pairedDisplay();
    const order = await newSubmittedOrder(fx, 20_000);
    const qr = await issueQris(fx, order.id);
    const due = order.totalIdr - 20_000;
    expect((await readState(display)).qris?.amountIdr).toBe(due);

    const cancelled = await postCancel(fx, order.id);
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(202);
    expect((await readHold(fx, order.id))?.state).toBe("cancelling");
    const whileCancelling = await readState(display);
    expect(whileCancelling.qris, "cancelling hides the QR").toBeNull();
    expect(whileCancelling.remainingIdr).toBe(due);

    fx.gateway.script(qr.intentId, { rawStatus: "02" });
    await runHoldCheck(
      fx,
      new Date(qr.expiresAt.getTime() + (HOLD_CLOSE_MARGIN_S + 1) * 1000),
    );
    expect((await readHold(fx, order.id))?.state).toBe("closed");
    const afterClose = await readState(display);
    expect(afterClose.qris).toBeNull();
    expect(afterClose.remainingIdr).toBe(due);
    expect(afterClose.tenders).toEqual([]);
    expect(await capturedIdr(fx, order.id)).toBe(0);
    await assertInvariants(fx, order.id);
  }, 60_000);

  it("QD-02 a hold amount that no longer equals the remaining amount is never shown (stale amount), even if the freeze was bypassed", async () => {
    const { display } = await pairedDisplay();
    const order = await newSubmittedOrder(fx, 0);
    const qr = await issueQris(fx, order.id);
    expect(qr.amountIdr).toBe(order.totalIdr);
    expect((await readState(display)).qris?.amountIdr).toBe(order.totalIdr);

    // Defence in depth: write the DP with triggers off (replica role), as a
    // path that forgot the guard would. The hold still says total.
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [fx.tenant.tenantId],
      );
      await client.query(
        `UPDATE orders SET deposit_applied_idr = 10000
          WHERE tenant_id=$1 AND id = (SELECT order_id FROM pos_qris_holds
                                        WHERE tenant_id=$1 AND payment_intent_id=$2)`,
        [fx.tenant.tenantId, qr.intentId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const res = await displayGet(display);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const state = customerDisplayStateSchema.parse(res.body.data);
    expect(state.depositAppliedIdr).toBe(10_000);
    expect(state.remainingIdr).toBe(order.totalIdr - 10_000);
    expect(state.qris, "hold amount != remaining: no QR").toBeNull();
    expect(JSON.stringify(res.body)).not.toContain(QR_STRING);
  }, 60_000);

  it("QD-02 with no selected bill the display is idle with no QR", async () => {
    const { display } = await pairedDisplay();
    const idle = await readState(display);
    expect(idle.orderId).toBeNull();
    expect(idle.state).toBe("idle");
    expect(idle.qris).toBeNull();
  }, 60_000);
});

// ---------------------------------------------------------------------- QD-03

describe("QD-03 cashier cancels, the display stops the QR, the customer pays in the gap", () => {
  it("QD-03 cancel hides the QR on the next read; the payment that lands afterwards is captured once for the unchanged bill (case 9)", async () => {
    const { display } = await pairedDisplay();
    const order = await newSubmittedOrder(fx, 0);
    const qr = await issueQris(fx, order.id);
    const total = order.totalIdr;
    expect(qr.amountIdr).toBe(total);
    const shown = await readState(display);
    expect(shown.qris?.amountIdr).toBe(total);

    const cancelled = await postCancel(fx, order.id);
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(202);
    const hidden = await readState(display);
    expect(hidden.qris, "next read: QR is gone").toBeNull();
    expect(hidden.version).toBeGreaterThan(shown.version);
    expect((await readHold(fx, order.id))?.state).toBe("cancelling");

    // The customer scanned the QR before the cashier cancelled and pays now.
    await payNotice(fx, qr.intentId, total);
    const hold = await readHold(fx, order.id);
    expect(hold?.state).toBe("paid");
    expect(await capturedIdr(fx, order.id)).toBe(total);
    expect(await refundsOfIntent(fx, qr.intentId)).toEqual([]);
    expect(await unallocatedFunds(fx, qr.intentId)).toEqual([]);

    const afterPay = await readState(display);
    expect(afterPay.qris).toBeNull();
    expect(afterPay.remainingIdr).toBe(0);
    expect(afterPay.tenders.reduce((sum, t) => sum + t.amountIdr, 0)).toBe(
      total,
    );
    expect(afterPay.version).toBeGreaterThan(hidden.version);
    await assertInvariants(fx, order.id);
  }, 60_000);
});

// ---------------------------------------------------------------------- QD-04

describe("QD-04 pairing", () => {
  it("QD-04 a display gets a 6-digit code valid 5 minutes, stored only as an HMAC bound to tenant and outlet; only a display device can ask", async () => {
    const display = await newDisplay();
    const before = Date.now();
    const issued = codeOf(await requestCode(display));
    const ttlS = (new Date(issued.expiresAt).getTime() - before) / 1000;
    expect(ttlS).toBeGreaterThan(CODE_TTL_S - 15);
    expect(ttlS).toBeLessThan(CODE_TTL_S + 15);

    const { rows } = await owner.query<{
      code_hash: Buffer;
      tenant_id: string;
      outlet_id: string;
      consumed_at: Date | null;
      raw: string;
    }>(
      `SELECT code_hash, tenant_id::text AS tenant_id, outlet_id::text AS outlet_id,
              consumed_at, row_to_json(c)::text AS raw
         FROM customer_display_pairing_codes c
        WHERE tenant_id=$1 AND display_device_id=$2`,
      [fx.tenant.tenantId, display.id],
    );
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(Buffer.isBuffer(row.code_hash)).toBe(true);
    expect(row.code_hash).toHaveLength(32);
    expect(row.tenant_id).toBe(fx.tenant.tenantId);
    expect(row.outlet_id).toBe(fx.tenant.outletId);
    expect(row.consumed_at).toBeNull();
    // Not the plain code and not an unkeyed hash of it (HMAC with a server key).
    expect(row.raw).not.toContain(`"${issued.code}"`);
    for (const algorithm of ["sha256", "sha1", "md5"])
      expect(
        createHash(algorithm).update(issued.code).digest("hex"),
        algorithm,
      ).not.toBe(row.code_hash.toString("hex"));
    expect(createHash("sha256").update(issued.code).digest()).not.toEqual(
      row.code_hash,
    );

    // A POS terminal (not a display device) cannot ask for a pairing code.
    const terminalAsking = await displayPost(fxTerminal, "/pairing-codes");
    expect(terminalAsking.status).toBeGreaterThanOrEqual(400);
    expect(terminalAsking.status).toBeLessThan(500);
  }, 60_000);

  it("QD-04 a code is single use: it pairs once and is consumed, the second terminal is refused", async () => {
    const display = await newDisplay();
    const { code } = codeOf(await requestCode(display));
    const first = await newTerminal();
    const second = await newTerminal();
    const paired = await pairWith(first, code);
    expect([200, 201], JSON.stringify(paired.body)).toContain(paired.status);
    const consumed = await owner.query(
      `SELECT consumed_at FROM customer_display_pairing_codes
        WHERE tenant_id=$1 AND display_device_id=$2`,
      [fx.tenant.tenantId, display.id],
    );
    expect(consumed.rows[0]?.consumed_at, "code is marked used").not.toBeNull();

    expectClientRefusal(await pairWith(second, code), "reused code");
    expect(
      (await displayGet(display)).status,
      "display is still paired to the first terminal only",
    ).toBe(200);
    const secondPairings = await owner.query(
      `SELECT 1 FROM customer_display_pairings
        WHERE tenant_id=$1 AND terminal_device_id=$2`,
      [fx.tenant.tenantId, second.id],
    );
    expect(secondPairings.rowCount).toBe(0);
  }, 60_000);

  // Assumption (brief gap 1): the SAME terminal that already consumed a code may
  // retry /pair with that code (lost response, double tap) and gets the same
  // pairing back; it never creates a second pairing and never revokes the first.
  // A different terminal reusing the code stays refused (test above).
  it("QD-04b the same terminal retrying /pair with its consumed code gets the same pairing and no second pairing row", async () => {
    const display = await newDisplay();
    const terminal = await newTerminal();
    const { code } = codeOf(await requestCode(display));
    const first = await pairWith(terminal, code);
    expect([200, 201], JSON.stringify(first.body)).toContain(first.status);
    const firstPairing = customerDisplayPairingSchema.parse(first.body.data);

    // New idempotency key: this is a genuine second request, not a replay of
    // the first response.
    const retry = await pairWith(terminal, code);
    expect([200, 201], JSON.stringify(retry.body)).toContain(retry.status);
    const retryPairing = customerDisplayPairingSchema.parse(retry.body.data);

    expect(retryPairing.id).toBe(firstPairing.id);
    expect(retryPairing).toMatchObject({
      status: "active",
      terminalDeviceId: terminal.id,
      displayDeviceId: display.id,
    });
    const rows = await owner.query<{ id: string; status: string }>(
      `SELECT id::text AS id, status FROM customer_display_pairings
        WHERE tenant_id=$1 AND (terminal_device_id=$2 OR display_device_id=$3)`,
      [fx.tenant.tenantId, terminal.id, display.id],
    );
    expect(rows.rows, "exactly one pairing row, still active").toEqual([
      { id: firstPairing.id, status: "active" },
    ]);
    expect(
      (await displayGet(display)).status,
      "the display still reads its state",
    ).toBe(200);
  }, 60_000);

  it("QD-04 an expired code is refused and the display can ask for a fresh one", async () => {
    const display = await newDisplay();
    const terminal = await newTerminal();
    const { code } = codeOf(await requestCode(display));
    const aged = await rawWrite(
      fx,
      `UPDATE customer_display_pairing_codes
          SET created_at = now() - interval '10 minutes',
              expires_at = now() - interval '5 minutes'
        WHERE tenant_id=$1 AND display_device_id=$2 AND consumed_at IS NULL`,
      [fx.tenant.tenantId, display.id],
    );
    expect(aged, JSON.stringify(aged)).toEqual({ ok: true });

    expectClientRefusal(await pairWith(terminal, code), "expired code");
    expectRefusedWithoutLeak(await displayGet(display), []);

    const fresh = codeOf(await requestCode(display));
    const paired = await pairWith(terminal, fresh.code);
    expect([200, 201], JSON.stringify(paired.body)).toContain(paired.status);
    expect((await displayGet(display)).status).toBe(200);
  }, 60_000);

  it("QD-04 one live code per display: a newer code replaces the older one", async () => {
    const display = await newDisplay();
    const terminal = await newTerminal();
    const older = codeOf(await requestCode(display)).code;
    let newer = codeOf(await requestCode(display)).code;
    // Same six digits twice is possible but then both are the same live code.
    if (newer === older) newer = codeOf(await requestCode(display)).code;
    const live = await owner.query(
      `SELECT 1 FROM customer_display_pairing_codes
        WHERE tenant_id=$1 AND display_device_id=$2 AND consumed_at IS NULL`,
      [fx.tenant.tenantId, display.id],
    );
    expect(live.rowCount).toBe(1);
    if (older !== newer)
      expectClientRefusal(await pairWith(terminal, older), "replaced code");
    const paired = await pairWith(terminal, newer);
    expect([200, 201], JSON.stringify(paired.body)).toContain(paired.status);
  }, 60_000);

  it("QD-04 a code of another tenant is refused and stays usable by the right terminal", async () => {
    const display = await newDisplay();
    const { code } = codeOf(await requestCode(display));
    const b = await otherTenant();
    expectClientRefusal(
      await pairWith(b.terminal, code, b),
      "code of another tenant",
    );
    expectRefusedWithoutLeak(await displayGet(display), []);
    const paired = await pairWith(fxTerminal, code);
    expect([200, 201], JSON.stringify(paired.body)).toContain(paired.status);
    expect((await displayGet(display)).status).toBe(200);
  }, 60_000);

  it("QD-04 a second pairing revokes the first, per terminal and per display", async () => {
    // Per terminal: the same terminal pairs a second display.
    const terminal = await newTerminal();
    const first = await pairedDisplay(terminal);
    expect((await displayGet(first.display)).status).toBe(200);
    const second = await pairedDisplay(terminal);
    expect(
      (await pairingRow(first.pairingId))?.status,
      "first pairing revoked",
    ).toBe("revoked");
    expect((await pairingRow(first.pairingId))?.revoked_at).not.toBeNull();
    expectRefusedWithoutLeak(await displayGet(first.display), []);
    expect((await displayGet(second.display)).status).toBe(200);

    // Per display: another terminal takes over the same display.
    const other = await newTerminal();
    const { code } = codeOf(await requestCode(second.display));
    const taken = await pairWith(other, code);
    expect([200, 201], JSON.stringify(taken.body)).toContain(taken.status);
    expect(
      (await pairingRow(second.pairingId))?.status,
      "display re-paired: old pairing revoked",
    ).toBe("revoked");
    const active = await owner.query(
      `SELECT 1 FROM customer_display_pairings
        WHERE tenant_id=$1 AND display_device_id=$2 AND status='active'`,
      [fx.tenant.tenantId, second.display.id],
    );
    expect(active.rowCount).toBe(1);
  }, 60_000);

  it("QD-04 DELETE pairings/:id revokes the pairing; the display reads nothing afterwards; another tenant cannot revoke it", async () => {
    const { display, pairingId } = await pairedDisplay();
    expect((await displayGet(display)).status).toBe(200);

    const b = await otherTenant();
    const foreign = await terminalDelete(
      b.terminal,
      `/pairings/${encodeURIComponent(pairingId)}`,
      b,
    );
    expect([403, 404], JSON.stringify(foreign.body)).toContain(foreign.status);
    expect((await pairingRow(pairingId))?.status).toBe("active");

    const revoked = await terminalDelete(
      fxTerminal,
      `/pairings/${encodeURIComponent(pairingId)}`,
    );
    expect([200, 204], JSON.stringify(revoked.body)).toContain(revoked.status);
    const row = await pairingRow(pairingId);
    expect(row?.status).toBe("revoked");
    expect(row?.revoked_at).not.toBeNull();
    expectRefusedWithoutLeak(await displayGet(display), []);
  }, 60_000);

  it("QD-04 wrong code 5 times from one terminal in 5 minutes: the next attempt, even with the right code, is 429 and pairs nothing", async () => {
    const [outletId] = await outlets();
    const display = await newDisplay(outletId!);
    const terminal = await newTerminal(outletId!);
    const { code } = codeOf(await requestCode(display));
    const wrong = (n: number) =>
      code === String(100000 + n) ? "999999" : String(100000 + n);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const res = await pairWith(terminal, wrong(attempt));
      expect(
        res.status,
        `wrong code ${attempt}: ${JSON.stringify(res.body)}`,
      ).toBeGreaterThanOrEqual(400);
      if (attempt <= 4)
        expect(
          res.status,
          `wrong code ${attempt} is not throttled yet`,
        ).not.toBe(429);
    }
    const blocked = await pairWith(terminal, code);
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(429);
    expectRefusedWithoutLeak(await displayGet(display), []);
    expect(
      (
        await owner.query(
          `SELECT 1 FROM customer_display_pairings WHERE tenant_id=$1 AND terminal_device_id=$2`,
          [fx.tenant.tenantId, terminal.id],
        )
      ).rowCount,
    ).toBe(0);
  }, 60_000);

  it("QD-04 20 wrong codes in an outlet in 5 minutes (spread over terminals): a fresh terminal with the right code is 429", async () => {
    const outletIds = await outlets();
    const outletId = outletIds[1]!;
    const display = await newDisplay(outletId);
    const { code } = codeOf(await requestCode(display));
    let attempts = 0;
    for (let t = 0; t < 5; t += 1) {
      const terminal = await newTerminal(outletId);
      for (let i = 0; i < 4; i += 1) {
        attempts += 1;
        const guess = String(200000 + attempts);
        const res = await pairWith(terminal, guess === code ? "999998" : guess);
        expect(
          res.status,
          `wrong code ${attempts}: ${JSON.stringify(res.body)}`,
        ).toBeGreaterThanOrEqual(400);
        if (attempts <= 19)
          expect(
            res.status,
            `wrong code ${attempts} is not throttled yet`,
          ).not.toBe(429);
      }
    }
    const fresh = await newTerminal(outletId);
    const blocked = await pairWith(fresh, code);
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(429);
    expectRefusedWithoutLeak(await displayGet(display), []);
  }, 120_000);
});

// ---------------------------------------------------------------------- QD-05

describe("QD-05 version, explicit selection, no client amount", () => {
  it("QD-05 version strictly increases on selection change, bill money change and hold change, and is stable when nothing changes", async () => {
    const { display } = await pairedDisplay();
    const billA = await newSubmittedOrder(fx, 0);
    const billB = await newSubmittedOrder(fx, 0);

    const v0 = (await readState(display)).version;
    expect((await readState(display)).version, "re-read is stable").toBe(v0);

    const key = randomUUID();
    expect((await selectBill(fxTerminal, billA.id, key)).status).toBe(200);
    const v1 = (await readState(display)).version;
    expect(v1, "select A").toBeGreaterThan(v0);
    expect((await selectBill(fxTerminal, billA.id, key)).status).toBe(200);
    expect(
      (await readState(display)).version,
      "idempotent replay of the same selection changes nothing",
    ).toBe(v1);

    expect((await selectBill(fxTerminal, billB.id)).status).toBe(200);
    const v2 = (await readState(display)).version;
    expect(v2, "select B").toBeGreaterThan(v1);

    expect((await selectBill(fxTerminal, billA.id)).status).toBe(200);
    const v3 = (await readState(display)).version;
    expect(v3, "select A again").toBeGreaterThan(v2);

    // Bill money change (no hold yet): DP 5,000 lands on the selected bill.
    const written = await rawSetDeposit(fx, billA.id, 5_000);
    expect(written, JSON.stringify(written)).toEqual({ ok: true });
    const afterMoney = await readState(display);
    expect(afterMoney.version, "bill money change").toBeGreaterThan(v3);
    expect(afterMoney.depositAppliedIdr).toBe(5_000);
    expect(afterMoney.remainingIdr).toBe(billA.totalIdr - 5_000);

    // Hold changes: open, cancelling, closed.
    const qr = await issueQris(fx, billA.id);
    expect(qr.amountIdr).toBe(billA.totalIdr - 5_000);
    const opened = await readState(display);
    expect(opened.version, "hold opened").toBeGreaterThan(afterMoney.version);
    expect(opened.qris?.amountIdr).toBe(billA.totalIdr - 5_000);

    expect((await postCancel(fx, billA.id)).status).toBe(202);
    const cancelling = await readState(display);
    expect(cancelling.version, "hold cancelling").toBeGreaterThan(
      opened.version,
    );

    fx.gateway.script(qr.intentId, { rawStatus: "02" });
    await runHoldCheck(
      fx,
      new Date(qr.expiresAt.getTime() + (HOLD_CLOSE_MARGIN_S + 1) * 1000),
    );
    expect((await readHold(fx, billA.id))?.state).toBe("closed");
    const closed = await readState(display);
    expect(closed.version, "hold closed").toBeGreaterThan(cancelling.version);

    // Back to idle by an explicit selection of nothing.
    expect((await selectBill(fxTerminal, null)).status).toBe(200);
    const idle = await readState(display);
    expect(idle.version, "select nothing").toBeGreaterThan(closed.version);
    expect(idle.orderId).toBeNull();
    expect(idle.qris).toBeNull();
    await assertInvariants(fx, billA.id);
    await assertInvariants(fx, billB.id);
  }, 120_000);

  it("QD-05 selection is explicit: only the terminal can select, an unknown bill is refused, and the selection never changes by itself", async () => {
    const { display } = await pairedDisplay();
    const bill = await newSubmittedOrder(fx, 0);
    const other = await newSubmittedOrder(fx, 0);
    expect((await selectBill(fxTerminal, bill.id)).status).toBe(200);
    const before = await readState(display);
    expect(before.orderId).toBe(bill.id);

    // The display itself cannot choose what it shows.
    const fromDisplay = await displayPut(display, "/selection", {
      orderId: other.id,
      idempotencyKey: randomUUID(),
    });
    expect(fromDisplay.status).toBeGreaterThanOrEqual(400);
    expect(fromDisplay.status).toBeLessThan(500);
    // A bill that does not exist is refused.
    const unknown = await selectBill(fxTerminal, uuidToUlid(randomUUID()));
    expect(unknown.status, JSON.stringify(unknown.body)).toBeGreaterThanOrEqual(
      400,
    );
    expect(unknown.status).toBeLessThan(500);
    // Creating another bill does not move the display.
    await newSubmittedOrder(fx, 0);
    const after = await readState(display);
    expect(after.orderId).toBe(bill.id);
    expect(after.version).toBe(before.version);
  }, 60_000);

  it("QD-05 display routes never accept an amount from the client", async () => {
    const { display } = await pairedDisplay();
    const bill = await newSubmittedOrder(fx, 20_000);
    expect((await selectBill(fxTerminal, bill.id)).status).toBe(200);
    const before = await readState(display);

    // Selection with a client amount: refused, nothing changes.
    const withAmount = await terminalPut(fxTerminal, "/selection", {
      orderId: bill.id,
      amountIdr: 1,
      idempotencyKey: randomUUID(),
    });
    expect(
      withAmount.status,
      JSON.stringify(withAmount.body),
    ).toBeGreaterThanOrEqual(400);
    expect(withAmount.status).toBeLessThan(500);
    const unchanged = await readState(display);
    expect(unchanged.version).toBe(before.version);
    expect(unchanged.remainingIdr).toBe(bill.totalIdr - 20_000);
    expect(unchanged.qris).toBeNull();

    // Pairing with a client amount: refused although the code is right, and
    // the same code still pairs without the extra field.
    const fresh = await newDisplay();
    const terminal = await newTerminal();
    const { code } = codeOf(await requestCode(fresh));
    const forged = await terminalPost(terminal, "/pair", {
      code,
      amountIdr: 1,
      idempotencyKey: randomUUID(),
    });
    expect(forged.status, JSON.stringify(forged.body)).toBeGreaterThanOrEqual(
      400,
    );
    expect(forged.status).toBeLessThan(500);
    expectRefusedWithoutLeak(await displayGet(fresh), []);
    const ok = await pairWith(terminal, code);
    expect([200, 201], JSON.stringify(ok.body)).toContain(ok.status);

    // The QR amount on the display is the server's remainder, whatever a
    // client query says.
    const qr = await issueQris(fx, bill.id);
    const spoofed = await agent(fx.app)
      .get(`${displayPath(fxTerminal.outletId)}?amountIdr=1`)
      .set("Host", display.host)
      .set(DEVICE_TOKEN_HEADER, display.token);
    if (spoofed.status === 200) {
      const state = customerDisplayStateSchema.parse(spoofed.body.data);
      expect(state.qris?.amountIdr).toBe(bill.totalIdr - 20_000);
    } else {
      expect(spoofed.status).toBeGreaterThanOrEqual(400);
      expect(spoofed.status).toBeLessThan(500);
    }
    expect(qr.amountIdr).toBe(bill.totalIdr - 20_000);
    await assertInvariants(fx, bill.id);
  }, 60_000);

  it("QD-05 issuing a QR from a terminal selects that bill on its display", async () => {
    const { display } = await pairedDisplay();
    const earlier = await newSubmittedOrder(fx, 0);
    const bill = await newSubmittedOrder(fx, 20_000);
    expect((await selectBill(fxTerminal, earlier.id)).status).toBe(200);
    const before = await readState(display);
    expect(before.orderId).toBe(earlier.id);
    expect(before.qris).toBeNull();

    const qr = await issueQris(fx, bill.id);
    const due = bill.totalIdr - 20_000;
    expect(qr.amountIdr).toBe(due);
    const after = await readState(display);
    expect(after.orderId, "the display moved to the bill that got the QR").toBe(
      bill.id,
    );
    expect(after.qris?.amountIdr).toBe(due);
    expect(after.remainingIdr).toBe(due);
    expect(after.version).toBeGreaterThan(before.version);
    await assertInvariants(fx, bill.id);
    await assertInvariants(fx, earlier.id);
  }, 60_000);
});
