// legend-iqi: POS kasir, new shift flow (Rp0 opening dialog, blind count with
// small denominations, recount, supervisor close with the latest count, cash
// without an open shift) against the FE mock runtime (VITE_API_MOCK=true).
//
// Run: LEGEND_MOCK_PORT=3237 heavy pnpm test:e2e:mock e2e/legend-iqi-pos-shift.mock.spec.ts
//
// Source of expected behavior: sub-brief legend-iqi (contract summary and
// mock scenarios `shift-not-open`, `count-stale`, `count-superseded`) and the
// mockups in design/mockups/pos. Never backend code.
//
// Assumptions (the brief leaves exact copy open):
//  I1 The Rp0 dialog has the buttons "Ya, buka dengan Rp0" and "Periksa lagi";
//     initial focus is on "Periksa lagi" (the safe button). It shows only for
//     Rp0, never for a positive opening float.
//  I2 Small denominations (2.000, 1.000, 500, 200, 100) are textboxes named
//     "Rp 2.000" ... "Rp 100", like the note fields ("Rp 100.000").
//  I3 The waiting screen reads "Langkah 2 dari 2", names the count number as
//     "Hitungan ke-N" (also accepted: "Hitungan N", "Hitungan #N") and has a
//     button "Hitung ulang" that returns to step 1.
//  I4 No open shift on the payment screen: choosing Tunai shows
//     "Belum ada shift kasir terbuka" and a control named "Buka shift" (link or
//     button) that leads to /pos/shift. Raw error codes are never shown.
//  I5 Supervisor errors use plain words: a stale count says the cashier must
//     count again ("hitung ulang"); a superseded count says to load the latest
//     count ("hitungan terbaru"). The shift stays open and the approve action
//     stays available.
//  I6 The shift seeded by `?demo=shift-aktif` is the demo shift
//     0c0c0001-... and the supervisor page for it shows the latest submitted
//     count, so a count sent from /pos/shift/tutup appears there.
//  I7 Engine state survives page.goto (sessionStorage) within one test, so a
//     test may open a shift, then navigate to the bill.
import {
  expect as baseExpect,
  test,
  type Locator,
  type Page,
} from "@playwright/test";

const expect = baseExpect.configure({ timeout: 15_000 });

const DEMO_ORDER_ID = "0b0b0048-0000-4000-8000-000000000048";
const DEMO_SHIFT_ID = "0c0c0001-0000-4000-8000-000000000001";

test.describe.configure({ timeout: 90_000 });
test.use({ viewport: { width: 1280, height: 800 } });

// ---------------------------------------------------------------- helpers

const rp = (amount: string) => `Rp\\s*${amount.replace(/\./g, "\\.")}`;
const BACKSPACE = /^Hapus angka terakhir$/;

async function waitForHydration(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      Boolean(
        (window as unknown as { __TSR_ROUTER__?: unknown }).__TSR_ROUTER__,
      ),
    undefined,
    { timeout: 60_000 },
  );
}

async function open(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await waitForHydration(page);
}

const main = (page: Page) => page.locator("#main-content");
const heading = (page: Page, name: string | RegExp) =>
  page.getByRole("heading", { name }).first();
const SUPERVISOR_URL = `/pos/supervisor/shift/${DEMO_SHIFT_ID}`;

function methodOption(page: Page, name: string): Locator {
  const re = new RegExp(`^${name}`);
  return page
    .getByRole("button", { name: re })
    .or(page.getByRole("radio", { name: re }));
}

async function enterAmount(
  page: Page,
  input: Locator,
  amount: number,
): Promise<void> {
  await expect(input).toBeVisible();
  const zero = page.getByRole("button", { name: "0", exact: true });
  if ((await zero.count()) === 0) {
    await input.fill(String(amount));
    return;
  }
  const back = page.getByRole("button", { name: BACKSPACE });
  for (let i = 0; i < 14; i += 1) {
    const digits = (await input.inputValue()).replace(/\D/g, "");
    if (/^0*$/.test(digits)) break;
    await back.click();
  }
  for (const digit of String(amount)) {
    await page.getByRole("button", { name: digit, exact: true }).click();
  }
}

