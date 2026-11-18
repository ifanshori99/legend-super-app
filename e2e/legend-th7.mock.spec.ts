import { expect, test } from "@playwright/test";

// Floor plan & table editor (legend-th7, PRD v1.7 §3 F9 "Denah & Meja") against
// mock mode: a Vite dev server with VITE_API_MOCK=true, no API and no database.
// The role cookie defaults to `all`; the guard test switches it.
//
//   pnpm test:e2e:mock e2e/legend-th7.mock.spec.ts
const NAV = { waitUntil: "networkidle" as const };
const TABLES = "/kelola/meja?mock=normal";

test.describe("legend-th7 · floor plan & table editor", () => {
  test("F9 zones keep pay mode, service charge, minimum spend and hours", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await page.goto(TABLES, NAV);
    await expect(
      page.getByRole("heading", { name: "Denah & Meja", level: 1 }),
    ).toBeVisible();
    // The plan draws the fixtures' tables (A03 is occupied, 4 seats).
    await expect(
      page.getByRole("button", {
        name: /^Meja A03 · 4 kursi · Indoor Reguler/,
      }),
    ).toBeVisible();

    const indoor = page.getByRole("row", { name: /Indoor Reguler/ });
    await expect(indoor).toBeVisible();
    await expect(indoor).toContainText("Bayar di muka");
    await expect(indoor).toContainText("5%");
    await expect(indoor).toContainText("Tanpa minimum");
    await expect(indoor).toContainText("Setiap hari 08.00–22.00");

    // §3 F9 "Zona": the private room is open bill with a Rp 500.000 minimum.
    const privateRoom = page.getByRole("row", {
      name: /Private Room Nusantara/,
    });
    await expect(privateRoom).toContainText("Open bill");
    await expect(privateRoom).toContainText("10%");
    await expect(privateRoom).toContainText(/Rp\s?500\.000/);

    expect(errors).toEqual([]);
  });

  test("F9 zone settings form saves the pay mode and the service charge", async ({
    page,
  }) => {
    await page.goto(TABLES, NAV);
    await page
      .getByRole("button", { name: "Ubah zona Indoor Reguler" })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: "Pengaturan zona" }),
    ).toBeVisible();
    await expect(dialog.getByLabel("Nama zona")).toHaveValue("Indoor Reguler");

    await dialog.getByRole("radio", { name: "Open bill" }).click();
    await dialog.getByLabel("Service charge (%)").fill("7,5");
    await dialog.getByLabel("Minimum spend (Rp)").fill("150000");
    await dialog.getByRole("button", { name: "Simpan zona" }).click();
    await expect(
      page.getByText("Zona tersimpan", { exact: true }),
    ).toBeVisible();

    const indoor = page.getByRole("row", { name: /Indoor Reguler/ });
    await expect(indoor).toContainText("Open bill");
    await expect(indoor).toContainText("7.5%");
    await expect(indoor).toContainText(/Rp\s?150\.000/);
  });

  test("F9 a zone without a name is refused before it reaches the API", async ({
    page,
  }) => {
    await page.goto(TABLES, NAV);
    await page.getByRole("button", { name: "Ubah zona Taman Outdoor" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Nama zona").fill("");
    await dialog.getByRole("button", { name: "Simpan zona" }).click();
    await expect(dialog.getByText("Nama zona wajib diisi")).toBeVisible();
    await expect(dialog.getByLabel("Nama zona")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await expect(page.getByText("Zona tersimpan", { exact: true })).toHaveCount(
      0,
    );
  });

  test("F9 moving a table marks the plan dirty and saves it in one request", async ({
    page,
  }) => {
    await page.goto(TABLES, NAV);
    const a03 = page.getByRole("button", { name: /^Meja A03/ });
    await a03.click();
    const inspector = page.getByRole("region", { name: "Meja A03" });
    await expect(inspector.getByLabel("X")).toHaveValue("220");

    // Keyboard placement: one grid step per arrow press (DESIGN.md a11y).
    await a03.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(inspector.getByLabel("X")).toHaveValue("240");
    await expect(page.getByText("1 meja belum disimpan")).toBeVisible();

    await page.getByRole("button", { name: "Simpan denah" }).click();
    await expect(
      page.getByText("Denah tersimpan", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("1 meja belum disimpan")).toHaveCount(0);
    await expect(inspector.getByLabel("X")).toHaveValue("240");
  });

  test("F9 a new table gets the next number and a free slot on the plan", async ({
    page,
  }) => {
    await page.goto(TABLES, NAV);
    await page
      .getByRole("button", { name: "Tambah meja", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    // Indoor Reguler holds A01–A06: the next number is A07.
    await expect(dialog.getByLabel("Kode meja")).toHaveValue("A07");
    await dialog.getByLabel("Kapasitas (kursi)").fill("4");
    await dialog.getByRole("button", { name: "Tambah", exact: true }).click();
    await expect(page.getByText("Meja A07 ditambahkan").first()).toBeVisible();
    await expect(page.getByRole("button", { name: /^Meja A07/ })).toBeVisible();
  });

  test("F9 a zone that still holds tables cannot be deleted", async ({
    page,
  }) => {
    await page.goto(TABLES, NAV);
    await page
      .getByRole("button", { name: "Hapus zona Taman Outdoor" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Hapus zona Taman Outdoor?" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Hapus zona", exact: true }).click();
    // The API answers 409 CONFLICT; the dialog keeps the reason in view.
    await expect(page.getByRole("alert")).toContainText(
      "Zona masih berisi 2 meja",
    );
    await page.getByRole("button", { name: "Batal" }).click();
    await expect(
      page.getByRole("row", { name: /Taman Outdoor/ }),
    ).toBeVisible();
  });

  test("ORD-04 the QR sheet issues signed labels for the chosen tables", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await page.goto("/kelola/meja/qr?mock=normal", NAV);
    await expect(
      page.getByRole("heading", { name: "QR meja", level: 2 }),
    ).toBeVisible();
    await expect(page.getByText("Belum ada label")).toBeVisible();

    await page.getByRole("checkbox", { name: "Pilih meja A01" }).check();
    await page.getByRole("checkbox", { name: "Pilih meja B01" }).check();
    await page.getByRole("button", { name: "Buat QR (2)" }).click();
    await expect(
      page.getByRole("heading", { name: "Label siap cetak" }),
    ).toBeVisible();
    // One label per issued table, each with a scannable QR image and the URL.
    await expect(page.getByText("Pindai untuk memesan")).toHaveCount(2);
    // The brand line on each sticker is the outlet name, not "Legend" (Q33).
    await expect(
      page
        .locator(".floor-print-sheet article")
        .getByText("Cafe Legend Bandung"),
    ).toHaveCount(2);
    await expect(page.getByText(/^https:\/\/.+\/t\/v1\./)).toHaveCount(2);
    await expect(
      page.getByRole("img", { name: "Meja A01", exact: true }),
    ).toBeVisible();
    // Re-issuing a label is offered once a table has one.
    await expect(
      page.getByRole("button", { name: "Muat ulang QR" }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Cetak label" }),
    ).toBeVisible();

    expect(errors).toEqual([]);
  });

  test("ORD-04 the printed QR sheet lays labels in two columns on A4", async ({
    page,
  }) => {
    // Assumption: the 2-column grid is the element holding the labels (the
    // parent of each article inside .floor-print-sheet), not the sheet root.
    await page.goto("/kelola/meja/qr?mock=normal", NAV);
    await expect(page.getByText("Belum ada label")).toBeVisible();
    for (const name of ["A01", "B01", "A02"]) {
      await page.getByRole("checkbox", { name: `Pilih meja ${name}` }).check();
    }
    await page.getByRole("button", { name: "Buat QR (3)" }).click();
    await expect(
      page.getByRole("heading", { name: "Label siap cetak" }),
    ).toBeVisible();
    await expect(page.getByText("Pindai untuk memesan")).toHaveCount(3);

    await page.setViewportSize({ width: 794, height: 1123 });
    await page.emulateMedia({ media: "print" });

    const sheet = page.locator(".floor-print-sheet");
    const labels = sheet.locator("article");
    await expect(labels).toHaveCount(3);

    const columns = await labels
      .first()
      .locator("..")
      .evaluate(
        (el) =>
          getComputedStyle(el).gridTemplateColumns.split(" ").filter(Boolean)
            .length,
      );
    expect(columns).toBe(2);

    const sheetBox = await sheet.boundingBox();
    expect(sheetBox).not.toBeNull();
    for (let i = 0; i < 3; i++) {
      const box = await labels.nth(i).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(sheetBox!.x - 1);
      expect(box!.x + box!.width).toBeLessThanOrEqual(
        sheetBox!.x + sheetBox!.width + 1,
      );
    }

    // The on-screen header of the sheet does not print.
    await expect(
      page.getByRole("button", { name: "Cetak label" }),
    ).toBeHidden();
  });

  test("F9 empty and error states are honest, with a way forward", async ({
    page,
  }) => {
    await page.goto("/kelola/meja?mock=empty", NAV);
    await expect(page.getByText("Belum ada zona")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Tambah zona" }).first(),
    ).toBeVisible();

    await page.goto("/kelola/meja?mock=error", NAV);
    // Mock mode retries a 500 the way TanStack Query does; wait for the state.
    await expect(
      page.getByText("Data tidak dapat dimuat", { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Coba lagi" })).toBeVisible();
  });

  test("F9 editing the floor needs floor.table.manage, not view", async ({
    page,
    context,
  }) => {
    // A supervisor may read and operate tables but not configure them (access
    // roles). The outlet manager runs the floor plan since legend-2l6k, so it
    // can no longer stand in for "view without manage".
    await page.goto(TABLES, NAV);
    await context.addCookies([
      {
        name: "legend-mock-role",
        value: "supervisor",
        url: new URL(page.url()).origin,
      },
    ]);
    await page.reload(NAV);
    await expect(
      page.getByText("Halaman tidak ditemukan", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Denah & Meja" })).toHaveCount(
      0,
    );
  });
});
