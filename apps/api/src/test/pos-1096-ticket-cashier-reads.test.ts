// Brief 1096, card 1 (bead legend-hpgyw): the three cashier reads for the
// facility ticket sale at the POS. Written from the brief, the coordinator's
// course correction and the contract file packages/shared/src/pos/ticket-cashier.ts
// (paths, query rules, output schemas), never from the service or route code.
//
//   GET /api/outlets/:outletId/pos/tickets/customers?q=
//   GET /api/outlets/:outletId/pos/tickets/products
//   GET /api/outlets/:outletId/pos/tickets/slots?facilityId&areaId&date
//
// Run just this file (from the repo root):
//   LEGEND_TEST_FILES="src/test/pos-1096-ticket-cashier-reads.test.ts" heavy pnpm test
//
// Fixtures: reuses the 1065 world (one tenant, outlet A with a facility, area,
// ticket product and a cashier whose role reaches outlet A only, a door staff
// without `pos.sale.create`, outlet B of the same tenant) and adds a second
// tenant, a tenant-wide cashier, an outlet C without facilities and extra
// products / customers.
//
// Assumptions (spec silent, also reported):
//  - The reads need only the cookie session on the tenant host (no device
//    token) and the staff's `pos.sale.create` on the path outlet.
//  - No permission / no reach / another tenant's outlet is refused with 403 or
//    404 (never 2xx, never a list); an anonymous caller gets 401.
//  - A search term shorter than 3 characters (after trimming) or a missing `q`
//    is refused with 400 or 422 and no customer is returned.
//  - "Name contains q" is the match rule (case of the stored name is used in
//    the tests); `%`, `_` are plain characters, so q = "%%%" lists nobody (a
//    400/422 refusal is accepted too).
//  - Customers of the search are active profiles only; closed profiles are
//    left out. Pending/suspended profiles are not asserted.
//  - A facility or area of another outlet (or an area that does not belong to
//    the facility) is refused (400, 403, 404 or 422); "when in doubt refuse".
//  - An area without units has no free slots: 200 with an empty list.
//  - Slots are the free start times of the area; a slot whose only unit has
//    been sold disappears from the list while the other slots stay.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  posTicketCustomerSchema,
  posTicketProductSchema,
  posTicketSlotSchema,
} from "@starter/shared/pos/ticket-cashier";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  fixtures,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";
import { seedMember, seedProfile } from "./member-loyalty-helpers.ts";
import {
  asOwnerTenant,
  authed,
  buildWorld,
  errorCode,
  newUnit,
  owner,
  saleBody,
  short,
  slotStart,
  teardownWorld,
  TICKET_LIST_IDR,
  type World,
} from "./pos-1065-world.ts";

const MAX_CUSTOMERS = 10;

let world: World;
let otherTenant: IsolatedTenant;
let outletC: string;
let wideCashier: { client: ReturnType<typeof agent>; userId: string };
// Supervisor-like staff of outlet A: pos.sale.create AND facility.booth.operate.
// Bead legend-tkxhs: the slots read needs only pos.sale.create (the pure
// cashier `world.cashier`), so this user is a control that a holder of both
// permissions still reads slots, and the one who may read /api/facility/availability.
let boothCashier: { client: ReturnType<typeof agent>; userId: string };
let anonymous: ReturnType<typeof agent>;

/** Tag that makes this run's customers findable and nobody else's. */
const tag = randomUUID().slice(0, 6);

const ids = {
  category: randomUUID(),
  menuItem: randomUUID(),
  extraSingle: randomUUID(),
  inactiveSingle: randomUUID(),
  noMenuSingle: randomUUID(),
  packageComponent: randomUUID(),
  subscriptionPlan: randomUUID(),
  facilityB: randomUUID(),
  areaB: randomUUID(),
  productB: randomUUID(),
  emptyArea: randomUUID(),
  slotArea: randomUUID(),
  slotUnit: randomUUID(),
};

