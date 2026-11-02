import { expect, test } from "@playwright/test";

// Explicit state coverage for the contract-backed purchasing mock.
test("PRD §3.18 / Alur I: empty and error states offer a way forward", async ({
  page,
}) => {
  await page.goto("/kelola/pengadaan?mock=empty");
  await expect(page.getByText(/belum ada/i).first()).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Buat permintaan" }),
  ).toBeVisible();

  await page.goto("/kelola/pengadaan?mock=error");
  await expect(page.getByRole("alert").first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole("button", { name: /coba lagi/i })).toBeVisible();
});
