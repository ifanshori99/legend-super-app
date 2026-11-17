// WS-07 tax recap & Coretax export (bead legend-5fdy; PRD v1.7 §3 F19 "Pajak
// [P0] — Rekap PBJT, PPh 21 (dari payroll), PPh 23 (jasa supplier), dan PPN
// masukan bila badan usaha PKP, dengan ekspor dalam format yang siap diunggah
// ke Coretax DJP").
//
// Mock-mode spec: it runs against the web dev server with VITE_API_MOCK=true
// that `pnpm test:e2e:mock` starts (playwright.mock.config.ts) — no API, no
// database. Without LEGEND_MOCK_WEB_URL every test skips, so `pnpm test:e2e`
// (production build, mock compiled out) never fails on it.
import { expect, test, type Page } from "@playwright/test";
import { captureScreenshot } from "./screenshots.ts";

const base = process.env.LEGEND_MOCK_WEB_URL;

// The screen opens on the latest period with a recap, else the current
// business month (Asia/Jakarta). Pin the browser clock inside the fixtures'
// month so the spec never depends on the wall clock: one hour after the seeded
// November PBJT draft (cafeLegendAccountingFixtures.taxReports, generatedAt
// 2026-11-05T09:00Z). setFixedTime only fixes Date; timers keep running.
const FIXTURE_NOW = new Date("2026-11-05T17:00:00.000+07:00");

// The scenario retries a failing query a few times before the error state.
test.describe.configure({ timeout: 60_000 });

test.skip(
  !base,
  "Set LEGEND_MOCK_WEB_URL to a web server running VITE_API_MOCK.",
);

async function open(page: Page, path: string) {
  await page.clock.setFixedTime(FIXTURE_NOW);
  await page.goto(`${base}${path}`);
  // Hydration settles after load; a click before React attaches would be lost.
  await page.waitForLoadState("networkidle");
  // v3 (legend-vvth): the management topbar owns the page h1.
  await expect(
    page.getByRole("heading", { name: "Akuntansi", level: 1 }),
  ).toBeVisible();
}