const names = {
  inA: `Kartu ${tag} Rina`,
  inB: `Kartu ${tag} Budi`,
  closed: `Kartu ${tag} Tutup`,
  otherTenant: `Kartu ${tag} Tenant Lain`,
};

let rinaProfile: { id: string; userId: string; whatsappHash: string };
let otherTenantProfile: { id: string };

const OPERATING_HOURS = JSON.stringify([
  { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], opensAt: "00:00", closesAt: "23:59" },
]);

async function insertFacility(
  db: Parameters<Parameters<typeof asOwnerTenant>[1]>[0],
  facilityId: string,
  outletId: string,
  name: string,
) {
  await db.query(
    `INSERT INTO facilities (id, tenant_id, outlet_id, name, type, session_minutes, cleaning_minutes,
                             arrival_grace_minutes, operating_hours, overtime_policy, cancellation_policy)
     VALUES ($1, $2, $3, $4, 'shower', 20, 10, 10, $5, $6, $7)`,
    [
      facilityId,
      world.tenant.tenantId,
      outletId,
      name,
      OPERATING_HOURS,
      JSON.stringify({
        graceMinutes: 5,
        blockMinutes: 15,
        feePerBlockIdr: 5000,
      }),
      JSON.stringify({
        freeCancelMinutesBefore: 30,
        lateCancelResolution: "no_refund",
        lateCancelFeeIdr: 0,
        noShowResolution: "no_refund",
      }),
    ],
  );
}

