// Outlet settings and the Q39 business-day cutoff (bead legend-1mi5;
// contracts.md D-CORE-7). Runs against the FE mock runtime
// (VITE_API_MOCK=true): GET /api/org/outlets is served by
// features/ws07-accounting/mock.ts, PATCH /api/org/outlets/:outletId by
// features/ws01-org/mock.ts. No API, no database:
//   pnpm test:e2e:mock e2e/legend-1mi5.mock.spec.ts
import { expect, test } from "@playwright/test";
import { waitForHydration } from "./hydration.ts";

// The screen must use the outlet clock, never the device clock: a device in
// New York still shows the Asia/Jakarta business date below.
test.use({ timezoneId: "America/New_York" });

const CUTOFF = "04:00";
const EDITED_CUTOFF = "03:30";

/** Q39: local date of (instant − cutoff) in the outlet time zone. */
function expectedBusinessDate(
  now: Date,
  cutoff: string,
  timeZone = "Asia/Jakarta",
): string {
  const [hour, minute] = cutoff.split(":").map(Number);
  const shifted = new Date(now.getTime() - (hour * 60 + minute) * 60_000);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(shifted);
  const part = (type: "year" | "month" | "day") =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** Same rendering the screen uses for a business date (`id-ID`, UTC). */
function formatBusinessDate(value: string): string {
  const [year, month, day] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

test("legend-1mi5 the settings hub opens the outlet screen with the 04:00 default", async ({
  page,
}) => {
  await page.goto("/kelola/pengaturan");
  await waitForHydration(page);

  // The hub card only renders when the route exists and the visitor holds
  // org.structure.manage (mock role "all" by default).
  const card = page.getByRole("link", { name: /Nama, alamat, dan jam tutup buku outlet/ });
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.click();

  await expect(page).toHaveURL(/\/kelola\/pengaturan\/outlet$/);
  await expect(
    page.getByRole("heading", { name: "Outlet", level: 2 }),
  ).toBeVisible();
  await expect(page.locator("#outlet-cutoff")).toHaveValue(CUTOFF, {
    timeout: 15_000,
  });
  // The outlet's IANA zone is read-only; the contract has no time-zone input
  // on updateOutletInputSchema.
  await expect(page.locator("#outlet-time-zone")).toHaveValue("Asia/Jakarta");
});

test("legend-1mi5 changing the cutoff to 03:30 saves and survives a reload", async ({
  page,
}) => {
  await page.goto("/kelola/pengaturan/outlet");
  await waitForHydration(page);
  const cutoff = page.locator("#outlet-cutoff");
  await expect(cutoff).toHaveValue(CUTOFF, { timeout: 15_000 });

  await cutoff.fill(EDITED_CUTOFF);
  await page.getByRole("button", { name: "Simpan" }).click();
  await expect(cutoff).toHaveValue(EDITED_CUTOFF);

  // The live preview uses the same clock every screen reads: (now − 03:30) in
  // the outlet time zone, not the New York device date.
  await expect(page.getByTestId("outlet-business-date")).toHaveText(
    formatBusinessDate(expectedBusinessDate(new Date(), EDITED_CUTOFF)),
  );

  // sessionStorage keeps the mock save in this tab, like a reload would.
  await page.reload();
  await waitForHydration(page);
  await expect(page.locator("#outlet-cutoff")).toHaveValue(EDITED_CUTOFF, {
    timeout: 15_000,
  });
});

test("legend-1mi5 a cutoff outside 00:00–11:59 is refused with a visible message", async ({
  page,
}) => {
  await page.goto("/kelola/pengaturan/outlet");
  await waitForHydration(page);
  const cutoff = page.locator("#outlet-cutoff");
  await expect(cutoff).toHaveValue(CUTOFF, { timeout: 15_000 });
  const save = page.getByRole("button", { name: "Simpan" });

  // 13:00 is a valid time of day but outside the contract's range.
  await cutoff.fill("13:00");
  await save.click();
  await expect(page.getByRole("alert")).toContainText(
    /Periksa \d+ isian yang ditandai\./,
  );
  await expect(cutoff).toHaveValue("13:00");

  // "abc" is not a time at all.
  await cutoff.fill("abc");
  await save.click();
  await expect(page.getByRole("alert")).toContainText(
    /Periksa \d+ isian yang ditandai\./,
  );

  // Neither attempt reached the mock: a reload still shows the saved default.
  await page.reload();
  await waitForHydration(page);
  await expect(page.locator("#outlet-cutoff")).toHaveValue(CUTOFF, {
    timeout: 15_000,
  });
});

test("legend-1mi5 an inventory business date uses the outlet cutoff, not the device clock", async ({
  page,
}) => {
  await page.goto("/kelola/inventori/opname");
  await waitForHydration(page);
  // The toolbar action (and the empty-state action when the list is empty).
  // Client-only controls drop a click that lands before hydration, so retry
  // until the dialog's business-date field exists (legend-vxj pattern).
  await expect(async () => {
    await page
      .getByRole("button", { name: "Mulai opname" })
      .first()
      .click({ timeout: 5_000 });
    await expect(page.locator("#count-date")).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 20_000 });

  // The count session defaults to the outlet's business date: with the fixture
  // outlet (Asia/Jakarta, cutoff 04:00) that is (now − 4h) in Jakarta, even
  // though this browser runs in New York.
  await expect(page.locator("#count-date")).toHaveValue(
    expectedBusinessDate(new Date(), CUTOFF),
  );
});
