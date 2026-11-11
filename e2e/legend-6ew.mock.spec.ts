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
  // exact: the toast's polite live region repeats the title as "Notifikasi
  // Berpindah ke ..." for about a second, which a substring match also hits.
  await expect(
    page.getByText("Berpindah ke Nina Marlina", { exact: true }),
  ).toBeVisible();
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

  await modal.getByRole("combobox", { name: "Kode alasan" }).click();
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

  // The requester is picked as approver first: their own PIN is refused
  // (AUTH-06). The verify contract counts misses per staff, so the approver
  // the PIN is typed for is always the one picked.
  const approverPicker = modal.getByRole("combobox", {
    name: "Supervisor yang memasukkan PIN",
  });
  await approverPicker.click();
  await page.getByRole("option", { name: "Nina Marlina" }).click();
  // Radix Select hands focus back to its trigger a moment after it closes.
  // Wait for that before blurring, or the first key reaches the pad and the
  // rest land on the combobox, which owns them (a PIN of 1 + the clicks below).
  await expect(approverPicker).toBeFocused();

  await typePinOutsideFields(page, "246810");
  // The alert, not the static hint paragraph, which carries the same sentence.
  await expect(
    modal
      .getByRole("alert")
      .filter({ hasText: "Penyetuju tidak boleh sama dengan peminta" }),
  ).toBeVisible();

  // The supervisor is picked now; their PIN completes the override.
  await approverPicker.click();
  await page.getByRole("option", { name: "Yusuf Hidayat" }).click();
  await expect(approverPicker).toBeFocused();
  await expect(modal.getByRole("button", { name: "Angka 1" })).toBeEnabled();
  for (const digit of "482604")
    await modal.getByRole("button", { name: `Angka ${digit}` }).click();
  await expect(page.getByTestId("override-result")).toContainText(
    "Yusuf Hidayat",
  );
  await expect(page.getByTestId("override-result")).toContainText("350.000");
});

// legend-6ew E4: an active staff entry saved before the outlet was stored has
// no outletId. The device outlet stands in. (With no device outlet the POS area
// shows its no-outlet page, so the "sign in again" notice has no e2e route.)
async function openOverrideWithOldActiveEntry(page: Page, url: string) {
  await page.goto(url, NAV);
  await switchTo(page, "Nina Marlina", "246810");
  await page.evaluate(() => {
    const key = "legend-device-active-staff";
    const entry = JSON.parse(localStorage.getItem(key) ?? "{}");
    delete entry.outletId;
    localStorage.setItem(key, JSON.stringify(entry));
  });
  await page.reload(NAV);
  await expect(page.getByTestId("active-staff")).toContainText("Nina Marlina");
  await page.getByRole("button", { name: "Ajukan override" }).click();
  const modal = page.getByTestId("override-modal");
  await expect(modal).toBeVisible();
  return modal;
}

test("AUTH-06 · old active entry without outlet: the device outlet completes a PIN override", async ({
  page,
}) => {
  const modal = await openOverrideWithOldActiveEntry(page, SWITCH);
  await modal.getByRole("combobox", { name: "Kode alasan" }).click();
  await page.getByRole("option", { name: "Pelanggan membatalkan" }).click();
  await modal
    .getByLabel("Catatan alasan")
    .fill("Pelanggan batal sebelum dapur mulai");
  const approverPicker = modal.getByRole("combobox", {
    name: "Supervisor yang memasukkan PIN",
  });
  await approverPicker.click();
  await page.getByRole("option", { name: "Yusuf Hidayat" }).click();
  await expect(approverPicker).toBeFocused();
  for (const digit of "482604")
    await modal.getByRole("button", { name: `Angka ${digit}` }).click();
  await expect(page.getByTestId("override-result")).toContainText(
    "Yusuf Hidayat",
  );
});