async function insertProduct(
  db: Parameters<Parameters<typeof asOwnerTenant>[1]>[0],
  input: {
    id: string;
    outletId: string;
    facilityId: string;
    name: string;
    type: "single" | "package_component" | "subscription_plan";
    priceIdr: number;
    sessions: number;
    isActive: boolean;
    menuItemId: string | null;
  },
) {
  await db.query(
    `INSERT INTO facility_products
       (id, tenant_id, outlet_id, facility_id, name, type, price_idr, sessions, is_active, menu_item_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      input.id,
      world.tenant.tenantId,
      input.outletId,
      input.facilityId,
      input.name,
      input.type,
      input.priceIdr,
      input.sessions,
      input.isActive,
      input.menuItemId,
    ],
  );
}

beforeAll(async () => {
  world = await buildWorld("k1096");
  otherTenant = await createIsolatedTenant(`k1096o-${short()}`);
  anonymous = agent(world.app);

  // Outlet C: no facility at all (the empty state).
  outletC = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet C Kartu 1', 'Jl. Uji 5', 'Asia/Jakarta', $6, 'active')`,
    [
      outletC,
      world.tenant.tenantId,
      world.tenant.brandId,
      world.tenant.legalEntityId,
      `C${short()}`.toUpperCase(),
      JSON.stringify(fixtures.outlets[0].openingHours),
    ],
  );

  // A cashier whose role reaches the whole tenant (to read outlet B and C).
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Kasir Seluruh Tenant Kartu 1', false, NULL, $3, false, '["tenant","outlet"]')`,
    [
      roleId,
      world.tenant.tenantId,
      JSON.stringify(["order.view", "pos.sale.create"]),
    ],
  );
  const client = agent(world.app);
  await signUp(client, "Kasir Tenant Kartu 1");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [world.tenant.tenantId, userId, roleId],
  );
  wideCashier = { client, userId };

  const boothRoleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Supervisor Kartu 1', false, NULL, $3, false, '["tenant","outlet"]')`,
    [
      boothRoleId,
      world.tenant.tenantId,
      JSON.stringify([
        "order.view",
        "pos.sale.create",
        "facility.booth.operate",
      ]),
    ],
  );
  const boothClient = agent(world.app);
  await signUp(boothClient, "Supervisor Kartu 1");
  const boothSession = await boothClient.get("/api/auth/get-session");
  const boothUserId = boothSession.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 minute', $2)`,
    [world.tenant.tenantId, boothUserId, boothRoleId, world.outletA],
  );
  boothCashier = { client: boothClient, userId: boothUserId };

  await asOwnerTenant(world.tenant.tenantId, async (db) => {
    await db.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Kartu 1 Uji', 0)`,
      [ids.category, world.tenant.tenantId, world.tenant.brandId],
    );
    await db.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Tiket Kartu 1', true, $5)`,
      [
        ids.menuItem,
        world.tenant.tenantId,
        world.tenant.brandId,
        ids.category,
        randomUUID(),
      ],
    );
    const base = {
      outletId: world.outletA,
      facilityId: world.facilityId,
      priceIdr: 40_000,
      sessions: 1,
    };
    // The one extra sellable product of outlet A.
    await insertProduct(db, {
      ...base,
      id: ids.extraSingle,
      name: "Tiket Sauna 1x",
      type: "single",
      isActive: true,
      menuItemId: ids.menuItem,
    });
    // Products that must never be offered to the cashier.
    await insertProduct(db, {
      ...base,
      id: ids.inactiveSingle,
      name: "Tiket Nonaktif",
      type: "single",
      isActive: false,
      menuItemId: ids.menuItem,
    });
    await insertProduct(db, {
      ...base,
      id: ids.noMenuSingle,
      name: "Tiket Tanpa Menu",
      type: "single",
      isActive: true,
      menuItemId: null,
    });
    await insertProduct(db, {
      ...base,
      id: ids.packageComponent,
      name: "Komponen Paket",
      type: "package_component",
      isActive: true,
      menuItemId: ids.menuItem,
    });
    await insertProduct(db, {
      ...base,
      id: ids.subscriptionPlan,
      name: "Langganan 10x",
      type: "subscription_plan",
      sessions: 10,
      isActive: true,
      menuItemId: ids.menuItem,
    });

    // Outlet B: its own facility and a sellable product (must not show at A).
    await insertFacility(db, ids.facilityB, world.outletB, "Shower B");
    await db.query(
      `INSERT INTO facility_areas (id, tenant_id, outlet_id, facility_id, name, sort_order)
       VALUES ($1, $2, $3, $4, 'Area B', 0)`,
      [ids.areaB, world.tenant.tenantId, world.outletB, ids.facilityB],
    );
    await insertProduct(db, {
      id: ids.productB,
      outletId: world.outletB,
      facilityId: ids.facilityB,
      name: "Tiket Outlet B",
      type: "single",
      priceIdr: 55_000,
      sessions: 1,
      isActive: true,
      menuItemId: ids.menuItem,
    });

    // Areas of outlet A's facility for the slot tests: one without units, one
    // with exactly one unit (so selling it removes the slot).
    await db.query(
      `INSERT INTO facility_areas (id, tenant_id, outlet_id, facility_id, name, sort_order)
       VALUES ($1, $2, $3, $4, 'Area Kosong', 1), ($5, $2, $3, $4, 'Area Satu Unit', 2)`,
      [
        ids.emptyArea,
        world.tenant.tenantId,
        world.outletA,
        world.facilityId,
        ids.slotArea,
      ],
    );
    await db.query(
      `INSERT INTO facility_units (id, tenant_id, outlet_id, facility_id, area_id, code, status, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, 'available', 0)`,
      [
        ids.slotUnit,
        world.tenant.tenantId,
        world.outletA,
        world.facilityId,
        ids.slotArea,
        `S-${short()}`.toUpperCase(),
      ],
    );
  });

  // Customers: two active of the tenant, a closed one, one of another tenant,
  // and twelve more for the "at most 10" case.
  // A member with a loyalty consent, like the customers a ticket is sold to.
  rinaProfile = await seedMember(world.tenant.tenantId, { name: names.inA });
  await seedProfile(world.tenant.tenantId, { name: names.inB });
  await seedProfile(world.tenant.tenantId, {
    name: names.closed,
    status: "closed",
  });
  otherTenantProfile = await seedProfile(otherTenant.tenantId, {
    name: names.otherTenant,
  });
  for (let i = 1; i <= 12; i += 1)
    await seedProfile(world.tenant.tenantId, {
      name: `Antrian${tag} ${String(i).padStart(2, "0")}`,
    });
}, 240_000);

