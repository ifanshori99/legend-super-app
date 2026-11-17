import { expect, test } from "@playwright/test";

// Staff second factor, security settings and device sessions (bead legend-9bh;
// PRD v1.7 §3 F6 "Staf — Login Web", "Sesi & Perangkat", AUTH-05) against mock
// mode: the identity fixtures from @starter/shared/identity, the same contract
// validation the API applies, and the TOTP enrollment/verify rules.
// Acceptance ID in every test name: AUTH-05.
//
// Demo data (features/ws01-auth/mock.ts): the owner owes a second factor and
// has two devices; any six digits verify except 000000 (wrong code);
// localStorage["legend-mock-session"] = "idle" shortens the idle deadline.

test("AUTH-05: a staff user verifies the second factor and continues to the dashboard", async ({
  page,
}) => {
  await page.goto("/verifikasi");
  await expect(
    page.getByRole("heading", { name: "Verifikasi dua langkah" }),
  ).toBeVisible();
  await expect(page.getByText(/Masuk sebagai/)).toBeVisible();

  await page.getByLabel("Kode 6 angka").fill("123456");
  await page.getByRole("button", { name: "Verifikasi" }).click();

  await expect(page).toHaveURL(/\/kelola$/);
  await expect(
    page.getByText("Verifikasi berhasil. Membuka dashboard…", { exact: true }),
  ).toBeVisible();
});

test("AUTH-05: a wrong code keeps the session closed with a fix hint", async ({
  page,
}) => {
  await page.goto("/verifikasi");
  await page.getByLabel("Kode 6 angka").fill("000000");
  await page.getByRole("button", { name: "Verifikasi" }).click();

  await expect(
    page.getByText(/Kode salah atau sudah kedaluwarsa/),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/verifikasi/);
});

test("AUTH-05: the security page lists factors and devices, and revokes a device", async ({
  page,
}) => {
  await page.goto("/kelola/keamanan");
  await expect(
    page.getByRole("heading", { level: 1, name: "Keamanan akun" }),
  ).toBeVisible();

  // Two enrolled factors for the demo owner.
  await expect(
    page.getByText("Aplikasi autentikator", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Passkey", { exact: true })).toBeVisible();
  // Current device is marked and not revocable.
  await expect(page.getByText("Safari di Mac")).toBeVisible();
  await expect(page.getByText("Sesi ini")).toBeVisible();
  const sessions = page.getByRole("region", { name: "Sesi & perangkat" });
  await expect(sessions.getByText("Chrome di iPhone")).toBeVisible();

  await sessions.getByRole("button", { name: "Cabut", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Cabut sesi perangkat ini?" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cabut sesi" }).click();

  await expect(
    sessions.getByRole("listitem").filter({ hasText: "Chrome di iPhone" }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Sesi Chrome di iPhone dicabut.", { exact: true }),
  ).toBeVisible();
});

test("AUTH-05: an MFA role cannot remove its last second factor", async ({
  page,
}) => {
  await page.goto("/kelola/keamanan");
  await expect(page.getByText("Passkey", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Hapus" }).first().click();
  await expect(
    page.getByRole("heading", { name: "Hapus faktor kedua?" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Hapus" }).last().click();

  await expect(
    page.getByText(/Tambahkan faktor lain sebelum menghapus yang terakhir/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Hapus" }).first(),
  ).toBeDisabled();
});

test("AUTH-05: the idle warning appears before a management session ends", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("legend-mock-session", "idle");
  });
  await page.goto("/kelola/keamanan");

  await expect(
    page.getByRole("heading", { name: "Sesi akan segera berakhir" }),
  ).toBeVisible();
  await expect(page.getByText(/Sisa waktu sekitar/)).toBeVisible();

  const heading = page.getByRole("heading", {
    name: "Sesi akan segera berakhir",
  });
  await page.getByRole("button", { name: "Lanjut bekerja" }).click();
  await expect(heading).toHaveCount(0);
  // The mock is in-process (no network request to await), and the refetch it
  // starts settles within a few ms at 0 latency. Hold the absence check past
  // it, so a deadline that moves per read (legend-dw4d) cannot pass by closing
  // the dialog only until the refetch lands.
  await page.waitForTimeout(300);
  await expect(heading).toHaveCount(0);
});

test("AUTH-05: a failed refresh keeps the idle warning open with retry text", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("legend-mock-session", "idle"),
  );
  await page.goto("/kelola/keamanan");
  await expect(
    page.getByRole("heading", { name: "Sesi akan segera berakhir" }),
  ).toBeVisible();
  await page.evaluate(() =>
    localStorage.setItem("legend-mock-auth-error", "503"),
  );
  await page.getByRole("button", { name: "Lanjut bekerja" }).click();
  await expect(
    page
      .getByRole("dialog", { name: "Sesi akan segera berakhir" })
      .getByRole("alert"),
  ).toContainText("Sesi belum diperbarui");
  await page.evaluate(() => localStorage.removeItem("legend-mock-auth-error"));
  await page.getByRole("button", { name: "Lanjut bekerja" }).click();
  await expect(
    page.getByRole("heading", { name: "Sesi akan segera berakhir" }),
  ).toHaveCount(0);
});

test("AUTH-05: an unauthorized refresh returns to sign-in with a safe path", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("legend-mock-session", "idle"),
  );
  await page.goto("/kelola/keamanan");
  await expect(
    page.getByRole("heading", { name: "Sesi akan segera berakhir" }),
  ).toBeVisible();
  await page.evaluate(() =>
    localStorage.setItem("legend-mock-auth-error", "401"),
  );
  await page.getByRole("button", { name: "Lanjut bekerja" }).click();
  await expect(page).toHaveURL(/\/masuk\?lanjut=%2Fkelola%2Fkeamanan/);
});

test("AUTH-05: the security page shows honest empty states", async ({
  page,
}) => {
  await page.goto("/kelola/keamanan?mock=empty");

  await expect(page.getByText("Belum ada faktor kedua")).toBeVisible();
  await expect(page.getByText("Belum ada sesi perangkat")).toBeVisible();
});

test("AUTH-05: a failed load offers a retry instead of a blank page", async ({
  page,
}) => {
  await page.goto("/kelola/keamanan?mock=error");

  await expect(
    page.getByText("Data keamanan tidak dapat dimuat"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Coba lagi" })).toBeVisible();
});
