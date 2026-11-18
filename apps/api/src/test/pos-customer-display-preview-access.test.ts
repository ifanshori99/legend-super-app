// legend-dgtz0: access rules of the cashier preview
// GET /api/outlets/:outletId/pos/customer-display (brief 1017 card C, written
// from the brief and the shared contract, not from the route implementation).
//
// Rules under test:
// - `terminalDeviceId` must be a terminal of the PATH outlet and tenant. Another
//   outlet's or another tenant's terminal reads nothing: 403/404, no bill data,
//   and the answer is the same as for a terminal id that does not exist at all
//   (no existence leak).
// - A signed device token on the request must be the terminal being asked for.
// - A login session marked by a flagged shared device needs a live cashier token
//   (`X-Acting-Staff`) on this GET; the token is bound to device, session and
//   outlet. The display-device branch (display token, no session) keeps its own
//   auth. Personal devices and own-outlet reads stay as they were.
//
// Assumptions (the brief does not fix every status code):
// - Refusal statuses are 403 or 404 for cross-outlet / cross-tenant /
//   mismatching terminal, and 401 or 403 for the cashier-token gate; the
//   missing-token case answers ACTING_STAFF_REQUIRED (same code the other POS
//   routes use, see acting-staff-shared-device.test.ts). The stripped-header
//   replay only fixes status and "no data".
// - A refused read never carries the other bill's id, order number, outlet or
//   tenant id, or the paired display device id.
// - Bodies are wrapped as `{ data }`; the happy path parses with the shared
//   customerDisplayStateSchema (the web contract).
// - Shared-device state is set by SQL (`devices.shared_mode`) after the
//   pairing/selection fixtures are built, so fixtures never depend on the rule.
import { randomUUID } from "node:crypto";
import type { Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenantIdSchema } from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import {
  customerDisplayPairingSchema,
  customerDisplayStateSchema,
} from "@starter/shared/pos";
import { signDeviceToken } from "../lib/device-token.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
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
  newSubmittedOrder,
  resetHoldPorts,
  holdFixture,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";

const ACTING_HEADER = "X-Acting-Staff";
const PIN = "582914";
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

let fx: HoldFixture;
let plainTerminal: Device; // the fixture terminal, never flagged
let sharedTerminal: Device; // flagged shared device, own outlet
let otherOutletId: string; // second outlet of the fixture tenant
let secretsPlain: string[]; // what the plain terminal's display shows
let secretsShared: string[]; // what the shared terminal's display shows
let orderPlainId: string;
let orderSharedId: string;
let sharedSession: Staff; // login session that touched the flagged device
let cashierB: Staff; // staff with a PIN, acts through the token
let actingToken: string;
let tenantB: {
  host: string;
  outletId: string;
  staff: Staff;
  terminal: Device;
};
const knownDevices = new Map<string, { tenantId: string; outletId: string }>();

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

const displayPath = (outletId: string, suffix = "") =>
  `/api/outlets/${outletId}/pos/customer-display${suffix}`;

/** Cashier-side write (pair / select) on a terminal, as the existing display tests do. */
function terminalWrite(
  terminal: Device,
  method: "post" | "put",
  suffix: string,
  body: object,
) {
  return fx.staff.client[method](displayPath(terminal.outletId, suffix))
    .set("Host", fx.tenant.hostname)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, terminal.token)
    .send(body);
}

/** Pair a fresh display to `terminal` and make it show `orderId`. */
async function pairAndSelect(terminal: Device, orderId: string) {
  const display = await registerDevice(
    fx.tenant.tenantId,
    terminal.outletId,
    fx.tenant.hostname,
    "display",
  );
  const code = await agent(fx.app)
    .post(displayPath(display.outletId, "/pairing-codes"))
    .set("Host", display.host)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, display.token)
    .send({});
  expect(code.status, JSON.stringify(code.body)).toBe(200);
  const paired = await terminalWrite(terminal, "post", "/pair", {
    code: code.body.data.code,
    idempotencyKey: randomUUID(),
  });
  expect([200, 201], JSON.stringify(paired.body)).toContain(paired.status);
  const pairing = customerDisplayPairingSchema.safeParse(paired.body.data);
  expect(pairing.success).toBe(true);
  const selected = await terminalWrite(terminal, "put", "/selection", {
    orderId,
    idempotencyKey: randomUUID(),
  });
  expect(selected.status, JSON.stringify(selected.body)).toBe(200);
  return display;
}

