// O4 evidence (bead legend-wasr7.8): the offline cashier and the supervisor
// force close over the REAL API of the production build. Opt-in, it only
// takes screenshots:
//
//   O4_SHOTS=1 heavy --browser pnpm test:e2e
//
// Output: test-results/screenshots/legend-wasr7.8/o4-<scene>-<390|1280>.png
// (the review copies them to docs/review/img/). Offline = the API ping
// (`/api/health`) is blocked in the browser; every other call still answers,
// as on a tablet whose health check times out.
//
// World as in pos-real.spec.ts: one tenant seeded straight into the disposable
// database, staff are real Better Auth accounts, the till and the supervisor's
// screen are registered devices (token signed with the API's key).
import { createHmac, randomUUID } from "node:crypto";
import {
  expect,
  request,
  test,
  type APIRequestContext,
  type APIResponse,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import pg from "pg";
import { API_URL, PASSWORD, WEB_URL } from "./helpers.ts";
import { captureScreenshot } from "./screenshots.ts";

test.skip(!process.env.O4_SHOTS, "O4 screenshots run only with O4_SHOTS=1");

const BEAD = "legend-wasr7.8";
const PIN = "582914";
const FLOAT_IDR = 100_000;
const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
] as const;

const LIMITS = {
  maxOutlets: 5,
  maxActiveEmployees: 30,
  maxDevices: 40,
  aiRequestsPerMonth: 2_000,
  whatsappCostCapIdr: 0,
  aiCostCapIdr: 300_000,
  emailCostCapIdr: 50_000,
};
const OPENING_HOURS = Object.fromEntries(
  ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((day) => [
    day,
    { opens: "00:00", closes: "23:59" },
  ]),
);

const slug = `o4-shots-${randomUUID().slice(0, 8)}`;
const ids = {
  tenant: randomUUID(),
  brand: randomUUID(),
  entity: randomUUID(),
  outlet: randomUUID(),
  cashierRole: randomUUID(),
  supervisorRole: randomUUID(),
  category: randomUUID(),
  kopi: randomUUID(),
  teh: randomUUID(),
  till: randomUUID(),
  office: randomUUID(),
};

let db: pg.Pool;

function deviceToken(deviceId: string): string {
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
      deviceId,
      issuedAt: now - 5,
      expiresAt: now + 3600,
    }),
    "utf8",
  ).toString("base64url");
  const input = `dv1.${body}`;
  return `${input}.${createHmac("sha256", key).update(input).digest("base64url")}`;
}

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

async function seed(): Promise<void> {
  await db.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, $3, 'lengkap', 'active', 'shared', $4, $5, $6)`,
    [
      ids.tenant,
      slug,
      "Cafe Legend",
      JSON.stringify({
        modules: ["pos", "qr_order"],
        integrationProviders: [],
      }),
      JSON.stringify(LIMITS),
      randomUUID(),
    ],
  );
  await db.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Cafe Legend')`,
    [ids.brand, ids.tenant, `brand-${slug}`],
  );
  await db.query(
    `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Legend', false)`,
    [ids.entity, ids.tenant],
  );
  await db.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Cafe Legend Braga', 'Jl. Braga 12, Bandung', 'Asia/Jakarta', $6, 'active')`,
    [
      ids.outlet,
      ids.tenant,
      ids.brand,
      ids.entity,
      `O4-${slug}`.slice(0, 20).toUpperCase(),
      JSON.stringify(OPENING_HOURS),
    ],
  );
  const roles: [string, string, string[]][] = [
    [
      ids.cashierRole,
      "Kasir",
      [
        "order.view",
        "pos.sale.create",
        "pos.payment.accept",
        "shift.cash.operate",
      ],
    ],
    [
      ids.supervisorRole,
      "Supervisor",
      ["order.view", "shift.cash.approve_close", "shift.cash.view_all"],
    ],
  ];
  for (const [id, name, permissions] of roles)
    await db.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant"]')`,
      [id, ids.tenant, name, JSON.stringify(permissions)],
    );
  await asTenant(async (client) => {
    for (const [id, label] of [
      [ids.till, "Kasir 1"],
      [ids.office, "Tablet supervisor"],
    ])
      await client.query(
        `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
         VALUES ($1, $2, $3, 'pos', $4, now() - interval '1 minute')`,
        [id, ids.tenant, ids.outlet, label],
      );
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Minuman', 0)`,
      [ids.category, ids.tenant, ids.brand],
    );
    for (const [id, name] of [
      [ids.kopi, "Kopi Susu Legend"],
      [ids.teh, "Es Teh Lemon"],
    ])
      await client.query(
        `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
         VALUES ($1, $2, $3, $4, $5, true, $6)`,
        [id, ids.tenant, ids.brand, ids.category, name, randomUUID()],
      );
    for (const channel of ["dine_in", "takeaway"]) {
      const priceList = randomUUID();
      await client.query(
        `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
         VALUES ($1, $2, $3, $4, '2026-01-01')`,
        [priceList, ids.tenant, ids.outlet, channel],
      );
      for (const [item, price] of [
        [ids.kopi, 25_000],
        [ids.teh, 16_000],
      ] as const)
        await client.query(
          `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
           VALUES ($1, $2, $3, $4, $5)`,
          [randomUUID(), ids.tenant, priceList, item, price],
        );
    }
  });
}