afterAll(async () => {
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    otherTenant.tenantId,
    randomUUID(),
  ]);
  await teardownWorld(world);
});

// ---- Request helpers --------------------------------------------------------------

type Client = ReturnType<typeof agent>;

const base = (outletId: string) =>
  `/api/outlets/${encodeURIComponent(outletId)}/pos/tickets`;

const get = (client: Client, path: string) =>
  client.get(path).set(world.headers).set(originHeader);

const customersOf = (client: Client, outletId: string, q: string) =>
  get(client, `${base(outletId)}/customers?q=${encodeURIComponent(q)}`);
const productsOf = (client: Client, outletId: string) =>
  get(client, `${base(outletId)}/products`);
const slotsOf = (
  client: Client,
  outletId: string,
  query: { facilityId: string; areaId: string; date: string },
) =>
  get(
    client,
    `${base(outletId)}/slots?facilityId=${query.facilityId}&areaId=${query.areaId}&date=${query.date}`,
  );

const slotDate = () => slotStart().slice(0, 10);
const cashierA = () => world.cashier.client;
const boothA = () => boothCashier.client;

// Loose shape of the JSON a route returns; a refusal carries no `data` lists,
// which the tests assert at run time.
type ReplyBody = {
  error?: { code?: string };
  code?: string;
  data: {
    customers: { id: string; name: string }[];
    products: { id: string }[];
    slots: unknown;
  };
};
type Reply = { status: number; body: ReplyBody };

function expectRefused(reply: Reply, allowed: number[]) {
  expect(
    allowed,
    `status ${reply.status}: ${JSON.stringify(reply.body)}`,
  ).toContain(reply.status);
  expect(errorCode(reply.body), JSON.stringify(reply.body)).toBeTruthy();
  // A refusal never carries a list.
  expect(reply.body?.data?.customers).toBeUndefined();
  expect(reply.body?.data?.products).toBeUndefined();
  expect(reply.body?.data?.slots).toBeUndefined();
}

const customerNames = (reply: Reply): string[] =>
  (reply.body.data.customers as { name: string }[]).map((c) => c.name);
const productIds = (reply: Reply): string[] =>
  (reply.body.data.products as { id: string }[]).map((p) => p.id);

// ---- Customers: main flow --------------------------------------------------------

describe("legend-hpgyw ticket cashier customers: search", () => {
  it("legend-hpgyw a cashier with pos.sale.create finds active customers whose name contains q, ordered by name", async () => {
    const reply = await customersOf(cashierA(), world.outletA, `Kartu ${tag}`);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    // Active customers of this tenant only: not the closed one, not the other tenant's.
    expect(customerNames(reply)).toEqual([names.inB, names.inA]);
  });

  it("legend-hpgyw the search matches in the middle of a name", async () => {
    const reply = await customersOf(cashierA(), world.outletA, `${tag} Rin`);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(customerNames(reply)).toEqual([names.inA]);
  });

  it("legend-hpgyw each hit has ONLY id and name: no phone, WhatsApp hash, user id, email or other CRM field", async () => {
    const reply = await customersOf(cashierA(), world.outletA, `${tag} Rina`);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    const [hit] = reply.body.data.customers as Record<string, unknown>[];
    expect(Object.keys(hit!).sort()).toEqual(["id", "name"]);
    expect(posTicketCustomerSchema.parse(hit)).toEqual({
      id: rinaProfile.id,
      name: names.inA,
    });
    const text = JSON.stringify(reply.body);
    expect(text).not.toContain(rinaProfile.whatsappHash);
    expect(text).not.toContain(rinaProfile.userId);
    expect(text).not.toMatch(/phone|telepon|whatsapp|email|points|balance/i);
  });

  it("legend-hpgyw a hit is the id the ticket sale accepts as customerProfileId (control: the sale of that customer succeeds)", async () => {
    const reply = await customersOf(cashierA(), world.outletA, `${tag} Rina`);
    const picked = reply.body.data.customers[0].id as string;
    const unitId = await newUnit(world);
    const sold = await authed(
      world,
      cashierA().post("/api/facility/tickets/pos"),
      world.normalA,
    ).send({ ...saleBody(world, unitId), customerProfileId: picked });
    expect(sold.status, JSON.stringify(sold.body)).toBe(200);
  });

  it("legend-hpgyw at most 10 customers come back, the first 10 by name, even when 12 match", async () => {
    const reply = await customersOf(cashierA(), world.outletA, `Antrian${tag}`);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    const expected = Array.from(
      { length: MAX_CUSTOMERS },
      (_, i) => `Antrian${tag} ${String(i + 1).padStart(2, "0")}`,
    );
    expect(customerNames(reply)).toEqual(expected);
  });

  it("legend-hpgyw empty state: a term nobody matches returns 200 with an empty list", async () => {
    const reply = await customersOf(
      cashierA(),
      world.outletA,
      `zzzz-${tag}-none`,
    );
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(reply.body.data.customers).toEqual([]);
  });
});

