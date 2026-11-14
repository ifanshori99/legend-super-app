// legend-nnufz: Pengaturan AI wired to the real contract
// (docs/briefs/sub-ai-settings-wire.md). Behaviours:
//  (1) The platform lock (`?state=disabled` or `?ai=off`, provider view
//      `platformLocked`; docs/briefs/sub-ai-settings-v2.md) locks ALL tenant AI
//      settings: one page-wide alert banner, and every control of the ChatGPT,
//      custom model and budget cards is disabled. Saved values stay visible.
//  (2) The service order card keeps the saved status visible under the lock and
//      shows an "unavailable" line (not "not connected / not ready") when its
//      status failed to load.
//  (3) "Simpan kemampuan" / "Kembalikan ke deteksi" call PATCH /api/ai/provider
//      and never PUT. Saving with no real change is a no-op (no request).
//  (4) The range rule is strict: output must be LOWER than context.
//
// Assumptions (the brief is the spec; the mock transport records no requests):
//  - Which method was used is proven through the mock fault injector: a
//    one-shot failure is queued on `PUT /api/ai/provider`. A save that goes
//    through PATCH succeeds and never consumes it; a save that still uses PUT
//    would fail. A failure queued on `PATCH /api/ai/provider` must surface as
//    an error and no success copy. The same trick proves the empty-diff no-op:
//    a queued PATCH failure is NOT consumed (the save still reports success).
//  - "Only the changed fields" and the mock handler's null/422 behaviour are
//    asserted in tests/ws12-ai-settings-wire.test.mjs (source + mock handler).
//  - The detected mock model has context 128000 and output 16384.
//  - An equal output and context is invalid ("must leave room for input"), as
//    the API contract refines `maxOutputTokens < contextWindow`.
//
// Runs against the FE mock runtime (VITE_API_MOCK=true):
//   pnpm test:e2e:mock e2e/legend-nnufz.mock.spec.ts
import { expect, test, type Page } from "@playwright/test";
import { failNextCall, type MockFailure } from "./mock-fail-next.ts";
import { waitForHydration } from "./hydration.ts";

// The screen's queries retry once (queries.ts RETRY), so an unavailable state
// needs the first call AND its retry to fail.
async function failFirstTwoCalls(
  page: Page,
  endpointId: string,
  failure: MockFailure,
) {
  await page.addInitScript(
    ({ endpointId, failure }) => {
      let control: unknown;
      Object.defineProperty(window, "__legendMock", {
        configurable: true,
        get: () => control,
        set: (value: { failNext: (id: string, f: MockFailure) => void }) => {
          control = value;
          value.failNext(endpointId, failure);
          value.failNext(endpointId, failure);
        },
      });
    },
    { endpointId, failure },
  );
}

const PAGE = "/kelola/pengaturan/ai";
const BANNER = "AI dimatikan oleh platform";
const OLD_NOTICE = "Login ChatGPT dimatikan oleh platform";

const chatgptCard = (page: Page) =>
  page.getByRole("region", { name: "Login ChatGPT" });

// The capability editor sits in a fold that is closed by default.
async function openCaps(page: Page) {
  await page
    .getByText("Ubah kemampuan model", { exact: true })
    .click({ timeout: 15_000 });
}

