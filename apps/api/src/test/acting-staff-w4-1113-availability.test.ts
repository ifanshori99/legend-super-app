// Acting staff, brief 1113 finding P2: GET /api/menu/availability on a shared
// tablet.
//
// Spec (docs/briefs/1113-fix-akses-1094-so.md, CTO decision 2):
//  - With a cashier PIN token, GET availability uses the token's outlet: a
//    query for another outlet is 403 ACTING_STAFF_OUTLET_MISMATCH.
//  - Without outletId the list is narrowed to the token's outlet, never the
//    whole reach of the cashier's permission.
//  - The expiry sweep (restoreExpiredSoldOut) must not touch another outlet.
//  - Without a token (ordinary browser) nothing changes.
//
// Assumptions (spec silent):
//  - The cashier is staffed at BOTH outlets and signs in on outlet A's tablet,
//    so permissions and outlet scope alone would let outlet B through and only
//    the token-outlet check can refuse.
//  - An expired 86 is a sold_out row with sold_out_until in the past.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { tenantIdSchema } from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { ACTING_STAFF_ERROR_CODES } from "@starter/shared/pos/acting-staff";
import { signDeviceToken } from "../lib/device-token.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  asOwnerTenant,
  createWorld,
  type World,
} from "./order-recovery-helpers.ts";
import { owner } from "./floor-test-helpers.ts";

const ACTING_HEADER = "X-Acting-Staff";
const PIN = "913607";
const PERMISSIONS = ["menu.item.view", "menu.availability.toggle"];

type Person = { client: ReturnType<typeof agent>; userId: string };
type Response = { status: number; body: unknown };

let w: World;
let outletA: string;
let outletB: string;
let roleId: string;
let cashier: Person;
let session: Person;
const devices = new Map<string, string>();
let deviceA: string;

beforeAll(async () => {
  w = await createWorld();
  outletA = w.tenant.outletId;
  outletB = w.ids.otherOutlet;
  setDeviceOutletResolver(async ({ tenantId, deviceId }) =>
    tenantId === w.tenant.tenantId ? (devices.get(deviceId) ?? null) : null,
  );
  roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Kasir 86 1113', false, NULL, $3, false, '["tenant","outlet"]')`,
    [roleId, w.tenant.tenantId, JSON.stringify(PERMISSIONS)],
  );
  cashier = await makeUser("Kasir A+B 1113", { outletId: outletA });
  await assign(cashier.userId, outletB);
  deviceA = await newDevice(outletA);
}, 120_000);

beforeEach(async () => {
  session = await makeUser("Login Tablet 1113", null);
});

afterAll(async () => {
  setDeviceOutletResolver(null);
  await w.teardown();
});

async function assign(userId: string, outletId: string | null) {
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [
      w.tenant.tenantId,
      userId,
      roleId,
      outletId ? "outlet" : "tenant",
      outletId,
    ],
  );
}

async function makeUser(
  label: string,
  scope: { outletId: string } | null,
): Promise<Person> {
  const client = agent(w.app);
  await signUp(client, label);
  const me = await client.get("/api/auth/get-session");
  const userId = me.body.user.id as string;
  await assign(userId, scope?.outletId ?? null);
  return { client, userId };
}

async function newDevice(outletId: string): Promise<string> {
  const id = randomUUID();
  devices.set(id, outletId);
  await owner.query(
    `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at, shared_mode)
     VALUES ($1, $2, $3, 'pos', $4, now() - interval '1 minute', true)`,
    [id, w.tenant.tenantId, outletId, `Tablet 1113 ${id.slice(0, 6)}`],
  );
  return id;
}

const tokenOf = (deviceId: string) =>
  signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: w.tenant.tenantId,
    brandId: null,
    deviceId,
  });

async function cashierToken(): Promise<string> {
  await setStaffPin(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(w.tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    cashier.userId,
    { outletId: outletA, userId: cashier.userId },
    { pin: PIN },
  );
  const response = await session.client
    .post("/api/staff-pins/pos-session")
    .set(w.headers)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, tokenOf(deviceA))
    .send({ userId: cashier.userId, pin: PIN });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data.token as string;
}

/** On the shared tablet; without `shared` it is an ordinary browser. */
function list(query: string, token?: string, shared = true): Promise<Response> {
  let request = session.client
    .get(`/api/menu/availability${query}`)
    .set(w.headers)
    .set(originHeader);
  if (shared) request = request.set(DEVICE_TOKEN_HEADER, tokenOf(deviceA));
  if (token) request = request.set(ACTING_HEADER, token);
  return request as unknown as Promise<Response>;
}

type Seed = { availabilityId: string; itemId: string };

/** A fresh menu item with an availability row; `expired` = an 86 that ended. */
async function seed(outletId: string, expired: boolean): Promise<Seed> {
  const itemId = randomUUID();
  const availabilityId = randomUUID();
  await asOwnerTenant(w.tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, $5, true, $6)`,
      [
        itemId,
        w.tenant.tenantId,
        w.tenant.brandId,
        w.ids.category,
        `Menu 1113 ${itemId.slice(0, 6)}`,
        randomUUID(),
      ],
    );
    await client.query(
      `INSERT INTO item_availability
         (id, tenant_id, outlet_id, menu_item_id, schedule, daily_limit, sold_out_until, status, source)
       VALUES ($1, $2, $3, $4, '[]', NULL, $5, $6, $7)`,
      [
        availabilityId,
        w.tenant.tenantId,
        outletId,
        itemId,
        expired ? new Date(Date.now() - 3_600_000) : null,
        expired ? "sold_out" : "available",
        expired ? "staff" : null,
      ],
    );
  });
  return { availabilityId, itemId };
}

async function statusOf(id: string): Promise<string> {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM item_availability WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, id],
  );
  return rows[0]!.status;
}

const idsOf = (response: Response) =>
  (response.body as { data: { id: string }[] }).data.map((row) => row.id);

describe("GET availability on a shared tablet (brief 1113 P2)", () => {
  it("token of outlet A, outletId=B: 403 ACTING_STAFF_OUTLET_MISMATCH and B's expired 86 is not restored", async () => {
    const b = await seed(outletB, true);
    const token = await cashierToken();
    const response = await list(`?outletId=${outletB}`, token);
    const body = response.body as { error?: { code?: string } };
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(body.error?.code).toBe(ACTING_STAFF_ERROR_CODES.OUTLET_MISMATCH);
    expect(await statusOf(b.availabilityId)).toBe("sold_out");
  });

  it("token of outlet A, no outletId: only outlet A rows, B's expired 86 stays untouched", async () => {
    const a = await seed(outletA, false);
    const b = await seed(outletB, true);
    const token = await cashierToken();
    const response = await list("?limit=100", token);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const ids = idsOf(response);
    expect(ids).toContain(a.availabilityId);
    expect(ids).not.toContain(b.availabilityId);
    expect(await statusOf(b.availabilityId)).toBe("sold_out");
  });

  it("token of outlet A, outletId=A: works and still restores A's expired 86", async () => {
    const a = await seed(outletA, true);
    const token = await cashierToken();
    const response = await list(`?outletId=${outletA}&limit=100`, token);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(idsOf(response)).toContain(a.availabilityId);
    expect(await statusOf(a.availabilityId)).toBe("available");
  });

  it("control, ordinary browser: a tenant-wide login keeps its normal reach, outletId=B works", async () => {
    const b = await seed(outletB, false);
    const response = await list(
      `?outletId=${outletB}&limit=100`,
      undefined,
      false,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(idsOf(response)).toContain(b.availabilityId);
  });
});