describe("legend-hpgyw ticket cashier customers: refusals", () => {
  for (const q of ["", "a", "ab", " ab ", "  a  "]) {
    it(`legend-hpgyw a term shorter than 3 characters (${JSON.stringify(q)}) is refused and lists nobody`, async () => {
      expectRefused(
        await customersOf(cashierA(), world.outletA, q),
        [400, 422],
      );
    });
  }

  it("legend-hpgyw a missing q is refused", async () => {
    expectRefused(
      await get(cashierA(), `${base(world.outletA)}/customers`),
      [400, 422],
    );
  });

  it("legend-hpgyw unknown query keys are refused (strict contract)", async () => {
    expectRefused(
      await get(
        cashierA(),
        `${base(world.outletA)}/customers?q=${tag}&limit=500`,
      ),
      [400, 422],
    );
  });

  for (const q of ["%%%", "___", "%_%"]) {
    it(`legend-hpgyw the wildcard term ${JSON.stringify(q)} does not list the customer base`, async () => {
      const reply = await customersOf(cashierA(), world.outletA, q);
      if (reply.status === 200) {
        expect(reply.body.data.customers).toEqual([]);
      } else {
        expectRefused(reply, [400, 422]);
      }
    });
  }

  it("legend-hpgyw another tenant's customer never appears, even when searched by its exact name", async () => {
    const reply = await customersOf(
      cashierA(),
      world.outletA,
      names.otherTenant,
    );
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(reply.body.data.customers).toEqual([]);
    expect(JSON.stringify(reply.body)).not.toContain(otherTenantProfile.id);
  });

  it("legend-hpgyw a closed profile is not offered", async () => {
    const reply = await customersOf(cashierA(), world.outletA, names.closed);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(reply.body.data.customers).toEqual([]);
  });
});

// ---- Customers: rate limit -------------------------------------------------------

describe("legend-hpgyw ticket cashier customers: rate limit", () => {
  it("legend-hpgyw the 31st search within a minute is 429, and the limit is per user", async () => {
    // The tenant-wide cashier makes no other customer search in this file.
    const search = () =>
      customersOf(wideCashier.client, world.outletA, `Kartu ${tag}`);
    for (let n = 1; n <= 30; n += 1) {
      const reply = await search();
      expect(reply.status, `request ${n}: ${JSON.stringify(reply.body)}`).toBe(
        200,
      );
    }
    const limited = await search();
    expect(limited.status, JSON.stringify(limited.body)).toBe(429);
    expect(errorCode(limited.body)).toBe("RATE_LIMITED");
    expect(limited.body?.data?.customers).toBeUndefined();
    // Another user is not slowed by it.
    const other = await customersOf(cashierA(), world.outletA, `Kartu ${tag}`);
    expect(other.status, JSON.stringify(other.body)).toBe(200);
  });
});

