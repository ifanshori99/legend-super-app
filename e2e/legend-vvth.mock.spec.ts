// Design v3 sweep for the finance & stock kelola screens (bead legend-vvth,
// DESIGN.md v3 §5): the management topbar owns the page h1, section navigation
// is one tab group with a single aria-current link, summary panels are double
// shells, and table screens use the semantic Table (no uppercase header band).
//
// Runs against the mock-mode web server (no API, no database):
//   LEGEND_MOCK_PORT=3247 pnpm test:e2e:mock e2e/legend-vvth.mock.spec.ts
import { expect, test, type Page } from "@playwright/test";

const baseURL =
  process.env.LEGEND_MOCK_WEB_URL ?? process.env.E2E_MOCK_BASE_URL;

test.skip(
  !baseURL,
  "Mock runner not started: use pnpm test:e2e:mock (playwright.mock.config.ts).",
);
test.use({ baseURL });

/** Fixture ids from cafeLegendInventoryFixtures (stable by construction). */
const POSTED_COUNT = "00000000-0000-4000-8000-000000007802";
/** Posted journal fixture used by the accounting detail screen. */
const JOURNAL = "e1000000-0000-4000-8000-000000000005";

/** Waits for hydration: server-rendered links click before React attaches. */
async function ready(page: Page) {
  await page.waitForFunction(() =>
    Boolean((window as unknown as { __TSR_ROUTER__?: unknown }).__TSR_ROUTER__),
  );
  await page.waitForTimeout(250);
}

const AREAS = [
  { path: "/kelola/inventori", title: "Inventori" },
  { path: "/kelola/akuntansi", title: "Akuntansi" },
  { path: "/kelola/loyalty", title: "Loyalty" },
  { path: "/kelola/pajak", title: "Pajak & service charge" },
  { path: "/kelola/pembayaran", title: "Pembayaran" },
  { path: "/kelola/pengadaan", title: "Pengadaan" },
] as const;

test.describe("legend-vvth · finance & stock v3 sweep", () => {
  test("VVTH the shell topbar is the only h1 on every swept page", async ({
    page,
  }) => {
    for (const area of AREAS) {
      await page.goto(area.path, { waitUntil: "networkidle" });
      await expect(page.locator("#main-content")).toBeVisible();
      // One h1 for the page, and it belongs to the shell topbar.
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await expect(
        page.getByRole("heading", { level: 1, name: area.title }),
      ).toBeVisible();
      await expect(page.locator("#main-content h1")).toHaveCount(0);
    }
  });

  test("VVTH section navigation is one tab group with a single current tab", async ({
    page,
  }) => {
    const cases = [
      { path: "/kelola/inventori", nav: "Inventori", current: "Item" },
      {
        path: "/kelola/inventori/saldo",
        nav: "Inventori",
        current: "Saldo & Par",
      },
      { path: "/kelola/akuntansi", nav: "Akuntansi", current: "Bagan Akun" },
      {
        path: `/kelola/akuntansi/jurnal/${JOURNAL}`,
        nav: "Akuntansi",
        current: "Jurnal",
      },
      {
        path: "/kelola/loyalty",
        nav: "Loyalty & member",
        current: "Program",
      },
      {
        path: "/kelola/pajak",
        nav: "Pajak & service charge",
        current: "Aturan pajak",
      },
    ] as const;

    for (const entry of cases) {
      await page.goto(entry.path, { waitUntil: "networkidle" });
      await ready(page);
      const nav = page.getByRole("navigation", { name: entry.nav });
      await expect(nav).toBeVisible();
      const current = nav.locator('a[aria-current="page"]');
      await expect(current).toHaveCount(1);
      await expect(current).toHaveText(entry.current);
    }
  });

  test("VVTH stock balances keep one summary strip and a carded alert panel", async ({
    page,
  }) => {
    await page.goto("/kelola/inventori/saldo", { waitUntil: "networkidle" });
    await ready(page);

    const strip = page.getByRole("region", { name: "Ringkasan stok" });
    await expect(strip).toBeVisible();
    await expect(strip.getByText("Item di bawah par")).toBeVisible();
    await expect(strip.getByText("Nilai stok")).toBeVisible();

    await expect(
      page.getByRole("heading", { name: "Peringatan stok kritis" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Saldo per lokasi" }),
    ).toBeVisible();
  });

  test("VVTH opname variance review is a real table, not a custom header band", async ({
    page,
  }) => {
    await page.goto(`/kelola/inventori/opname/${POSTED_COUNT}`, {
      waitUntil: "networkidle",
    });
    await ready(page);

    await expect(
      page.getByRole("heading", { name: "Ringkasan selisih" }),
    ).toBeVisible();
    const table = page.getByRole("table");
    await expect(table).toBeVisible();
    for (const header of ["Item", "Sistem", "Fisik", "Selisih"]) {
      await expect(
        table.getByRole("columnheader", { name: header, exact: true }),
      ).toBeVisible();
    }
    // Amounts line up with tabular figures inside a numeric cell.
    await expect(table.getByRole("cell", { name: /Rp/ }).first()).toBeVisible();
  });

  test("VVTH the swept list screens still show their empty state", async ({
    page,
  }) => {
    await page.goto("/kelola/inventori/saldo?mock=empty", {
      waitUntil: "networkidle",
    });
    await ready(page);
    await expect(page.getByText("Belum ada saldo stok")).toBeVisible();
  });
});
