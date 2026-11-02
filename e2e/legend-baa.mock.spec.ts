import { expect, test, type Page } from "@playwright/test";

// Customer and staff sign-in (WS-01, bead legend-baa) against the FE mock
// runtime: no API, no database. Every screen runs on the identity contract and
// its Cafe Legend fixtures through VITE_API_MOCK=true (docs/frontend.md
// "Browser specs in mock mode"). Acceptance IDs live in the test names:
// AUTH-01 (code lifetime/single use/browser binding), AUTH-03 (no WhatsApp
// message is sent by the system) and AUTH-07 (points need a verified number).
//
// Run: pnpm test:e2e:mock e2e/legend-baa.mock.spec.ts

const CODE = /^[0-9A-Z]{4}-[0-9A-Z]{4}$/;

/**
 * The first hit on a cold Vite dev server paints the server HTML before React
 * hydrates; a click in that window is lost. React attests a hydrated node with
 * an internal `__reactFiber$…` property, so wait for that on the page's button.
 */
async function waitForHydration(page: Page) {
  await page.waitForFunction(
    () => {
      const button = document.querySelector("#main-content button");
      return (
        button !== null &&
        Object.keys(button).some((key) => key.startsWith("__reactFiber$"))
      );
    },
    undefined,
    { timeout: 60_000 },
  );
}