// ---- Products: main flow --------------------------------------------------------

describe("legend-hpgyw ticket cashier products: catalog", () => {
  it("legend-hpgyw the cashier sees exactly the active single products of the outlet with a POS menu item", async () => {
    const reply = await productsOf(cashierA(), world.outletA);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    // Not offered: inactive, no menu item, package component, subscription plan,
    // and the product of outlet B.
    expect([...productIds(reply)].sort()).toEqual(
      [world.productId, ids.extraSingle].sort(),
    );
    for (const hidden of [
      ids.inactiveSingle,
      ids.noMenuSingle,
      ids.packageComponent,
      ids.subscriptionPlan,
      ids.productB,
    ])
      expect(productIds(reply)).not.toContain(hidden);
  });

  it("legend-hpgyw each product matches the contract (id, facility, name, server price, sessions, areas, units) and nothing else", async () => {
    const reply = await productsOf(cashierA(), world.outletA);
    for (const product of reply.body.data.products as Record<string, unknown>[])
      expect(Object.keys(posTicketProductSchema.parse(product)).sort()).toEqual(
        Object.keys(product).sort(),
      );
    const shower = (
      reply.body.data.products as {
        id: string;
        facilityName: string;
        name: string;
        priceIdr: number;
        sessions: number;
        areas: { id: string; name: string }[];
        units: { areaId: string }[];
      }[]
    ).find((p) => p.id === world.productId)!;
    expect(shower).toMatchObject({
      facilityName: "Shower A",
      name: "Tiket Shower 1x",
      priceIdr: TICKET_LIST_IDR,
      sessions: 1,
    });
    expect(shower.areas).toEqual(
      expect.arrayContaining([{ id: world.areaId, name: "Area Tiket" }]),
    );
    const areaIds = shower.areas.map((a) => a.id);
    for (const unit of shower.units) expect(areaIds).toContain(unit.areaId);
  });

  it("legend-hpgyw the price comes from the server product: a changed product price shows at the next read", async () => {
    await asOwnerTenant(world.tenant.tenantId, (db) =>
      db.query(
        "UPDATE facility_products SET price_idr = 41000 WHERE tenant_id = $1 AND id = $2",
        [world.tenant.tenantId, ids.extraSingle],
      ),
    );
    const reply = await productsOf(cashierA(), world.outletA);
    const extra = (
      reply.body.data.products as { id: string; priceIdr: number }[]
    ).find((p) => p.id === ids.extraSingle);
    expect(extra?.priceIdr).toBe(41_000);
  });

  it("legend-hpgyw a tenant-wide cashier sees outlet B's own product at outlet B and not outlet A's", async () => {
    const reply = await productsOf(wideCashier.client, world.outletB);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(productIds(reply)).toEqual([ids.productB]);
  });

  it("legend-hpgyw empty state: an outlet without facilities returns 200 with an empty list", async () => {
    const reply = await productsOf(wideCashier.client, outletC);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(reply.body.data.products).toEqual([]);
  });
});

// ---- Slots --------------------------------------------------------------------

