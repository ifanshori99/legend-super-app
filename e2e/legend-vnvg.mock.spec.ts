// Invitation to link WhatsApp on the member screens (bead legend-vnvg; PRD v1.7
// §3 F3 "Penautan WhatsApp", AUTH-07). Runs against the FE mock runtime
// (VITE_API_MOCK=true): `?mock=wa-unverified` makes getCurrentAuth answer
// whatsAppVerified=false, the default answers true. Screenshots go through
// e2e/screenshots.ts and only reach the evidence folder with
// LEGEND_CAPTURE_SCREENSHOTS=1.
import { expect, test, type Page } from "@playwright/test";
import { waitForHydration } from "./hydration.ts";
import { captureScreenshot } from "./screenshots.ts";

const MOCK_URL =
  process.env.LEGEND_MOCK_WEB_URL ??
  process.env.E2E_MOCK_BASE_URL ??
  process.env.LEGEND_MOCK_URL;

test.skip(
  !MOCK_URL,
  "Needs a VITE_API_MOCK=true server (pnpm test:e2e:mock); see the header of this file.",
);

const PROMPT_TITLE = "Hubungkan WhatsApp";

async function open(page: Page, path: string, scenario?: string) {
  await page.goto(scenario ? `${path}?mock=${scenario}` : path, {
    waitUntil: "networkidle",
  });
  await waitForHydration(page);
}

for (const path of ["/member", "/member/poin"]) {
  test(`legend-vnvg: ${path} invites an unlinked member to connect WhatsApp`, async ({
    page,
  }) => {
    await open(page, path, "wa-unverified");
    const prompt = page.getByTestId("member-whatsapp-prompt");
    await expect(prompt).toBeVisible({ timeout: 20_000 });
    await expect(
      prompt.getByRole("heading", { name: PROMPT_TITLE }),
    ).toBeVisible();
    await expect(prompt.getByText("WhatsApp belum terhubung")).toBeVisible();
    await expect(
      prompt.getByRole("link", { name: PROMPT_TITLE }),
    ).toHaveAttribute(
      "href",
      `/masuk/hubungkan?lanjut=${encodeURIComponent(path)}`,
    );
  });

  test(`legend-vnvg: ${path} hides the invitation once WhatsApp is verified`, async ({
    page,
  }) => {
    await open(page, path, "wa-verified");
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({
      timeout: 20_000,
    });
    // The check settled (no skeleton left) and no prompt remains.
    await expect(page.getByText("Memuat status WhatsApp")).toHaveCount(0, {
      timeout: 20_000,
    });
    await expect(page.getByTestId("member-whatsapp-prompt")).toHaveCount(0);
  });
}

// The link screen returns to the member screen the visitor started from. Only
// /member paths count: anything else falls back to the member home.
for (const [lanjut, expected] of [
  ["/member/poin", "/member/poin"],
  ["/member", "/member"],
  ["/member/poin?x=1#y", "/member/poin"],
  ["https://evil.example/member", "/member"],
  ["//evil.example", "/member"],
  ["/masuk", "/member"],
  ["/member/../masuk", "/member"],
  ["/member/%2Fevil", "/member"],
] as const) {
  test(`legend-vnvg: /masuk/hubungkan?lanjut=${lanjut} returns to ${expected}`, async ({
    page,
  }) => {
    await page.goto(
      `/masuk/hubungkan?lanjut=${encodeURIComponent(lanjut)}&mock=wa-verified`,
      { waitUntil: "networkidle" },
    );
    await waitForHydration(page);
    await expect(
      page.getByRole("link", { name: "Ke halaman member" }),
    ).toHaveAttribute("href", expected, { timeout: 20_000 });
  });
}

test("legend-vnvg: the empty points history asks to connect WhatsApp while unlinked", async ({
  page,
}) => {
  // The server renders the ledger from fixtures, so reach the empty ledger by
  // a client-side navigation, which reads the scenario.
  await open(page, "/member", "wa-unverified-empty");
  await page.getByRole("link", { name: "Lihat riwayat poin" }).click();
  await expect(page.getByTestId("member-whatsapp-prompt")).toBeVisible({
    timeout: 20_000,
  });
  await expect(
    page.getByText("Hubungkan WhatsApp untuk mulai mengumpulkan poin."),
  ).toBeVisible();
  await expect(page.getByText("Belum ada mutasi poin.")).toHaveCount(0);
});

test("legend-vnvg: a failed status check shows an error with a retry", async ({
  page,
}) => {
  await open(page, "/member/poin", "error");
  const alert = page
    .getByRole("alert")
    .filter({ hasText: "Status WhatsApp belum dapat diperiksa" });
  await expect(alert).toBeVisible({ timeout: 20_000 });
  await expect(
    alert.getByText("Periksa koneksi kamu, lalu coba lagi."),
  ).toBeVisible();
  await expect(alert.getByRole("button", { name: "Coba lagi" })).toBeVisible();
});

for (const width of [390, 1280]) {
  for (const [name, scenario] of [
    ["belum-terhubung", "wa-unverified"],
    ["terhubung", "wa-verified"],
  ] as const) {
    test(`legend-vnvg visual ${name} ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      for (const [screen, path] of [
        ["member", "/member"],
        ["poin", "/member/poin"],
      ] as const) {
        await open(page, path, scenario);
        await expect(page.getByText("Memuat status WhatsApp")).toHaveCount(0, {
          timeout: 20_000,
        });
        await captureScreenshot(
          page,
          `member-whatsapp-link/${screen}-${name}-${width}.png`,
        );
      }
    });
  }
}
