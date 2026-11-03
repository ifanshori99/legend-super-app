// Menu back-office write gating (bead legend-5a74; PRD v1.7 §3.7 RBAC).
//
// Mock mode only: `legend-mock-role` picks a role template (lib/areas/access.ts),
// so the same screen opens as a view-only role and as a manager with no API or
// database. The API re-checks each write; this spec proves the presentation
// side: controls requiring menu.item.manage / menu.price.manage /
// menu.availability.toggle are absent for view-only roles and present for a
// manager, while the list/detail stays readable.
import { expect, test, type Page } from "@playwright/test";

const ROLE_COOKIE = "legend-mock-role";
const base = process.env.LEGEND_MOCK_WEB_URL ?? "";
test.skip(
  base === "",
  "Set LEGEND_MOCK_WEB_URL (pnpm test:e2e:mock) to a web server running VITE_API_MOCK.",
);

// Fixture ids from @starter/shared/menu fixtures (mock mode serves them).
const ESPRESSO_ID = "00000000-0000-4000-8000-000000001000";
const FIRST_ITEM = "Espresso";

async function openAs(page: Page, role: string, path: string) {
  await page
    .context()
    .addCookies([{ name: ROLE_COOKIE, value: role, url: base }]);
  await page.goto(`${base}${path}`);
}

/** A shared-component page needs hydration before a Radix control responds. */
async function clickUntil(
  page: Page,
  action: () => Promise<void>,
  assertion: () => Promise<void>,
) {
  await page.waitForFunction(() =>
    Boolean((window as unknown as { __TSR_ROUTER__?: unknown }).__TSR_ROUTER__),
  );
  await expect(async () => {
    await action();
    await assertion();
  }).toPass({ timeout: 20_000 });
}

