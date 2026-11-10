import { expect, test } from "@playwright/test";

// Small FE guards found by the m1 audit (beads legend-j48q, legend-gy1o,
// legend-radz): the fixes already shipped, these specs keep them from
// regressing. Mock mode only, no API and no DB:
//   pnpm test:e2e:mock e2e/legend-fe-small.mock.spec.ts
const baseURL =
  process.env.LEGEND_MOCK_WEB_URL ?? process.env.E2E_MOCK_BASE_URL;
test.skip(
  !baseURL,
  "Mock runner not started: use pnpm test:e2e:mock (playwright.mock.config.ts).",
);
test.use({ baseURL });

test("legend-j48q · the customer shell 'Masuk' button opens /masuk, never /sign-in", async ({
  page,
  context,
}) => {
  // Mock mode signs everyone in by default; the role cookie "none" signs out.
  await context.addCookies([
    { name: "legend-mock-role", value: "none", url: baseURL },
  ]);
  await page.goto("/f/00000000-0000-4000-8000-000000009002", {
    waitUntil: "networkidle",
  });
  const signIn = page.getByRole("banner").getByRole("link", { name: "Masuk" });
  await expect(signIn).toBeVisible();
  const href = await signIn.getAttribute("href");
  expect(href).toMatch(/^\/masuk(\?|$)/);
  expect(href).not.toContain("/sign-in");
  await signIn.click();
  await expect(page).toHaveURL(/\/masuk(\?|$)/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Masuk ke Legend" }),
  ).toBeVisible();
});

test("legend-gy1o · the purchasing page has exactly one <main> landmark", async ({
  page,
}) => {
  await page.goto("/kelola/pengadaan?mock=normal");
  await expect(
    page.getByRole("heading", { name: "Daftar permintaan" }),
  ).toBeVisible();
  // The shell owns the skip-link target; the page must not add a second one.
  await expect(page.getByRole("main")).toHaveCount(1);
  await expect(page.locator("main")).toHaveCount(1);
  await expect(page.locator("main#main-content")).toHaveCount(1);
});

test("legend-radz · FormField gives a Radix Select trigger its name, id and error wiring", async ({
  page,
}) => {
  await page.goto("/platform/akses-dukungan?mock=normal", {
    waitUntil: "networkidle",
  });
  await page.getByRole("button", { name: "Minta akses" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Minta akses dukungan" });

  // The label names the trigger: getByRole("combobox", { name }) resolves only
  // through aria-labelledby/for, since the trigger has no text of its own name.
  const tenant = dialog.getByRole("combobox", { name: /Tenant/ });
  await expect(tenant).toBeVisible();
  await expect(tenant).toHaveAttribute("id", /.+/);
  await expect(tenant).toHaveAttribute("aria-labelledby", /-label$/);
  const labelFor = await dialog
    .locator("label", { hasText: "Tenant" })
    .first()
    .getAttribute("for");
  expect(labelFor).toBe(await tenant.getAttribute("id"));
  await expect(tenant).toHaveAttribute("aria-required", "true");

  // Submitting empty marks the trigger invalid and points it at the error.
  await dialog.getByRole("button", { name: "Mulai sesi" }).click();
  await expect(tenant).toHaveAttribute("aria-invalid", "true");
  const describedBy = await tenant.getAttribute("aria-describedby");
  expect(describedBy).toMatch(/-error/);
});