async function taxes(publisherId: string): Promise<void> {
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), ids.tenant, publisherId],
    );
    await client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-O4', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), ids.tenant, publisherId],
    );
  });
}

type Member = { api: APIRequestContext; userId: string };

/** A Better Auth account holding one role; `api` carries its cookie. */
async function member(
  api: APIRequestContext,
  roleId: string,
  name: string,
): Promise<Member> {
  const signedUp = await api.post(`${API_URL}/api/auth/sign-up/email`, {
    headers: { Origin: WEB_URL },
    data: {
      name,
      email: `o4-${randomUUID()}@example.com`,
      password: PASSWORD,
    },
  });
  expect(signedUp.status(), await signedUp.text()).toBe(200);
  const session = await api.get(`${API_URL}/api/auth/get-session`);
  const userId = (await session.json()).user.id as string;
  await db.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [ids.tenant, userId, roleId],
  );
  return { api, userId };
}

function post(
  who: Member,
  deviceId: string,
  path: string,
  body: Record<string, unknown>,
  method: "post" | "put" = "post",
): Promise<APIResponse> {
  return who.api[method](`${API_URL}${path}`, {
    headers: { Origin: WEB_URL, "X-Device-Token": deviceToken(deviceId) },
    data: body,
  });
}

/** A browser context of one registered device, signed in as `roleId`. */
async function screen(
  browser: Browser,
  deviceId: string,
  roleId: string,
  name: string,
): Promise<{ context: BrowserContext; who: Member }> {
  const context = await browser.newContext({ baseURL: WEB_URL });
  const token = deviceToken(deviceId);
  await context.addInitScript((value) => {
    window.localStorage.setItem("legend.device.token", value);
  }, token);
  const who = await member(context.request, roleId, name);
  return { context, who };
}

const shot = (page: Page, scene: string, fullPage = false) =>
  captureScreenshot(
    page,
    `${BEAD}/o4-${scene}-${page.viewportSize()?.width ?? 0}.png`,
    { fullPage },
  );

async function goOffline(page: Page): Promise<void> {
  await page.route("**/api/health**", (route) =>
    route.abort("internetdisconnected"),
  );
  await expect(page.getByText(/^Offline ·/).first()).toBeVisible({
    timeout: 40_000,
  });
}

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

let shiftId = "";
let cashier: { context: BrowserContext; who: Member };
let supervisor: { context: BrowserContext; who: Member };
let witness: Member;

test.beforeAll(async ({ browser }) => {
  db = new pg.Pool({
    connectionString: process.env.STARTER_TEST_DATABASE_URL,
    max: 2,
  });
  await seed();
  cashier = await screen(browser, ids.till, ids.cashierRole, "Rina (Kasir)");
  supervisor = await screen(
    browser,
    ids.office,
    ids.supervisorRole,
    "Budi (Supervisor)",
  );
  witness = await member(
    await request.newContext(),
    ids.supervisorRole,
    "Sari (Supervisor)",
  );
  await taxes(supervisor.who.userId);
  const pin = await post(
    witness,
    ids.office,
    `/api/staff-pins/${ids.outlet}/${witness.userId}`,
    { pin: PIN },
    "put",
  );
  expect(pin.status(), await pin.text()).toBe(204);
  const opened = await post(
    cashier.who,
    ids.till,
    `/api/outlets/${ids.outlet}/pos/shifts`,
    { openingFloatIdr: FLOAT_IDR, idempotencyKey: randomUUID() },
  );
  expect(opened.status(), await opened.text()).toBe(201);
  shiftId = ((await opened.json()) as { data: { id: string } }).data.id;
});

