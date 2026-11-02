import { expect, test, type Page } from "@playwright/test";

// Mock-mode spec: the notification center (bead legend-w3v, PRD §3.15 F15,
// §2 PWA). It runs against a web server with VITE_API_MOCK=true, so every
// request is served by features/ws05-notifications/mock.ts from the shared
// fixture set: no API and no database.

const NOTIFICATION_CENTER = "/kelola/notifikasi";

/** Mock mode publishes this once the client bundle (and its handlers) ran. */
async function waitForHydration(page: Page) {
  await page.waitForFunction(() =>
    Boolean((window as unknown as { __legendMock?: unknown }).__legendMock),
  );
}

async function openPreferences(page: Page) {
  await waitForHydration(page);
  await page.getByRole("tab", { name: /Preferensi/ }).click();
  await expect(
    page.getByRole("heading", { name: "Kategori & kanal" }),
  ).toBeVisible();
}

test.describe("notification center (F15)", () => {
  test("F15 the in-app inbox lists the signed-in user's notifications and marks them read", async ({
    page,
  }) => {
    await page.goto(NOTIFICATION_CENTER);
    await waitForHydration(page);
    await expect(
      page.getByRole("heading", { level: 1, name: "Notifikasi" }),
    ).toBeVisible();
    await expect(page.getByText("Pesanan A-042 siap")).toBeVisible();
    await expect(page.getByText("Printer stasiun Kopi offline")).toBeVisible();
    await expect(
      page.getByRole("tab", { name: /Kotak masuk.*belum dibaca/ }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Tandai semua dibaca" }).click();

    await expect(page.getByText("Semua sudah dibaca")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Tandai semua dibaca" }),
    ).toBeDisabled();
    await expect(page.locator("li[data-unread]")).toHaveCount(0);
  });

  test("F15 the unread filter explains an empty result and returns to all", async ({
    page,
  }) => {
    await page.goto(NOTIFICATION_CENTER);
    await waitForHydration(page);
    await page.getByRole("radio", { name: "Belum dibaca" }).click();
    await expect(page.getByText("Pesanan A-042 siap")).toBeVisible();

    await page.getByRole("button", { name: "Tandai dibaca" }).click();
    await expect(
      page.getByText("Tidak ada notifikasi untuk filter ini"),
    ).toBeVisible();

    await page.getByRole("radio", { name: "Semua" }).click();
    await expect(page.getByText("Pesanan A-042 siap")).toBeVisible();
  });

  test("F15 the inbox shows its empty state when nothing is recorded", async ({
    page,
  }) => {
    await page.goto(`${NOTIFICATION_CENTER}?mock=empty`);
    await waitForHydration(page);
    await expect(page.getByText("Belum ada notifikasi")).toBeVisible();
  });

  test("F15 the inbox shows an error state with a retry when the API fails", async ({
    page,
  }) => {
    await page.goto(`${NOTIFICATION_CENTER}?mock=error`);
    await waitForHydration(page);
    await expect(page.getByText("Notifikasi tidak dapat dimuat")).toBeVisible();
    await expect(page.getByRole("button", { name: "Coba lagi" })).toBeVisible();
  });

  test("F15 U14 preferences keep WhatsApp off under the tenant policy and save a channel change", async ({
    page,
  }) => {
    await page.goto(NOTIFICATION_CENTER);
    await openPreferences(page);

    await expect(
      page.getByText(
        "WhatsApp dimatikan oleh kebijakan tenant; pilihan Anda disimpan untuk nanti.",
      ),
    ).toBeVisible();
    await expect(
      page.locator("#notification-daily_summary-whatsapp"),
    ).toBeDisabled();

    await page.locator("#notification-daily_summary-email").click();
    await page.getByRole("button", { name: "Simpan preferensi" }).click();
    await expect(
      page.getByText("Preferensi notifikasi tersimpan").first(),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Simpan preferensi" }),
    ).toBeDisabled();
  });

  test("F15 quiet hours reject the same start and end time", async ({
    page,
  }) => {
    await page.goto(NOTIFICATION_CENTER);
    await openPreferences(page);

    await page.getByLabel("Mulai", { exact: true }).fill("08:00");
    await page.getByLabel("Selesai", { exact: true }).fill("08:00");
    await page.getByRole("button", { name: "Simpan preferensi" }).click();

    await expect(
      page.getByText("Jam mulai dan selesai tidak boleh sama."),
    ).toBeVisible();
  });

  test("F15 the preference form shows its error state", async ({ page }) => {
    await page.goto(`${NOTIFICATION_CENTER}?mock=error`);
    await waitForHydration(page);
    await page.getByRole("tab", { name: /Preferensi/ }).click();
    await expect(page.getByText("Preferensi tidak dapat dimuat")).toBeVisible();
  });

  test("F15 the preference form shows a skeleton while it loads", async ({
    page,
  }) => {
    await page.goto(`${NOTIFICATION_CENTER}?mock=slow`);
    await waitForHydration(page);
    await page.getByRole("tab", { name: /Preferensi/ }).click();
    await expect(page.locator('[aria-busy="true"]')).toBeVisible();
  });

  test("F15 an untouched preference set falls back to tenant defaults", async ({
    page,
  }) => {
    await page.goto(`${NOTIFICATION_CENTER}?mock=empty`);
    await openPreferences(page);
    await expect(
      page.getByText(
        "Default tenant dipakai sampai Anda menyimpan pilihan sendiri.",
      ),
    ).toBeVisible();
  });
});

test.describe("web push opt-in (F15 PWA)", () => {
  test.use({ permissions: ["notifications"] });

  test("F15 PWA the browser can be turned on and off for web push", async ({
    page,
  }) => {
    await page.goto(NOTIFICATION_CENTER);
    await waitForHydration(page);
    // Chromium's headless shell reports "denied" for every page; full Chrome
    // (channel: "chrome") honors the granted permission.
    const permission = await page.evaluate(() => Notification.permission);
    test.skip(
      permission === "denied",
      "This browser refuses notification permission (headless shell).",
    );
    await openPreferences(page);

    await expect(
      page.getByText("Belum aktif di perangkat ini", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Aktifkan notifikasi" }).click();
    await expect(
      page.getByText("Aktif di perangkat ini", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Matikan di perangkat ini" }),
    ).toBeVisible();

    await page
      .getByRole("button", { name: "Matikan di perangkat ini" })
      .click();
    await expect(
      page.getByText("Belum aktif di perangkat ini", { exact: true }),
    ).toBeVisible();
  });
});

test.describe("iOS >= 16.4 guidance (F15 PWA)", () => {
  test.use({
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    viewport: { width: 390, height: 844 },
  });

  test("F15 PWA an iPhone that has not installed the app is told to add it to the Home Screen", async ({
    page,
  }) => {
    await page.goto(NOTIFICATION_CENTER);
    await openPreferences(page);

    await expect(page.getByText("Pasang dulu di iPhone")).toBeVisible();
    await expect(
      page.getByText("Ketuk Bagikan, lalu pilih Tambahkan ke Layar Utama."),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Aktifkan notifikasi" }),
    ).toHaveCount(0);
  });
});
