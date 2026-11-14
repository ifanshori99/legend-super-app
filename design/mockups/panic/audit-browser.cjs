/* Local mockup verification. No app server, credentials, or real alerts. */
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createHash } = require("node:crypto");

const dir = __dirname;
const candidates = [
  process.env.PANIC_AUDIT_NODE_MODULES,
  path.resolve(dir, "../../../node_modules"),
].filter(Boolean);
const modules = candidates.find(
  (candidate) =>
    fs.existsSync(
      path.join(candidate, ".pnpm/playwright@1.63.0/node_modules/playwright"),
    ) &&
    fs.existsSync(
      path.join(
        candidate,
        ".pnpm/axe-core@4.14.0/node_modules/axe-core/axe.min.js",
      ),
    ),
);
if (!modules)
  throw new Error(
    "Set PANIC_AUDIT_NODE_MODULES to an existing local dependency directory.",
  );
const { chromium } = require(
  path.join(modules, ".pnpm/playwright@1.63.0/node_modules/playwright"),
);
const axePath = path.join(
  modules,
  ".pnpm/axe-core@4.14.0/node_modules/axe-core/axe.min.js",
);
const allFiles = [
  "state-incoming.html",
  "state-acknowledged.html",
  "state-reconnecting.html",
  "state-unreachable.html",
  "state-revoked.html",
  "state-multiple.html",
  "direction-b.html",
];
const only = process.argv
  .find((argument) => argument.startsWith("--only="))
  ?.slice(7);
const files = only ? allFiles.filter((file) => file === only) : allFiles;
if (!files.length) throw new Error("Unknown --only file.");
let previousRuns = [];
const resultsPath = path.join(dir, "audit-results.json");
if (fs.existsSync(resultsPath)) {
  const previous = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
  previousRuns = previous.previousRuns || [];
  delete previous.previousRuns;
  previousRuns.push(previous);
}
const hashes = () =>
  Object.fromEntries(
    allFiles.map((file) => [
      file,
      createHash("sha256")
        .update(fs.readFileSync(path.join(dir, file)))
        .digest("hex"),
    ]),
  );
