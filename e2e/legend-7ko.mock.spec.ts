// WS-03 floor board: live table status board and table operations (bead
// legend-7ko; ORD-10). Runs against the mock-mode web server (no API, no
// database): `pnpm test:e2e:mock` from the mock-runner bead, or
// `playwright -c playwright.mock.config.ts`.
import { expect, test, type Page } from "@playwright/test";

const baseURL =
  process.env.LEGEND_MOCK_WEB_URL ?? process.env.E2E_MOCK_BASE_URL;

test.skip(
  !baseURL,
  "Mock runner not started: use pnpm test:e2e:mock (playwright.mock.config.ts).",
);
test.use({ baseURL });

async function openBoard(page: Page, search = "") {
  await page.goto(`/pos/meja${search}`);
  await expect(
    page.getByRole("heading", { name: "Papan Status Meja" }),
  ).toBeVisible();
}

const tableButton = (page: Page, code: string) =>
  page.getByRole("button", { name: new RegExp(`^Meja ${code},`) });

async function openActions(page: Page, code: string) {
  await tableButton(page, code).click();
  const panel = page.getByRole("dialog").last();
  await expect(panel).toBeVisible();
  return panel;
}

test("ORD-10 board shows every floor status with seat duration and bill", async ({
  page,
}) => {
  await openBoard(page);
  // The legend carries the PRD states (Papan Status).
  for (const label of [
    "Kosong",
    "Terisi",
    "Menunggu pesanan",
    "Menunggu tagihan",
    "Perlu dibersihkan",
    "Direservasi",
  ])
    await expect(
      page.getByRole("listitem").filter({ hasText: label }).first(),
    ).toBeVisible();

  // A running session shows how long the guests have been seated.
  await expect(tableButton(page, "A03")).toContainText("Duduk");
  await expect(tableButton(page, "P1")).toContainText("Sisa tagihan");
  await expect(tableButton(page, "W03")).toContainText("Nonaktif");
});

test("ORD-10 a table with an outstanding bill cannot be emptied", async ({
  page,
}) => {
  await openBoard(page);
  await openActions(page, "P1");
  await page.getByRole("button", { name: "Tutup meja" }).click();
  const dialog = page.getByRole("dialog").last();
  await expect(dialog).toContainText("ORD-10");
  await dialog.getByRole("button", { name: "Tutup sesi" }).click();

  // The server refuses (waiter has not confirmed), the bill is untouched and
  // the reason says how to proceed (ORD-10).
  await expect(dialog).toContainText("tagihan belum lunas");
  await expect(dialog).toContainText(/Rp\s?114\.350/);
  await dialog.getByRole("button", { name: "Tutup", exact: true }).click();
  const panel = page.getByRole("dialog").last();
  await expect(panel.getByText(/Rp\s?114\.350/)).toBeVisible();
  await panel
    .getByRole("button", { name: "Tutup", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "Papan Status Meja" }),
  ).toBeVisible();
  await expect(tableButton(page, "P1")).toContainText("Menunggu tagihan");
});

test("ORD-10 closing a settled, cleaned table frees it on the board", async ({
  page,
}) => {
  await openBoard(page);
  await openActions(page, "A03");
  await page.getByRole("button", { name: "Tutup meja" }).click();
  const dialog = page.getByRole("dialog").last();
  await page.getByText("Meja sudah dibersihkan").click();
  await dialog.getByRole("button", { name: "Tutup sesi" }).click();
  await expect(
    page.getByText("Meja ditutup dan sudah bersih.").first(),
  ).toBeVisible();
  await expect(tableButton(page, "A03")).toContainText("Kosong");
});

test("ORD-10 an open-bill session is confirmed before the table counts as seated", async ({
  page,
}) => {
  await openBoard(page);
  await openActions(page, "W01");
  await page.getByRole("button", { name: "Konfirmasi sesi" }).click();
  const dialog = page.getByRole("dialog").last();
  await dialog.getByRole("button", { name: "Konfirmasi sesi" }).click();
  await expect(page.getByText("Sesi meja dikonfirmasi.").first()).toBeVisible();
  await expect(tableButton(page, "W01")).toContainText("Menunggu pesanan");
});

test("ORD-10 staff move a running session to an empty table", async ({
  page,
}) => {
  await openBoard(page);
  await openActions(page, "A03");
  await page.getByRole("button", { name: "Pindah meja" }).click();
  const dialog = page.getByRole("dialog").last();
  await dialog.locator("#move-session-target").click();
  await page.getByRole("option", { name: /A01/ }).click();
  await dialog.getByRole("button", { name: "Pindahkan" }).click();

  await expect(
    page.getByText("Sesi dipindahkan ke meja A01.").first(),
  ).toBeVisible();
  await expect(tableButton(page, "A01")).toContainText("Menunggu pesanan");
  await expect(tableButton(page, "A03")).toContainText("Perlu dibersihkan");
});

test("ORD-10 merging two unpaid open-bill tables puts them on one bill", async ({
  page,
}) => {
  await openBoard(page);
  // W01 waits for confirmation; a merge needs two running sessions.
  await openActions(page, "W01");
  await page.getByRole("button", { name: "Konfirmasi sesi" }).click();
  const confirm = page.getByRole("dialog").last();
  await confirm.getByRole("button", { name: "Konfirmasi sesi" }).click();
  await expect(page.getByText("Sesi meja dikonfirmasi.").first()).toBeVisible();

  await openActions(page, "W02");
  await page.getByRole("button", { name: "Gabung meja" }).click();
  const dialog = page.getByRole("dialog").last();
  await dialog.locator("#merge-source").click();
  await page.getByRole("option", { name: /W01/ }).click();
  await dialog.getByRole("button", { name: "Gabungkan" }).click();

  await expect(page.getByText("Meja digabung").first()).toBeVisible();
  await expect(tableButton(page, "W01")).toContainText("Digabung");
  await expect(tableButton(page, "W02")).toContainText("Digabung");
});

test("ORD-06 a partly paid table is never merged or re-split (paid share lock)", async ({
  page,
}) => {
  await openBoard(page);
  // P1 already has a paid share in the fixtures.
  await openActions(page, "P1");
  await page.getByRole("button", { name: "Gabung meja" }).click();
  const merge = page.getByRole("dialog").last();
  await merge.locator("#merge-source").click();
  await page.getByRole("option", { name: /W02/ }).click();
  await merge.getByRole("button", { name: "Gabungkan" }).click();
  await expect(page.getByRole("alert").first()).toContainText(
    "sudah dibayar sebagian",
  );
});

test("ORD-06 a partly paid table cannot be re-split from the panel", async ({
  page,
}) => {
  await openBoard(page);
  await openActions(page, "P1");
  await page.getByRole("button", { name: "Pisah tagihan" }).click();
  const split = page.getByRole("dialog").last();
  await split.locator("#split-parts").fill("3");
  await split.getByRole("button", { name: "Bagi tagihan" }).click();
  await expect(page.getByRole("alert").first()).toContainText(
    "sudah dibayar sebagian",
  );
});

test("ORD-10 the board has an empty state for an outlet without a floor plan", async ({
  page,
}) => {
  await openBoard(page, "?mock=empty");
  await expect(page.getByText("Denah meja belum diatur")).toBeVisible();
});

test("ORD-10 the board explains a load failure and offers a retry", async ({
  page,
}) => {
  await openBoard(page, "?mock=error");
  await expect(page.getByRole("alert").first()).toBeVisible();
  await expect(page.getByText("Denah meja tidak dapat dimuat")).toBeVisible();
  await expect(page.getByRole("button", { name: "Coba lagi" })).toBeVisible();
});
