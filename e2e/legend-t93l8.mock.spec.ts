// Dearer-swap charge at the till: method picker (bead legend-t93l8), mock mode.
//
// Run: pnpm test:e2e:mock e2e/legend-t93l8.mock.spec.ts
// Screenshots: LEGEND_T93L8_SHOTS=docs/review/img pnpm test:e2e:mock <this file>
import { expect, test, type Page } from "@playwright/test";
import { waitForHydration } from "./hydration";

const MOCK_URL = process.env.LEGEND_MOCK_WEB_URL;
const SHOTS = process.env.LEGEND_T93L8_SHOTS;

test.skip(
  !MOCK_URL,
  "Mock runner not started: use pnpm test:e2e:mock (playwright.mock.config.ts).",
);

const CHARGE = "0f8a6c1e-7b3d-4c52-9e01-2a4b6c8d0e1f";
const STORE = /^legend-pos-charge-collect:/;

async function open(page: Page, demo?: string) {
  await page.goto(
    `${MOCK_URL}/pos/tagih-selisih/${CHARGE}${demo ? `?demo=${demo}` : ""}`,
  );
  await waitForHydration(page);
  await expect(
    page.getByRole("heading", { name: "Penagihan selisih" }),
  ).toBeVisible();
}

const button = (page: Page, name: RegExp) => page.getByRole("button", { name });
const methods = (page: Page) =>
  page.getByRole("group", { name: "Metode pembayaran" });
const pick = (page: Page, label: string) =>
  methods(page).getByText(label, { exact: true }).click();

async function expectLocked(page: Page) {
  await expect(methods(page)).toHaveCount(0);
  await expect(
    button(page, /Tagih selisih · Tunai|Buat QRIS|Catat EDC/),
  ).toHaveCount(0);
  await expect(button(page, /Periksa status/)).toBeVisible();
}

const storedKey = (page: Page) =>
  page.evaluate((prefix) => {
    const name = Object.keys(localStorage).find((k) =>
      new RegExp(prefix).test(k),
    );
    return name ? (JSON.parse(localStorage[name]!).key as string) : null;
  }, STORE.source);

test("t93l8 a QRIS answer is a code, not money: locked until paid", async ({
  page,
}) => {
  await open(page);
  await pick(page, "QRIS");
  await button(page, /Buat QRIS/).click();
  await expect(page.locator("svg title")).toHaveText(
    "Kode QRIS tagihan selisih",
  );
  await expect(page.getByText(/Berlaku \d+:\d{2} lagi/)).toBeVisible();
  await expect(page.getByText("Penagihan tercatat")).toHaveCount(0);
  await expectLocked(page);
  // Checking the status of a live code never frees the methods.
  await button(page, /Periksa status/).click();
  await expectLocked(page);
});

test("t93l8 the paid QRIS settles by polling", async ({ page }) => {
  await open(page, "selisih-qris-lunas");
  await pick(page, "QRIS");
  await button(page, /Buat QRIS/).click();
  await expect(page.getByText("Penagihan tercatat")).toBeVisible({
    timeout: 20_000,
  });
});

test("t93l8 an expired or failed code can be renewed", async ({ page }) => {
  for (const [demo, text] of [
    ["selisih-qris-kedaluwarsa", "Kode QRIS kedaluwarsa"],
    ["selisih-qris-gagal", "Pembayaran QRIS gagal"],
  ] as const) {
    await open(page, demo);
    await expect(page.getByText(text)).toBeVisible();
    await pick(page, "QRIS");
    await button(page, /Buat QRIS baru/).click();
    await expect(page.locator("svg title")).toHaveText(
      "Kode QRIS tagihan selisih",
    );
  }
});

test("t93l8 time up on this device hides the code but keeps the lock", async ({
  page,
}) => {
  await open(page, "selisih-qris-habis");
  await expect(page.getByText("Waktu kode habis")).toBeVisible();
  await expect(page.locator("svg title")).toHaveCount(0);
  await expectLocked(page);
});

test("t93l8 a lost QRIS answer shows the code the server holds", async ({
  page,
}) => {
  await open(page, "selisih-qris-putus");
  await pick(page, "QRIS");
  await button(page, /Buat QRIS/).click();
  await expect(
    page.getByText("Status penagihan belum dapat dipastikan"),
  ).toBeVisible();
  await expectLocked(page);
  await button(page, /Periksa status/).click();
  await expect(page.locator("svg title")).toHaveText(
    "Kode QRIS tagihan selisih",
  );
  await expectLocked(page);
});

