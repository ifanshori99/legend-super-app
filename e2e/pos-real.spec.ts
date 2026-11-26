// 1268 W6: the outlet's till over the real API of the production build.
//
// Story (brief 1268 section 7, as far as it runs without a payment gateway):
// open shift -> cash sale with change -> EDC standalone (supervisor PIN) ->
// blind count -> supervisor PIN -> shift closed, drawer figure checked.
//
// QRIS is not here: the production build has no simulated gateway (the Duitku
// adapter refuses a sandbox account in a production build and calls the
// provider over the network). It stays in apps/api tests until a fake provider
// exists (see apps/web/src/features/ws04-pos-kasir/CONTRACT-GAPS.md).
//
// World: one tenant seeded straight into the disposable database, reached by
// its own host `<slug>.legend.test` (a registered tenant domain, the same
// routing as a production subdomain; the Host header is sent, so no DNS is needed). Staff are real Better Auth
// accounts with role assignments; the till is a registered device whose token
// is signed with the key the API derives from BETTER_AUTH_SECRET.
import { createHmac, randomUUID } from "node:crypto";
import {
  expect,
  request,
  test,
  type APIRequestContext,
  type APIResponse,
} from "@playwright/test";
import pg from "pg";
import { API_URL, PASSWORD, WEB_URL } from "./helpers.ts";

const PIN = "582914";
const KOPI_IDR = 25_000;
const FLOAT_IDR = 100_000;
// 2 x Kopi Susu Rp25.000 = Rp50.000 + PBJT 10% = Rp55.000.
const SALE_IDR = 55_000;
const HANDED_IDR = 100_000;

// The same plan limits and opening hours the platform fixtures use.
const LIMITS = {
  maxOutlets: 5,
  maxActiveEmployees: 30,
  maxDevices: 40,
  aiRequestsPerMonth: 2_000,
  whatsappCostCapIdr: 0,
  aiCostCapIdr: 300_000,
  emailCostCapIdr: 50_000,
};
const DAY_HOURS = { opens: "08:00", closes: "22:00" };
const OPENING_HOURS = Object.fromEntries(
  ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((day) => [
    day,
    DAY_HOURS,
  ]),
);

const slug = `pos-real-${randomUUID().slice(0, 8)}`;
// `.localhost` is refused as a tenant host (shared normalizeHostname), so the
// tenant gets a `.legend.test` name, as in the API tests; only the Host header
// carries it, no DNS is needed.
const hostname = `${slug}.legend.test`;
const ids = {
  tenant: randomUUID(),
  brand: randomUUID(),
  entity: randomUUID(),
  outlet: randomUUID(),
  cashierRole: randomUUID(),
  supervisorRole: randomUUID(),
  category: randomUUID(),
  kopi: randomUUID(),
  priceList: randomUUID(),
  device: randomUUID(),
  terminal: randomUUID(),
};

type Member = { api: APIRequestContext; userId: string };

let db: pg.Pool;
let cashier: Member;
let supervisor: Member;
const state: { shiftId: string; countId: string } = {
  shiftId: "",
  countId: "",
};

// ---- The API's own device token (lib/device-token.ts): HMAC-SHA256 ---------

function deviceToken(): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret)
    throw new Error("BETTER_AUTH_SECRET is not set for the e2e run.");
  const key = createHmac("sha256", secret)
    .update("legend.device-token.v1")
    .digest();
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(
    JSON.stringify({
      version: 1,
      tenantId: ids.tenant,
      brandId: null,
      deviceId: ids.device,
      issuedAt: now - 5,
      expiresAt: now + 3600,
    }),
    "utf8",
  ).toString("base64url");
  const input = `dv1.${body}`;
  return `${input}.${createHmac("sha256", key).update(input).digest("base64url")}`;
}

// ---- Seeding ---------------------------------------------------------------

