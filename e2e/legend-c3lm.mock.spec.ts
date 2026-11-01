import { expect, test } from "@playwright/test";

// Member PWA (bead legend-c3lm) against mock mode: the fixtures from
// @starter/shared/crm, the same contract validation the API applies, and the
// LOY-03 redemption rules. Acceptance IDs live in the test names.

declare global {
  interface Window {
    __TSR_ROUTER__?: {
      navigate: (options: { to: string }) => Promise<void>;
    };
    __legendMock?: {
      setScenario: (scenario: string) => void;
    };
  }
}

test("member overview shows balance, tier and every member section (LOY-03)", async ({
  page,
}) => {
  await page.goto("/member");
  await expect(
    page.getByRole("heading", { level: 1, name: /Halo, / }),
  ).toBeVisible();
  await expect(page.getByText("Saldo poin")).toBeVisible();
  await expect(page.getByText("Tier saat ini")).toBeVisible();
  await expect(page.getByText("Misi aktif")).toBeVisible();
  await expect(page.getByText("Hadiah untuk ditukar")).toBeVisible();
  await expect(page.getByText("Voucher kamu")).toBeVisible();
  await expect(page.getByText("Kunjungan terakhir")).toBeVisible();
  await expect(page.getByText("Menu favorit")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Lihat riwayat poin" }),
  ).toBeVisible();
});

test("member navigates points, missions, vouchers, visits and favorites (LOY-03)", async ({
  page,
}) => {
  await page.goto("/member/poin");
  await expect(page.getByRole("heading", { name: "Poin saya" })).toBeVisible();
  await expect(page.getByText("Riwayat poin")).toBeVisible();

  await page.getByRole("link", { name: "Misi" }).click();
  await expect(page.getByRole("heading", { name: "Misi saya" })).toBeVisible();
  await expect(page.getByText("Stamp Card 10 Kopi")).toBeVisible();

  await page.getByRole("link", { name: "Voucher" }).click();
  await expect(
    page.getByRole("heading", { name: "Voucher saya" }),
  ).toBeVisible();
  await expect(page.getByRole("tab", { name: "Aktif" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await page.getByRole("link", { name: "Member" }).click();
  await page.locator('a[href="/member/kunjungan"]').click();
  await expect(
    page.getByRole("heading", { name: "Riwayat kunjungan" }),
  ).toBeVisible();
  await page.goto("/member/favorit");
  await expect(
    page.getByRole("heading", { name: "Menu favorit" }),
  ).toBeVisible();
  await expect(page.getByText("Kopi Susu Aren")).toBeVisible();
});

test("redeeming a reward spends points once and shows a pickup code (LOY-03)", async ({
  page,
}) => {
  // Reach the catalog through the router (client navigation), which is also
  // how a member gets there from a push notification or the bottom nav.
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.__TSR_ROUTER__));
  await page.evaluate(() =>
    window.__TSR_ROUTER__?.navigate({ to: "/member/reward" }),
  );
  await expect(
    page.getByRole("heading", { name: "Katalog hadiah" }),
  ).toBeVisible();
  await expect(page.getByText("Poin kamu: 1.240")).toBeVisible();

  await page
    .getByRole("button", { name: "Tukar", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Sisa saldo 990")).toBeVisible();

  // A double tap must not spend twice: both clicks share one idempotency key
  // and the mock enforces it like the API (LOY-03).
  await page.evaluate(() => {
    const confirm = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Tukar sekarang",
    );
    confirm?.click();
    confirm?.click();
  });
  await expect(page.getByText("Penukaran berhasil")).toBeVisible();
  const code = await page.getByText(/^RWD[A-Z0-9]{5}$/).textContent();
  expect(code).toMatch(/^RWD[A-Z0-9]{5}$/);

  await page.getByRole("button", { name: "Selesai" }).click();
  await expect(page.getByText("Poin kamu: 990")).toBeVisible();

  await page.evaluate(() =>
    window.__TSR_ROUTER__?.navigate({ to: "/member/poin" }),
  );
  await expect(page.getByRole("heading", { name: "Poin saya" })).toBeVisible();
  await expect(page.getByText("-250")).toHaveCount(1);
});

test("membership screen verifies WhatsApp and saves versioned consents (AUTH-07)", async ({
  page,
}) => {
  await page.goto("/member/daftar");
  await page.waitForFunction(() => Boolean(window.__TSR_ROUTER__));
  await expect(
    page.getByRole("heading", { name: "Keanggotaan Legend" }),
  ).toBeVisible();
  await expect(
    page.getByText("WhatsApp terverifikasi", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Persetujuan program loyalty")).toBeVisible();
  await expect(page.getByText("Versi kebijakan 2026-01").first()).toBeVisible();

  await page.getByLabel("Program loyalty (wajib)").uncheck();
  await expect(
    page.getByText("Tanpa persetujuan program", { exact: false }),
  ).toBeVisible();

  const save = page.getByRole("button", { name: "Simpan persetujuan" });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(
    page.getByText("Persetujuan tersimpan.", { exact: true }),
  ).toBeVisible();
  await expect(save).toBeDisabled();
});

test("member lists keep their empty state (LOY-03)", async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem("legend-mock-scenario", "empty"),
  );
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.__TSR_ROUTER__));
  await page.evaluate(() =>
    window.__TSR_ROUTER__?.navigate({ to: "/member/misi" }),
  );
  await expect(
    page.getByText("Belum ada misi aktif. Cek lagi bulan depan."),
  ).toBeVisible();
  await page.evaluate(() =>
    window.__TSR_ROUTER__?.navigate({ to: "/member/reward" }),
  );
  await expect(
    page.getByText("Belum ada hadiah yang bisa ditukar."),
  ).toBeVisible();
});