async function orderNumberOf(orderId: string): Promise<string> {
  const read = await fx.get(`${fx.base}/${orderId}`);
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  return read.body.data.orderNumber as string;
}

beforeAll(async () => {
  fx = await holdFixture("display-preview-access");
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id::text AS id FROM devices WHERE tenant_id=$1 AND type='pos'",
    [fx.tenant.tenantId],
  );
  expect(rows, "the fixture registers exactly one POS terminal").toHaveLength(
    1,
  );
  plainTerminal = signedDevice(
    rows[0]!.id,
    fx.tenant.tenantId,
    fx.tenant.outletId,
    fx.tenant.hostname,
  );
  setDeviceOutletResolver(async (input) => {
    const known = knownDevices.get(input.deviceId);
    return known && known.tenantId === input.tenantId ? known.outletId : null;
  });
  otherOutletId = (await seedTenantOutlets(fx.tenant.tenantId, 1))[0]!;

  // Two terminals of the fixture outlet, each paired to its own display that
  // shows its own bill; then flag one of them as a shared device.
  sharedTerminal = await registerDevice(
    fx.tenant.tenantId,
    fx.tenant.outletId,
    fx.tenant.hostname,
    "pos",
  );
  const orderPlain = await newSubmittedOrder(fx, 0);
  const orderShared = await newSubmittedOrder(fx, 0);
  orderPlainId = orderPlain.id;
  orderSharedId = orderShared.id;
  const plainDisplay = await pairAndSelect(plainTerminal, orderPlain.id);
  const sharedDisplay = await pairAndSelect(sharedTerminal, orderShared.id);
  secretsPlain = [
    orderPlain.id,
    await orderNumberOf(orderPlain.id),
    plainDisplay.id,
  ];
  secretsShared = [
    orderShared.id,
    await orderNumberOf(orderShared.id),
    sharedDisplay.id,
  ];
  await owner.query("UPDATE devices SET shared_mode = true WHERE id = $1", [
    sharedTerminal.id,
  ]);

  // Sessions of the shared terminal: a login session and a cashier with a PIN.
  sharedSession = await staffOfIsolatedTenant(fx.app, fx.tenant);
  cashierB = await staffOfIsolatedTenant(fx.app, fx.tenant);
  const ctx = establishTenantContext({
    tenantId: tenantIdSchema.parse(fx.tenant.tenantId),
    brandId: null,
    source: "session",
  });
  await setStaffPin(
    ctx,
    cashierB.userId,
    { outletId: fx.tenant.outletId, userId: cashierB.userId },
    { pin: PIN },
  );
  const login = await sharedSession.client
    .post("/api/staff-pins/pos-session")
    .set("Host", fx.tenant.hostname)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, sharedTerminal.token)
    .send({ userId: cashierB.userId, pin: PIN });
  expect(login.status, JSON.stringify(login.body)).toBe(201);
  actingToken = login.body.data.token as string;

  // Second tenant with a cashier and a terminal.
  const tenant = await createIsolatedTenant(
    `display-pa-${randomUUID().slice(0, 6)}`,
  );
  await owner.query("UPDATE roles SET permissions = $2 WHERE id = $1", [
    tenant.roleId,
    JSON.stringify(CASHIER_PERMISSIONS),
  ]);
  tenantB = {
    host: tenant.hostname,
    outletId: tenant.outletId,
    staff: await staffOfIsolatedTenant(fx.app, tenant),
    terminal: await registerDevice(
      tenant.tenantId,
      tenant.outletId,
      tenant.hostname,
      "pos",
    ),
  };
});
afterAll(async () => {
  resetHoldPorts();
  await owner.end();
});

