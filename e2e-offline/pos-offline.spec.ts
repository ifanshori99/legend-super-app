// O5 (legend-wasr7.9): the cashier tablet offline, in a real browser on a
// tenant host. See playwright.offline.config.ts for the harness.
//
// STATUS (27 Nov): full scenario. Harness proven (tenant host,
// cookie domain, session, shift, kit, real offline, screenshots); a click on the
// menu tile "Kopi Susu" does not add it to the cart in this build, see
// docs/briefs/1272-o5-progress.md.
//
// Story: online cashier screen (the kit is fetched) -> the internet goes away
// -> cash sale saved on the tablet -> queue sheet -> shift close refused while
// the queue is not empty -> internet back -> the queue sends itself, the
// cloud holds the sale once -> sign-out allowed.
import { createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chromium,
  expect,
  request,
  test as base,
  type Page,
} from "@playwright/test";
import pg from "pg";
import {
  OFFLINE_API_URL,
  OFFLINE_SLUG,
  OFFLINE_WEB_URL,
} from "../playwright.offline.config.ts";

const PASSWORD = "A-long-test-password-123!";
const FLOAT_IDR = 100_000;
const KOPI_IDR = 25_000;
const hostname = `${OFFLINE_SLUG}.legend.test`;
const DIRECT_API = "http://127.0.0.1:4101";
const ids = {
  tenant: randomUUID(),
  brand: randomUUID(),
  entity: randomUUID(),
  outlet: randomUUID(),
  cashierRole: randomUUID(),
  category: randomUUID(),
  kopi: randomUUID(),
  device: randomUUID(),
};
const LIMITS = {
  maxOutlets: 5,
  maxActiveEmployees: 30,
  maxDevices: 40,
  aiRequestsPerMonth: 2_000,
  whatsappCostCapIdr: 0,
  aiCostCapIdr: 300_000,
  emailCostCapIdr: 50_000,
};
const DAY_HOURS = { opens: "00:00", closes: "23:59" };
const OPENING_HOURS = Object.fromEntries(
  ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((day) => [
    day,
    DAY_HOURS,
  ]),
);

let db: pg.Pool;
const cashier = { email: `e2e-${randomUUID()}@example.com`, userId: "" };

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
      expiresAt: now + 6 * 3600,
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

async function seedWorld(): Promise<void> {
  await db.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, $3, 'lengkap', 'active', 'shared', $4, $5, $6)`,
    [
      ids.tenant,
      OFFLINE_SLUG,
      `Tenant ${OFFLINE_SLUG}`,
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
    [ids.brand, ids.tenant, `brand-${OFFLINE_SLUG}`, "Kafe Offline"],
  );
  await db.query(
    `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)`,
    [ids.entity, ids.tenant, `Entity ${OFFLINE_SLUG}`],
  );
  await db.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, 'OUT-O5', 'Outlet Offline', 'Jl. Braga 12, Bandung', 'Asia/Jakarta', $5, 'active')`,
    [
      ids.outlet,
      ids.tenant,
      ids.brand,
      ids.entity,
      JSON.stringify(OPENING_HOURS),
    ],
  );
  await db.query(
    `INSERT INTO tenant_domains (id, tenant_id, brand_id, hostname, kind, tls_status, verified_at)
     VALUES ($1, $2, $3, $4, 'platform_subdomain', 'active', now())`,
    [randomUUID(), ids.tenant, ids.brand, hostname],
  );
  await db.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'E2E Kasir', false, NULL, $3, false, '["tenant"]')`,
    [
      ids.cashierRole,
      ids.tenant,
      JSON.stringify([
        "order.view",
        "pos.sale.create",
        "pos.payment.accept",
        "shift.cash.operate",
      ]),
    ],
  );
  await asTenant((client) =>
    client.query(
      `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
       VALUES ($1, $2, $3, 'pos', 'Kasir E2E', now() - interval '1 minute')`,
      [ids.device, ids.tenant, ids.outlet],
    ),
  );
}

async function seedCashier(): Promise<void> {
  const api = await request.newContext({ baseURL: DIRECT_API });
  const signedUp = await api.post("/api/auth/sign-up/email", {
    headers: { Origin: OFFLINE_WEB_URL, Host: "api.legend.test:4101" },
    data: { name: "Kasir Offline", email: cashier.email, password: PASSWORD },
  });
  expect(signedUp.status(), await signedUp.text()).toBe(200);
  // The session cookie is for `.legend.test`, so this loopback client never
  // sends it back: the sign-up answer carries the user.
  cashier.userId = (
    (await signedUp.json()) as { user: { id: string } }
  ).user.id;
  await api.dispose();
  await db.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [ids.tenant, cashier.userId, ids.cashierRole],
  );
}

async function seedCatalog(): Promise<void> {
  await asTenant(async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Minuman', 0)`,
      [ids.category, ids.tenant, ids.brand],
    );
    await client.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5)`,
      [ids.kopi, ids.tenant, ids.brand, ids.category, randomUUID()],
    );
    for (const channel of ["dine_in", "takeaway"]) {
      const list = randomUUID();
      await client.query(
        `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
         VALUES ($1, $2, $3, $4, '2026-01-01')`,
        [list, ids.tenant, ids.outlet, channel],
      );
      await client.query(
        `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), ids.tenant, list, ids.kopi, KOPI_IDR],
      );
    }
    await client.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), ids.tenant, cashier.userId],
    );
    await client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-E2E', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), ids.tenant, cashier.userId],
    );
  });
}