test.describe("tax recap and Coretax export", () => {
  test("F19-Pajak: PBJT/PPN gating, generate, finalize and export a recap", async ({
    page,
  }) => {
    await open(page, "/kelola/akuntansi/pajak?mock=normal");

    // Fixtures' latest period opens with the seeded PBJT draft and its outlet.
    await expect(
      page.getByRole("heading", { name: "PBJT · November 2026" }),
    ).toBeVisible();
    await expect(page.getByText("Draf", { exact: true }).first()).toBeVisible();
    // Scope to the table: the mobile line list is in the DOM but hidden at
    // desktop widths.
    const seededTable = page.getByRole("table");
    await expect(
      seededTable.getByText("Cafe Legend Bandung").first(),
    ).toBeVisible();
    await expect(seededTable.getByText(/Rp\s?37\.500/).first()).toBeVisible();

    // Finalising November is refused: the fiscal period is still open
    // (contract transitionTaxReport → PERIOD_NOT_CLOSED). The refusal stays on
    // the report card, next to the action.
    await page.getByRole("button", { name: "Finalkan", exact: true }).click();
    const finalizeAll = page.getByRole("dialog");
    await expect(
      finalizeAll.getByText("Finalkan rekap PBJT?", { exact: true }),
    ).toBeVisible();
    await finalizeAll
      .getByRole("button", { name: "Finalkan rekap", exact: true })
      .click();
    await expect(
      page.getByText(
        "Periode buku ini belum ditutup, jadi rekap belum dapat difinalkan.",
        { exact: true },
      ),
    ).toBeVisible({ timeout: 15_000 });

    // October is closed. No PBJT recap exists there, so the empty state offers
    // the one next action.
    await page.getByRole("button", { name: "Periode sebelumnya" }).click();
    await expect(page.getByLabel("Periode buku")).toHaveValue("2026-10");
    await expect(
      page.getByRole("heading", { name: "PBJT · Oktober 2026" }),
    ).toBeVisible();
    await expect(page.getByText("Belum ada rekap PBJT")).toBeVisible();

    await page.getByRole("button", { name: "Buat rekap" }).click();
    const generate = page.getByRole("dialog");
    await expect(
      generate.getByText("Buat rekap PBJT", { exact: true }),
    ).toBeVisible();
    await expect(
      generate.getByText("PT Sultan Solusi Nusantara").first(),
    ).toBeVisible();
    await generate
      .getByRole("button", { name: "Buat draf rekap", exact: true })
      .click();
    await expect(
      page.getByText("Rekap pajak dibuat sebagai draf.").first(),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Draf", { exact: true }).first()).toBeVisible();
    // The recap carries the stored line values, including the total.
    await expect(
      page.getByRole("table").getByText(/Rp\s?37\.500/).first(),
    ).toBeVisible();

    // draft → final locks the numbers; the status history records it.
    await page.getByRole("button", { name: "Finalkan", exact: true }).click();
    const lock = page.getByRole("dialog");
    await expect(
      lock.getByText(/Setelah final, angka rekap periode Oktober 2026/),
    ).toBeVisible();
    await lock
      .getByRole("button", { name: "Finalkan rekap", exact: true })
      .click();
    await expect(page.getByText("Final", { exact: true }).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("Difinalkan", { exact: true })).toBeVisible();

    // final → exported: the artifact dialog shows the Coretax file metadata,
    // downloads the server's artifact as-is, and offers a CSV check copy.
    await page.getByRole("button", { name: "Ekspor Coretax" }).click();
    const artifact = page.getByRole("dialog");
    await expect(
      artifact.getByText("Berkas Coretax siap", { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      artifact.getByText("coretax-pbjt-2026-10-r0.xml", { exact: true }),
    ).toBeVisible();
    await expect(
      artifact.getByText("Coretax XML", { exact: true }),
    ).toBeVisible();

    const xmlPromise = page.waitForEvent("download");
    await artifact.getByRole("link", { name: "Unduh berkas Coretax" }).click();
    const xml = await xmlPromise;
    expect(xml.suggestedFilename()).toBe("coretax-pbjt-2026-10-r0.xml");

    const downloadPromise = page.waitForEvent("download");
    await artifact.getByRole("button", { name: "Unduh CSV" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("rekap-pbjt-2026-10.csv");
    // The header X and the footer both announce "Tutup": close via the footer.
    await artifact
      .getByRole("button", { name: "Tutup", exact: true })
      .last()
      .click();
    await expect(
      page.getByText("Terekspor", { exact: true }).first(),
    ).toBeVisible();

    // PPN masukan is gated instead of an empty table: the entity is not PKP.
    await page.getByRole("radio", { name: "PPN masukan" }).click();
    await expect(
      page.getByText("PPN masukan belum berlaku", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Status PKP badan usaha: Belum PKP", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("table")).toHaveCount(0);

    // PPh 21 has a seeded exported recap for October; PPh 23 has none.
    await page.getByRole("radio", { name: "PPh 21", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "PPh 21 · Oktober 2026" }),
    ).toBeVisible();
    await expect(
      page.getByText("Terekspor", { exact: true }).first(),
    ).toBeVisible();
    await page.getByRole("radio", { name: "PPh 23", exact: true }).click();
    await expect(page.getByText("Belum ada rekap PPh 23")).toBeVisible();
  });

  test("F19-Pajak: the recap is readable at 390px and exports from the phone", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, "/kelola/akuntansi/pajak?mock=normal");
    await expect(
      page.getByRole("heading", { name: "PBJT · November 2026" }),
    ).toBeVisible();
    // The mobile line block shows the subject and the stored amount, not a
    // clipped six-column table.
    await expect(page.getByText("Cafe Legend Bandung").first()).toBeVisible();
    await expect(
      page.getByText("Basis (DPP)", { exact: true }).first(),
    ).toBeVisible();
    await page.getByRole("radio", { name: "PPN masukan" }).click();
    await expect(
      page.getByText("PPN masukan belum berlaku", { exact: true }),
    ).toBeVisible();
  });
});

for (const width of [390, 1440]) {
  for (const theme of ["light", "dark"]) {
    test(`F19-Pajak visual ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.clock.setFixedTime(FIXTURE_NOW);
      await page.addInitScript(
        (value) => localStorage.setItem("legend-theme", value),
        theme,
      );
      await page.goto(`${base}/kelola/akuntansi/pajak?mock=normal`, {
        waitUntil: "networkidle",
      });
      await expect(
        page.getByRole("heading", { name: "PBJT · November 2026" }),
      ).toBeVisible();
      await captureScreenshot(page, `legend-5fdy/${width}-${theme}.png`);
    });
  }
}

for (const scenario of ["empty", "error"]) {
  test(`F19-Pajak visual ${scenario}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.clock.setFixedTime(FIXTURE_NOW);
    await page.goto(`${base}/kelola/akuntansi/pajak?mock=${scenario}`, {
      waitUntil: "networkidle",
    });
    await expect(
      page
        .getByText(
          scenario === "error"
            ? "Data tidak dapat dimuat"
            : "Belum ada rekap PBJT",
        )
        .first(),
    ).toBeVisible({ timeout: 20_000 });
    if (scenario === "error")
      await expect(
        page.getByRole("button", { name: "Coba lagi" }),
      ).toBeVisible();
    await captureScreenshot(page, `legend-5fdy/390-${scenario}.png`);
  });
}