const results = {
  previousRuns,
  startedAt: new Date().toISOString(),
  toolVersions: { playwright: "1.63.0", axeCore: "4.14.0" },
  sourceHashes: hashes(),
  scope:
    "Static illustrative mockups only; no backend, delivery, authorization or screen-reader certification.",
  axeTags: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
  cases: [],
  failures: [],
};
function save() {
  fs.writeFileSync(
    path.join(dir, "audit-results.json"),
    JSON.stringify(results, null, 2) + "\n",
  );
}
function check(testCase, name, pass, evidence) {
  testCase.checks.push({ name, pass, evidence });
  if (!pass) {
    const failure = {
      file: testCase.file,
      width: testCase.width,
      name,
      evidence,
    };
    results.failures.push(failure);
    console.error("FAIL " + JSON.stringify(failure));
  }
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const file of files) {
      for (const width of [1280, 390, 320]) {
        const testCase = { file, width, height: 844, checks: [] };
        results.cases.push(testCase);
        const page = await browser.newPage({
          viewport: { width, height: 844 },
          reducedMotion: "reduce",
        });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        try {
          await page.goto(pathToFileURL(path.join(dir, file)).href);
          await page.evaluate(() => document.fonts.ready);
          const overflow = await page.evaluate(() => ({
            viewport: innerWidth,
            scroll: document.documentElement.scrollWidth,
          }));
          check(
            testCase,
            "No horizontal overflow",
            overflow.scroll <= overflow.viewport,
            overflow,
          );
          const motion = await page.evaluate(() => ({
            reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
            activeAnimations: document
              .getAnimations()
              .filter((animation) => animation.playState === "running").length,
          }));
          check(
            testCase,
            "Reduced motion is static",
            motion.reduced && motion.activeAnimations === 0,
            motion,
          );
          await page.addScriptTag({ path: axePath });
          const axe = await page.evaluate(async (tags) => {
            const result = await window.axe.run(document, {
              runOnly: { type: "tag", values: tags },
            });
            return {
              violations: result.violations.map(
                ({ id, impact, nodes, help }) => ({
                  id,
                  impact,
                  help,
                  nodes: nodes.map(({ target, failureSummary }) => ({
                    target,
                    failureSummary,
                  })),
                }),
              ),
              incomplete: result.incomplete.map(({ id, impact, nodes }) => ({
                id,
                impact,
                targets: nodes.map(({ target }) => target),
              })),
              passes: result.passes.length,
            };
          }, results.axeTags);
          testCase.axe = axe;
          check(
            testCase,
            "No serious or critical axe violations",
            !axe.violations.some(
              ({ impact }) => impact === "serious" || impact === "critical",
            ),
            axe.violations,
          );
          const interactive = page.locator(
            "button:not([disabled]), summary, a[href]",
          );
          const count = await interactive.count();
          if (count) {
            await page.keyboard.press("Tab");
            const focus = await page.evaluate(() => {
              const node = document.activeElement;
              const style = getComputedStyle(node);
              return {
                tag: node.tagName,
                text: node.textContent.trim(),
                focusVisible: node.matches(":focus-visible"),
                outlineStyle: style.outlineStyle,
                outlineWidth: style.outlineWidth,
              };
            });
            check(
              testCase,
              "Keyboard focus is visible on first action",
              focus.tag !== "BODY" &&
                focus.focusVisible &&
                focus.outlineStyle !== "none" &&
                parseFloat(focus.outlineWidth) >= 2,
              focus,
            );
          } else
            testCase.keyboard = "N/A: informational state has no controls.";

          if (file === "state-incoming.html" && width === 390) {
            const box = await page.locator('[data-action="ack"]').boundingBox();
            check(
              testCase,
              "Incoming CTA visible without scroll at 390x844",
              box &&
                box.y >= 0 &&
                box.y + box.height <= 844 &&
                box.height >= 44,
              box,
            );
          }
          if (file === "state-incoming.html" || file === "direction-b.html") {
            await page.locator('[data-action="ack"]').click();
            const feedback = await page.locator(".mock-feedback").textContent();
            const button = page.locator('[data-action="ack"]');
            check(
              testCase,
              "Single ACK records response without closing incident",
              (await button.isDisabled()) &&
                /Respons tercatat/.test(await button.textContent()) &&
                /Insiden belum dinyatakan selesai/.test(feedback),
              feedback,
            );
            check(
              testCase,
              "Single ACK status updated",
              /Anda menuju lokasi/.test(
                await page.locator(".details").textContent(),
              ),
              await page.locator(".details").textContent(),
            );
            check(
              testCase,
              "ACK feedback receives focus",
              await page
                .locator(".mock-feedback")
                .evaluate(
                  (node) =>
                    document.activeElement === node &&
                    node.getAttribute("role") === "status",
                ),
              feedback,
            );
          }
          if (file === "state-multiple.html") {
            check(
              testCase,
              "Three independent alerts present",
              (await page.locator(".queue-item").count()) === 3,
              await page.locator(".queue-item").count(),
            );
            for (let index = 0; index < 3; index++) {
              const item = page.locator(".queue-item").nth(index);
              const button = item.locator('[data-action="ack"]');
              await button.click();
              const remaining = 2 - index;
              const state = await page.evaluate(() => ({
                title: document.querySelector(".screen-title").textContent,
                status: document.querySelector(".screen-top .status-label")
                  .textContent,
                queueLabel: document
                  .querySelector(".alert-queue")
                  .getAttribute("aria-label"),
              }));
              const expectedTitle = remaining
                ? `${remaining} lokasi perlu bantuan`
                : "Semua alert sudah direspons";
              const statusCorrect = state.status.includes(String(remaining));
              const queueLabelCorrect =
                remaining > 0 || !/menunggu/i.test(state.queueLabel);
              check(
                testCase,
                `Queue count after ACK ${index + 1}`,
                state.title === expectedTitle &&
                  statusCorrect &&
                  queueLabelCorrect,
                state,
              );
              check(
                testCase,
                `ACK ${index + 1} accessible button state`,
                (await button.isDisabled()) &&
                  (await button.getAttribute("aria-label")) === null &&
                  /Respons tercatat/.test(await button.textContent()),
                {
                  text: await button.textContent(),
                  ariaLabel: await button.getAttribute("aria-label"),
                },
              );
              const remainingButtons = await page
                .locator(".queue-item button:not([disabled])")
                .count();
              check(
                testCase,
                `Other alerts retained after ACK ${index + 1}`,
                remainingButtons === remaining &&
                  (await page.locator(".queue-item").count()) === 3,
                { remainingButtons },
              );
            }
          }
          if (file === "state-unreachable.html") {
            await page.locator('[data-action="pin"]').click();
            const feedback = await page.locator(".mock-feedback").textContent();
            check(
              testCase,
              "PIN recovery is safe local simulation",
              /Simulasi perpindahan ke layar PIN/.test(feedback) &&
                (await page.locator("input").count()) === 0,
              feedback,
            );
          }
          if (file === "state-revoked.html") {
            await page.locator("summary").focus();
            await page.keyboard.press("Enter");
            check(
              testCase,
              "Revoked recovery steps open with keyboard",
              (await page.locator("details").getAttribute("open")) !== null &&
                (await page.locator("details li").count()) === 3,
              await page.locator("details").textContent(),
            );
          }
          check(
            testCase,
            "No JavaScript runtime errors",
            errors.length === 0,
            errors,
          );
        } catch (error) {
          check(testCase, "Audit completed", false, error.stack);
        } finally {
          await page.close();
          save();
        }
        console.log(`AUDITED ${file} ${width}px`);
      }
    }
  } finally {
    await browser.close();
    results.finishedAt = new Date().toISOString();
    results.sourceHashesAfter = hashes();
    if (
      JSON.stringify(results.sourceHashes) !==
      JSON.stringify(results.sourceHashesAfter)
    )
      results.failures.push({ name: "Sources changed during audit" });
    results.pass = results.failures.length === 0;
    save();
    console.log(
      JSON.stringify({
        pass: results.pass,
        cases: results.cases.length,
        failures: results.failures.length,
        results: path.join(dir, "audit-results.json"),
      }),
    );
    process.exitCode = results.pass ? 0 : 1;
  }
}
run().catch((error) => {
  results.failures.push({ name: "Browser audit setup", evidence: error.stack });
  results.pass = false;
  save();
  console.error(error);
  process.exitCode = 1;
});
