import { expect, test, type Page } from "@playwright/test";
import { captureScreenshot } from "./screenshots.ts";

// WhatsApp login confirm card on /masuk (bead kmndq), against the FE mock
// runtime. In mock mode the API never touches the network, so `page.route`
// cannot intercept it; states are driven through the mock handler
// (VITE_API_MOCK=true) and `window.__legendMock.failNext`, like
// e2e/legend-baa.mock.spec.ts.
//
// ASSUMPTIONS (spec gap, the implementer must match them):
//  - The mock answers a requireConfirm challenge: poll 1 pending, poll 2
//    awaiting with senderMasked "+62 812-****-7890" (the contract's example
//    format; the brief's "+62 ****7890" is the same idea, shown as the API
//    sends it). Confirm completes it; cancel ends it.
//  - Card copy: "Pesan diterima dari <masked>. Masuk sebagai nomor ini?",
//    buttons "Ya, masuk" and "Bukan saya".
//  - Bukan saya shows "Masuk dibatalkan. Minta kode baru, lalu kirim pesannya
//    dari nomor WhatsApp-mu sendiri." and offers a button to start again (the existing
//    "Masuk dengan WhatsApp" start button or "Minta kode baru").
//  - Expired on confirm: CHALLENGE_EXPIRED shows the existing
//    "Kode sudah kedaluwarsa" end state.
//  - Network error on confirm keeps the card, shows the existing offline copy
//    and a second tap on "Ya, masuk" works.
//  - Screenshots go through captureScreenshot (docs/ paths are guarded by
//    tests/e2e-screenshot-paths.test.mjs): test-results/screenshots/kmndq/
//    by default, docs/design/screenshots/kmndq/ with
//    LEGEND_CAPTURE_SCREENSHOTS=1. The brief's separate QA folder is not used.
//
// Run: pnpm test:e2e:mock e2e/legend-kmndq.mock.spec.ts

const MASKED = "+62 812-****-7890";
const CARD_TEXT = new RegExp(
  `Pesan diterima dari ${MASKED.replace(/[+*]/g, "\\$&")}\\. Masuk sebagai nomor ini\\?`,
);
const CANCELLED_TITLE = "Masuk dibatalkan";
const CANCELLED_HINT =
  "Minta kode baru, lalu kirim pesannya dari nomor WhatsApp-mu sendiri.";
const CONFIRM_ID = "POST /api/auth/login-challenges/:challengeId/confirm";

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
] as const;

/** Screenshots show the settled state, not a frame mid-transition. */
async function capture(page: Page, name: string) {
  await page.evaluate(() =>
    document.getAnimations().forEach((animation) => {
      // Infinite animations cannot be finished (Web Animations InvalidStateError).
      if (animation.effect?.getComputedTiming().endTime !== Infinity)
        animation.finish();
    }),
  );
  await captureScreenshot(page, name);
}

/** Waits for React to hydrate the page's button (a cold dev server paints first). */
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

async function startLogin(page: Page, path = "/masuk?lanjut=%2Fmember") {
  await page.goto(path);
  await waitForHydration(page);
  await page.getByRole("button", { name: "Masuk dengan WhatsApp" }).click();
  await expect(page.getByText("Menunggu pesan WhatsApp-mu…")).toBeVisible();
}

async function reachConfirmCard(page: Page) {
  await startLogin(page);
  // The mock lets the message land on the second poll (2 s apart).
  await expect(page.getByText(CARD_TEXT)).toBeVisible({ timeout: 20_000 });
}

async function failNext(
  page: Page,
  match: string,
  failure: { status: number; code: string; message?: string },
) {
  await page.evaluate(
    ([id, value]) => {
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
      mock?.failNext(id, value);
    },
    [match, failure] as const,
  );
}

