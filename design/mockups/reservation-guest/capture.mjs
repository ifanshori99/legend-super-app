import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync, existsSync } from "node:fs";

const root = dirname(fileURLToPath(import.meta.url));
const require = createRequire(
  join(
    resolve(process.env.LEGEND_TOOLING_ROOT || process.cwd()),
    "package.json",
  ),
);
const { chromium } = require("@playwright/test");
const chrome =
  process.env.GHOSTEX_CHROME ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browser = await chromium.launch(
  existsSync(chrome) ? { executablePath: chrome } : {},
);
const states = [
  "detail",
  "reschedule",
  "validation",
  "submitting",
  "pending",
  "approved",
  "rejected",
  "late",
  "cancel",
  "cancel-late",
  "cancelled",
  "cancelled-late",
  "invalid",
  "loading",
  "error",
  "rate-limit",
];
const report = {
  widths: [320, 390, 1280],
  states: states.length,
  screenshots: 0,
  assertions: [],
  errors: [],
};
try {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
  });
  page.on("pageerror", (error) => report.errors.push(error.message));
  for (const width of report.widths) {
    await page.setViewportSize({ width, height: 844 });
    for (const state of states) {
      await page.goto(pathToFileURL(join(root, `${state}.html`)).href);
      await page.evaluate(() => document.fonts.ready);
      assert.equal(
        await page.locator("#content").getAttribute("data-state"),
        state,
      );
      const layout = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > window.innerWidth,
        badTargets: [...document.querySelectorAll("#content button")]
          .filter((e) => !e.disabled && e.getBoundingClientRect().height < 44)
          .map((e) => e.textContent),
        headingCount: document.querySelectorAll("#content h1").length,
        text: document.querySelector("#content").textContent,
        missingTargets: [...document.querySelectorAll("[data-state]")].filter(
          (e) => e.tagName === "BUTTON" && !window.guestStates[e.dataset.state],
        ).length,
      }));
      assert.equal(
        layout.overflow,
        false,
        `Horizontal overflow: ${state} at ${width}`,
      );
      assert.deepEqual(
        layout.badTargets,
        [],
        `Small touch targets: ${state} at ${width}`,
      );
      assert.equal(layout.headingCount, 1);
      assert.equal(layout.missingTargets, 0);
      if (state === "invalid")
        assert.doesNotMatch(layout.text, /Menteng|50\.000|18 November/);
      if (width !== 320) {
        await page.screenshot({
          path: join(
            root,
            `${state}-${width === 390 ? "mobile" : "desktop"}.png`,
          ),
          fullPage: true,
        });
        report.screenshots++;
      }
    }
  }
  report.assertions.push(
    "All 16 states render without overflow at 320/390/1280; headings, action targets and 44px buttons checked.",
  );
  for (const state of [
    "cancel",
    "cancel-late",
    "cancelled",
    "cancelled-late",
    "late",
  ]) {
    await page.goto(pathToFileURL(join(root, `${state}.html`)).href);
    const amounts = await page.locator(".money-panel dd").allTextContents();
    const values = amounts.map((v) => Number(v.replace(/\D/g, "")));
    assert.equal(values[0], values[1] + values[2], `DP conservation: ${state}`);
    assert.equal(values[0], 50000);
  }
  report.assertions.push(
    "DP paid equals refund plus forfeiture in all five money states; no live money operation.",
  );
  await page.goto(pathToFileURL(join(root, "approved.html")).href);
  await page.locator('[data-state="detail"]').click();
  assert.match(
    await page.locator(".visit-time").textContent(),
    /19 November 2026/,
  );
  assert.equal(
    await page
      .locator("#content h1")
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await page.locator('[data-state="cancel"]').click();
  assert.match(
    await page.locator(".visit-time").textContent(),
    /19 November 2026/,
  );
  await page.goto(pathToFileURL(join(root, "approved.html")).href);
  await page.locator('[data-state="detail"]').click();
  await page.locator('[data-state="reschedule"]').click();
  await page.locator('[data-state="submitting"]').click();
  await page.waitForFunction(
    () => document.querySelector("#content").dataset.state === "pending",
  );
  assert.match(
    await page.locator(".visit-time").textContent(),
    /19 November 2026/,
  );
  report.assertions.push(
    "Approved schedule persists through detail, cancellation, and a second pending request; keyboard focus moves to heading.",
  );
  await page.goto(pathToFileURL(join(root, "late.html")).href);
  await page.locator('[data-state="cancel-late"]').click();
  await page.locator('[data-state="cancelled-late"]').click();
  assert.equal(
    await page.locator("#content").getAttribute("data-state"),
    "cancelled-late",
  );
  assert.match(await page.locator(".money-panel").textContent(), /Rp25\.000/);
  report.assertions.push(
    "Late cancellation requires confirmation and retains the 25k refund/25k deduction fixture.",
  );
  assert.deepEqual(report.errors, []);
  writeFileSync(
    join(root, "capture-report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
