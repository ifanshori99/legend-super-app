// WS-10 employee PWA: Beranda, attendance clock (selfie + geofence + device
// binding + rotating QR) and correction requests (bead legend-nv3y; PRD v1.7
// §3 Kelompok D 33, F25, §4 Alur L, HR-02).
//
// Mock-mode spec: `pnpm test:e2e:mock e2e/legend-nv3y.mock.spec.ts` starts a
// web dev server with VITE_API_MOCK=true (no API, no database). The clock is
// frozen on the fixture date so the fixture roster and the fixture "today"
// agree; geolocation is granted at the mock's outlet point. The browser has no
// camera in this runner, so the spec uses the screen's native-camera fallback
// (a real file input), then binds the device through the mock control exactly
// as a supervisor would.
import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./screenshots.ts";

const base = process.env.LEGEND_MOCK_WEB_URL;
test.skip(
  !base,
  "Set LEGEND_MOCK_WEB_URL (pnpm test:e2e:mock) to a web server running VITE_API_MOCK.",
);

const FIXTURE_NOW = new Date("2026-11-01T02:05:00.000+07:00");
const OUTLET_POINT = { latitude: -6.9175, longitude: 107.6191 };
const ROLE_COOKIE = "legend-mock-role";
// A 1×1 PNG: the screen resizes it through canvas like any phone photo.
const SELFIE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function openEmployeeApp(
  page: import("@playwright/test").Page,
  path: string,
  options: { location?: { latitude: number; longitude: number } } = {},
) {
  await page
    .context()
    .addCookies([{ name: ROLE_COOKIE, value: "employee", url: base }]);
  await page.clock.setFixedTime(FIXTURE_NOW);
  const location = options.location ?? OUTLET_POINT;
  await page.context().grantPermissions(["geolocation"]);
  await page.context().setGeolocation({
    latitude: location.latitude,
    longitude: location.longitude,
    accuracy: 8,
  });
  await page.goto(`${base}${path}`);
}

/** The screen's fallback for a browser without a camera stream. */
async function attachSelfie(page: import("@playwright/test").Page) {
  await page.locator('input[type="file"]').setInputFiles({
    name: "selfie.png",
    mimeType: "image/png",
    buffer: SELFIE_PNG,
  });
  await expect(page.getByText("Selfie siap dikirim.").first()).toBeVisible();
}

test("HR-02 the employee clocks in with a selfie and a bound device, then the log lands in the history", async ({
  page,
}) => {
  await openEmployeeApp(page, "/karyawan");
  await expect(
    page.getByRole("heading", { name: "Halo, Budi Santoso", level: 1 }),
  ).toBeVisible();
  await expect(page.getByText("Head Barista · NIP CL-1003")).toBeVisible();
  await expect(page.getByText("Belum absen masuk")).toBeVisible();
  // Fixture roster for the fixture "today" (PRD Beranda: jadwal hari ini).
  await expect(page.getByText("08.00–16.00")).toBeVisible();

  // Three taps from the Beranda: Absen masuk → shutter/file → Kirim absen.
  await page.getByRole("link", { name: "Absen masuk" }).click();
  await expect(
    page.getByRole("heading", { name: "Absen masuk", level: 1 }),
  ).toBeVisible();
  await expect(page.getByText(/Lokasi ditemukan/).first()).toBeVisible();
  await attachSelfie(page);
  await page
    .getByRole("button", { name: "Ikat perangkat ini (mode mock)" })
    .click();
  await expect(page.getByText("Perangkat terikat (mode mock).")).toBeVisible();
  await page.getByRole("button", { name: "Kirim absen" }).click();

  await expect(
    page.getByRole("heading", { name: "Absen tercatat" }),
  ).toBeVisible();
  await expect(page.getByText("Sah")).toBeVisible();
  await expect(page.getByText("Selfie & GPS")).toBeVisible();

  await page.getByRole("link", { name: "Buka riwayat absensi" }).click();
  await expect(
    page.getByRole("heading", { name: "Riwayat absensi", level: 1 }),
  ).toBeVisible();
  // Today's group carries the new log (fixture day, outlet time zone).
  await expect(page.getByText("Min, 1 Nov 2026")).toBeVisible();
  await expect(page.getByText("Masuk").first()).toBeVisible();
});

