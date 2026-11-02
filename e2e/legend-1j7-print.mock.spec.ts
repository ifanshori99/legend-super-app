import { expect, test } from "@playwright/test";

const poId = "00000000-0000-4000-8000-000000008501";

test("PRD §3.18: purchase order has a print-ready document", async ({
  page,
}) => {
  await page.goto(`/kelola/pengadaan/po/${poId}/cetak`);
  await expect(
    page.getByRole("heading", { name: "PO/BDG/2026/10/0042" }),
  ).toBeVisible();
  await expect(page.getByText("Kopi Arabika Gayo")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Cetak / simpan PDF" }),
  ).toBeVisible();
  await page.emulateMedia({ media: "print" });
  await expect(page.locator(".purchase-print-sheet")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Cetak / simpan PDF" }),
  ).toBeHidden();
});
