// WS-10 onboarding/offboarding FE (bead legend-u3x3; PRD v1.7 §3 D26
// "Onboarding"/"Offboarding", §4 Alur M). Runs against the FE mock runtime: the
// screens read @starter/shared/hris fixtures through VITE_API_MOCK=true, no API
// and no database (frontend standard, "Typed endpoints and mock mode").
//
// How to run: `pnpm test:e2e:mock` starts a VITE_API_MOCK web server and names
// it in `LEGEND_MOCK_WEB_URL`. With no variable set every test skips, so the
// production-build runner stays green.
import { expect, test } from "@playwright/test";
import { waitForHydration } from "./hydration.ts";
import { captureScreenshot } from "./screenshots.ts";

const MOCK_URL = process.env.LEGEND_MOCK_WEB_URL;

test.skip(
  !MOCK_URL,
  "Needs a VITE_API_MOCK=true server (pnpm test:e2e:mock); see the header of this file.",
);

/** Vite's first compile of a route outlasts the 5 s assertion default. */
const COLD_START_TIMEOUT_MS = 30_000;

/** The two onboarding fixtures: CL-1019 (manager) and CL-1020 (barista). */
const SRI_RAHAYU = "00000000-0000-4000-8000-000000001020";
/** The terminated fixture with an offboarding checklist. */
const NADIA_SAFITRI = "00000000-0000-4000-8000-000000001018";

type Theme = "light" | "dark";

async function openTheme(page: import("@playwright/test").Page, theme: Theme) {
  await page.addInitScript(
    (value) => localStorage.setItem("legend-theme", value),
    theme,
  );
}

test("F24 Alur M: the onboarding list shows the fixture employees and their progress", async ({
  page,
}) => {
  await page.goto("/kelola/onboarding?mock=normal");
  await expect(
    page.getByRole("heading", { name: "Karyawan dalam onboarding" }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });

  // One StatStrip for the list's numbers (DESIGN.md §5 Management).
  await expect(
    page.getByRole("region", { name: "Ringkasan onboarding" }),
  ).toBeVisible();

  // Both onboarding fixtures, with the checklist progress the task rows give.
  await expect(page.getByText("Sri Rahayu", { exact: true })).toBeVisible();
  await expect(page.getByText("Andi Wijaya", { exact: true })).toBeVisible();
  await expect(page.getByText("1/2 tugas")).toBeVisible();
  await expect(page.getByText("0/1 tugas")).toBeVisible();

  // The template that applies to the barista position.
  await expect(page.getByText("Onboarding Barista")).toBeVisible();
});

test("F24 Alur M: completing a task on the onboarding detail moves the progress", async ({
  page,
}) => {
  await page.goto(`/kelola/onboarding/${SRI_RAHAYU}?mock=normal`);
  await waitForHydration(page);

  // The barista fixture has one done and one open task.
  await expect(page.getByRole("heading", { name: "Sri Rahayu" })).toBeVisible({
    timeout: COLD_START_TIMEOUT_MS,
  });
  await expect(page.getByText("50% selesai")).toBeVisible();

  const complete = page.getByRole("button", {
    name: "Selesaikan tugas Pelatihan Dasar Barista",
  });
  // A click before hydration is lost; retry until the row leaves the list.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if ((await complete.count()) === 0) break;
    await complete.click();
    await page.waitForTimeout(400);
  }

  // The task action runs through the contract's transition and the mock store,
  // then the checklist refetches: 2 of 2 tasks are done.
  await expect(page.getByText("100% selesai")).toBeVisible();
  await expect(complete).toHaveCount(0);
});

/** Clicks until the button leaves the list; a click before hydration is lost. */
async function clickUntilGone(button: import("@playwright/test").Locator) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if ((await button.count()) === 0) return;
    await button.click();
    await button.page().waitForTimeout(400);
  }
}