describe("legend-hpgyw ticket cashier slots: free start times", () => {
  it("legend-hpgyw a free area lists ordered, well-formed slots that include the usual sale time", async () => {
    const reply = await slotsOf(cashierA(), world.outletA, {
      facilityId: world.facilityId,
      areaId: ids.slotArea,
      date: slotDate(),
    });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(reply.body.data).toMatchObject({
      facilityId: world.facilityId,
      areaId: ids.slotArea,
      businessDate: slotDate(),
    });
    const slots = reply.body.data.slots as {
      startsAt: string;
      endsAt: string;
    }[];
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      expect(Object.keys(posTicketSlotSchema.parse(slot)).sort()).toEqual([
        "endsAt",
        "startsAt",
      ]);
      expect(Date.parse(slot.endsAt)).toBeGreaterThan(
        Date.parse(slot.startsAt),
      );
    }
    const starts = slots.map((s) => Date.parse(s.startsAt));
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(slots.map((s) => Date.parse(s.startsAt))).toContain(
      Date.parse(slotStart()),
    );
    // Nothing but the start and the end: no unit, hold or queue data.
    expect(JSON.stringify(reply.body.data.slots)).not.toMatch(
      /unit|hold|queue|status/i,
    );
  });

  it("legend-hpgyw selling the only unit of a slot removes that slot and keeps the others", async () => {
    const query = {
      facilityId: world.facilityId,
      areaId: ids.slotArea,
      date: slotDate(),
    };
    const before = await slotsOf(cashierA(), world.outletA, query);
    const beforeStarts = (before.body.data.slots as { startsAt: string }[]).map(
      (s) => Date.parse(s.startsAt),
    );
    expect(beforeStarts).toContain(Date.parse(slotStart()));

    const sold = await authed(
      world,
      cashierA().post("/api/facility/tickets/pos"),
      world.normalA,
    ).send({
      ...saleBody(world, ids.slotUnit),
      areaId: ids.slotArea,
    });
    expect(sold.status, JSON.stringify(sold.body)).toBe(200);

    const after = await slotsOf(cashierA(), world.outletA, query);
    expect(after.status, JSON.stringify(after.body)).toBe(200);
    const afterStarts = (after.body.data.slots as { startsAt: string }[]).map(
      (s) => Date.parse(s.startsAt),
    );
    expect(afterStarts).not.toContain(Date.parse(slotStart()));
    // The sold slot (and any slot it overlaps) is gone; the later ones stay.
    expect(afterStarts.length).toBeLessThan(beforeStarts.length);
    expect(afterStarts.length).toBeGreaterThan(0);
    expect(afterStarts.every((start) => beforeStarts.includes(start))).toBe(
      true,
    );
  });

  it("legend-tkxhs a pure cashier (pos.sale.create without facility.booth.operate) reads the slots (200)", async () => {
    // Spec (brief 1163 card 2): the POS ticket slots need only pos.sale.create.
    const reply = await slotsOf(cashierA(), world.outletA, {
      facilityId: world.facilityId,
      areaId: ids.slotArea,
      date: slotDate(),
    });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(reply.body.data).toMatchObject({
      facilityId: world.facilityId,
      areaId: ids.slotArea,
      businessDate: slotDate(),
    });
    const slots = reply.body.data.slots as { startsAt: string }[];
    // Not asserting the usual sale time here: the test above sells that slot.
    expect(slots.length).toBeGreaterThan(0);
  });

  it("legend-tkxhs a staff with pos.sale.create AND facility.booth.operate still reads the slots (200), same list as the pure cashier", async () => {
    const query = {
      facilityId: world.facilityId,
      areaId: ids.slotArea,
      date: slotDate(),
    };
    const booth = await slotsOf(boothA(), world.outletA, query);
    const pure = await slotsOf(cashierA(), world.outletA, query);
    expect(booth.status, JSON.stringify(booth.body)).toBe(200);
    expect(pure.status, JSON.stringify(pure.body)).toBe(200);
    expect(booth.body.data.slots).toEqual(pure.body.data.slots);
  });

  it("legend-tkxhs the pure cashier still gets 403 on the booth availability route (/api/facility/availability needs facility.booth.operate), while the supervisor gets 200", async () => {
    const path = `/api/facility/availability?facilityId=${world.facilityId}&date=${slotDate()}`;
    const refused = await get(cashierA(), path);
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(errorCode(refused.body), JSON.stringify(refused.body)).toBeTruthy();
    const allowed = await get(boothA(), path);
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
  });

  it("legend-hpgyw empty state: an area without units has no free slots (200, empty list)", async () => {
    const reply = await slotsOf(cashierA(), world.outletA, {
      facilityId: world.facilityId,
      areaId: ids.emptyArea,
      date: slotDate(),
    });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(reply.body.data.slots).toEqual([]);
  });

  it("legend-hpgyw a bad date or a missing field is refused", async () => {
    for (const path of [
      `slots?facilityId=${world.facilityId}&areaId=${world.areaId}&date=not-a-date`,
      `slots?facilityId=${world.facilityId}&areaId=${world.areaId}`,
      `slots?facilityId=nope&areaId=${world.areaId}&date=${slotDate()}`,
      `slots?areaId=${world.areaId}&date=${slotDate()}`,
    ])
      expectRefused(
        await get(cashierA(), `${base(world.outletA)}/${path}`),
        [400, 422],
      );
  });

  it("legend-hpgyw a facility or area of another outlet is refused through outlet A's path", async () => {
    // Facility of outlet B through outlet A.
    expectRefused(
      await slotsOf(cashierA(), world.outletA, {
        facilityId: ids.facilityB,
        areaId: ids.areaB,
        date: slotDate(),
      }),
      [400, 403, 404, 422],
    );
    // Area of outlet B under outlet A's facility.
    expectRefused(
      await slotsOf(cashierA(), world.outletA, {
        facilityId: world.facilityId,
        areaId: ids.areaB,
        date: slotDate(),
      }),
      [400, 403, 404, 422],
    );
    // Outlet A's facility through outlet B's path (tenant-wide cashier).
    expectRefused(
      await slotsOf(wideCashier.client, world.outletB, {
        facilityId: world.facilityId,
        areaId: world.areaId,
        date: slotDate(),
      }),
      [400, 403, 404, 422],
    );
  });
});