async function enterPin(page: Page, pin: string): Promise<void> {
  const field = page.getByLabel(/PIN supervisor/i).and(page.locator("input"));
  const pad = page.getByRole("button", { name: "1", exact: true });
  await expect(field.or(pad)).toBeVisible();
  if ((await field.count()) > 0) {
    await field.fill(pin);
    return;
  }
  for (const digit of pin) {
    await page.getByRole("button", { name: digit, exact: true }).click();
  }
}

/** Field label: "Rp100.000 · lembar" or "Rp100 · keping" (suffix optional). */
const denominationField = (denomination: string) =>
  new RegExp(
    `^Rp\\s?${denomination.replace(/\./g, "\\.")}(?:\\s*·\\s*(?:lembar|keping))?$`,
  );

const ALL_DENOMINATIONS = [
  "100.000",
  "50.000",
  "20.000",
  "10.000",
  "5.000",
  "2.000",
  "1.000",
  "500",
  "200",
  "100",
] as const;
type Denomination = (typeof ALL_DENOMINATIONS)[number];

/** Fills every denomination field (unlisted ones get 0): robust to prefill. */
async function fillCounts(
  page: Page,
  counts: Partial<Record<Denomination, number>>,
): Promise<void> {
  for (const denomination of ALL_DENOMINATIONS) {
    await page
      .getByRole("textbox", {
        name: denominationField(denomination),
      })
      .fill(String(counts[denomination] ?? 0));
  }
}

// 18x100.000 + 6x50.000 + 5x20.000 + 2x10.000 + 2x5.000 = 2.230.000
const NOTES: Partial<Record<Denomination, number>> = {
  "100.000": 18,
  "50.000": 6,
  "20.000": 5,
  "10.000": 2,
  "5.000": 2,
};
// 2x2.000 + 3x1.000 + 4x500 + 5x200 + 10x100 = 11.000
const SMALL: Partial<Record<Denomination, number>> = {
  "2.000": 2,
  "1.000": 3,
  "500": 4,
  "200": 5,
  "100": 10,
};
const NOTES_AND_SMALL = { ...NOTES, ...SMALL };

async function startCount(page: Page): Promise<void> {
  await open(page, "/pos/shift/tutup?demo=shift-aktif");
  await expect(heading(page, /Tutup shift.*Hitung kas/)).toBeVisible();
  await expect(main(page)).toContainText("Langkah 1 dari 2");
}

async function sendCount(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Kirim hitungan kas" }).click();
  await expect(main(page)).toContainText("Langkah 2 dari 2");
  await expect(main(page)).toContainText(/Menunggu (persetujuan )?supervisor/i);
}

/** Matches "Hitungan ke-2", "Hitungan 2" and "Hitungan #2" (I3). */
const countNumber = (n: number) =>
  new RegExp(`Hitungan\\s*(ke-?\\s?|#|nomor\\s)?${n}(?!\\d)`, "i");

async function fillApproval(page: Page, reason: string): Promise<void> {
  const note = page
    .getByRole("textbox", { name: /Penjelasan selisih|Alasan/i })
    .first();
  await expect(note).toBeVisible();
  await note.fill(reason);
  await enterPin(page, "123456");
}

const approveButton = (page: Page) =>
  page.getByRole("button", { name: /Setujui & tutup shift/ });

// ------------------------------------------------------- open shift with Rp0