// ------------------------------------------------------------------- helpers

type Preview = {
  client: Staff["client"];
  host: string;
  outletId: string;
  terminalDeviceId?: string;
  deviceToken?: string;
  acting?: string;
};

function preview(p: Preview) {
  let req = p.client.get(displayPath(p.outletId)).set("Host", p.host);
  if (p.terminalDeviceId)
    req = req.query({ terminalDeviceId: p.terminalDeviceId });
  if (p.deviceToken) req = req.set(DEVICE_TOKEN_HEADER, p.deviceToken);
  if (p.acting) req = req.set(ACTING_HEADER, p.acting);
  return req;
}

const errorCode = (res: Response): string | null =>
  (res.body as { error?: { code?: string } })?.error?.code ?? null;

function expectNoData(res: Response, secrets: string[]) {
  const text = `${JSON.stringify(res.body)} ${res.text}`;
  for (const secret of secrets) expect(text).not.toContain(secret);
  expect(text).not.toContain(fx.tenant.tenantId);
}

function expectRefused(
  res: Response,
  secrets: string[],
  statuses: number[] = [403, 404],
) {
  expect(statuses, `${res.status} ${JSON.stringify(res.body)}`).toContain(
    res.status,
  );
  expectNoData(res, secrets);
}

function expectOwnState(res: Response, orderId: string, terminalId: string) {
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const parsed = customerDisplayStateSchema.safeParse(res.body.data);
  if (!parsed.success)
    throw new Error(`preview breaks the web contract: ${parsed.error.message}`);
  expect(parsed.data.orderId).toBe(orderId);
  expect(parsed.data.terminalDeviceId).toBe(terminalId);
}

// ------------------------------------------------------------ cross outlet/tenant