// ---- Access: 403 without permission, cross outlet, cross tenant -----------------

describe("legend-hpgyw ticket cashier reads: access", () => {
  const readers = (outletId: string) => ({
    customers: (client: Client) =>
      customersOf(client, outletId, `Kartu ${tag}`),
    products: (client: Client) => productsOf(client, outletId),
    slots: (client: Client) =>
      slotsOf(client, outletId, {
        facilityId: world.facilityId,
        areaId: world.areaId,
        date: slotDate(),
      }),
  });

  for (const endpoint of ["customers", "products", "slots"] as const) {
    it(`legend-hpgyw ${endpoint}: staff without pos.sale.create (door staff, tenant-wide) gets 403 and no data`, async () => {
      expectRefused(
        await readers(world.outletA)[endpoint](world.doorStaff.client),
        [403],
      );
    });

    it(`legend-hpgyw ${endpoint}: an anonymous caller gets 401`, async () => {
      const reply = await readers(world.outletA)[endpoint](anonymous);
      expect(reply.status, JSON.stringify(reply.body)).toBe(401);
      expect(reply.body?.data?.customers).toBeUndefined();
      expect(reply.body?.data?.products).toBeUndefined();
      expect(reply.body?.data?.slots).toBeUndefined();
    });

    it(`legend-hpgyw ${endpoint}: a cashier whose role reaches outlet A only is refused at outlet B of the same tenant`, async () => {
      expectRefused(
        await readers(world.outletB)[endpoint](cashierA()),
        [403, 404],
      );
    });

    it(`legend-hpgyw ${endpoint}: another tenant's outlet is refused (403 or 404) on this tenant's host`, async () => {
      expectRefused(
        await readers(otherTenant.outletId)[endpoint](wideCashier.client),
        [403, 404],
      );
    });

    it(`legend-hpgyw ${endpoint}: an unknown outlet id is refused`, async () => {
      expectRefused(
        await readers(randomUUID())[endpoint](wideCashier.client),
        [400, 403, 404, 422],
      );
    });
  }

  it("legend-hpgyw control: the cashier of outlet A reads all three at outlet A (200), so the refusals above are about access", async () => {
    const r = readers(world.outletA);
    for (const endpoint of ["customers", "products", "slots"] as const) {
      const reply = await r[endpoint](cashierA());
      expect(reply.status, `${endpoint}: ${JSON.stringify(reply.body)}`).toBe(
        200,
      );
    }
  });
});
