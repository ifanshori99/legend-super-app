// legend-nnufz: Pengaturan AI wired to the real contract
// (docs/briefs/sub-ai-settings-wire.md). Behaviours:
//  (1) The platform kill switch (`?ai=off`, ChatGPT status `platformDisabled`)
//      locks only the ChatGPT connection. Its notice lives INSIDE the ChatGPT
//      card (a status, not a page-wide alert banner). The custom model panel
//      and the budget card stay usable.
//  (2) The service order card reflects the lock and shows an "unavailable"
//      line (not "not connected / not ready") when its status failed to load.
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
const NOTICE = "Login ChatGPT dimatikan oleh platform";

const chatgptCard = (page: Page) =>
  page.getByRole("region", { name: "Login ChatGPT" });

test.describe("legend-nnufz platformDisabled locks only ChatGPT", () => {
  test("notice sits in the ChatGPT card; custom model and budget stay usable", async ({
    page,
  }) => {
    await page.goto(`${PAGE}?ai=off&state=detected`);
    await waitForHydration(page);

    // The notice is a status inside the ChatGPT card, never a page alert.
    const card = chatgptCard(page);
    await expect(
      card.getByRole("status").filter({ hasText: NOTICE }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(card.getByText("Dikunci platform").first()).toBeVisible();
    await expect(page.getByText(NOTICE)).toHaveCount(1);
    await expect(
      page.getByRole("alert").filter({ hasText: NOTICE }),
    ).toHaveCount(0);

    // ChatGPT (connected in this scenario): its only action is locked.
    await expect(
      card.getByRole("button", { name: "Cabut koneksi" }),
    ).toBeDisabled();

    // Custom model panel: the saved address and the save button stay usable.
    const baseUrl = page.getByLabel(/Alamat layanan/);
    await expect(baseUrl).toHaveValue("https://model.example.com/v1", {
      timeout: 15_000,
    });
    await expect(baseUrl).toBeEnabled();
    await expect(page.getByLabel(/Nama model/)).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "Simpan dan uji ulang koneksi" }),
    ).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "Simpan kemampuan" }),
    ).toBeEnabled();

    // Budget card: the field is editable and a save goes through.
    const limit = page.getByLabel(/Batas per bulan/);
    await expect(limit).toBeEnabled({ timeout: 15_000 });
    await limit.fill("6000000");
    const saveBudget = page.getByRole("button", { name: "Simpan anggaran" });
    await expect(saveBudget).toBeEnabled();
    await saveBudget.click();
    await expect(page.getByText("Anggaran disimpan.")).toBeVisible({
      timeout: 15_000,
    });
  });

  test("with no model saved yet the custom form is still usable", async ({
    page,
  }) => {
    await page.goto(`${PAGE}?ai=off`);
    await waitForHydration(page);
    await expect(
      chatgptCard(page).getByRole("status").filter({ hasText: NOTICE }),
    ).toBeVisible({ timeout: 15_000 });

    await expect(page.getByLabel(/Alamat layanan/)).toBeEnabled({
      timeout: 15_000,
    });
    await expect(page.getByLabel(/API key/)).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "Hubungkan ChatGPT" }),
    ).toBeDisabled();
  });

  test("without the kill switch nothing is locked and no notice shows", async ({
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
    await expect(page.getByText(NOTICE)).toHaveCount(0);
  });
});

test.describe("legend-nnufz service order card", () => {
  test("shows the lock when the platform switch is on", async ({ page }) => {
    await page.goto(`${PAGE}?ai=off&state=detected`);
    await waitForHydration(page);
    await expect(page.getByText("Utama · Dikunci platform")).toBeVisible({
      timeout: 15_000,
    });
    // The fallback is independent of the switch.
    await expect(page.getByText("Cadangan otomatis · Siap")).toBeVisible();
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

  test("a failed provider read reads as unavailable and hides the readiness note", async ({
    page,
  }) => {
    await failFirstTwoCalls(page, "GET /api/ai/provider", {
      status: 409,
      code: "CONFLICT",
      message: "provider gagal",
    });
    await page.goto(`${PAGE}?state=detected`);
    await waitForHydration(page);
    await expect(
      page.getByText("Cadangan otomatis · Status belum bisa dimuat"),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Cadangan otomatis · Belum siap")).toHaveCount(
      0,
    );
    await expect(
      page.getByText(
        "Siapkan model kustom agar AI memiliki cadangan saat ChatGPT bermasalah.",
      ),
    ).toHaveCount(0);
    await expect(
      page.getByText(
        "Cadangan dipakai otomatis bila layanan utama bermasalah.",
      ),
    ).toHaveCount(0);
  });
});

test.describe("legend-nnufz capability save uses PATCH, never PUT", () => {
  test("save then reset succeed without touching PUT", async ({ page }) => {
    await page.goto(`${PAGE}?state=detected`);
    await waitForHydration(page);

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