describe("preview: another outlet's or tenant's terminal reads nothing", () => {
  it("a terminalDeviceId of another outlet of the same tenant is refused with no bill data", async () => {
    // Sanity: the same terminal is readable on its own outlet.
    expectOwnState(
      await preview({
        client: fx.staff.client,
        host: fx.tenant.hostname,
        outletId: fx.tenant.outletId,
        terminalDeviceId: plainTerminal.id,
      }),
      orderPlainId,
      plainTerminal.id,
    );
    // Path outlet = another outlet, terminal belongs to the fixture outlet.
    const crossOutlet = await preview({
      client: fx.staff.client,
      host: fx.tenant.hostname,
      outletId: otherOutletId,
      terminalDeviceId: plainTerminal.id,
    });
    expectRefused(crossOutlet, [...secretsPlain, ...secretsShared]);
    const crossOutletShared = await preview({
      client: fx.staff.client,
      host: fx.tenant.hostname,
      outletId: otherOutletId,
      terminalDeviceId: sharedTerminal.id,
    });
    expectRefused(crossOutletShared, [...secretsPlain, ...secretsShared]);
  }, 60_000);

  it("a cross-outlet terminal answers exactly like a terminal that does not exist (no existence leak)", async () => {
    const crossOutlet = await preview({
      client: fx.staff.client,
      host: fx.tenant.hostname,
      outletId: otherOutletId,
      terminalDeviceId: plainTerminal.id,
    });
    const unknown = await preview({
      client: fx.staff.client,
      host: fx.tenant.hostname,
      outletId: otherOutletId,
      terminalDeviceId: randomUUID(),
    });
    expectRefused(unknown, secretsPlain);
    expect(crossOutlet.status).toBe(unknown.status);
    expect(errorCode(crossOutlet)).toBe(errorCode(unknown));
  }, 60_000);

  it("a terminalDeviceId of another tenant is refused with no bill data, in both directions, and looks like an unknown id", async () => {
    // Tenant B's cashier asks for tenant A's terminal at tenant B's outlet.
    const bReadsA = await preview({
      client: tenantB.staff.client,
      host: tenantB.host,
      outletId: tenantB.outletId,
      terminalDeviceId: plainTerminal.id,
    });
    const bUnknown = await preview({
      client: tenantB.staff.client,
      host: tenantB.host,
      outletId: tenantB.outletId,
      terminalDeviceId: randomUUID(),
    });
    expectRefused(bReadsA, [...secretsPlain, ...secretsShared]);
    expect(bReadsA.status).toBe(bUnknown.status);
    expect(errorCode(bReadsA)).toBe(errorCode(bUnknown));

    // Tenant A's cashier asks for tenant B's terminal at tenant A's outlet.
    const aReadsB = await preview({
      client: fx.staff.client,
      host: fx.tenant.hostname,
      outletId: fx.tenant.outletId,
      terminalDeviceId: tenantB.terminal.id,
    });
    const aUnknown = await preview({
      client: fx.staff.client,
      host: fx.tenant.hostname,
      outletId: fx.tenant.outletId,
      terminalDeviceId: randomUUID(),
    });
    expectRefused(aReadsB, secretsPlain);
    expect(aReadsB.status).toBe(aUnknown.status);
    expect(errorCode(aReadsB)).toBe(errorCode(aUnknown));
    expect(JSON.stringify(aReadsB.body)).not.toContain(tenantB.terminal.id);
  }, 60_000);

  it("tenant B's cashier on tenant B's host cannot read tenant A's outlet preview at all", async () => {
    const res = await preview({
      client: tenantB.staff.client,
      host: tenantB.host,
      outletId: fx.tenant.outletId,
      terminalDeviceId: plainTerminal.id,
      deviceToken: tenantB.terminal.token,
    });
    expectRefused(res, [...secretsPlain, ...secretsShared], [401, 403, 404]);
  }, 60_000);
});

// -------------------------------------------------------------- shared device

describe("preview on a shared device needs the cashier token", () => {
  it("a shared-device session with the terminal token but no X-Acting-Staff is refused with ACTING_STAFF_REQUIRED and no bill data", async () => {
    const res = await preview({
      client: sharedSession.client,
      host: fx.tenant.hostname,
      outletId: fx.tenant.outletId,
      deviceToken: sharedTerminal.token,
    });
    expectRefused(res, secretsShared, [401, 403]);
    expect(errorCode(res), JSON.stringify(res.body)).toBe(
      "ACTING_STAFF_REQUIRED",
    );
  }, 60_000);

  it("a shared-device session replayed without any device header (query only) is still refused and shows no bill", async () => {
    const res = await preview({
      client: sharedSession.client,
      host: fx.tenant.hostname,
      outletId: fx.tenant.outletId,
      terminalDeviceId: sharedTerminal.id,
    });
    expectRefused(res, secretsShared, [401, 403]);
  }, 60_000);

  it("with a live cashier token for its own terminal the shared-device preview shows that terminal's bill", async () => {
    expectOwnState(
      await preview({
        client: sharedSession.client,
        host: fx.tenant.hostname,
        outletId: fx.tenant.outletId,
        deviceToken: sharedTerminal.token,
        acting: actingToken,
      }),
      orderSharedId,
      sharedTerminal.id,
    );
    // Asking explicitly for the same terminal is the same answer.
    expectOwnState(
      await preview({
        client: sharedSession.client,
        host: fx.tenant.hostname,
        outletId: fx.tenant.outletId,
        terminalDeviceId: sharedTerminal.id,
        deviceToken: sharedTerminal.token,
        acting: actingToken,
      }),
      orderSharedId,
      sharedTerminal.id,
    );
  }, 60_000);

  it("a cashier token plus the shared terminal's token cannot read another terminal's bill (terminalDeviceId must equal the device)", async () => {
    const res = await preview({
      client: sharedSession.client,
      host: fx.tenant.hostname,
      outletId: fx.tenant.outletId,
      terminalDeviceId: plainTerminal.id,
      deviceToken: sharedTerminal.token,
      acting: actingToken,
    });
    expectRefused(res, secretsPlain, [400, 403, 404]);
  }, 60_000);

  it("a cashier token of outlet A used against another outlet's preview is refused with no bill data", async () => {
    const res = await preview({
      client: sharedSession.client,
      host: fx.tenant.hostname,
      outletId: otherOutletId,
      terminalDeviceId: sharedTerminal.id,
      deviceToken: sharedTerminal.token,
      acting: actingToken,
    });
    expectRefused(res, [...secretsShared, ...secretsPlain], [401, 403, 404]);
    const noQuery = await preview({
      client: sharedSession.client,
      host: fx.tenant.hostname,
      outletId: otherOutletId,
      deviceToken: sharedTerminal.token,
      acting: actingToken,
    });
    expectRefused(
      noQuery,
      [...secretsShared, ...secretsPlain],
      [401, 403, 404],
    );
  }, 60_000);

  it("a garbage cashier token on the shared device is refused and shows no bill", async () => {
    const res = await preview({
      client: sharedSession.client,
      host: fx.tenant.hostname,
      outletId: fx.tenant.outletId,
      deviceToken: sharedTerminal.token,
      acting: "not-a-live-token",
    });
    expectRefused(res, secretsShared, [401, 403]);
  }, 60_000);
});

