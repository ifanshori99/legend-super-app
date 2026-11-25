import { expect, test } from "@playwright/test";

// 1269 F0: the deferred shower is closed per facility type, against the FE mock
// runtime. Run: pnpm test:e2e:mock e2e/legend-1269-shower-closed.mock.spec.ts
const mockWebUrl = process.env.LEGEND_MOCK_WEB_URL;
test.skip(!mockWebUrl, "Requires the mock-mode web server");
test.use({ baseURL: mockWebUrl ?? "http://localhost:3320" });
test.setTimeout(120_000);

const SHOWER = "00000000-0000-4000-8000-000000009001";
const WFC = "00000000-0000-4000-8000-000000009002";
const WAIT = { timeout: 60_000 };

test("guests find no shower booking page, and the WFC one opens", async ({
  page,
}) => {
  await page.goto(`/f/${WFC}`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Zona WFC Legend" }),
  ).toBeVisible(WAIT);
  await page.goto(`/f/${SHOWER}`);
  await expect(
    page.getByRole("heading", { name: "Masuk dengan WhatsApp" }),
  ).toHaveCount(0, WAIT);
  await expect(
    page.getByRole("heading", { level: 1, name: "Shower Room Legend" }),
  ).toHaveCount(0);
});

test("the board opens the WFC facility and refuses a named shower", async ({
  page,
}) => {
  await page.goto("/fasilitas?mock=normal");
  await expect(page.getByText("Zona WFC Legend").first()).toBeVisible(WAIT);
  await page.goto(`/fasilitas?mock=normal&facilityId=${SHOWER}`);
  await expect(page.getByText("Belum ada bilik")).toBeVisible(WAIT);
  await expect(page.locator('[data-slot="facility-unit"]')).toHaveCount(0);
});

test("FAC-08 a panic alert shows on the emergency screen of a closed shower, whose links open the WFC board", async ({
  page,
}) => {
  await page.addInitScript(() =>
    window.localStorage.setItem("legend.mock.panic", "restore"),
  );
  await page.goto(`/fasilitas/darurat?mock=normal&facilityId=${SHOWER}`);
  await expect(page.getByRole("dialog")).toContainText("P2", WAIT);
  await expect(
    page.locator('[data-slot="facility-staff-subnav"] a').first(),
  ).toHaveAttribute("href", new RegExp(`facilityId=${WFC}`));
});

test("the settings of a shower show only guest Wi-Fi; a WFC shows every tab", async ({
  page,
}) => {
  await page.goto(`/kelola/fasilitas/${SHOWER}?mock=normal`);
  await expect(page.getByRole("tab")).toHaveCount(1, WAIT);
  await expect(page.locator('[data-slot="facility-wifi"]')).toBeVisible();
  await page.goto(`/kelola/fasilitas/${WFC}?mock=normal`);
  await expect(page.getByRole("tab")).toHaveCount(7, WAIT);
});
