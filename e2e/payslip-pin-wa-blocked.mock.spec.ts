// Card legend-bzw5k: the WhatsApp PIN reset says WHY it is blocked.
//   - 409 with reason identity_missing  -> "Nomor WhatsApp belum terdaftar"
//   - 409 with reason identity_too_new  -> "Nomor WhatsApp belum 3 hari"
//   - 409 without a reason              -> one combined screen (both causes)
//   - 429 with retryAfterSeconds        -> a live "Coba lagi dalam MM:SS" count
//                                          down on the "Terlalu banyak
//                                          percobaan" screen
// Runs in mock mode (`pnpm test:e2e:mock e2e/payslip-pin-wa-blocked.mock.spec.ts`);
// the `?waScenario=` scenarios are the mock's stand-ins for those API answers.
//
// ASSUMPTIONS
//  - A 429 without the number keeps the old "Coba lagi nanti" text; that case
//    is covered by payslip-pin-wa-reset.mock.spec.ts only as long as that
//    spec's rate-limited scenario has no number, so it is NOT asserted here.
//  - The screens for "no WhatsApp" and "number under 3 days" must differ in
//    heading, and neither may offer the other's explanation as its own title.
import { expect, test, type Page } from "@playwright/test";
import { waitForHydration } from "./hydration.ts";

const base = process.env.LEGEND_MOCK_WEB_URL;
test.skip(
  !base,
  "Mock runner not started: use pnpm test:e2e:mock (playwright.mock.config.ts).",
);
test.use({ baseURL: base });

/** Vite compiles a route on its first request: the first assertion waits. */
const COLD = 30_000;
const ROLE_COOKIE = "legend-mock-role";
const FORGOT_PATH = "/karyawan/slip-gaji/lupa-pin";
const COUNTDOWN = /Coba lagi dalam ((\d+):)?(\d{2}):(\d{2})/;

async function openBlocked(page: Page, scenario: string) {
  await page
    .context()
    .addCookies([{ name: ROLE_COOKIE, value: "employee", url: base! }]);
  await page.goto(`${FORGOT_PATH}?waScenario=${scenario}`);
  await waitForHydration(page);
  await expect(page.getByRole("heading", { name: "Lupa PIN?" })).toBeVisible({
    timeout: COLD,
  });
  await page
    .getByRole("button", { name: /^Lewat WhatsApp/ })
    .or(page.getByRole("link", { name: /^Lewat WhatsApp/ }))
    .first()
    .click();
}

const NO_WA_HEADING = "Nomor WhatsApp belum terdaftar";
const TOO_NEW_HEADING = "Nomor WhatsApp belum 3 hari";

test("F30 HR-01 bzw5k: a 409 'no WhatsApp number' shows its own screen, not the under-3-days one", async ({
  page,
}) => {
  await openBlocked(page, "no-wa");
  await expect(page.getByRole("heading", { name: NO_WA_HEADING })).toBeVisible({
    timeout: COLD,
  });
  await expect(
    page.getByRole("heading", { name: TOO_NEW_HEADING }),
  ).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Buka WhatsApp" })).toHaveCount(
    0,
  );
  await expect(
    page
      .getByRole("button", { name: "Kembali ke slip gaji" })
      .or(page.getByRole("link", { name: "Kembali ke slip gaji" }))
      .first(),
  ).toBeVisible();
});

test("F30 HR-01 bzw5k: a 409 'number under 3 days' shows its own screen, not the no-number one", async ({
  page,
}) => {
  await openBlocked(page, "too-new");
  await expect(
    page.getByRole("heading", { name: TOO_NEW_HEADING }),
  ).toBeVisible({ timeout: COLD });
  await expect(page.getByRole("heading", { name: NO_WA_HEADING })).toHaveCount(
    0,
  );
  await expect(page.getByRole("link", { name: "Buka WhatsApp" })).toHaveCount(
    0,
  );
});

test("F30 HR-01 bzw5k: a 409 without a reason shows neither specific heading but names both causes", async ({
  page,
}) => {
  await openBlocked(page, "unavailable-plain");
  await expect(
    page.getByText(/belum terdaftar, atau baru tertaut kurang dari 3 hari/),
  ).toBeVisible({ timeout: COLD });
  await expect(page.getByRole("heading", { name: NO_WA_HEADING })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("heading", { name: TOO_NEW_HEADING }),
  ).toHaveCount(0);
});

test("F30 ur82k bzw5k: a 429 with a wait shows 'Coba lagi dalam' with a time that counts down", async ({
  page,
}) => {
  await openBlocked(page, "rate-limited-wait");
  await expect(
    page.getByRole("heading", { name: "Terlalu banyak percobaan" }),
  ).toBeVisible({ timeout: COLD });

  const countdown = page.getByText(COUNTDOWN).first();
  await expect(countdown).toBeVisible();
  // The server gave a number, so the vague text is not shown.
  await expect(page.getByText("Coba lagi nanti")).toHaveCount(0);

  const toSeconds = (text: string) => {
    const m = COUNTDOWN.exec(text)!;
    return Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4]);
  };
  const first = toSeconds((await countdown.textContent()) ?? "");
  expect(first).toBeGreaterThan(0);
  expect(first).toBeLessThanOrEqual(3600);

  // Real one-second ticks: poll (not sleep) until at least one tick shows.
  await expect
    .poll(async () => toSeconds((await countdown.textContent()) ?? ""), {
      timeout: 10_000,
    })
    .toBeLessThan(first);
});

test("F30 ur82k bzw5k: while the wait runs there is no retry button, only HR help and a way back", async ({
  page,
}) => {
  await openBlocked(page, "rate-limited-wait");
  await expect(page.getByText(COUNTDOWN).first()).toBeVisible({
    timeout: COLD,
  });
  await expect(page.getByRole("button", { name: "Coba lagi" })).toHaveCount(0);
  await expect(
    page
      .getByRole("button", { name: "Lihat cara minta bantuan" })
      .or(page.getByRole("link", { name: "Lihat cara minta bantuan" }))
      .first(),
  ).toBeVisible();
  await expect(
    page
      .getByRole("button", { name: "Kembali ke slip gaji" })
      .or(page.getByRole("link", { name: "Kembali ke slip gaji" }))
      .first(),
  ).toBeVisible();
});
