import { expect, test, type Page } from "@playwright/test";
import { captureScreenshot } from "./screenshot-width.ts";

// Device PIN pad, switch user and supervisor override (bead legend-6ew; PRD
// v1.7 §3 F6 "PIN Perangkat", §3.6 "Override Supervisor", AUTH-06) against the
// FE mock runtime. Mock PINs: Nina Marlina (kasir) 246810, Yusuf Hidayat
// (supervisor) 482604. Phone approvals are decided through
// window.__legendDevicePinMock.decide(...).
//
// How to run: `pnpm test:e2e:mock` (mock web server on port 3302) names the
// URL in LEGEND_MOCK_WEB_URL; with no variable set every test skips.
const MOCK_URL = process.env.LEGEND_MOCK_WEB_URL;

test.skip(
  !MOCK_URL,
  "Needs a VITE_API_MOCK=true server (pnpm test:e2e:mock); see the header of this file.",
);

const NAV = { waitUntil: "networkidle" as const };
const SWITCH = `${MOCK_URL}/pos/ganti-pengguna?mock=normal`;

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
});

async function typePin(page: Page, pin: string) {
  for (const digit of pin) await page.keyboard.press(digit);
}

// Radix focuses the first field of a dialog; the pad ignores keys typed into a
// field, so drop the focus before typing a PIN there.
async function typePinOutsideFields(page: Page, pin: string) {
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  await typePin(page, pin);
}

// Gives each mock call a real round trip so a PIN typed during the check of
// the previous one races it, as on a slow edge node.
async function slowMock(page: Page, latencyMs: number) {
  await page.evaluate(
    (ms) =>
      (
        window as unknown as {
          __legendMock?: { setLatencyMs: (v: number) => void };
        }
      ).__legendMock?.setLatencyMs(ms),
    latencyMs,
  );
}

async function shot(page: Page, name: string) {
  await captureScreenshot(page, `legend-6ew/${name}.png`);
}

async function switchTo(page: Page, name: string, pin: string) {
  await page.getByRole("button", { name }).click();
  await typePin(page, pin);
  await expect(page.getByTestId("active-staff")).toContainText(name);
}

test("AUTH-06 · switch user: pick a name, type the PIN with the keyboard", async ({
  page,
}) => {
  await page.goto(SWITCH, NAV);
  await expect(
    page.getByRole("heading", { name: "Ganti pengguna", level: 1 }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Nina Marlina" }).click();
  await expect(page.getByText("PIN untuk Nina Marlina")).toBeVisible();
  await page.keyboard.press("2");
  await expect(page.getByTestId("pin-dots")).toHaveAccessibleName(
    /1 dari 6 angka terisi/,
  );
  await page.keyboard.press("Backspace");
  await typePin(page, "246810");
  await expect(page.getByTestId("active-staff")).toContainText("Nina Marlina");
  await expect(page.getByText("Berpindah ke Nina Marlina")).toBeVisible();
});

test("AUTH-06 · touch pad: tapping the digit keys verifies the PIN", async ({
  page,
}) => {
  await page.goto(SWITCH, NAV);
  await page.getByRole("button", { name: "Yusuf Hidayat" }).click();
  for (const digit of "482604")
    await page.getByRole("button", { name: `Angka ${digit}` }).click();
  await expect(page.getByTestId("active-staff")).toContainText("Yusuf Hidayat");
});

// Regression (legend-6ew "typing the final PIN digit fails"): the pad used to
// disable its keys while a PIN was checked, so digits typed straight after a
// wrong PIN were dropped and the sixth digit never submitted; the focused key
// also turned disabled and threw focus to <body>.
test("AUTH-06 · regression: a PIN typed with the keyboard during the previous check still submits on its sixth digit", async ({
  page,
}) => {
  await page.goto(SWITCH, NAV);
  await slowMock(page, 400);
  await page.getByRole("button", { name: "Nina Marlina" }).click();
  await typePin(page, "111222");
  // No wait for the answer: the next PIN is typed while the first is checked.
  await typePin(page, "246810");
  await expect(page.getByTestId("active-staff")).toContainText("Nina Marlina");
});

test("AUTH-06 · regression: tapping the on-screen keys straight after a wrong PIN submits, and focus stays on the pad", async ({
  page,
}) => {
  await page.goto(SWITCH, NAV);
  await slowMock(page, 400);
  await page.getByRole("button", { name: "Nina Marlina" }).click();
  for (const digit of "111222")
    await page.getByRole("button", { name: `Angka ${digit}` }).click();
  // The final key keeps focus while the PIN is checked (no drop to <body>).
  await expect(page.getByRole("button", { name: "Angka 2" })).toBeFocused();
  for (const digit of "246810")
    await page.getByRole("button", { name: `Angka ${digit}` }).click();
  await expect(page.getByTestId("active-staff")).toContainText("Nina Marlina");
});

test("AUTH-06 · regression: keyboard-only user activates the keys with Enter and keeps focus after the sixth digit", async ({
  page,
}) => {
  await page.goto(SWITCH, NAV);
  await page.getByRole("button", { name: "Yusuf Hidayat" }).click();
  for (const digit of "482604") {
    await page.getByRole("button", { name: `Angka ${digit}` }).focus();
    await page.keyboard.press("Enter");
  }
  await expect(page.getByTestId("active-staff")).toContainText("Yusuf Hidayat");
});

test("AUTH-06 · a wrong PIN shows the error and attempts left; a PIN of another person is refused", async ({
  page,
}) => {
  await page.goto(SWITCH, NAV);
  await page.getByRole("button", { name: "Nina Marlina" }).click();
  await typePin(page, "111222");
  await expect(
    page.getByRole("alert").filter({ hasText: "PIN salah" }),
  ).toBeVisible();
  await expect(page.getByText("Sisa 4 percobaan")).toBeVisible();
  await shot(page, "pin-salah-390-light");
  await typePin(page, "482604");
  await expect(
    page.getByText("PIN ini bukan milik Nina Marlina"),
  ).toBeVisible();
});

test("AUTH-06 · five wrong PINs lock the pad with a countdown", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(SWITCH, NAV);
  await page.getByRole("button", { name: "Nina Marlina" }).click();
  // Wait for each answer so every try is counted on its own line.
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await typePin(page, "111222");
    await expect(page.getByText(`Sisa ${5 - attempt} percobaan`)).toBeVisible();
  }
  await typePin(page, "111222");
  await expect(page.getByTestId("pin-lockout")).toBeVisible();
  await expect(page.getByTestId("pin-lockout-time")).toHaveText(/^1[45]:\d\d$/);
  await expect(page.getByRole("button", { name: "Angka 1" })).toBeDisabled();
  await shot(page, "terkunci-390-light");
  await page.setViewportSize({ width: 1440, height: 900 });
  await shot(page, "terkunci-1440-light");
});