for (const outcome of ["approved", "rejected", "expired"] as const) {
  test(`AUTH-06 · phone approval ends ${outcome}`, async ({ page }) => {
    await page.goto(SWITCH, NAV);
    await switchTo(page, "Nina Marlina", "246810");
    await page.getByRole("button", { name: "Ajukan override" }).click();
    const modal = page.getByTestId("override-modal");
    await modal.getByRole("combobox", { name: "Kode alasan" }).click();
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

// legend-495 G3/G5: helpers for the phone wait.
type DevicePinMockHooks = {
  decide: (v: string) => void;
  settleOverride: (v: string | null) => void;
  failCancel: (on: boolean) => void;
};
async function mockHook<K extends keyof DevicePinMockHooks>(
  page: Page,
  name: K,
  arg: Parameters<DevicePinMockHooks[K]>[0],
) {
  await page.evaluate(
    ([hook, value]) =>
      (
        window as unknown as {
          __legendDevicePinMock: Record<string, (v: unknown) => void>;
        }
      ).__legendDevicePinMock[hook as string]?.(value),
    [name, arg] as const,
  );
}

async function openPhoneWait(page: Page) {
  await page.goto(SWITCH, NAV);
  await switchTo(page, "Nina Marlina", "246810");
  await page.getByRole("button", { name: "Ajukan override" }).click();
  const modal = page.getByTestId("override-modal");
  await modal.getByRole("combobox", { name: "Kode alasan" }).click();
  await page.getByRole("option", { name: "Stok habis" }).click();
  await modal.getByLabel("Catatan alasan").fill("Bahan habis di dapur");
  await modal.getByRole("radio", { name: "Persetujuan dari ponsel" }).click();
  await modal
    .getByRole("button", { name: "Kirim ke ponsel supervisor" })
    .click();
  await expect(page.getByTestId("override-pending")).toBeVisible();
  return modal;
}

test("AUTH-06 · request approved but override not settled: no approval yet", async ({
  page,
}) => {
  await openPhoneWait(page);
  await mockHook(page, "settleOverride", "pending");
  await mockHook(page, "decide", "approved");
  // Past two poll cycles the request reads approved; still waiting, no result.
  await page.waitForTimeout(7_000);
  await expect(page.getByTestId("override-pending")).toBeVisible();
  await expect(page.getByTestId("override-result")).toHaveCount(0);
  // Once the override settles as approved, the result appears.
  await mockHook(page, "settleOverride", null);
  await expect(page.getByTestId("override-result")).toContainText(
    "Persetujuan dari ponsel",
    { timeout: 15_000 },
  );
});

for (const settled of ["rejected", "cancelled", "expired"] as const) {
  test(`AUTH-06 · request approved but override settled ${settled}: shown as not approved`, async ({
    page,
  }) => {
    await openPhoneWait(page);
    await mockHook(page, "settleOverride", settled);
    await mockHook(page, "decide", "approved");
    await expect(
      page.getByTestId(
        `override-${settled === "rejected" ? "rejected" : settled}`,
      ),
    ).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("override-result")).toHaveCount(0);
  });
}

for (const closer of ["Escape", "X"] as const) {
  test(`AUTH-06 · ${closer} on a pending wait cancels the request first`, async ({
    page,
  }) => {
    const modal = await openPhoneWait(page);
    if (closer === "Escape") await page.keyboard.press("Escape");
    else await modal.getByRole("button", { name: "Tutup" }).first().click();
    await expect(modal).toHaveCount(0);
    // The request was withdrawn, not just hidden.
    const statuses = await page.evaluate(() =>
      (
        window as unknown as {
          __legendDevicePinMock: { requestStatuses: () => string[] };
        }
      ).__legendDevicePinMock.requestStatuses(),
    );
    expect(statuses).toEqual(["cancelled"]);
  });

  test(`AUTH-06 · ${closer} on a pending wait with a failing cancel keeps the dialog open`, async ({
    page,
  }) => {
    const modal = await openPhoneWait(page);
    await mockHook(page, "failCancel", true);
    if (closer === "Escape") await page.keyboard.press("Escape");
    else await modal.getByRole("button", { name: "Tutup" }).first().click();
    await expect(page.getByTestId("override-pending")).toBeVisible();
    await expect(
      modal.getByText("Permintaan belum bisa dibatalkan", { exact: false }),
    ).toBeVisible();
    // Retrying after the failure clears works.
    await mockHook(page, "failCancel", false);
    await modal.getByRole("button", { name: "Berhenti menunggu" }).click();
    await expect(modal).toHaveCount(0);
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
  // No staff is named and the roster is empty: the PIN is not sent at all
  // (per-staff attempts need a user), so the pad says to pick a name first.
  await expect(
    page.getByText("Pilih dulu nama staf atau supervisor", { exact: false }),
  ).toBeVisible();
  await shot(page, "offline-390-light");
});
