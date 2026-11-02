// WS-09 guest Wi-Fi captive portal (bead legend-g9r3; PRD v1.7 §3 Kelompok C
// "Wi-Fi Tamu & WFC", §4 Alur X, FAC-11/FAC-12/FAC-13).
//
// Run: pnpm test:e2e:mock e2e/legend-g9r3.mock.spec.ts — mock mode only, no API
// and no DB. The portal builds absolute links and a role cookie from one
// origin, so this file reads E2E_MOCK_BASE_URL (the mock runner sets it) and
// skips when it is missing.
import { expect, test } from "@playwright/test";

declare global {
  interface Window {
    /** Mock-mode controls from features/ws09-wifi/mock.ts (production: absent). */
    __legendWifiMock: {
      pay(sameDaySpendIdr: number): void;
      consume(usedMinutes: number): void;
    };
  }
}

const base = process.env.E2E_MOCK_BASE_URL;
const ZONE = "00000000-0000-4000-8000-000000009401";
const FACILITY = "00000000-0000-4000-8000-000000009002";
const TABLE = "st_01JC0QRD4M5N6P7Q8R9S0T1V2W";

test.skip(!base, "Run with pnpm test:e2e:mock so E2E_MOCK_BASE_URL is set.");
// FAC-12/FAC-13 wait for the portal's 30-second quota poll, so allow more time.
test.describe.configure({ timeout: 90_000 });

async function openPortal(
  page: import("@playwright/test").Page,
  options: { table?: string; role?: string; query?: string } = {},
) {
  if (options.role)
    await page
      .context()
      .addCookies([
        { name: "legend-mock-role", value: options.role, url: base },
      ]);
  const table = options.table ?? TABLE;
  const query = options.query ?? "";
  await page.goto(
    `${base}/wifi?zone=${ZONE}&facility=${FACILITY}&table=${table}${query}`,
  );
  await expect(page.getByRole("heading", { name: "Wi-Fi Tamu" })).toBeVisible();
  // The mock runtime (and its controls) load with the first fixture call.
  await page.waitForFunction(
    () => Boolean(window.__legendWifiMock),
    undefined,
    {
      timeout: 10_000,
    },
  );
}

test("FAC-11 a guest opens the table menu from the portal without a Wi-Fi login", async ({
  page,
}) => {
  await openPortal(page, { role: "none" });
  await expect(
    page.getByRole("heading", { name: "Masuk dengan WhatsApp" }),
  ).toBeVisible();
  const menu = page.getByRole("link", { name: "Pesan makanan & minuman" });
  await expect(menu).toHaveAttribute("href", `/t/${TABLE}`);
  await menu.click();
  await expect(page).toHaveURL(new RegExp(`/t/${TABLE}$`));
});

test("FAC-12 the connect screen turns into the quota meter and the allowance is the day's", async ({
  page,
}) => {
  await openPortal(page, { query: "&mock=empty" });
  // The device limit is stated before the guest connects (FAC-12).
  await expect(page.getByText("Maksimal 2 perangkat per akun")).toBeVisible();
  await page.getByRole("button", { name: "Sambungkan Wi-Fi" }).click();
  await expect(
    page.getByRole("heading", { name: "Sisa kuota hari ini" }),
  ).toBeVisible();
  // 2 free hours + 3 hours from the fixture's Rp90.000 of paid spend.
  await expect(page.getByText("0 dari 300 menit terpakai")).toBeVisible();
  await expect(page.getByText("5 jam", { exact: false })).toBeVisible();
});

test("FAC-12 the quota grows within a minute after a paid order", async ({
  page,
}) => {
  await openPortal(page);
  await expect(page.getByText("4 jam 15 menit")).toBeVisible();
  // A paid order lands at the POS; the portal re-reads the session on its poll.
  await page.evaluate(() => window.__legendWifiMock.pay(120_000));
  await expect(page.getByText("5 jam 15 menit")).toBeVisible({
    timeout: 45_000,
  });
});

test("FAC-13 a spent quota drops to the base speed and the session is never disconnected", async ({
  page,
}) => {
  await openPortal(page);
  await page.evaluate(() => window.__legendWifiMock.consume(300));
  await expect(page.getByText("Kecepatan dasar").first()).toBeVisible({
    timeout: 45_000,
  });
  await expect(page.getByText("Kuota habis", { exact: true })).toBeVisible();
  await expect(page.getByText(/tidak diputus/)).toBeVisible();
  await expect(page.getByText("Tambah 1 jam").first()).toBeVisible();
});

test("the '+1 jam' reminder opens the drinks menu of the table", async ({
  page,
}) => {
  await openPortal(page);
  await page.evaluate(() => window.__legendWifiMock.consume(288));
  await expect(page.getByText("Kuota hampir habis")).toBeVisible({
    timeout: 45_000,
  });
  await page.getByRole("button", { name: "Tambah 1 jam" }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("link", { name: "Buka menu meja" }),
  ).toHaveAttribute("href", `/t/${TABLE}`);
});