test("HR-02 a clock-in outside the geofence from an unbound device is flagged, not accepted", async ({
  page,
}) => {
  // ~5.5 km north of the outlet: well outside the fixture policy's 150 m fence.
  await openEmployeeApp(page, "/karyawan/absensi?type=in", {
    location: {
      latitude: OUTLET_POINT.latitude + 0.05,
      longitude: OUTLET_POINT.longitude,
    },
  });
  await attachSelfie(page);
  await expect(page.getByText(/Lokasi ditemukan/).first()).toBeVisible();
  await page.getByRole("button", { name: "Kirim absen" }).click();

  await expect(
    page.getByRole("heading", { name: "Absen ditandai untuk ditinjau" }),
  ).toBeVisible();
  await expect(page.getByText("Lokasi di luar radius outlet.")).toBeVisible();
  await expect(
    page.getByText("Perangkat ini belum terikat ke akun Anda."),
  ).toBeVisible();
  await expect(page.getByText("Ditandai", { exact: true })).toBeVisible();
});

test("HR-02 the rotating outlet QR fallback records a valid clock-in", async ({
  page,
}) => {
  await openEmployeeApp(page, "/karyawan/absensi?type=in");
  await attachSelfie(page);
  await page.getByRole("radio", { name: "QR outlet" }).click();
  await page
    .getByRole("button", { name: "Ikat perangkat ini (mode mock)" })
    .click();
  // The mock exposes the outlet screen's current 30-second code.
  await page.getByRole("button", { name: "Gunakan kode demo" }).click();
  await page.getByRole("button", { name: "Kirim absen" }).click();

  await expect(
    page.getByRole("heading", { name: "Absen tercatat" }),
  ).toBeVisible();
  await expect(page.getByText("QR outlet", { exact: true })).toBeVisible();
});