test("AUTH-06 · override with a supervisor PIN records reason and value; the requester's own PIN is refused", async ({
  page,
}) => {
  await page.goto(SWITCH, NAV);
  await switchTo(page, "Nina Marlina", "246810");
  await page.getByRole("button", { name: "Ajukan override" }).click();
  const modal = page.getByTestId("override-modal");
  await expect(modal).toBeVisible();

  // Incomplete form: the PIN is not submitted and the fields explain why.
  await typePinOutsideFields(page, "482604");
  await expect(modal.getByText("Pilih kode alasan.")).toBeVisible();
  await expect(
    modal.getByText("Tulis alasan, minimal 3 karakter."),
  ).toBeVisible();

  await modal.getByRole("combobox").click();
  await page.getByRole("option", { name: "Pelanggan membatalkan" }).click();
  await modal
    .getByLabel("Catatan alasan")
    .fill("Pelanggan batal sebelum dapur mulai");
  // Fixed fields drop their error at once, not on the next PIN.
  await expect(modal.getByText("Pilih kode alasan.")).toHaveCount(0);
  await expect(
    modal.getByText("Tulis alasan, minimal 3 karakter."),
  ).toHaveCount(0);
  await shot(page, "override-pin-1440-light");

  await typePinOutsideFields(page, "246810");
  await expect(
    modal.getByText("Penyetuju tidak boleh sama dengan peminta"),
  ).toBeVisible();

  await expect(modal.getByRole("button", { name: "Angka 1" })).toBeEnabled();
  for (const digit of "482604")
    await modal.getByRole("button", { name: `Angka ${digit}` }).click();
  await expect(page.getByTestId("override-result")).toContainText(
    "Yusuf Hidayat",
  );
  await expect(page.getByTestId("override-result")).toContainText("350.000");
});

for (const outcome of ["approved", "rejected", "expired"] as const) {
  test(`AUTH-06 · phone approval ends ${outcome}`, async ({ page }) => {
    await page.goto(SWITCH, NAV);
    await switchTo(page, "Nina Marlina", "246810");
    await page.getByRole("button", { name: "Ajukan override" }).click();
    const modal = page.getByTestId("override-modal");
    await modal.getByRole("combobox").click();
    await page.getByRole("option", { name: "Stok habis" }).click();
    await modal.getByLabel("Catatan alasan").fill("Bahan habis di dapur");
    await modal.getByRole("radio", { name: "Persetujuan dari ponsel" }).click();
    await modal
      .getByRole("button", { name: "Kirim ke ponsel supervisor" })
      .click();

    await expect(page.getByTestId("override-pending")).toBeVisible();
    if (outcome === "approved") await shot(page, "override-menunggu-390-dark");
    await page.evaluate(
      (value) =>
        (
          window as unknown as {
            __legendDevicePinMock?: { decide: (v: string) => void };
          }
        ).__legendDevicePinMock?.decide(value),
      outcome,
    );

    if (outcome === "approved") {
      await expect(page.getByTestId("override-result")).toContainText(
        "Persetujuan dari ponsel",
        { timeout: 15_000 },
      );
    } else {
      await expect(page.getByTestId(`override-${outcome}`)).toBeVisible({
        timeout: 15_000,
      });
      if (outcome === "rejected")
        await expect(
          page.getByText("Nilai tidak sesuai dengan struk."),
        ).toBeVisible();
      await shot(page, `override-${outcome}-390-light`);
    }
  });
}

test("AUTH-06 · kitchen shell switch-user page, empty roster and offline hint", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("legend-device-roster", "[]"),
  );
  await page.goto(`${MOCK_URL}/kds/ganti-pengguna?mock=normal`, NAV);
  await expect(
    page.getByText("Belum ada petugas di perangkat ini"),
  ).toBeVisible();
  await shot(page, "kds-kosong-1440-dark");

  await page.goto(`${MOCK_URL}/kds/ganti-pengguna?mock=offline`, NAV);
  await typePin(page, "246810");
  await expect(
    page.getByText("Tidak dapat menghubungi server", { exact: false }),
  ).toBeVisible();
  await shot(page, "offline-390-light");
});