test("F24 Alur M: exit clearance locks the work certificate until every clearance task is done", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openTheme(page, "light");
  await page.goto(`/kelola/offboarding/${NADIA_SAFITRI}?mock=normal`);
  await waitForHydration(page);

  await expect(
    page.getByRole("heading", { name: "Nadia Safitri" }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await expect(
    page.getByRole("heading", { name: "Checklist exit clearance" }),
  ).toBeVisible();

  // The fixture: asset done, final settlement blocked, certificate open.
  // The certificate task itself does not count toward clearance.
  await expect(
    page.getByText(
      "Exit clearance belum selesai: 1 tugas masih terbuka atau terblokir.",
    ),
  ).toBeVisible();
  const viewCertificate = page.getByRole("button", { name: "Lihat surat" });
  await expect(viewCertificate).toBeDisabled();
  await expect(
    page.getByRole("button", {
      name: "Selesaikan tugas Surat keterangan kerja",
    }),
  ).toBeDisabled();

  // Final settlement: an estimate from the payroll endpoints, never a total.
  await expect(
    page.getByRole("heading", { name: "Ringkasan penyelesaian akhir" }),
  ).toBeVisible();
  await expect(page.getByText("Estimasi", { exact: true })).toBeVisible();
  await expect(page.getByText("THR pro rata", { exact: true })).toBeVisible();
  // The daily-paid fixture has no THR wage component on record.
  await expect(
    page.getByText("Belum ada komponen upah THR tercatat"),
  ).toBeVisible();
  await expect(page.getByText("Tidak ada kasbon aktif")).toBeVisible();
  await expect(
    page.getByText(/Angka final mengikuti payroll run yang sudah dikunci/),
  ).toBeVisible();

  await captureScreenshot(page, "legend-u3x3/offboarding-1440-light.png");

  // Clear the blocked task: unblock, then complete.
  await clickUntilGone(
    page.getByRole("button", {
      name: "Buka blokir tugas Perhitungan hak akhir",
    }),
  );
  await clickUntilGone(
    page.getByRole("button", {
      name: "Selesaikan tugas Perhitungan hak akhir",
    }),
  );
  await expect(
    page.getByText(
      "Exit clearance selesai. Surat keterangan kerja bisa dibuka.",
    ),
  ).toBeVisible();

  // The certificate opens and prints only the employee's work facts.
  await expect(viewCertificate).toBeEnabled();
  await viewCertificate.click();
  await expect(
    page.getByRole("heading", { name: "SURAT KETERANGAN KERJA", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Nomor diterbitkan saat surat disahkan").first(),
  ).toBeVisible();
  await expect(page.getByText("Dimas Saputra").first()).toBeVisible();
  await expect(
    page.getByText("PT Sultan Solusi Nusantara").first(),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Cetak" })).toBeVisible();
  await captureScreenshot(
    page,
    "legend-u3x3/offboarding-certificate-1440-light.png",
  );
  await page.keyboard.press("Escape");
});

test("F24 Alur M: offboarding detail visual 390 dark", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await openTheme(page, "dark");
  await page.goto(`/kelola/offboarding/${NADIA_SAFITRI}?mock=normal`);
  await expect(
    page.getByRole("heading", { name: "Nadia Safitri" }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await expect(page.getByText("THR pro rata", { exact: true })).toBeVisible();
  await captureScreenshot(page, "legend-u3x3/offboarding-390-dark.png");
});

const SHOTS: { width: number; theme: Theme }[] = [
  { width: 390, theme: "light" },
  { width: 390, theme: "dark" },
  { width: 1440, theme: "light" },
];

for (const { width, theme } of SHOTS) {
  test(`F24 Alur M: onboarding visual ${width} ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openTheme(page, theme);
    await page.goto("/kelola/onboarding?mock=normal");
    await expect(
      page.getByRole("heading", { name: "Karyawan dalam onboarding" }),
    ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
    // Capture the loaded list, not the skeleton.
    await expect(page.getByText("Sri Rahayu", { exact: true })).toBeVisible();
    await captureScreenshot(
      page,
      `legend-u3x3/onboarding-${width}-${theme}.png`,
    );
  });
}

test("F24 Alur M: an empty onboarding list explains what will appear", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/kelola/onboarding?mock=empty");
  await expect(
    page.getByText("Belum ada karyawan dalam onboarding", { exact: true }),
  ).toBeVisible({ timeout: COLD_START_TIMEOUT_MS });
  await captureScreenshot(page, "legend-u3x3/onboarding-390-empty.png");
});