/** A fetch made by the page itself: the browser's cookies, origin and host. */
async function browserCall(
  page: Page,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  return page.evaluate(
    async ({ api, method, path, body, token }) => {
      const response = await fetch(`${api}${path}`, {
        method,
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "X-Device-Token": token,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return {
        status: response.status,
        body: await response.json().catch(() => null),
      };
    },
    { api: OFFLINE_API_URL, method, path, body, token: deviceToken() },
  );
}

// Service workers and the Cache API exist only in secure contexts, and the
// test origins are plain http on a non-localhost name (production is https).
// Chromium treats them as secure only with a user data directory, so this
// spec runs in a persistent context. Harness only.
const test = base.extend({
  context: async ({ baseURL }, use) => {
    const dir = mkdtempSync(join(tmpdir(), "o5-chromium-"));
    const context = await chromium.launchPersistentContext(dir, {
      // The new headless mode (full Chromium) honors the secure-origin flag;
      // the old headless shell ignores it.
      channel: "chromium",
      baseURL,
      serviceWorkers: "allow",
      viewport: { width: 390, height: 844 },
      args: [
        "--host-resolver-rules=MAP *.legend.test 127.0.0.1",
        `--unsafely-treat-insecure-origin-as-secure=${OFFLINE_WEB_URL},${OFFLINE_API_URL}`,
      ],
    });
    await use(context);
    await context.close();
    rmSync(dir, { recursive: true, force: true });
  },
});

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  db = new pg.Pool({
    connectionString: process.env.STARTER_TEST_DATABASE_URL,
    max: 2,
  });
  await seedWorld();
  await seedCashier();
  await seedCatalog();
});

test.afterAll(async () => {
  await db.end();
});

const SHOTS = "docs/review/img";
const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
];

const shot = (page: Page, scene: string, fullPage = false) =>
  page.screenshot({
    path: `${SHOTS}/o5-${scene}-${page.viewportSize()?.width ?? 0}.png`,
    fullPage,
  });

/** Both widths of the same screen (phone first, then the tablet). */
async function shotBoth(page: Page, scene: string, fullPage = false) {
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(400);
    await shot(page, scene, fullPage);
  }
}

async function offlineSales(): Promise<
  { state: string; flags: string[]; totalIdr: string }[]
> {
  return asTenant(async (client) => {
    const { rows } = await client.query(
      `SELECT state, flags, payload->>'totalIdr' AS "totalIdr"
         FROM pos_offline_sales WHERE tenant_id = $1 ORDER BY sequence_number`,
      [ids.tenant],
    );
    return rows;
  });
}