test("legend-iqi SHIFT-04 opening with Rp0 asks once in a dialog, and backing out keeps the form", async ({
  page,
}) => {
  await open(page, "/pos/shift");
  await expect(heading(page, "Buka shift kasir")).toBeVisible();
  const area = main(page);
  const submit = page.getByRole("button", { name: /^Buka shift/ });
  const dialog = page.getByRole("dialog");

  await submit.click();
  await expect(dialog).toBeVisible();
  // Explains the empty drawer and offers exactly the two choices.
  await expect(dialog).toContainText(/laci/i);
  await expect(dialog).toContainText(/Rp\s?0/);
  const confirm = dialog.getByRole("button", {
    name: /^Ya, buka dengan Rp\s?0/,
  });
  const recheck = dialog.getByRole("button", { name: "Periksa lagi" });
  await expect(confirm).toBeVisible();
  await expect(recheck).toBeVisible();
  // The safe button holds the initial focus (I1).
  await expect(recheck).toBeFocused();

  // "Periksa lagi": nothing opened, form still there.
  await recheck.click();
  await expect(dialog).toHaveCount(0);
  await expect(heading(page, "Buka shift kasir")).toBeVisible();
  await expect(area).toContainText("Belum ada shift aktif");

  // A new attempt asks again (once per attempt).
  await submit.click();
  await expect(dialog).toBeVisible();
  await recheck.click();
  await expect(dialog).toHaveCount(0);
});

test("legend-iqi SHIFT-05 confirming the Rp0 dialog opens the shift with a Rp0 float", async ({
  page,
}) => {
  await open(page, "/pos/shift");
  await page.getByRole("button", { name: /^Buka shift/ }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^Ya, buka dengan Rp\s?0/ })
    .click();

  await expect(heading(page, "Shift kasir")).toBeVisible();
  const area = main(page);
  await expect(area).toContainText("Shift aktif");
  await expect(area).toContainText(new RegExp(`Modal awal\\s*${rp("0")}`));
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Mulai tutup shift" }),
  ).toBeVisible();
});