test.describe("legend-nnufz platform lock (provider platformLocked) locks all AI settings", () => {
  test("banner shows; every control is disabled; saved values stay visible", async ({
    page,
  }) => {
    await page.goto(`${PAGE}?state=disabled`);
    await waitForHydration(page);

    // One page-wide alert banner; the ChatGPT card carries no notice of its own.
    const banner = page.getByRole("alert").filter({ hasText: BANNER });
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("alert")).toHaveCount(1);
    await expect(page.getByText(OLD_NOTICE)).toHaveCount(0);
    await expect(
      chatgptCard(page).getByRole("status").filter({ hasText: BANNER }),
    ).toHaveCount(0);

    // ChatGPT: the connection action is locked.
    await expect(
      chatgptCard(page).getByRole("button", { name: "Cabut koneksi" }),
    ).toBeDisabled();

    // Custom model: the saved values are shown, every control is disabled.
    const baseUrl = page.getByLabel(/Alamat layanan/);
    await expect(baseUrl).toHaveValue("https://model.example.com/v1", {
      timeout: 15_000,
    });
    await expect(baseUrl).toBeDisabled();
    await expect(page.getByLabel(/Nama model/)).toBeDisabled();
    await expect(page.getByLabel(/API key/)).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Uji ulang koneksi" }),
    ).toBeDisabled();
    await openCaps(page);
    await expect(page.getByLabel("Konteks (token)")).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Simpan kemampuan" }),
    ).toBeDisabled();

    // Budget: the saved limit is visible, field and save are locked.
    const limit = page.getByLabel(/Batas per bulan/);
    await expect(limit).toBeDisabled({ timeout: 15_000 });
    await expect(limit).not.toHaveValue("");
    await expect(
      page.getByRole("button", { name: "Simpan anggaran" }),
    ).toBeDisabled();
  });

  test("with no model saved yet the lock still disables the custom form and ChatGPT login", async ({
    page,
  }) => {
    await page.goto(`${PAGE}?ai=off`);
    await waitForHydration(page);
    await expect(
      page.getByRole("alert").filter({ hasText: BANNER }),
    ).toBeVisible({ timeout: 15_000 });

    await expect(page.getByLabel(/Alamat layanan/)).toBeDisabled({
      timeout: 15_000,
    });
    await expect(page.getByLabel(/API key/)).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Hubungkan ChatGPT" }),
    ).toBeDisabled();
  });

  test("without the lock nothing is disabled and no banner shows", async ({
    page,
  }) => {
    await page.goto(`${PAGE}?state=detected`);
    await waitForHydration(page);
    await expect(page.getByLabel(/Batas per bulan/)).toBeEnabled({
      timeout: 15_000,
    });
    await expect(
      page.getByRole("button", { name: "Cabut koneksi" }),
    ).toBeEnabled();
    await expect(page.getByLabel(/Alamat layanan/)).toBeEnabled();
    await expect(page.getByText(BANNER)).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
});