test("HR-02 the employee files a correction for a log and sees it pending", async ({
  page,
}) => {
  await openEmployeeApp(page, "/karyawan/absensi/riwayat");
  await expect(
    page.getByRole("heading", { name: "Riwayat absensi", level: 1 }),
  ).toBeVisible();

  await page
    .getByRole("button", { name: "Ajukan koreksi", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Ajukan koreksi absensi" }),
  ).toBeVisible();
  await dialog
    .getByLabel("Alasan")
    .fill("Lupa absen pulang setelah shift malam.");
  await dialog.getByRole("button", { name: "Kirim pengajuan" }).click();
  await expect(
    page.getByText("Pengajuan koreksi terkirim.").first(),
  ).toBeVisible();

  await page.getByRole("tab", { name: "Koreksi" }).click();
  await expect(page.getByText("Menunggu")).toBeVisible();
  await expect(
    page.getByText("Lupa absen pulang setelah shift malam."),
  ).toBeVisible();
});

test("HR-02 empty states keep the Beranda honest when there is no roster or history", async ({
  page,
}) => {
  await openEmployeeApp(page, "/karyawan?mock=empty");
  await expect(page.getByText("Belum absen masuk")).toBeVisible();
  await expect(
    page.getByText("Tidak ada shift terjadwal hari ini."),
  ).toBeVisible();
  await expect(
    page.getByText("Tidak ada pengajuan yang menunggu."),
  ).toBeVisible();
  await expect(page.getByText("Belum ada pengumuman.")).toBeVisible();
});

// ---- legend-nvc7: a refused offline correction stays visible ---------------
// The queue is seeded straight into localStorage, as an offline phone would have
// left it. CL-1003's employee id and the outlet id are the fixture tenant's
// (packages/shared/src/hris/fixtures.ts, core/fixtures.ts). Assumption: the
// mock correction endpoint accepts this body, so "Coba lagi" succeeds online.

const QUEUE_KEY = "legend-hris-corrections-queue";
const EMPLOYEE_ID = "00000000-0000-4000-8000-000000001003";
const OUTLET_ID = "6a2d4f80-1c3e-4b5a-9d7f-8e0c2b4a6d13";
const REFUSED_REASON = "Waktu koreksi di luar periode absensi.";
const REFUSED_TEXT = "Alasan server: Waktu koreksi di luar periode absensi.";
const QUEUED_REASON = "Ponsel mati saat jam pulang.";

function queued(
  key: string,
  reason: string,
  refused?: { status: number; code: string; reason: string; at: string },
) {
  return {
    key,
    employeeId: EMPLOYEE_ID,
    queuedAt: "2026-11-01T01:30:00.000Z",
    body: {
      outletId: OUTLET_ID,
      attendanceLogId: null,
      requestedType: "out",
      requestedOccurredAt: "2026-10-31T09:10:00.000Z",
      reason,
      idempotencyKey: key,
    },
    ...(refused ? { refused } : {}),
  };
}

const REFUSAL = {
  status: 422,
  code: "VALIDATION_FAILED",
  reason: REFUSED_REASON,
  at: "2026-11-01T01:45:00.000Z",
};

/** Seeds once per tab: a later reload keeps what the screen changed. */
async function seedQueue(
  page: import("@playwright/test").Page,
  rows: unknown[],
) {
  await page.addInitScript(
    ({ key, value }) => {
      if (localStorage.getItem(key) === null)
        localStorage.setItem(key, JSON.stringify(value));
    },
    { key: QUEUE_KEY, value: rows },
  );
}

const REFUSED_KEY = "11111111-1111-4111-8111-111111111111";
const WAITING_KEY = "22222222-2222-4222-8222-222222222222";

test("legend-nvc7 a refused queued correction shows Ditolak with the server's reason and three actions", async ({
  page,
}) => {
  await seedQueue(page, [queued(REFUSED_KEY, QUEUED_REASON, REFUSAL)]);
  await openEmployeeApp(page, "/karyawan");

  await expect(page.getByText("Ditolak", { exact: true })).toBeVisible();
  await expect(page.getByText(REFUSED_TEXT)).toBeVisible();
  await expect(page.getByText(QUEUED_REASON)).toBeVisible();
  await expect(page.getByRole("button", { name: "Coba lagi" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Ubah" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Buang" })).toBeVisible();
  // The card is no longer empty, and a refused entry is not "waiting".
  await expect(
    page.getByText("Tidak ada pengajuan yang menunggu."),
  ).toHaveCount(0);
  await expect(page.getByText(/pengajuan menunggu koneksi/)).toHaveCount(0);
});

test("legend-nvc7 Coba lagi resends the entry: it leaves Ditolak and appears as Menunggu from the server", async ({
  page,
}) => {
  await seedQueue(page, [queued(REFUSED_KEY, QUEUED_REASON, REFUSAL)]);
  await openEmployeeApp(page, "/karyawan");
  await expect(page.getByText("Ditolak", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Coba lagi" }).click();

  await expect(page.getByText("Ditolak", { exact: true })).toHaveCount(0);
  await expect(page.getByText(REFUSED_TEXT)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Buang" })).toHaveCount(0);
  await expect(page.getByText("Menunggu", { exact: true })).toBeVisible();
  await expect(page.getByText(QUEUED_REASON)).toBeVisible();
  const left = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? "[]"),
    QUEUE_KEY,
  );
  expect(left).toEqual([]);
});

test("legend-nvc7 Buang removes the refused entry and the card is empty again", async ({
  page,
}) => {
  await seedQueue(page, [queued(REFUSED_KEY, QUEUED_REASON, REFUSAL)]);
  await openEmployeeApp(page, "/karyawan");
  await expect(page.getByText("Ditolak", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Buang" }).click();

  await expect(page.getByText("Ditolak", { exact: true })).toHaveCount(0);
  await expect(page.getByText(QUEUED_REASON)).toHaveCount(0);
  await expect(
    page.getByText("Tidak ada pengajuan yang menunggu."),
  ).toBeVisible();
  const left = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? "[]"),
    QUEUE_KEY,
  );
  expect(left).toEqual([]);
});

test("legend-nvc7 Ubah opens the form prefilled; sending it replaces the refused entry", async ({
  page,
}) => {
  await seedQueue(page, [queued(REFUSED_KEY, QUEUED_REASON, REFUSAL)]);
  await openEmployeeApp(page, "/karyawan");

  await page.getByRole("button", { name: "Ubah" }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Ubah pengajuan koreksi" }),
  ).toBeVisible();
  await expect(
    dialog.getByText(
      "Perbaiki isian lalu kirim ulang. Pengajuan lama diganti.",
    ),
  ).toBeVisible();
  const reason = dialog.getByLabel("Alasan");
  await expect(reason).toHaveValue(QUEUED_REASON);

  await reason.fill("Ponsel mati, saya pulang pukul 16.10.");
  await dialog.getByRole("button", { name: "Kirim pengajuan" }).click();

  await expect(dialog).toHaveCount(0);
  // The refused entry is gone; the corrected request is the one that remains.
  await expect(page.getByText("Ditolak", { exact: true })).toHaveCount(0);
  await expect(page.getByText(REFUSED_TEXT)).toHaveCount(0);
  await expect(
    page.getByText("Ponsel mati, saya pulang pukul 16.10."),
  ).toBeVisible();
  await expect(page.getByText(QUEUED_REASON, { exact: true })).toHaveCount(0);
  const left = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? "[]"),
    QUEUE_KEY,
  );
  expect(left).toEqual([]);
});