// ------------------------------------------------------ personal device, display

describe("preview of a personal device and of the display screen is unaffected", () => {
  it("a personal session with its own terminal token reads its own bill", async () => {
    expectOwnState(
      await preview({
        client: fx.staff.client,
        host: fx.tenant.hostname,
        outletId: fx.tenant.outletId,
        deviceToken: plainTerminal.token,
      }),
      orderPlainId,
      plainTerminal.id,
    );
  }, 60_000);

  it("a personal session asking for a terminal of its own outlet by id reads that bill", async () => {
    expectOwnState(
      await preview({
        client: fx.staff.client,
        host: fx.tenant.hostname,
        outletId: fx.tenant.outletId,
        terminalDeviceId: plainTerminal.id,
      }),
      orderPlainId,
      plainTerminal.id,
    );
    expectOwnState(
      await preview({
        client: fx.staff.client,
        host: fx.tenant.hostname,
        outletId: fx.tenant.outletId,
        terminalDeviceId: plainTerminal.id,
        deviceToken: plainTerminal.token,
      }),
      orderPlainId,
      plainTerminal.id,
    );
  }, 60_000);

  it("a personal session whose device token is terminal X cannot read terminal Y's bill through terminalDeviceId", async () => {
    const res = await preview({
      client: fx.staff.client,
      host: fx.tenant.hostname,
      outletId: fx.tenant.outletId,
      terminalDeviceId: sharedTerminal.id,
      deviceToken: plainTerminal.token,
    });
    expectRefused(res, secretsShared, [400, 403, 404]);
  }, 60_000);

  it("the display screen (display token, no session, no cashier token) still reads its own bill", async () => {
    const { rows } = await owner.query<{ id: string }>(
      `SELECT display_device_id::text AS id FROM customer_display_pairings
        WHERE tenant_id=$1 AND terminal_device_id=$2 AND status='active'`,
      [fx.tenant.tenantId, sharedTerminal.id],
    );
    expect(rows).toHaveLength(1);
    const display = signedDevice(
      rows[0]!.id,
      fx.tenant.tenantId,
      fx.tenant.outletId,
      fx.tenant.hostname,
    );
    const res = await agent(fx.app)
      .get(displayPath(display.outletId))
      .set("Host", display.host)
      .set(DEVICE_TOKEN_HEADER, display.token);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.orderId).toBe(orderSharedId);
  }, 60_000);
});
