import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

// Axe per state of the WhatsApp login confirm card on /masuk (bead kmndq):
// waiting, confirm, success, cancelled, expired, network-error, at 390x844 and
// 1280x800, tags wcag2a wcag2aa wcag21aa wcag22aa. Fails on serious/critical.
// States are driven like e2e/legend-kmndq.mock.spec.ts (helpers copied: this
// file lives outside e2e/ on purpose).
//
// Run: LEGEND_MOCK_PORT=3235 heavy pnpm exec playwright test \
//        -c scripts/ui-check-kmndq/playwright.config.ts
//
// `@axe-core/playwright` is not a dependency: the axe-core bundle from the pnpm
// store is injected instead.

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];
const BLOCKING = new Set(["serious", "critical"]);

const MASKED = "+62 812-****-7890";
const CARD_TEXT = new RegExp(
  `Pesan diterima dari ${MASKED.replace(/[+*]/g, "\\$&")}\\. Masuk sebagai nomor ini\\?`,
);
const CONFIRM_ID = "POST /api/auth/login-challenges/:challengeId/confirm";

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
] as const;

function findAxePath(): string {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const store = join(root, "node_modules/.pnpm");
  const hit = readdirSync(store).find((entry) => entry.startsWith("axe-core@"));
  if (hit === undefined) {
    throw new Error("axe-core not found in node_modules/.pnpm");
  }
  return join(store, hit, "node_modules/axe-core/axe.min.js");
}

interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  nodes: { target: unknown[] }[];
}

async function runAxe(page: Page, label: string): Promise<void> {
  await page.addScriptTag({ path: findAxePath() });
  const violations = await page.evaluate(
    async (tags) =>
      (
        await (
          window as unknown as {
            axe: {
              run: (
                context: Document,
                options: unknown,
              ) => Promise<{ violations: AxeViolation[] }>;
            };
          }
        ).axe.run(document, { runOnly: { type: "tag", values: tags } })
      ).violations,
    AXE_TAGS,
  );
  for (const violation of violations) {
    const targets = violation.nodes
      .map((node) => node.target.join(" "))
      .join(" | ");
    console.log(
      `[axe] ${label} ${violation.impact ?? "n/a"} ${violation.id}: ${violation.help} -> ${targets}`,
    );
  }
  const blocking = violations.filter((violation) =>
    BLOCKING.has(violation.impact ?? ""),
  );
  expect(
    blocking.map((violation) => `${violation.impact} ${violation.id}`),
    `${label}: serious/critical axe violations`,
  ).toEqual([]);
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
  test.describe(`kmndq axe at ${viewport.width}px`, () => {
    test.use({ viewport });
    const label = (state: string) => `${state}-${viewport.width}`;

    test("waiting", async ({ page }) => {
      test.slow();
      await startLogin(page);
      await expect(page.getByRole("link", { name: "Buka WhatsApp" })).toBeVisible();
      await runAxe(page, label("waiting"));
    });

    test("confirm", async ({ page }) => {
      test.slow();
      await reachConfirmCard(page);
      await expect(page.getByRole("button", { name: "Ya, masuk" })).toBeVisible();
      await runAxe(page, label("confirm"));
    });

    test("success", async ({ page }) => {
      test.slow();
      await reachConfirmCard(page);
      await page.getByRole("button", { name: "Ya, masuk" }).click();
      await expect(page).toHaveURL(/\/member$/, { timeout: 20_000 });
      await page.waitForLoadState("load");
      await runAxe(page, label("success"));
    });

    test("cancelled", async ({ page }) => {
      test.slow();
      await reachConfirmCard(page);
      await page.getByRole("button", { name: "Bukan saya" }).click();
      await expect(
        page.getByText(
          "Masuk dibatalkan. Minta kode baru, lalu kirim pesannya dari nomor WhatsApp-mu sendiri.",
        ),
      ).toBeVisible();
      await runAxe(page, label("cancelled"));
    });

    test("expired", async ({ page }) => {
      test.slow();
      await reachConfirmCard(page);
      await failNext(page, CONFIRM_ID, {
        status: 410,
        code: "CHALLENGE_EXPIRED",
        message: "Kode sudah kedaluwarsa.",
      });
      await page.getByRole("button", { name: "Ya, masuk" }).click();
      await expect(page.getByText("Kode sudah kedaluwarsa")).toBeVisible();
      await runAxe(page, label("expired"));
    });

    test("network-error", async ({ page }) => {
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
      await runAxe(page, label("network-error"));
    });
  });
}

// Innermost elements that stick out past the viewport, for the report.
async function overflow(page: Page) {
  return page.evaluate(() => {
    const cw = document.documentElement.clientWidth;
    const out = (el: Element) => el.getBoundingClientRect().right > cw + 1;
    const offenders = [...document.querySelectorAll("body *")]
      .filter(out)
      .filter((el) => ![...el.children].some(out))
      .slice(0, 8)
      .map((el) => {
        const r = el.getBoundingClientRect();
        const cls = typeof el.className === "string" ? el.className : "";
        return `${el.tagName.toLowerCase()}.${cls.slice(0, 80)} [${Math.round(r.left)}-${Math.round(r.right)}] "${(el.textContent ?? "").trim().slice(0, 40)}"`;
      });
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: cw,
      offenders,
    };
  });
}

test.describe("kmndq reflow at 320px", () => {
  test.use({ viewport: { width: 320, height: 640 } });

  test("waiting and confirm states add no width at 320 px", async ({
    page,
  }) => {
    test.slow();
    const report: string[] = [];
    await page.goto("/masuk?lanjut=%2Fmember");
    await waitForHydration(page);
    const start = await overflow(page);
    report.push(`start ${start.scrollWidth}: ${start.offenders.join(" | ")}`);
    await page.getByRole("button", { name: "Masuk dengan WhatsApp" }).click();
    await expect(page.getByText("Menunggu pesan WhatsApp-mu…")).toBeVisible();
    const waiting = await overflow(page);
    report.push(`waiting ${waiting.scrollWidth}: ${waiting.offenders.join(" | ")}`);
    await expect(page.getByText(CARD_TEXT)).toBeVisible({ timeout: 20_000 });
    const confirm = await overflow(page);
    report.push(`confirm ${confirm.scrollWidth}: ${confirm.offenders.join(" | ")}`);
    // The /masuk page itself already overflows at 320 px (bead filed by
    // legend-kmndq); this check only guards that the new states add no width.
    const baseline = Math.max(start.scrollWidth, start.clientWidth);
    const widest = Math.max(waiting.scrollWidth, confirm.scrollWidth);
    expect(widest, report.join("\n")).toBeLessThanOrEqual(baseline);
  });
});