test("legend-nvc7 a waiting entry shows Menunggu koneksi without actions, and the banner counts only waiting entries", async ({
  page,
}) => {
  await seedQueue(page, [
    queued(REFUSED_KEY, QUEUED_REASON, REFUSAL),
    queued(WAITING_KEY, "Sinyal hilang di dapur."),
  ]);
  // Offline for the page: online, the flush would send the waiting entry
  // straight away and it would leave the queue.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "onLine", { get: () => false });
  });
  await openEmployeeApp(page, "/karyawan");

  await expect(
    page.getByText("Menunggu koneksi", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Sinyal hilang di dapur.")).toBeVisible();
  await expect(page.getByText("1 pengajuan menunggu koneksi")).toBeVisible();
  // Only the refused entry has actions.
  await expect(page.getByRole("button", { name: "Coba lagi" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Buang" })).toHaveCount(1);
});

for (const width of [390, 1280]) {
  test(`legend-nvc7 visual ${width}: the refused entry fits, with touch-sized actions`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await seedQueue(page, [
      queued(REFUSED_KEY, QUEUED_REASON, REFUSAL),
      queued(WAITING_KEY, "Sinyal hilang di dapur."),
    ]);
    await openEmployeeApp(page, "/karyawan");
    await expect(page.getByText("Ditolak", { exact: true })).toBeVisible();
    await expect(page.getByText(REFUSED_TEXT)).toBeVisible();

    // No horizontal overflow, and every action is at least 44 px tall.
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    for (const name of ["Coba lagi", "Ubah", "Buang"]) {
      const button = page.getByRole("button", { name, exact: true });
      await button.scrollIntoViewIfNeeded();
      const box = await button.boundingBox();
      expect(box, name).not.toBeNull();
      expect(box!.height, name).toBeGreaterThanOrEqual(44);
      expect(box!.x + box!.width, name).toBeLessThanOrEqual(width);
    }

    await captureScreenshot(page, `legend-nvc7/refused-${width}.png`);
  });
}