test.afterAll(async () => {
  await cashier?.context.close();
  await supervisor?.context.close();
  await witness?.api.dispose();
  await db?.end();
});

test("offline cashier screens", async () => {
  const page = await cashier.context.newPage();
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await page.goto("/pos/kasir");
    // Online first: the tablet takes its offline kit on the first tick.
    await expect(
      page.getByRole("button", { name: /Kopi Susu Legend/ }).first(),
    ).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(6_000);
    await goOffline(page);

    await page
      .getByRole("button", { name: /Kopi Susu Legend/ })
      .first()
      .click();
    await page
      .getByRole("button", { name: /Es Teh Lemon/ })
      .first()
      .click();
    await shot(page, "banner");

    await page
      .getByRole("button", { name: /^Bayar/ })
      .last()
      .click();
    const pay = page.getByRole("dialog");
    await expect(pay.getByText("Bayar · offline")).toBeVisible();
    await pay
      .getByRole("button", { name: /^Rp\s?100\.000$/ })
      .first()
      .click();
    await shot(page, "bayar");

    await pay.getByRole("button", { name: "Simpan penjualan" }).click();
    await expect(
      page.getByText("Penjualan disimpan di tablet").first(),
    ).toBeVisible();
    await shot(page, "tersimpan");
    await page.getByRole("button", { name: "Pesanan baru" }).click();

    await page.getByRole("button", { name: "Lihat antrean" }).first().click();
    await expect(
      page.getByText("Penjualan offline di tablet ini").first(),
    ).toBeVisible();
    await shot(page, "antrean");
    await page.keyboard.press("Escape");

    await page.goto("/pos/shift/tutup");
    await expect(
      page.getByText("Shift belum bisa ditutup").first(),
    ).toBeVisible({ timeout: 30_000 });
    await shot(page, "tutup", true);

    await page.getByRole("button", { name: "Sign out" }).first().click();
    await expect(page.getByText("Belum bisa keluar").first()).toBeVisible();
    await shot(page, "keluar");
    await page.getByRole("button", { name: "Tetap di sini" }).click();
  }
  await page.close();
});

test("supervisor force close screens", async () => {
  const page = await supervisor.context.newPage();
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await page.goto(`/pos/supervisor/shift/${shiftId}`);
    await page
      .getByRole("button", { name: "Tutup paksa shift" })
      .first()
      .click({ timeout: 30_000 });
    await expect(page.getByText("Hitung ulang uang di laci")).toBeVisible({
      timeout: 30_000,
    });
    await shot(page, "paksa-hitung", true);
  }

  // One forced count, one witness approval, then the ready screen per width.
  await page.setViewportSize(VIEWPORTS[1]);
  // The drawer: the float plus two offline cash sales (Rp 45.100 each, as
  // counted by the supervisor in whole notes).
  await page.getByLabel(/^Rp\s?100\.000$/).fill("1");
  await page.getByLabel(/^Rp\s?50\.000$/).fill("1");
  await page.getByLabel(/^Rp\s?20\.000$/).fill("2");
  await page.getByRole("button", { name: /Kirim hitungan/ }).click();
  await expect(page.getByText("Menunggu supervisor lain")).toBeVisible({
    timeout: 30_000,
  });
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await shot(page, "paksa-saksi", true);
  }
  await page.getByLabel("PIN supervisor").fill(PIN);
  await page.getByRole("button", { name: "Setujui hitungan" }).click();
  await expect(page.getByText("Persetujuan diterima")).toBeVisible({
    timeout: 30_000,
  });
  await page
    .getByRole("textbox")
    .last()
    .fill("Tablet kasir rusak, antrean offline belum terkirim");
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await shot(page, "paksa-siap", true);
  }
  await page.getByRole("button", { name: "Tutup paksa shift" }).click();
  await expect(page.getByText("Shift ditutup paksa").first()).toBeVisible({
    timeout: 30_000,
  });
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await shot(page, "paksa-selesai", true);
  }
  await page.close();
});
