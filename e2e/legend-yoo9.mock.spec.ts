// Legacy /sign-in links inside the QR journey now hand the guest to the WS-01
// /masuk screen with the page they came from (bead legend-yoo9): the checkout
// sign-in card returns to that checkout, and the bill's point-claim card
// returns to `/t/<token>/bill`. Both use an app-local `?redirect=` path, which
// /masuk validates before render (beads legend-qhh5, legend-yoo9).
//
// Runs against the mock web server (no API, no database):
//   pnpm test:e2e:mock e2e/legend-yoo9.mock.spec.ts
import { expect, test, type Page } from "@playwright/test";

const baseURL =
  process.env.LEGEND_MOCK_WEB_URL ?? process.env.E2E_MOCK_BASE_URL;

test.skip(
  !baseURL,
  "Mock runner not started: use pnpm test:e2e:mock (playwright.mock.config.ts).",
);
test.use({ baseURL });

/** A01, pay-first, no minimum spend — the same fixture legend-woz uses. */
const payFirstTable = `v1.${"C".repeat(40)}.${"D".repeat(43)}`;

/** P1, open bill with two splits (one paid) — the legend-woz claim fixture. */
const privateRoom = `v1.${"E".repeat(40)}.${"F".repeat(43)}`;

/** The mock accepts any joined session for a point claim; this cookie makes it
 *  ask a guest to sign in instead (`legend-mock-guest=1`, ws03 mock.ts). */
const GUEST_COOKIE = "legend-mock-guest";

/**
 * The first hit on a cold Vite dev server paints the server HTML before React
 * hydrates; a click in that window is lost. React attests a hydrated node with
 * an internal `__reactFiber$…` property, so wait for that on `selector`.
 */
async function waitForHydration(page: Page, selector: string) {
  await page.waitForFunction(
    (target) => {
      const node = document.querySelector(target);
      return (
        node !== null &&
        Object.keys(node).some((key) => key.startsWith("__reactFiber$"))
      );
    },
    selector,
    { timeout: 60_000 },
  );
}

/** Scan the table and confirm the guest count (PRD §3 "Scan & Sesi Meja"). */
async function joinTable(page: Page, token: string) {
  await page.goto(`/t/${token}`);
  await waitForHydration(page, "#main-content button");
  await page.getByRole("button", { name: "Mulai pesan" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
}

/** Put one Espresso in the shared cart (variant and sugar are required). */
async function addEspresso(page: Page) {
  await page.getByRole("searchbox", { name: "Cari menu" }).fill("espresso");
  await page.getByRole("button", { name: "Lihat detail Espresso" }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("radio", { name: /Dingin/ }).click();
  await sheet.getByRole("radio", { name: "Normal" }).click();
  await sheet.getByRole("button", { name: "Tambah ke keranjang" }).click();
  await expect(sheet).toBeHidden();
}

async function goToCheckout(page: Page) {
  await page.getByRole("link", { name: /Keranjang/ }).click();
  await page.getByRole("link", { name: "Lanjut ke checkout" }).click();
  await expect(
    page.getByRole("heading", { name: "Checkout", level: 1 }),
  ).toBeVisible();
}

test.describe("Legacy /sign-in links resume the page after /masuk", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        sessionStorage.clear();
        localStorage.setItem("legend-theme", "light");
      } catch {
        // storage blocked: the test still runs
      }
    });
  });

  test("legend-yoo9: checkout sign-in returns to this checkout", async ({
    page,
  }) => {
    test.slow();
    await joinTable(page, payFirstTable);
    await addEspresso(page);
    await goToCheckout(page);

    const expected = `/t/${payFirstTable}/checkout`;
    // The shell's own sign-in button sits outside #main-content (CustomerShell
    // header); the checkout card's link is the one inside the page.
    const signIn = page.locator("#main-content a[href^='/masuk?redirect=']");
    await expect(signIn).toHaveCount(1);
    await expect(signIn).toHaveAttribute(
      "href",
      `/masuk?redirect=${encodeURIComponent(expected)}`,
    );
    expect(
      new URL(
        (await signIn.getAttribute("href")) ?? "",
        "https://legend.test",
      ).searchParams.get("redirect"),
    ).toBe(expected);
  });

  // The claim card's login CTA carries the same `/masuk?redirect=<bill>` target,
  // but the mock never reaches "available + requires login": P1 ships split and
  // unpaid, and the split screen has no whole-bill pay path there. The change is
  // typechecked and shares its builder with the checkout card asserted above;
  // a mock state for the guest claim remains a follow-up (see bead note).
});