test("AUTH-03: the guest sends the code; the page promises no WhatsApp reply", async ({
  page,
}) => {
  test.slow();
  await page.goto("/masuk");
  await waitForHydration(page);

  await expect(
    page.getByRole("heading", { level: 1, name: "Masuk ke Legend" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Legend tidak mengirim pesan WhatsApp apa pun. Konfirmasi selalu muncul di halaman ini.",
    ),
  ).toBeVisible();
  await expect(
    page.getByText("Kode ini rahasia", { exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Masuk dengan WhatsApp" }).click();

  const code = page.getByText(CODE);
  await expect(code).toBeVisible();

  // The message is filled in for the guest to send, to the tenant's number.
  const link = page.getByRole("link", { name: "Buka WhatsApp" });
  const href = await link.getAttribute("href");
  expect(href).toMatch(/^https:\/\/wa\.me\/\d+\?text=/);
  expect(decodeURIComponent(href ?? "")).toContain("MASUK LEGEND");

  await expect(
    page.getByText("Kirim pesan itu ke nomor Legend tanpa mengubah kodenya."),
  ).toBeVisible();
  await expect(page.getByText("Menunggu pesan WhatsApp-mu…")).toBeVisible();
});

test("AUTH-01: a code is bound to this browser and signs it in once", async ({
  page,
}) => {
  test.slow();
  await page.goto("/masuk?lanjut=%2Fmember");
  await waitForHydration(page);

  await page.getByRole("button", { name: "Masuk dengan WhatsApp" }).click();

  await expect(page.getByText(CODE)).toBeVisible();
  await expect(
    page.getByText(/^Berlaku \d:\d\d lagi, sekali pakai\.$/),
  ).toBeVisible();
  // Desktop shows the QR that opens WhatsApp with the same message.
  await expect(
    page.getByRole("img", { name: /QR untuk membuka WhatsApp/ }),
  ).toBeVisible();

  // The mock completes the challenge on the second poll, like the webhook.
  await expect(page).toHaveURL(/\/member$/, { timeout: 20_000 });
});

test("AUTH-01: a code asked for elsewhere is refused and a fresh one is offered", async ({
  page,
}) => {
  test.slow();
  await page.goto("/masuk");
  await waitForHydration(page);

  // First challenge installs the mock control (it boots on the first call).
  await page.getByRole("button", { name: "Masuk dengan WhatsApp" }).click();
  await expect(page.getByText(CODE)).toBeVisible();
  await page.getByRole("button", { name: "Batal" }).click();
  await expect(
    page.getByRole("button", { name: "Masuk dengan WhatsApp" }),
  ).toBeVisible();

  // AUTH-01 binding: the next poll belongs to a browser that did not ask.
  // A local cast, not a global Window declaration: specs share one tsconfig and
  // another spec already declares __legendMock with a different shape.
  await page.evaluate(() => {
    const mock = (
      window as unknown as {
        __legendMock?: {
          failNext: (
            match: string,
            failure: { status: number; code: string; message?: string },
          ) => void;
        };
      }
    ).__legendMock;
    mock?.failNext("GET /api/auth/login-challenges/:challengeId", {
      status: 403,
      code: "CHALLENGE_BROWSER_MISMATCH",
      message: "Kode ini dibuat di perangkat lain.",
    });
  });
  await page.getByRole("button", { name: "Masuk dengan WhatsApp" }).click();

  await expect(
    page.getByText("Kode ini bukan untuk browser ini"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Minta kode baru" }),
  ).toBeVisible();
});

test("AUTH-01: the email link works once and a dead link asks for a new one", async ({
  page,
}) => {
  test.slow();
  await page.goto("/masuk/email");
  await waitForHydration(page);

  await page.getByLabel("Email").fill("sari.puspita@gmail.com");
  await page.getByRole("button", { name: "Kirim tautan masuk" }).click();

  // The answer never says whether the address exists.
  await expect(page.getByText("Periksa emailmu")).toBeVisible();
  await expect(
    page.getByText(/Jika sari\.puspita@gmail\.com terdaftar/),
  ).toBeVisible();

  const token = "a".repeat(43);
  await page.goto(`/masuk/tautan?token=${token}`);
  await waitForHydration(page);
  await page.getByRole("button", { name: "Masuk sekarang" }).click();
  await expect(page.getByText("Berhasil masuk")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Ke halaman member" }),
  ).toBeVisible();

  await page.goto("/masuk/tautan");
  await expect(page.getByText("Tautan tidak lengkap")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Minta tautan baru" }),
  ).toHaveAttribute("href", "/masuk/email");
});

test("AUTH-07: points wait for a verified number, so Google asks to link WhatsApp", async ({
  page,
}) => {
  test.slow();
  await page.goto("/masuk/google");
  await waitForHydration(page);
  await expect(
    page.getByRole("heading", { name: "Masuk dengan Google" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      /Hubungkan nomor dulu sebelum mengumpulkan atau menukar poin\./,
    ),
  ).toBeVisible();

  // No session in this browser: the link prompt's empty state.
  await page.goto("/masuk/hubungkan?mock=empty");
  await expect(page.getByText("Masuk dulu")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Ke halaman masuk" }),
  ).toHaveAttribute("href", "/masuk");

  // Signed in without a verified number: the prompt explains and links.
  await page.goto("/masuk/hubungkan?mock=normal");
  await expect(
    page.getByText(/Poin tidak bisa dikumpulkan atau ditukar/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Hubungkan WhatsApp" }).click();
  await expect(page.getByText(CODE)).toBeVisible();
  // Exact: the points paragraph above also contains "nomor WhatsApp terhubung".
  await expect(
    page.getByText("Nomor WhatsApp terhubung", { exact: true }),
  ).toBeVisible({ timeout: 20_000 });
});

test("AUTH-01: a failed start explains the fix, and 390px has no sideways scroll", async ({
  page,
}) => {
  test.slow();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/masuk?mock=error");
  await waitForHydration(page);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);

  await page.getByRole("button", { name: "Masuk dengan WhatsApp" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Masuk belum bisa diproses. Coba lagi sebentar lagi.",
  );

  await page.goto("/masuk?mock=offline");
  await waitForHydration(page);
  await page.getByRole("button", { name: "Masuk dengan WhatsApp" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Tidak ada koneksi internet. Sambungkan perangkatmu, lalu coba lagi.",
  );
});

test("AUTH-01: a backslash or tab return path cannot leave the app (open redirect)", async ({
  page,
}) => {
  test.slow();
  // "/\evil.example" and "/<TAB>/evil.example" both normalize to
  // "//evil.example" in a browser; the contract refuses them, so the sign-in
  // lands on the default home instead (Opus review, legend-baa).
  for (const lanjut of ["%2F%5Cevil.example", "%2F%09%2Fevil.example"]) {
    await page.goto(`/masuk?lanjut=${lanjut}`);
    await waitForHydration(page);
    await page.getByRole("button", { name: "Masuk dengan WhatsApp" }).click();
    await expect(page.getByText(CODE)).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Ke halaman member" }),
    ).toHaveAttribute("href", "/member", { timeout: 20_000 });
    expect(new URL(page.url()).pathname).toBe("/masuk");
  }
});

test("AUTH-07: the link-WhatsApp screen keeps its 16px gutter at 360px and 390px", async ({
  page,
}) => {
  test.slow();
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/masuk/hubungkan?mock=normal");
  await waitForHydration(page);
  expect(
    await page.evaluate(() =>
      Math.max(
        ...Array.from(document.querySelectorAll("#main-content section")).map(
          (node) => node.getBoundingClientRect().right,
        ),
      ),
    ),
  ).toBeLessThanOrEqual(360 - 15);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/masuk/hubungkan?mock=normal");
  await waitForHydration(page);
  await expect(
    page.getByText(/Poin tidak bisa dikumpulkan atau ditukar/),
  ).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  const right = await page.evaluate(() =>
    Math.max(
      ...Array.from(
        document.querySelectorAll(
          "#main-content section, #main-content [role=status], #main-content h1",
        ),
      ).map((node) => node.getBoundingClientRect().right),
    ),
  );
  expect(right).toBeLessThanOrEqual(390 - 15);
  await page.screenshot({
    path: "docs/design/screenshots/legend-baa/masuk-hubungkan-390-light.png",
    fullPage: true,
  });
});