test.describe("legend-nnufz service order card", () => {
  test("keeps the saved status visible when the platform lock is on", async ({
    page,
  }) => {
    await page.goto(`${PAGE}?state=disabled`);
    await waitForHydration(page);
    await expect(page.getByText("Utama · Terhubung")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("Cadangan otomatis · Siap")).toBeVisible();
    await expect(page.getByText("Dikunci platform")).toHaveCount(0);
  });

  test("shows connected and ready without the switch", async ({ page }) => {
    await page.goto(`${PAGE}?state=detected`);
    await waitForHydration(page);
    await expect(page.getByText("Utama · Terhubung")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("Cadangan otomatis · Siap")).toBeVisible();
    await expect(
      page.getByText(
        "Cadangan dipakai otomatis bila layanan utama bermasalah.",
      ),
    ).toBeVisible();
  });

  test("a failed ChatGPT status reads as unavailable, not 'not connected'", async ({
    page,
  }) => {
    await failFirstTwoCalls(page, "GET /api/ai/chatgpt", {
      status: 409,
      code: "CONFLICT",
      message: "status gagal",
    });
    await page.goto(`${PAGE}?state=detected`);
    await waitForHydration(page);
    await expect(
      page.getByText("Utama · Status belum bisa dimuat"),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Utama · Belum terhubung")).toHaveCount(0);
  });

  test("a failed provider read shows a page load error, not locked cards or the platform banner", async ({
    page,
  }) => {
    await failFirstTwoCalls(page, "GET /api/ai/provider", {
      status: 409,
      code: "CONFLICT",
      message: "provider gagal",
    });
    await page.goto(`${PAGE}?state=detected`);
    await waitForHydration(page);
    await expect(page.getByText("Bagian ini belum bisa dimuat")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole("button", { name: "Coba lagi" })).toBeVisible();
    await expect(page.getByText("AI dimatikan oleh platform")).toHaveCount(0);
    await expect(page.getByText("Cadangan otomatis · Belum siap")).toHaveCount(
      0,
    );
  });
});

test.describe("legend-nnufz capability save uses PATCH, never PUT", () => {
  test("save then reset succeed without touching PUT", async ({ page }) => {
    await page.goto(`${PAGE}?state=detected`);
    await waitForHydration(page);
    await openCaps(page);

    const context = page.getByLabel("Konteks (token)");
    await expect(context).toHaveValue("128000", { timeout: 15_000 });

    // If the screen still saved through PUT, this one-shot failure would hit it.
    await failNextCall(page, "PUT /api/ai/provider", {
      status: 409,
      code: "CONFLICT",
      message: "PUT dipakai",
    });

    await context.fill("64000");
    await page.getByRole("button", { name: "Simpan kemampuan" }).click();
    await expect(page.getByText("Kemampuan disimpan.")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(context).toHaveValue("64000");

    // Reset appears once an override exists and also goes through PATCH.
    await page.getByRole("button", { name: "Kembalikan ke deteksi" }).click();
    await expect(
      page.getByText("Nilai dikembalikan ke hasil deteksi."),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(context).toHaveValue("128000");
    await expect(
      page.getByRole("button", { name: "Kembalikan ke deteksi" }),
    ).toHaveCount(0);
  });

  test("reset clears every override at once (PATCH null)", async ({ page }) => {
    await page.goto(`${PAGE}?state=detected`);
    await waitForHydration(page);
    await openCaps(page);

    const context = page.getByLabel("Konteks (token)");
    const tools = page.getByLabel("Panggilan alat");
    await expect(context).toHaveValue("128000", { timeout: 15_000 });

    await context.fill("64000");
    await tools.selectOption("no");
    await page.getByRole("button", { name: "Simpan kemampuan" }).click();
    await expect(page.getByText("Kemampuan disimpan.")).toBeVisible({
      timeout: 15_000,
    });
    await expect(context).toHaveValue("64000");
    await expect(tools).toHaveValue("no");

    await page.getByRole("button", { name: "Kembalikan ke deteksi" }).click();
    await expect(
      page.getByText("Nilai dikembalikan ke hasil deteksi."),
    ).toBeVisible({ timeout: 15_000 });
    await expect(context).toHaveValue("128000");
    await expect(tools).toHaveValue("yes");
    await expect(
      page.getByRole("button", { name: "Kembalikan ke deteksi" }),
    ).toHaveCount(0);
  });

  test("a failed PATCH shows an error and no success message", async ({
    page,
  }) => {
    await page.goto(`${PAGE}?state=detected`);
    await waitForHydration(page);
    await openCaps(page);
    const context = page.getByLabel("Konteks (token)");
    await expect(context).toHaveValue("128000", { timeout: 15_000 });

    await failNextCall(page, "PATCH /api/ai/provider", {
      status: 409,
      code: "CONFLICT",
      message: "PATCH gagal",
    });
    await context.fill("64000");
    await page.getByRole("button", { name: "Simpan kemampuan" }).click();

    await expect(page.getByRole("alert")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Kemampuan disimpan.")).toHaveCount(0);
    // The stored overrides did not change: no reset button yet.
    await expect(
      page.getByRole("button", { name: "Kembalikan ke deteksi" }),
    ).toHaveCount(0);
  });
});

test.describe("legend-nnufz capability diff against the shown values", () => {
  test("saving an unchanged form is a no-op: success, no request", async ({
    page,
  }) => {
    await page.goto(`${PAGE}?state=detected`);
    await waitForHydration(page);
    await openCaps(page);
    const context = page.getByLabel("Konteks (token)");
    await expect(context).toHaveValue("128000", { timeout: 15_000 });

    // A request would consume this failure and show an error; a no-op does not.
    await failNextCall(page, "PATCH /api/ai/provider", {
      status: 409,
      code: "CONFLICT",
      message: "PATCH tidak boleh dipanggil",
    });
    await page.getByRole("button", { name: "Simpan kemampuan" }).click();

    await expect(page.getByText("Kemampuan disimpan.")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole("alert")).toHaveCount(0);
    // Nothing was stored: no override, so no reset button.
    await expect(
      page.getByRole("button", { name: "Kembalikan ke deteksi" }),
    ).toHaveCount(0);
  });

  test("typing the detected value back is still an unchanged form", async ({
    page,
  }) => {
    await page.goto(`${PAGE}?state=detected`);
    await waitForHydration(page);
    await openCaps(page);
    const context = page.getByLabel("Konteks (token)");
    await expect(context).toHaveValue("128000", { timeout: 15_000 });

    await failNextCall(page, "PATCH /api/ai/provider", {
      status: 409,
      code: "CONFLICT",
      message: "PATCH tidak boleh dipanggil",
    });
    await context.fill("64000");
    await context.fill("128000");
    await page.getByRole("button", { name: "Simpan kemampuan" }).click();

    await expect(page.getByText("Kemampuan disimpan.")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("after a save, the saved values are the new baseline", async ({
    page,
  }) => {
    await page.goto(`${PAGE}?state=detected`);
    await waitForHydration(page);
    await openCaps(page);
    const context = page.getByLabel("Konteks (token)");
    const output = page.getByLabel("Jawaban maks. (token)");
    await expect(context).toHaveValue("128000", { timeout: 15_000 });

    await context.fill("64000");
    await page.getByRole("button", { name: "Simpan kemampuan" }).click();
    await expect(page.getByText("Kemampuan disimpan.")).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByRole("button", { name: "Kembalikan ke deteksi" }),
    ).toBeVisible();

    // Saving again without edits sends nothing (the failure stays queued).
    await failNextCall(page, "PATCH /api/ai/provider", {
      status: 409,
      code: "CONFLICT",
      message: "PATCH tidak boleh dipanggil",
    });
    await page.getByRole("button", { name: "Simpan kemampuan" }).click();
    await expect(page.getByText("Kemampuan disimpan.")).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);

    // Changing only the output keeps the earlier context override: the
    // queued failure now hits this real request.
    await output.fill("8000");
    await page.getByRole("button", { name: "Simpan kemampuan" }).click();
    await expect(page.getByRole("alert")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Kemampuan disimpan.")).toHaveCount(0);
  });

  test("changing one field keeps the other stored value", async ({ page }) => {
    await page.goto(`${PAGE}?state=detected`);
    await waitForHydration(page);
    await openCaps(page);
    const context = page.getByLabel("Konteks (token)");
    const output = page.getByLabel("Jawaban maks. (token)");
    await expect(context).toHaveValue("128000", { timeout: 15_000 });

    await context.fill("64000");
    await page.getByRole("button", { name: "Simpan kemampuan" }).click();
    await expect(page.getByText("Kemampuan disimpan.")).toBeVisible({
      timeout: 15_000,
    });

    await output.fill("8000");
    await page.getByRole("button", { name: "Simpan kemampuan" }).click();
    await expect(page.getByText("Kemampuan disimpan.")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(context).toHaveValue("64000");
    await expect(output).toHaveValue("8000");
  });
});

test.describe("legend-nnufz capability range is strict (output < context)", () => {
  test("output equal to context is refused before any request", async ({
    page,
  }) => {
    await page.goto(`${PAGE}?state=detected`);
    await waitForHydration(page);
    await openCaps(page);
    const context = page.getByLabel("Konteks (token)");
    const output = page.getByLabel("Jawaban maks. (token)");
    await expect(context).toHaveValue("128000", { timeout: 15_000 });

    await output.fill("128000");
    await page.getByRole("button", { name: "Simpan kemampuan" }).click();

    await expect(
      page.getByText(/Batas jawaban tidak boleh melebihi konteks/),
    ).toBeVisible();
    await expect(page.getByText("Kemampuan disimpan.")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Kembalikan ke deteksi" }),
    ).toHaveCount(0);
  });

  test("output above context is refused", async ({ page }) => {
    await page.goto(`${PAGE}?state=detected`);
    await waitForHydration(page);
    await openCaps(page);
    const context = page.getByLabel("Konteks (token)");
    await expect(context).toHaveValue("128000", { timeout: 15_000 });

    await context.fill("8000");
    await page.getByRole("button", { name: "Simpan kemampuan" }).click();
    // Stored output 16384 is now above the new context 8000.
    await expect(
      page.getByText(/Batas jawaban tidak boleh melebihi konteks/),
    ).toBeVisible();
    await expect(page.getByText("Kemampuan disimpan.")).toHaveCount(0);
  });

  test("output one below context is accepted", async ({ page }) => {
    await page.goto(`${PAGE}?state=detected`);
    await waitForHydration(page);
    await openCaps(page);
    const context = page.getByLabel("Konteks (token)");
    const output = page.getByLabel("Jawaban maks. (token)");
    await expect(context).toHaveValue("128000", { timeout: 15_000 });

    await output.fill("127999");
    await page.getByRole("button", { name: "Simpan kemampuan" }).click();

    await expect(page.getByText("Kemampuan disimpan.")).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByText(/Batas jawaban tidak boleh melebihi konteks/),
    ).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
});