for (const viewport of VIEWPORTS) {
  test.describe(`kmndq at ${viewport.width}px`, () => {
    test.use({ viewport });

    test("kmndq: waiting for the message shows the code and no confirm card", async ({
      page,
    }) => {
      test.slow();
      await startLogin(page);

      await expect(
        page.getByRole("link", { name: "Buka WhatsApp" }),
      ).toBeVisible();
      await expect(page.getByText(CARD_TEXT)).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Ya, masuk" })).toHaveCount(
        0,
      );
      await capture(page, `kmndq/waiting-${viewport.width}.png`);
    });

    test("kmndq: a landed message shows the masked number with Ya, masuk and Bukan saya", async ({
      page,
    }) => {
      test.slow();
      await reachConfirmCard(page);

      await expect(page.getByText(CARD_TEXT)).toBeVisible();
      const yes = page.getByRole("button", { name: "Ya, masuk" });
      const no = page.getByRole("button", { name: "Bukan saya" });
      await expect(yes).toBeVisible();
      await expect(yes).toBeEnabled();
      await expect(no).toBeVisible();
      await expect(no).toBeEnabled();
      // Nobody is signed in yet: the page stays on /masuk.
      await expect(page).toHaveURL(/\/masuk/);
      // The state change is announced to assistive tech.
      await expect(
        page
          .locator('[aria-live="polite"], [role="status"]')
          .filter({ hasText: CARD_TEXT }),
      ).not.toHaveCount(0);
      if (viewport.width === 390) {
        for (const button of [yes, no]) {
          const box = await button.boundingBox();
          expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
        }
      }
      await capture(page, `kmndq/confirm-${viewport.width}.png`);
    });

    test("kmndq: Ya, masuk signs in and lands on the return page", async ({
      page,
    }) => {
      test.slow();
      await reachConfirmCard(page);

      await page.getByRole("button", { name: "Ya, masuk" }).click();

      await expect(page).toHaveURL(/\/member$/, { timeout: 20_000 });
      await capture(page, `kmndq/success-${viewport.width}.png`);
    });

    test("kmndq: Bukan saya cancels and goes back to the start with a clear message", async ({
      page,
    }) => {
      test.slow();
      await reachConfirmCard(page);

      await page.getByRole("button", { name: "Bukan saya" }).click();

      await expect(page.getByText(CANCELLED_TITLE)).toBeVisible();
      await expect(page.getByText(CANCELLED_HINT)).toBeVisible();
      await expect(page.getByText(CARD_TEXT)).toHaveCount(0);
      await expect(page).toHaveURL(/\/masuk/);
      // The guest can start again, and nothing signed them in.
      await expect(
        page.getByRole("button", {
          name: /Masuk dengan WhatsApp|Minta kode baru/,
        }),
      ).toBeVisible();
      await capture(page, `kmndq/cancelled-${viewport.width}.png`);
    });

    test("kmndq: confirming after the code lapsed shows the expired state", async ({
      page,
    }) => {
      test.slow();
      await reachConfirmCard(page);
      await failNext(page, CONFIRM_ID, {
        status: 410,
        code: "CHALLENGE_EXPIRED",
        message: "Kode sudah kedaluwarsa.",
      });

      await page.getByRole("button", { name: "Ya, masuk" }).click();

      await expect(page.getByText("Kode sudah kedaluwarsa")).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Minta kode baru" }),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Ya, masuk" })).toHaveCount(
        0,
      );
      await capture(page, `kmndq/expired-${viewport.width}.png`);
    });

    test("kmndq: a network error on confirm keeps the card and a retry signs in", async ({
      page,
    }) => {
      test.slow();
      await reachConfirmCard(page);
      await failNext(page, CONFIRM_ID, {
        status: 0,
        code: "NETWORK_ERROR",
        message: "Tidak ada koneksi.",
      });

      await page.getByRole("button", { name: "Ya, masuk" }).click();

      await expect(
        page.getByText(
          "Tidak ada koneksi internet. Sambungkan perangkatmu, lalu coba lagi.",
        ),
      ).toBeVisible();
      await expect(page.getByText(CARD_TEXT)).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Ya, masuk" }),
      ).toBeEnabled();
      await capture(page, `kmndq/network-error-${viewport.width}.png`);

      await page.getByRole("button", { name: "Ya, masuk" }).click();
      await expect(page).toHaveURL(/\/member$/, { timeout: 20_000 });
    });
  });
}