/** Owner-side writes set the tenant local, because RLS is forced. */
async function asTenant<T>(
  run: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [ids.tenant],
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

async function seedTenant(): Promise<void> {
  await db.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, $3, 'lengkap', 'active', 'shared', $4, $5, $6)`,
    [
      ids.tenant,
      slug,
      `Tenant ${slug}`,
      JSON.stringify({
        modules: ["pos", "qr_order"],
        integrationProviders: [],
      }),
      JSON.stringify(LIMITS),
      randomUUID(),
    ],
  );
  await db.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)`,
    [ids.brand, ids.tenant, `brand-${slug}`, `Brand ${slug}`],
  );
  await db.query(
    `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)`,
    [ids.entity, ids.tenant, `Entity ${slug}`],
  );
  await db.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Braga 12, Bandung', 'Asia/Jakarta', $7, 'active')`,
    [
      ids.outlet,
      ids.tenant,
      ids.brand,
      ids.entity,
      `OUT-${slug}`.slice(0, 20).toUpperCase(),
      `Outlet ${slug}`,
      JSON.stringify(OPENING_HOURS),
    ],
  );
  await db.query(
    `INSERT INTO tenant_domains (id, tenant_id, brand_id, hostname, kind, tls_status, verified_at)
     VALUES ($1, $2, $3, $4, 'platform_subdomain', 'active', now())`,
    [randomUUID(), ids.tenant, ids.brand, hostname],
  );
  const roles: [string, string, string[]][] = [
    [
      ids.cashierRole,
      "E2E Kasir",
      [
        "order.view",
        "pos.sale.create",
        "pos.payment.accept",
        "shift.cash.operate",
      ],
    ],
    [
      ids.supervisorRole,
      "E2E Supervisor",
      [
        "order.view",
        "pos.edc_standalone.approve",
        "shift.cash.approve_close",
        "shift.cash.view_all",
      ],
    ],
  ];
  for (const [id, name, permissions] of roles)
    await db.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant"]')`,
      [id, ids.tenant, name, JSON.stringify(permissions)],
    );
  // The till: a registered device. `token_issued_at` one minute back keeps the
  // token minted below current.
  await asTenant((client) =>
    client.query(
      `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
       VALUES ($1, $2, $3, 'pos', 'Kasir E2E', now() - interval '1 minute')`,
      [ids.device, ids.tenant, ids.outlet],
    ),
  );
}