test("t93l8 refresh after a lost cash answer: check first, same key", async ({
  page,
}) => {
  await open(page, "selisih-belum-pasti");
  await button(page, /Tagih selisih · Tunai/).click();
  await expect(
    page.getByText("Status penagihan belum dapat dipastikan"),
  ).toBeVisible();
  const key = await storedKey(page);
  expect(key).not.toBeNull();
  // The reload resets the mock store, so the server reads "open" here.
  await open(page, "selisih-belum-pasti");
  await expectLocked(page);
  await button(page, /Periksa status/).click();
  await expect(page.getByText("Penagihan belum tercatat")).toBeVisible();
  await button(page, /Tagih selisih · Tunai/).click();
  await expect(
    page.getByText("Status penagihan belum dapat dipastikan"),
  ).toBeVisible();
  expect(await storedKey(page)).toBe(key);
  await button(page, /Periksa status/).click();
  await expect(page.getByText("Penagihan tercatat")).toBeVisible();
});

test("1267 after a lost cash answer another method is refused, no code made", async ({
  page,
}) => {
  await open(page, "selisih-belum-pasti");
  await button(page, /Tagih selisih · Tunai/).click();
  await expect(
    page.getByText("Status penagihan belum dapat dipastikan"),
  ).toBeVisible();
  const key = await storedKey(page);
  await open(page, "selisih-belum-pasti");
  await button(page, /Periksa status/).click();
  await expect(page.getByText("Penagihan belum tercatat")).toBeVisible();
  // The cash answer was never seen: a code could pay the charge twice.
  await pick(page, "QRIS");
  await button(page, /Buat QRIS/).click();
  await expect(
    page.getByText("Status penagihan belum dapat dipastikan"),
  ).toBeVisible();
  await expect(page.locator("svg title")).toHaveCount(0);
  expect(await storedKey(page)).toBe(key);
});

test("t93l8 an unresolved attempt in another tab locks this one", async ({
  page,
  context,
}) => {
  await open(page);
  const other = await context.newPage();
  await open(other, "selisih-belum-pasti");
  await button(other, /Tagih selisih · Tunai/).click();
  await expect(
    other.getByText("Status penagihan belum dapat dipastikan"),
  ).toBeVisible();
  await expectLocked(page);
});

test("t93l8 a double tap settles once", async ({ page }) => {
  await open(page);
  await button(page, /Tagih selisih · Tunai/).evaluate((el) => {
    (el as HTMLButtonElement).click();
    (el as HTMLButtonElement).click();
  });
  await expect(page.getByText("Penagihan tercatat")).toBeVisible();
  expect(await storedKey(page)).toBeNull();
});

test("t93l8 EDC: no amount field, only the server's approved sale", async ({
  page,
}) => {
  await open(page);
  await pick(page, "EDC kartu");
  await expect(
    page.getByText("Belum ada transaksi EDC yang disetujui"),
  ).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await expect(button(page, /Catat EDC/)).toHaveCount(0);

  await open(page, "selisih-edc-disetujui");
  // The bank holds the money: cash and QRIS are gone.
  await expect(methods(page)).toHaveCount(0);
  await expect(button(page, /Catat EDC/)).toBeDisabled();
  await page.getByText("EDC BCA 01").click();
  await button(page, /Catat EDC/).click();
  await expect(page.getByText("Penagihan tercatat")).toBeVisible();
});

test("t93l8 EDC pending, unknown or under review stays locked", async ({
  page,
}) => {
  for (const demo of [
    "selisih-edc-menunggu",
    "selisih-edc-belum-pasti",
    "selisih-edc-tinjau",
  ]) {
    await open(page, demo);
    await expectLocked(page);
    await button(page, /Periksa status/).click();
    await expectLocked(page);
  }
});

test("t93l8 a refused EDC sale frees the other methods", async ({ page }) => {
  await open(page, "selisih-edc-ditolak");
  await pick(page, "EDC kartu");
  await expect(page.getByText("Saldo tidak cukup")).toBeVisible();
  await expect(button(page, /Catat EDC/)).toHaveCount(0);
  await pick(page, "Tunai");
  await expect(button(page, /Tagih selisih · Tunai/)).toBeEnabled();
});

const STATES: [string, string | undefined, string | undefined][] = [
  ["pilih", undefined, undefined],
  ["qris-aktif", undefined, "QRIS"],
  ["qris-kedaluwarsa", "selisih-qris-kedaluwarsa", undefined],
  ["edc-disetujui", "selisih-edc-disetujui", undefined],
  ["edc-belum-pasti", "selisih-edc-belum-pasti", undefined],
  ["perlu-supervisor", "selisih-edc-tinjau", undefined],
  ["lunas", "selisih-lunas", undefined],
];
for (const width of [390, 1280])
  for (const [name, demo, method] of STATES)
    test(`t93l8 ${name} fits ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
      await open(page, demo);
      if (method) {
        await pick(page, method);
        await button(page, /Buat QRIS/).click();
        await expect(page.getByText(/Berlaku/)).toBeVisible();
      }
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      if (width === 390)
        await page
          .getByRole("heading", { name: "Penagihan selisih" })
          .evaluate((el) => el.closest("section")!.scrollIntoView());
      if (SHOTS)
        await page.screenshot({
          path: `${SHOTS}/1267-tukar-${name}-${width}.png`,
        });
    });