test("legend-iqi SHIFT-05 a positive opening float opens without any dialog", async ({
  page,
}) => {
  await open(page, "/pos/shift");
  await enterAmount(page, page.getByLabel("Uang yang sudah dihitung"), 500_000);
  await page.getByRole("button", { name: /^Buka shift/ }).click();
  await expect(main(page)).toContainText("Shift aktif");
  await expect(main(page)).toContainText(
    new RegExp(`Modal awal\\s*${rp("500.000")}`),
  );
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

// ------------------------------------------------ cash without an open shift

test("legend-iqi PAY-03 choosing cash without an open shift points to Buka shift", async ({
  page,
}) => {
  await open(page, `/pos/bayar/${DEMO_ORDER_ID}`);
  await expect(heading(page, "Pilih metode pembayaran")).toBeVisible();
  // Cash stays visible even without a shift.
  await expect(methodOption(page, "Tunai")).toBeVisible();
  await methodOption(page, "Tunai").click();
  const proceed = page.getByRole("button", { name: /Lanjutkan dengan Tunai/ });
  const area = main(page);
  const noShift = area.getByText("Belum ada shift kasir terbuka");
  // The panel may appear on selection or after "Lanjutkan dengan Tunai".
  await expect(noShift.or(proceed).first()).toBeVisible();
  if (!(await noShift.isVisible())) await proceed.click();
  await expect(noShift).toBeVisible();
  // No way to take cash, the bill stays unpaid.
  await expect(
    page.getByRole("button", { name: /Konfirmasi terima tunai/ }),
  ).toHaveCount(0);
  await expect(area).toContainText("Belum lunas");

  const openShift = page
    .getByRole("link", { name: "Buka shift" })
    .or(page.getByRole("button", { name: "Buka shift" }))
    .first();
  await openShift.click();
  await expect(page).toHaveURL(/\/pos\/shift/);
  await expect(heading(page, "Buka shift kasir")).toBeVisible();
});

test("legend-iqi PAY-03 Buka shift from the bill leads back to the same bill after opening", async ({
  page,
}) => {
  await open(page, `/pos/bayar/${DEMO_ORDER_ID}`);
  await methodOption(page, "Tunai").click();
  await expect(
    main(page).getByText("Belum ada shift kasir terbuka"),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Buka shift" })
    .or(page.getByRole("button", { name: "Buka shift" }))
    .first()
    .click();
  await expect(heading(page, "Buka shift kasir")).toBeVisible();

  await enterAmount(page, page.getByLabel("Uang yang sudah dihitung"), 500_000);
  await page.getByRole("button", { name: /^Buka shift/ }).click();

  // Back on the same bill, now able to take cash.
  await expect(page).toHaveURL(new RegExp(`/pos/bayar/${DEMO_ORDER_ID}`));
  await expect(heading(page, "Pilih metode pembayaran")).toBeVisible();
  await expect(main(page)).toContainText(
    new RegExp(`Sisa yang harus dibayar\\s*${rp("148.000")}`),
  );
  await expect(
    main(page).getByText("Belum ada shift kasir terbuka"),
  ).toHaveCount(0);
});

test("legend-iqi PAY-03 after opening a shift the same bill takes cash", async ({
  page,
}) => {
  // Open the shift first (the way the panel's button leads), then pay.
  await open(page, "/pos/shift");
  await enterAmount(page, page.getByLabel("Uang yang sudah dihitung"), 500_000);
  await page.getByRole("button", { name: /^Buka shift/ }).click();
  await expect(main(page)).toContainText("Shift aktif");

  await open(page, `/pos/bayar/${DEMO_ORDER_ID}`);
  await methodOption(page, "Tunai").click();
  await page.getByRole("button", { name: /Lanjutkan dengan Tunai/ }).click();
  await expect(heading(page, "Terima pembayaran tunai")).toBeVisible();
  await expect(main(page)).not.toContainText("Belum ada shift kasir terbuka");
  await enterAmount(page, page.getByLabel("Uang diterima"), 150_000);
  await page.getByRole("button", { name: /Konfirmasi terima tunai/ }).click();
  await expect(heading(page, "Pembayaran selesai")).toBeVisible();
});

test("legend-iqi PAY-04 a cash payment refused with SHIFT_NOT_OPEN shows plain words and Buka shift", async ({
  page,
}) => {
  // The screen believes a shift exists, the server side says it does not.
  await open(page, "/pos/shift?demo=shift-aktif");
  await expect(main(page)).toContainText("Shift aktif");
  await open(page, `/pos/bayar/${DEMO_ORDER_ID}?mock=shift-not-open`);
  await methodOption(page, "Tunai").click();
  await page.getByRole("button", { name: /Lanjutkan dengan Tunai/ }).click();
  await expect(heading(page, "Terima pembayaran tunai")).toBeVisible();
  await enterAmount(page, page.getByLabel("Uang diterima"), 150_000);
  await page.getByRole("button", { name: /Konfirmasi terima tunai/ }).click();

  const area = main(page);
  await expect(area.getByText("Belum ada shift kasir terbuka")).toBeVisible();
  await expect(area).not.toContainText(/SHIFT_NOT_OPEN|409/);
  await expect(
    page
      .getByRole("link", { name: "Buka shift" })
      .or(page.getByRole("button", { name: "Buka shift" }))
      .first(),
  ).toBeVisible();
  // Nothing was paid.
  await expect(heading(page, "Pembayaran selesai")).toHaveCount(0);
  await expect(area).toContainText("Belum lunas");
});

test("legend-iqi PAY-04 the same refusal in a split payment shows the same message", async ({
  page,
}) => {
  await open(page, "/pos/shift?demo=shift-aktif");
  await expect(main(page)).toContainText("Shift aktif");
  await open(
    page,
    `/pos/bayar/${DEMO_ORDER_ID}?demo=split&mock=shift-not-open`,
  );
  const area = main(page);
  await expect(area).toContainText(
    new RegExp(`Sisa yang harus dibayar\\s*${rp("48.000")}`),
  );
  await methodOption(page, "Tunai").click();
  await page.getByRole("button", { name: /Lanjutkan dengan Tunai/ }).click();

  // Split panel first or cash panel directly (same as legend-mjmm A3).
  const acceptCash = page.getByRole("button", {
    name: new RegExp(`Terima tunai\\s*${rp("48.000")}`),
  });
  const received = page.getByLabel("Uang diterima");
  await expect(acceptCash.or(received)).toBeVisible();
  if (await acceptCash.isVisible()) await acceptCash.click();
  await enterAmount(page, received, 50_000);
  await page.getByRole("button", { name: /Konfirmasi terima tunai/ }).click();

  await expect(area.getByText("Belum ada shift kasir terbuka")).toBeVisible();
  await expect(area).not.toContainText(/SHIFT_NOT_OPEN|409/);
  await expect(
    page
      .getByRole("link", { name: "Buka shift" })
      .or(page.getByRole("button", { name: "Buka shift" }))
      .first(),
  ).toBeVisible();
  await expect(area).toContainText("Belum lunas");
});

// -------------------------------------------------- close step 1: blind count

test("legend-iqi SHIFT-06 small denominations are counted per piece and reach the supervisor", async ({
  page,
}) => {
  await startCount(page);
  const area = main(page);
  // Note and small denominations are all there; no total-only shortcut.
  for (const denomination of ALL_DENOMINATIONS) {
    await expect(
      page.getByRole("textbox", {
        name: denominationField(denomination),
      }),
    ).toBeVisible();
  }
  await expect(
    page.getByRole("button", { name: /Masukkan total saja/i }),
  ).toHaveCount(0);

  await fillCounts(page, NOTES);
  await expect(area).toContainText(
    new RegExp(`Total uang fisik\\s*${rp("2.230.000")}`),
  );
  await fillCounts(page, NOTES_AND_SMALL);
  // 2.230.000 + 11.000: the small pieces count toward the total.
  await expect(area).toContainText(
    new RegExp(`Total uang fisik\\s*${rp("2.241.000")}`),
  );
  // Blind: no system figure and no difference before sending.
  await expect(area).not.toContainText(/Rp\s*2\.250\.000/);
  await expect(area).not.toContainText(/Kas sistem|Kas kurang|Kas lebih/);

  await sendCount(page);
  await expect(area).toContainText(countNumber(1));
  await expect(area).not.toContainText(/Rp\s*2\.250\.000/);
  await expect(area).not.toContainText(/Kas sistem|Kas kurang|Kas lebih/);

  // The supervisor works from that same count (I6).
  await open(page, SUPERVISOR_URL);
  await expect(heading(page, "Persetujuan tutup shift")).toBeVisible();
  await expect(main(page)).toContainText(
    new RegExp(`Kas dihitung:?\\s*${rp("2.241.000")}`),
  );
});

test("legend-iqi SHIFT-06 an all-zero count needs the empty-drawer confirmation", async ({
  page,
}) => {
  await startCount(page);
  await fillCounts(page, {});
  await page.getByRole("button", { name: "Kirim hitungan kas" }).click();
  // Not sent yet: asks whether the drawer is really empty.
  const confirm = page.getByRole("button", { name: /^Ya, laci kosong/ });
  await expect(confirm).toBeVisible();
  await expect(main(page)).not.toContainText("Langkah 2 dari 2");
  await confirm.click();
  await expect(main(page)).toContainText("Langkah 2 dari 2");
  await expect(main(page)).toContainText(/Menunggu (persetujuan )?supervisor/i);
});

// ------------------------------------------------------------- recount

test("legend-iqi SHIFT-07 recounting from the waiting screen replaces the older count", async ({
  page,
}) => {
  await startCount(page);
  await fillCounts(page, NOTES);
  await sendCount(page);
  const area = main(page);
  await expect(area).toContainText(countNumber(1));

  await page.getByRole("button", { name: "Hitung ulang" }).click();
  await expect(area).toContainText("Langkah 1 dari 2");
  await expect(
    page.getByRole("button", { name: "Kirim hitungan kas" }),
  ).toBeVisible();

  await fillCounts(page, NOTES_AND_SMALL);
  await expect(area).toContainText(
    new RegExp(`Total uang fisik\\s*${rp("2.241.000")}`),
  );
  await sendCount(page);
  await expect(area).toContainText(countNumber(2));

  // The supervisor sees only the newer count.
  await open(page, SUPERVISOR_URL);
  await expect(heading(page, "Persetujuan tutup shift")).toBeVisible();
  await expect(main(page)).toContainText(
    new RegExp(`Kas dihitung:?\\s*${rp("2.241.000")}`),
  );
  await expect(main(page)).not.toContainText(
    new RegExp(`Kas dihitung:?\\s*${rp("2.230.000")}`),
  );
});

test("legend-iqi SHIFT-07 one click on Hitung ulang from the shift screen opens the count form", async ({
  page,
}) => {
  await startCount(page);
  await fillCounts(page, NOTES);
  await sendCount(page);

  await open(page, "/pos/shift");
  await expect(main(page)).toContainText("Menunggu supervisor");
  await page
    .getByRole("link", { name: "Hitung ulang" })
    .or(page.getByRole("button", { name: "Hitung ulang" }))
    .first()
    .click();

  await expect(page).toHaveURL(/\/pos\/shift\/tutup/);
  await expect(main(page)).toContainText("Langkah 1 dari 2");
  await expect(
    page.getByRole("button", { name: "Kirim hitungan kas" }),
  ).toBeVisible();
});

// -------------------------------------------------- close step 2: supervisor

test("legend-iqi SUP-02 the supervisor approves the submitted count and the shift closes for good", async ({
  page,
}) => {
  await startCount(page);
  await fillCounts(page, NOTES_AND_SMALL);
  await sendCount(page);

  await open(page, SUPERVISOR_URL);
  await expect(heading(page, "Persetujuan tutup shift")).toBeVisible();
  const area = main(page);
  await expect(area).toContainText(
    new RegExp(`Kas dihitung:?\\s*${rp("2.241.000")}`),
  );
  await expect(area).toContainText(/Kas kurang/);

  // Short count: reason and PIN (the "PIN without a reason" guard is covered
  // by legend-mjmm SUP-01).
  await fillApproval(
    page,
    "Uang kembalian diduga berlebih pada transaksi tunai.",
  );
  await approveButton(page).click();

  await expect(area).toContainText("Shift sudah ditutup");
  await expect(approveButton(page)).toHaveCount(0);

  // Reloading shows the locked result, never a second approval.
  await open(page, SUPERVISOR_URL);
  await expect(main(page)).toContainText("Shift sudah ditutup");
  await expect(approveButton(page)).toHaveCount(0);
});

test("legend-iqi SUP-03 a cash sale after the count blocks the close with a recount message", async ({
  page,
}) => {
  await open(page, `${SUPERVISOR_URL}?mock=count-stale`);
  await expect(heading(page, "Persetujuan tutup shift")).toBeVisible();
  await fillApproval(
    page,
    "Uang kembalian diduga berlebih pada transaksi tunai.",
  );
  await approveButton(page).click();

  const area = main(page);
  await expect(area).toContainText(/hitung ulang/i);
  await expect(area).not.toContainText(/SHIFT_COUNT_STALE|409/);
  // Not closed: the supervisor can still see the approval form.
  await expect(area).not.toContainText("Shift sudah ditutup");
  await expect(approveButton(page)).toBeVisible();
});

test("legend-iqi SUP-04 an outdated count blocks the close and asks for the latest count", async ({
  page,
}) => {
  await open(page, `${SUPERVISOR_URL}?mock=count-superseded`);
  await expect(heading(page, "Persetujuan tutup shift")).toBeVisible();
  await fillApproval(
    page,
    "Uang kembalian diduga berlebih pada transaksi tunai.",
  );
  await approveButton(page).click();

  const area = main(page);
  await expect(area).toContainText(/hitungan terbaru/i);
  await expect(area).not.toContainText(/SHIFT_COUNT_SUPERSEDED|409/);
  await expect(area).not.toContainText("Shift sudah ditutup");
  await expect(approveButton(page)).toBeVisible();
});