async function seedCatalog(supervisorId: string): Promise<void> {
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'E2E Kasir', 0)`,
      [ids.category, ids.tenant, ids.brand],
    );
    await client.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5)`,
      [ids.kopi, ids.tenant, ids.brand, ids.category, randomUUID()],
    );
    await client.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'takeaway', '2026-01-01')`,
      [ids.priceList, ids.tenant, ids.outlet],
    );
    await client.query(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), ids.tenant, ids.priceList, ids.kopi, KOPI_IDR],
    );
    await client.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), ids.tenant, supervisorId],
    );
    await client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-E2E', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), ids.tenant, supervisorId],
    );
    await client.query(
      `INSERT INTO payment_edc_terminals
         (id, tenant_id, outlet_id, bank_code, terminal_id, merchant_id, model,
          connection, ip_address, supported_methods, status)
       VALUES ($1, $2, $3, 'bca', 'TID-E2E', 'MID-E2E', 'Test EDC', 'lan',
               '10.0.0.8', ARRAY['card','qris'], 'active')`,
      [ids.terminal, ids.tenant, ids.outlet],
    );
  });
}

/** A real Better Auth account holding one role of the tenant. */
async function member(roleId: string, name: string): Promise<Member> {
  const api = await request.newContext({ baseURL: API_URL });
  const signedUp = await api.post("/api/auth/sign-up/email", {
    headers: { Origin: WEB_URL },
    data: {
      name,
      email: `e2e-${randomUUID()}@example.com`,
      password: PASSWORD,
    },
  });
  expect(signedUp.status()).toBe(200);
  const session = await api.get("/api/auth/get-session");
  const userId = (await session.json()).user.id as string;
  await db.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [ids.tenant, userId, roleId],
  );
  return { api, userId };
}

// ---- Calls -------------------------------------------------------------------

const posBase = `/api/outlets/${ids.outlet}/pos`;

function call(
  who: Member,
  method: "get" | "post",
  path: string,
  body?: Record<string, unknown>,
  // The overrides route reads its key from the Idempotency-Key header; the
  // POS routes take it in the body.
  keyIn: "body" | "header" = "body",
): Promise<APIResponse> {
  const headers: Record<string, string> = {
    Host: hostname,
    Origin: WEB_URL,
    "X-Device-Token": deviceToken(),
  };
  if (method === "get") return who.api.get(path, { headers });
  if (keyIn === "header") headers["Idempotency-Key"] = randomUUID();
  return who.api.post(path, {
    headers,
    data: keyIn === "body" ? { idempotencyKey: randomUUID(), ...body } : body,
  });
}

// The answers are read field by field, as the API tests do.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function data<T = Record<string, any>>(
  response: APIResponse,
  status: number,
): Promise<T> {
  const text = await response.text();
  expect(response.status(), text).toBe(status);
  return (JSON.parse(text) as { data: T }).data;
}

/** Cashier keys the order, submits it when it is still a draft. */
async function newOrder(): Promise<{
  id: string;
  number: string;
  totalIdr: number;
  status: string;
}> {
  const created = await data(
    await call(cashier, "post", `${posBase}/orders`, {
      channel: "pos",
      serviceType: "takeaway",
      items: [{ menuItemId: ids.kopi, quantity: 2, modifierIds: [] }],
    }),
    201,
  );
  let status = created.status as string;
  if (status === "draft") {
    const submitted = await data(
      await call(cashier, "post", `${posBase}/orders/${created.id}/submit`, {
        expectedStatus: status,
      }),
      200,
    );
    status = submitted.status as string;
  }
  return {
    id: created.id as string,
    number: created.number as string,
    totalIdr: created.totalIdr as number,
    status,
  };
}

/** Banknotes that add up to `total`, largest first. */
function countsFor(total: number) {
  let rest = total;
  const lines: { denominationIdr: number; quantity: number }[] = [];
  for (const denominationIdr of [
    100_000, 50_000, 20_000, 10_000, 5_000, 1_000,
  ]) {
    const quantity = Math.floor(rest / denominationIdr);
    if (quantity > 0) lines.push({ denominationIdr, quantity });
    rest -= quantity * denominationIdr;
  }
  return lines;
}

/** The supervisor's own PIN approves what the cashier asks for. */
async function approve(input: {
  action: "edc_standalone" | "cash_shift_close";
  objectType: string;
  objectId: string;
  valueIdr: number;
  reason: string;
}): Promise<string> {
  const response = await call(
    cashier,
    "post",
    "/api/pos-overrides",
    {
      outletId: ids.outlet,
      action: input.action,
      valueIdr: input.valueIdr,
      reason: input.reason,
      objectType: input.objectType,
      objectId: input.objectId,
      approval: {
        method: "supervisor_pin",
        approverUserId: supervisor.userId,
        pin: PIN,
      },
    },
    "header",
  );
  const override = await data(response, 201);
  expect(override.status).toBe("approved");
  return override.id as string;
}

// ---- The story -----------------------------------------------------------------

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  db = new pg.Pool({
    connectionString: process.env.STARTER_TEST_DATABASE_URL,
    max: 2,
  });
  await seedTenant();
  cashier = await member(ids.cashierRole, "E2E Kasir");
  supervisor = await member(ids.supervisorRole, "E2E Supervisor");
  await seedCatalog(supervisor.userId);
  // The supervisor sets their own PIN, as on the tablet (PUT /api/staff-pins).
  const pin = await supervisor.api.put(
    `/api/staff-pins/${ids.outlet}/${supervisor.userId}`,
    {
      headers: { Host: hostname, Origin: WEB_URL },
      data: { pin: PIN },
    },
  );
  expect(pin.status(), await pin.text()).toBe(204);
});

test.afterAll(async () => {
  await cashier?.api.dispose();
  await supervisor?.api.dispose();
  // Orders, audit rows and receipts are append-only: the tenant stays in the
  // disposable database. Give it a valid creator for tenant listings.
  await db.end();
});

test("the cashier opens a shift with a float, and a second open is refused", async () => {
  const shift = await data(
    await call(cashier, "post", `${posBase}/shifts`, {
      openingFloatIdr: FLOAT_IDR,
    }),
    201,
  );
  state.shiftId = shift.id as string;
  const again = await call(cashier, "post", `${posBase}/shifts`, {
    openingFloatIdr: FLOAT_IDR,
  });
  expect(again.status()).toBeGreaterThanOrEqual(400);
  expect(again.status()).toBeLessThan(500);
});

test("a cash sale gives change and the order completes", async () => {
  const order = await newOrder();
  expect(order.totalIdr).toBe(SALE_IDR);
  const paid = await data(
    await call(cashier, "post", `${posBase}/orders/${order.id}/tenders`, {
      method: "cash",
      receivedIdr: HANDED_IDR,
      expectedStatus: order.status,
    }),
    201,
  );
  expect(paid.tender).toMatchObject({
    method: "cash",
    amountIdr: SALE_IDR,
    receivedIdr: HANDED_IDR,
    changeIdr: HANDED_IDR - SALE_IDR,
  });
  expect(paid.remainingIdr).toBe(0);
  const done = await data(
    await call(cashier, "post", `${posBase}/orders/${order.id}/complete`, {
      expectedStatus: paid.order.status,
    }),
    200,
  );
  expect(done.status).toBe("completed");
});

test("EDC standalone: supervisor PIN settles the bill once, flagged for reconciliation", async () => {
  const order = await newOrder();
  const overrideId = await approve({
    action: "edc_standalone",
    objectType: "pos_order",
    objectId: order.id,
    valueIdr: order.totalIdr,
    reason: "Agen EDC mati, kunci manual",
  });
  const standalone = {
    terminalId: ids.terminal,
    bankRef: "123456789012",
    approvalCode: "A1B2C3",
    overrideId,
  };
  const paid = await data(
    await call(cashier, "post", `${posBase}/orders/${order.id}/tenders`, {
      method: "edc_card",
      expectedStatus: order.status,
      standalone,
    }),
    201,
  );
  expect(paid.remainingIdr).toBe(0);
  // One override pays one bill, once.
  const second = await call(
    cashier,
    "post",
    `${posBase}/orders/${order.id}/tenders`,
    { method: "edc_card", expectedStatus: paid.order.status, standalone },
  );
  expect(second.status()).toBeGreaterThanOrEqual(400);
  expect(second.status()).toBeLessThan(500);
  const rows = await db.query(
    `SELECT status, mode, needs_reconciliation, rrn, amount_idr::int AS amount_idr
       FROM edc_transactions
      WHERE tenant_id = $1 AND reference = $2 AND mode = 'standalone'`,
    [ids.tenant, order.number],
  );
  expect(rows.rows).toEqual([
    {
      status: "approved",
      mode: "standalone",
      needs_reconciliation: true,
      rrn: "123456789012",
      amount_idr: SALE_IDR,
    },
  ]);
  const done = await data(
    await call(cashier, "post", `${posBase}/orders/${order.id}/complete`, {
      expectedStatus: paid.order.status,
    }),
    200,
  );
  expect(done.status).toBe("completed");
});

test("blind count, supervisor PIN, shift closes; only cash is in the drawer", async () => {
  const blind = await data(
    await call(cashier, "get", `${posBase}/shifts/${state.shiftId}`),
    200,
  );
  expect(blind.shift.expectedIdr).toBeNull();

  // Drawer: float + the cash sale. The EDC bill never touched it.
  const expectedIdr = FLOAT_IDR + SALE_IDR;
  const counted = await data(
    await call(cashier, "post", `${posBase}/shifts/${state.shiftId}/counts`, {
      counts: countsFor(expectedIdr),
    }),
    201,
  );
  expect(counted.countedIdr).toBe(expectedIdr);
  expect(counted).not.toHaveProperty("expectedIdr");
  expect(counted).not.toHaveProperty("varianceIdr");
  expect(counted.noteRequired).toBe(false);
  state.countId = counted.id as string;

  // Closing without an approval is refused.
  const bare = await call(
    cashier,
    "post",
    `${posBase}/shifts/${state.shiftId}/close`,
    {
      countId: state.countId,
      approvedBy: supervisor.userId,
      approvalRequestId: randomUUID(),
    },
  );
  expect(bare.status()).toBeGreaterThanOrEqual(400);
  expect(bare.status()).toBeLessThan(500);

  const approvalId = await approve({
    action: "cash_shift_close",
    objectType: "pos_shift_count",
    objectId: state.countId,
    valueIdr: 0,
    reason: "Hitung kas akhir shift",
  });
  const closed = await data(
    await call(cashier, "post", `${posBase}/shifts/${state.shiftId}/close`, {
      countId: state.countId,
      approvedBy: supervisor.userId,
      approvalRequestId: approvalId,
    }),
    200,
  );
  // The cashier's answer stays blind.
  expect(closed).toMatchObject({
    status: "closed",
    expectedIdr: null,
    varianceIdr: null,
  });

  const report = await data(
    await call(supervisor, "get", `${posBase}/shifts/${state.shiftId}`),
    200,
  );
  expect(report.shift).toMatchObject({
    status: "closed",
    expectedIdr,
    countedIdr: expectedIdr,
    varianceIdr: 0,
  });
});
