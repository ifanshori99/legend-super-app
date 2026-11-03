import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./screenshots.ts";

// Approval inbox (bead legend-mxl; PRD v1.7 §3 F7 Kotak Approval; MCP-04 UI;
// AUTH-06 distinct actor) against the FE mock runtime (mock e2e port 3301).
// The signed-in mock user is the owner, who requested the AI price change.
const NAV = { waitUntil: "networkidle" as const };
const INBOX = "/kelola/persetujuan?mock=normal";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
});

test("MCP-04 inbox lists user, AI and MCP requests with source badges", async ({
  page,
}) => {
  await page.goto(INBOX, NAV);
  const rows = page.getByTestId("approval-row");
  await expect(rows.first()).toBeVisible();
  await expect(rows.locator('[data-source="user"]').first()).toBeVisible();
  await expect(rows.locator('[data-source="ai"]').first()).toBeVisible();
  await expect(rows.locator('[data-source="mcp"]').first()).toBeVisible();
  // Locate by content, not position: the overdue request sorts first.
  await expect(rows.filter({ hasText: "Aksi AI" }).first()).toBeVisible();
  await expect(rows.filter({ hasText: "Terlambat" }).first()).toBeVisible();
});

test("MCP-04 deadline filter shows the overdue request and blocks the decision", async ({
  page,
}) => {
  await page.goto(INBOX, NAV);
  await page.getByRole("combobox", { name: "Batas waktu" }).click();
  await page.getByRole("option", { name: "Sudah lewat" }).click();
  const rows = page.getByTestId("approval-row");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Terlambat");
  await rows
    .first()
    .getByRole("button", { name: /Tinjau/ })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Batas waktu sudah lewat.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Setujui" })).toBeDisabled();
});

test("AUTH-06 the requester cannot approve their own AI request", async ({
  page,
}) => {
  await page.goto(INBOX, NAV);
  await page
    .getByTestId("approval-row")
    .filter({ hasText: "Aksi AI" })
    .getByRole("button", { name: /Tinjau/ })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Anda pemohon permintaan ini.")).toBeVisible();
  // F38: an agent proposal is labelled a draft that has not been applied.
  await expect(dialog.getByTestId("agent-draft-notice")).toContainText(
    "Belum ada yang diterapkan",
  );
  await expect(dialog.locator('[data-source="ai"]')).toContainText("Draf AI");
  await expect(dialog.getByTestId("approval-diff")).toContainText("28.000");
  await expect(dialog.getByTestId("approval-diff")).toContainText("30.000");
  await expect(dialog.getByRole("button", { name: "Setujui" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Tolak" })).toBeDisabled();
});

test("MCP-04 reject needs a reason, then asks for the second factor", async ({
  page,
}) => {
  await page.goto(INBOX, NAV);
  await page
    .getByTestId("approval-row")
    .filter({ hasText: "Refund" })
    .getByRole("button", { name: /Tinjau/ })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Tolak" }).click();
  await expect(
    dialog.getByText("Tulis alasan minimal 3 karakter."),
  ).toBeVisible();

  await dialog
    .getByLabel("Alasan keputusan", { exact: false })
    .fill("Bukti pembayaran belum lengkap.");
  await dialog.getByRole("button", { name: "Tolak" }).click();
  await expect(dialog.getByTestId("mfa-step-up")).toBeVisible();
  await dialog.getByLabel("Kode autentikator").fill("123456");
  await dialog.getByRole("button", { name: "Verifikasi dan kirim" }).click();
  await expect(page.getByText("Permintaan ditolak.").first()).toBeVisible();
});

test("MCP-04 deep link opens one request", async ({ page }) => {
  await page.goto(
    "/kelola/persetujuan/a9c00000-0000-4000-8000-000000000003?mock=normal",
    NAV,
  );
  await expect(page.getByTestId("approval-detail")).toBeVisible();
  await expect(page.getByText("Kopi Susu Legend")).toBeVisible();
});

for (const width of [390, 1440]) {
  for (const theme of ["light", "dark"]) {
    test(`MCP-04 visual ${width} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(
        (value) => localStorage.setItem("legend-theme", value),
        theme,
      );
      await page.goto(INBOX, NAV);
      const items = page.locator(
        '[data-testid="approval-card"]:visible, [data-testid="approval-row"]:visible',
      );
      await expect(items.first()).toBeVisible();
      await captureScreenshot(page, `legend-mxl/inbox-${width}-${theme}.png`);
      await items
        .filter({ hasText: "Refund" })
        .getByRole("button", { name: /Tinjau/ })
        .first()
        .click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await captureScreenshot(page, `legend-mxl/detail-${width}-${theme}.png`, {
        fullPage: false,
      });
    });
  }
}

for (const scenario of ["empty", "error", "offline"]) {
  test(`MCP-04 visual ${scenario} state`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(`/kelola/persetujuan?mock=${scenario}`, NAV);
    await expect(
      page
        .getByText(
          scenario === "empty"
            ? "Tidak ada permintaan menunggu"
            : scenario === "offline"
              ? "Anda sedang offline"
              : "Kotak Approval tidak bisa dimuat",
        )
        .first(),
    ).toBeVisible();
    await captureScreenshot(page, `legend-mxl/inbox-390-${scenario}.png`);
  });
}