test("the offline till: sell, queue, close refused, ingest once, sign out", async ({
  page,
  context,
}) => {
  test.setTimeout(240_000);
  await page.addInitScript((token) => {
    window.localStorage.setItem("legend.device.token", token);
  }, deviceToken());
  await page.goto("/sign-in");
  expect(await page.evaluate(() => window.isSecureContext)).toBe(true);
  const signIn = await browserCall(page, "POST", "/api/auth/sign-in/email", {
    email: cashier.email,
    password: PASSWORD,
  });
  expect(signIn.status, JSON.stringify(signIn.body)).toBe(200);
  const opened = await browserCall(
    page,
    "POST",
    `/api/outlets/${ids.outlet}/pos/shifts`,
    { openingFloatIdr: FLOAT_IDR, idempotencyKey: randomUUID() },
  );
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);

  // Online first: the tablet takes its offline kit on its first tick.
  await page.setViewportSize(VIEWPORTS[0]!);
  await page.goto("/pos/kasir");
  await expect(
    page.getByRole("button", { name: /Kopi Susu/ }).first(),
  ).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(8_000);
  await page
    .getByRole("button", { name: /Kopi Susu/ })
    .first()
    .click();

  // The internet goes away for real: every request of the browser fails.
  const offlineBanner = page.getByText(/^Offline ·/).first();
  await context.setOffline(true);
  await expect(offlineBanner).toBeVisible({ timeout: 40_000 });
  await shot(page, "banner");

  // Phones: the cart is its own view and opening it is a navigation of the
  // app. Offline it must still work (release bug found 27 Nov: the root
  // beforeLoad read the session from the server and landed on "Terjadi
  // kesalahan"). The cart and the offline kit stay on the tablet.
  await page.getByRole("button", { name: /Lihat keranjang/ }).click();
  await expect(page.getByText("Subtotal · 1 item").first()).toBeVisible();

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    if (viewport.width > 700) {
      await page
        .getByRole("button", { name: /Kopi Susu/ })
        .first()
        .click();
      await shot(page, "banner");
    }
    await page
      .getByRole("button", { name: /^Bayar/ })
      .last()
      .click();
    const pay = page.getByRole("dialog");
    await expect(pay.getByText("Bayar · offline")).toBeVisible();
    await pay.getByRole("button", { name: "Uang pas" }).first().click();
    await shot(page, "bayar");
    await pay.getByRole("button", { name: "Simpan penjualan" }).click();
    await expect(
      page.getByRole("heading", { name: "Penjualan disimpan di tablet" }),
    ).toBeVisible();
    await shot(page, "tersimpan");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Pesanan baru" })
      .click();
  }

  await page.getByRole("button", { name: "Lihat antrean" }).first().click();
  await expect(
    page.getByText("Penjualan offline di tablet ini").first(),
  ).toBeVisible();
  await shotBoth(page, "antrean");
  await page.keyboard.press("Escape");
  // Nothing reached the cloud while the tablet was offline.
  expect(await offlineSales()).toEqual([]);

  // Still offline: the close screen was never opened on this tablet, so its
  // code comes from the service worker's precache (CTO 27 Nov, 6 a), and the
  // screen says it needs the internet and holds the count (6 b and c).
  await page.evaluate(() => {
    window.history.pushState({}, "", "/pos/shift/tutup");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(
    page.getByText("Tutup shift butuh internet").first(),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Tutup shift · Hitung kas")).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Kembali ke kasir" }),
  ).toBeVisible();
  await shotBoth(page, "tutup-offline");

  // Shift close is refused while the queue is not empty. The tablet gets its
  // internet back but the batch endpoint keeps failing (a flaky link), so the
  // two sales stay on the tablet; the close screen is a real page load.
  await context.route("**/api/outlets/*/pos/offline-batch", (route) =>
    route.abort(),
  );
  await context.setOffline(false);
  await page.goto("/pos/shift/tutup");
  await expect(page.getByText("Shift belum bisa ditutup").first()).toBeVisible({
    timeout: 30_000,
  });
  await shotBoth(page, "tutup", true);
  // The till frame has no sign-out button; a cashier signs out from the member
  // page, which holds the same queue guard.
  await page.goto("/member");
  await page
    .locator("html[data-hydrated='true']")
    .waitFor({ state: "attached" });
  await expect(
    page.getByRole("button", { name: "Sign out" }).first(),
  ).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Sign out" }).first().click();
  await expect(page.getByText("Belum bisa keluar").first()).toBeVisible({
    timeout: 15_000,
  });
  await shotBoth(page, "keluar");
  await page.getByRole("button", { name: "Tetap di sini" }).click();
  expect(await offlineSales()).toEqual([]);
  // Back at the till the queue sends itself once the link works.
  await page.goto("/pos/kasir");
  await context.unroute("**/api/outlets/*/pos/offline-batch");

  // The internet is back: the queue sends itself, the cloud holds each sale
  // once, at the price the tablet showed (Rp25.000 + PBJT 10%).
  await expect
    .poll(async () => (await offlineSales()).length, { timeout: 120_000 })
    .toBe(2);
  const sold = await offlineSales();
  for (const sale of sold) {
    expect(sale.state).toBe("ingested");
    expect(sale.flags).toEqual([]);
    expect(sale.totalIdr).toBe("27500");
  }
  // A later sync repeats nothing: still two sales, two numbers.
  await page.waitForTimeout(65_000);
  expect(await offlineSales()).toHaveLength(2);
  const numbers = await asTenant(async (client) => {
    const { rows } = await client.query(
      `SELECT count(*)::int AS orders FROM orders
        WHERE tenant_id = $1 AND id IN (SELECT event_id FROM pos_offline_sales WHERE tenant_id = $1)`,
      [ids.tenant],
    );
    return rows[0].orders as number;
  });
  expect(numbers).toBe(2);

  // Queue empty: the close and the sign-out are no longer held.
  await page.goto("/pos/shift/tutup");
  await expect(page.getByText("Tutup shift · Hitung kas").first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("Shift belum bisa ditutup")).toHaveCount(0);
  await shotBoth(page, "tutup-bebas", true);
});