test("legend-5a74 a view-only menu role sees the item list without create, edit, delete or 86 controls", async ({
  page,
}) => {
  // Admin Tenant holds menu.item.view only among the menu permissions.
  await openAs(page, "tenant_admin", "/kelola/menu");

  await expect(
    page.getByRole("heading", { name: "Daftar item", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(FIRST_ITEM, { exact: true }).first(),
  ).toBeVisible();

  // No write affordances at all, and no empty action column.
  await expect(page.getByText("Tambah item", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Ubah item" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Hapus item" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /^(Tandai habis|Aktifkan lagi)$/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("columnheader", { name: "Aksi", exact: true }),
  ).toHaveCount(0);

  // Display order is an item write too: filtering to one category would show
  // the reorder buttons for a manager, never for this role.
  const category = page.getByRole("combobox", { name: "Kategori" });
  await clickUntil(
    page,
    () => category.click(),
    async () =>
      expect(
        page.getByRole("option", { name: "Kopi", exact: true }),
      ).toBeVisible({ timeout: 1_000 }),
  );
  await page.getByRole("option", { name: "Kopi", exact: true }).click();
  await expect(
    page.getByText(FIRST_ITEM, { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^Naikkan / })).toHaveCount(0);
  await expect(
    page.getByText("Pakai tombol naik/turun", { exact: false }),
  ).toHaveCount(0);
});

test("legend-5a74 a view-only role sees categories without add, edit, delete or reorder controls", async ({
  page,
}) => {
  await openAs(page, "tenant_admin", "/kelola/menu/kategori");

  await expect(
    page.getByRole("heading", { name: "Kategori", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Kopi", { exact: true }).first()).toBeVisible();

  await expect(
    page.getByRole("button", { name: "Tambah kategori" }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Ubah kategori" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: /^Hapus kategori / }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Naikkan / })).toHaveCount(0);
  await expect(
    page.getByRole("columnheader", { name: "Aksi", exact: true }),
  ).toHaveCount(0);
});

test("legend-5a74 a view-only role cannot toggle 86 or edit availability schedules", async ({
  page,
}) => {
  await openAs(page, "tenant_admin", "/kelola/menu/ketersediaan");

  await expect(
    page.getByRole("heading", { name: "Ketersediaan", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(FIRST_ITEM, { exact: true }).first(),
  ).toBeVisible();

  await expect(
    page.getByRole("button", { name: /^(Tandai habis|Aktifkan lagi)$/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Atur ketersediaan" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("columnheader", { name: "Aksi", exact: true }),
  ).toHaveCount(0);
});

test("legend-5a74 a price viewer sees price lists without add, manage, date or delete controls", async ({
  page,
}) => {
  // Outlet Manager holds menu.price.view without menu.price.manage.
  await openAs(page, "outlet_manager", "/kelola/menu/harga");

  await expect(
    page.getByRole("heading", { name: "Harga per kanal", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Dine-in", { exact: true }).first(),
  ).toBeVisible();

  await expect(
    page.getByRole("button", { name: "Tambah daftar harga" }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Atur harga" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Ubah tanggal" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: /^Hapus daftar harga / }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("columnheader", { name: "Aksi", exact: true }),
  ).toHaveCount(0);
});

test("legend-5a74 a view-only role sees combos and stations read-only", async ({
  page,
}) => {
  // Outlet Manager can open the combos section (menu.price.view) and holds no
  // menu.item.manage, which both the combo and station APIs require.
  await openAs(page, "outlet_manager", "/kelola/menu/paket");
  await expect(
    page.getByRole("heading", { name: "Paket & combo", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Paket Kopi dan Croissant", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Tambah paket" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("button", { name: "Ubah paket" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Hapus paket / })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("columnheader", { name: "Aksi", exact: true }),
  ).toHaveCount(0);

  await openAs(page, "outlet_manager", "/kelola/menu/stasiun");
  await expect(
    page.getByRole("heading", { name: "Stasiun", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Dapur", { exact: true }).first()).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Tambah stasiun" }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Ubah stasiun" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: /^Hapus stasiun / }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("columnheader", { name: "Aksi", exact: true }),
  ).toHaveCount(0);
});

test("legend-5a74 an item viewer opens the detail without save, photo, active, variant or modifier writes", async ({
  page,
}) => {
  await openAs(page, "tenant_admin", `/kelola/menu/${ESPRESSO_ID}`);

  await expect(
    page.getByRole("heading", { name: FIRST_ITEM, exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Nama item", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Simpan item" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("button", { name: "Pilih foto" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Ganti foto" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Nama item" })).toHaveCount(0);
  await expect(page.getByRole("switch")).toHaveCount(0);

  // Variants stay readable; the write button does not.
  await clickUntil(
    page,
    () => page.getByRole("tab", { name: "Varian" }).click(),
    async () => expect(page.getByText("Panas", { exact: true })).toBeVisible(),
  );
  await expect(page.getByRole("button", { name: "Tambah varian" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("button", { name: "Ubah varian" })).toHaveCount(
    0,
  );

  // Modifier groups stay readable; group/modifier writes do not.
  await page.getByRole("tab", { name: "Modifier" }).click();
  await expect(
    page.getByText("Tingkat gula", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Tambah grup" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("button", { name: "Ubah grup" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Hapus grup / })).toHaveCount(
    0,
  );

  // Expanding a group shows its modifiers without their write buttons.
  await clickUntil(
    page,
    () => page.getByRole("button", { name: "Lihat modifier" }).first().click(),
    async () =>
      expect(page.getByText("Normal", { exact: true }).first()).toBeVisible(),
  );
  await expect(
    page.getByRole("button", { name: "Tambah modifier" }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Ubah modifier" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: /^Hapus modifier / }),
  ).toHaveCount(0);
});

test("legend-5a74 kitchen and cashier templates never reach the menu area (no write controls either)", async ({
  page,
}) => {
  // Both templates lack dashboard.management.view, so /kelola shows the area
  // gate instead of the menu screens — the strongest form of "no controls".
  for (const role of ["cashier", "kitchen_lead"]) {
    await openAs(page, role, "/kelola/menu");
    await expect(
      page.getByText("Anda belum punya akses ke area ini", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Daftar item", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByText("Tambah item", { exact: true })).toHaveCount(0);
  }
});

test("legend-5a74 a manager still gets every write control", async ({
  page,
}) => {
  await openAs(page, "general_manager", "/kelola/menu");
  await expect(
    page.getByRole("heading", { name: "Daftar item", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Tambah item", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Ubah item" }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Hapus item" }).first(),
  ).toBeVisible();
  await expect(
    page
      .getByRole("button", { name: /^(Tandai habis|Aktifkan lagi)$/ })
      .first(),
  ).toBeVisible();
  await expect(
    page.getByRole("columnheader", { name: "Aksi", exact: true }),
  ).toBeVisible();

  await openAs(page, "general_manager", "/kelola/menu/kategori");
  await expect(
    page.getByRole("button", { name: "Tambah kategori" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Ubah kategori" }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^Naikkan / }).first(),
  ).toBeVisible();

  await openAs(page, "general_manager", "/kelola/menu/ketersediaan");
  await expect(
    page
      .getByRole("button", { name: /^(Tandai habis|Aktifkan lagi)$/ })
      .first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Atur ketersediaan" }).first(),
  ).toBeVisible();

  await openAs(page, "general_manager", "/kelola/menu/harga");
  await expect(
    page.getByRole("button", { name: "Tambah daftar harga" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Atur harga" }).first(),
  ).toBeVisible();

  await openAs(page, "general_manager", "/kelola/menu/paket");
  await expect(
    page.getByRole("button", { name: "Tambah paket" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Ubah paket" }).first(),
  ).toBeVisible();

  await openAs(page, "general_manager", "/kelola/menu/stasiun");
  await expect(
    page.getByRole("button", { name: "Tambah stasiun" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Ubah stasiun" }).first(),
  ).toBeVisible();
});
