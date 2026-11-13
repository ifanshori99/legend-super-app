import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

// Run with heavy. A shared installed browser package may be used for this static
// design audit, without symlinking dependencies into the application checkout.
const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, "../../..");
let modulePath = process.env.LEGEND_PLAYWRIGHT_MODULE;
if (!modulePath) {
  const candidates = [
    root,
    path.resolve(root, "../.."),
    path.resolve(root, "../legend"),
  ];
  for (const candidate of candidates) {
    try {
      modulePath = createRequire(path.join(candidate, "package.json")).resolve(
        "@playwright/test",
      );
      break;
    } catch {
      const store = path.join(candidate, "node_modules/.pnpm");
      const installed =
        existsSync(store) &&
        readdirSync(store).find((name) =>
          name.startsWith("@playwright+test@1.63.0"),
        );
      if (installed) {
        modulePath = path.join(
          store,
          installed,
          "node_modules/@playwright/test/index.mjs",
        );
        break;
      }
    }
  }
}
if (!modulePath)
  throw new Error(
    "Set LEGEND_PLAYWRIGHT_MODULE to the installed Playwright module",
  );
const { chromium } = await import(pathToFileURL(modulePath).href);
const browser = await chromium.launch({ headless: true });
const states = [
  "empty",
  "device",
  "connected",
  "failed",
  "expired",
  "detected",
  "disabled",
  "loading",
  "offline",
  "session",
];
const base = pathToFileURL(path.join(dir, "ai-settings.html")).href;
const results = [];
const runtimeErrors = [];
const externalRequests = [];
try {
  const page = await browser.newPage();
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  await page.route(/^https?:/, (route) => {
    externalRequests.push(route.request().url());
    return route.abort();
  });
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme });
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const state of states) {
        await page.goto(`${base}?state=${state}`);
        await page.evaluate(() => document.fonts.ready);
        const geometry = await page.evaluate(() => ({
          viewport: innerWidth,
          content: document.documentElement.scrollWidth,
          height: document.documentElement.scrollHeight,
          fontLoaded: document.fonts.check("16px Jakarta"),
          heading: document.querySelector("h1")?.textContent,
          clipped: [
            ...document.querySelectorAll(
              "h1,h2,h3,p,label,button,input,summary,a",
            ),
          ]
            .filter((el) => {
              const r = el.getBoundingClientRect();
              return r.width > 0 && (r.left < -1 || r.right > innerWidth + 1);
            })
            .map((el) => ({
              tag: el.tagName,
              text: el.textContent.slice(0, 80),
            })),
        }));
        assert.equal(geometry.heading?.trim(), "Pengaturan AI");
        assert.ok(
          geometry.content <= width,
          `${state}/${width}: horizontal overflow`,
        );
        assert.equal(
          geometry.clipped.length,
          0,
          `${state}/${width}: clipped elements`,
        );
        if (await page.locator("#custom-api-key").count())
          assert.equal(
            await page.locator("#custom-api-key").inputValue(),
            "",
            "Stored key must never be prefilled",
          );
        assert.ok(
          (await page.locator(".btn.primary").count()) <= 1,
          "One primary action per screen",
        );
        if (state === "detected")
          assert.equal(
            await page.locator("details[open]").count(),
            0,
            "Advanced capability overrides start collapsed",
          );
        if (state === "loading") {
          assert.equal(await page.locator('[aria-busy="true"]').count(), 1);
          assert.equal(
            await page.locator("#screen input, #screen button").count(),
            0,
            "Loading cannot expose editable controls",
          );
        }
        if (["offline", "session"].includes(state)) {
          assert.equal(
            await page.locator("#settingsControls").count(),
            0,
            "Unavailable settings are not editable",
          );
          assert.equal(await page.locator('[role="alert"]').count(), 1);
        }
        if (state === "disabled") {
          const enabled = await page
            .locator(
              "#settingsControls input:enabled, #settingsControls select:enabled, #settingsControls button:enabled",
            )
            .count();
          assert.equal(
            enabled,
            0,
            "Platform kill switch must disable every setting control",
          );
        }
        if (state === "device") {
          assert.equal(
            await page
              .locator('a[href="https://auth.openai.com/codex/device"]')
              .count(),
            1,
          );
        }
        if (theme === "light" && [1280, 390].includes(width)) {
          const previewStyle = await page.addStyleTag({
            content:
              ".top,.breadcrumb,h1,.intro,.review-bar,.mockup-foot{display:none!important}",
          });
          await page.locator(".content").screenshot({
            path: path.join(
              dir,
              `preview-${state}-${width === 1280 ? "desktop" : "mobile"}.jpg`,
            ),
            type: "jpeg",
            quality: 82,
          });
          await previewStyle.evaluate((element) => element.remove());
        }
        if (
          theme === "dark" &&
          state === "detected" &&
          [1280, 390].includes(width)
        ) {
          await page.screenshot({
            path: path.join(
              dir,
              `ai-settings-detected-dark-${width === 1280 ? "desktop" : "mobile"}.png`,
            ),
            fullPage: true,
          });
        }
        if (state === "detected" && width === 1280) {
          const contrast = await page.evaluate(() => {
            const css = getComputedStyle(document.documentElement);
            const canvas = document.createElement("canvas");
            canvas.width = 1;
            canvas.height = 1;
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            function luminance(color) {
              ctx.clearRect(0, 0, 1, 1);
              ctx.fillStyle = color;
              ctx.fillRect(0, 0, 1, 1);
              const rgba = [...ctx.getImageData(0, 0, 1, 1).data];
              const linear = rgba.slice(0, 3).map((channel) => {
                const value = channel / 255;
                return value <= 0.04045
                  ? value / 12.92
                  : ((value + 0.055) / 1.055) ** 2.4;
              });
              return (
                0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
              );
            }
            const token = (name) => css.getPropertyValue(name).trim();
            const pairs = [];
            for (const surface of ["--canvas", "--paper", "--surface"]) {
              pairs.push({
                label: `Text on ${surface}`,
                foreground: token("--ink"),
                background: token(surface),
                required: 4.5,
              });
              pairs.push({
                label: `Helper on ${surface}`,
                foreground: token("--muted"),
                background: token(surface),
                required: 4.5,
              });
              pairs.push({
                label: `Input edge on ${surface}`,
                foreground: token("--input-edge"),
                background: token(surface),
                required: 3,
              });
            }
            pairs.push({
              label: "Primary action",
              foreground: token("--on-action"),
              background: token("--action"),
              required: 4.5,
            });
            return pairs.map((pair) => {
              const values = [
                luminance(pair.foreground),
                luminance(pair.background),
              ].sort((a, b) => a - b);
              return {
                ...pair,
                ratio: (values[1] + 0.05) / (values[0] + 0.05),
              };
            });
          });
          for (const pair of contrast)
            assert.ok(
              pair.ratio >= pair.required,
              `${theme} ${pair.label}: contrast ${pair.ratio}`,
            );
          results.push({
            check: "Source color contrast",
            theme,
            pairs: contrast,
            pass: true,
          });
        }
        results.push({ state, width, theme, ...geometry });
      }
    }
  }
  await page.emulateMedia({ colorScheme: "light" });

  await page.goto(`${base}?state=empty`);
  assert.equal(await page.locator("#connect-chatgpt").isDisabled(), true);
  await page.locator("#risk-consent").check();
  assert.equal(await page.locator("#connect-chatgpt").isEnabled(), true);
  await page.locator("#connect-chatgpt").click();
  assert.equal(
    await page
      .locator('a[href="https://auth.openai.com/codex/device"]')
      .count(),
    1,
  );
  results.push({ check: "Owner risk consent gates device login", pass: true });

  for (const state of ["empty", "connected", "device"]) {
    await page.goto(`${base}?state=${state}&role=admin`);
    for (const id of ["connect-chatgpt", "revoke-chatgpt"]) {
      const control = page.locator(`#${id}`);
      if (await control.count())
        assert.equal(
          await control.isDisabled(),
          true,
          `Admin cannot use ${id}`,
        );
    }
  }
  results.push({
    check: "Admin cannot start or revoke owner login",
    pass: true,
  });

  for (const state of ["offline", "session"]) {
    await page.goto(`${base}?state=${state}`);
    await page.locator("#screen .btn.primary").click();
    assert.equal(await page.locator("#connect-chatgpt").count(), 1);
    results.push({
      check: `${state} recovery reaches simulated settings`,
      pass: true,
    });
  }

  await page.goto(`${base}?state=connected`);
  await page.locator("#revoke-chatgpt").click();
  const dialog = page.locator("dialog[open]");
  assert.equal(await dialog.count(), 1, "Revocation must require confirmation");
  await page.keyboard.press("Escape");
  assert.equal(
    await page.locator("#revoke-chatgpt").count(),
    1,
    "Cancel preserves connection",
  );
  results.push({
    check: "Revocation opens a cancellable native dialog",
    pass: true,
  });

  await page.goto(`${base}?state=empty`);
  await page.keyboard.press("Tab");
  const focus = await page.evaluate(() => ({
    tag: document.activeElement.tagName,
    outline: getComputedStyle(document.activeElement).outlineStyle,
  }));
  assert.notEqual(focus.tag, "BODY");
  assert.notEqual(focus.outline, "none");
  results.push({ check: "Keyboard focus is visible", ...focus, pass: true });
  const reviewPath = path.join(dir, "review.html");
  assert.ok(
    existsSync(reviewPath),
    "Review page must exist before final verification",
  );
  const reviewUrl = pathToFileURL(reviewPath).href;
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(reviewUrl);
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(
        [...document.images].map((image) => {
          image.loading = "eager";
          return image.decode();
        }),
      );
    });
    const review = await page.evaluate(() => ({
      viewport: innerWidth,
      content: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
      images: [...document.images].map((image) => ({
        source: image.getAttribute("src"),
        loaded: image.complete && image.naturalWidth > 0,
      })),
      anchors: [
        ...new Set(
          [...document.querySelectorAll('a[href^="#"]')].map((link) =>
            link.getAttribute("href"),
          ),
        ),
      ]
        .filter((href) =>
          document.getElementById(href.slice(1))?.matches("section.state"),
        )
        .map((href) => ({
          href,
          exists: !!document.getElementById(decodeURIComponent(href.slice(1))),
        })),
    }));
    assert.ok(review.content <= width, `Review/${width}: horizontal overflow`);
    assert.ok(
      review.height < 7900,
      `Review/${width}: ${review.height}px exceeds complete Ghostex capture height`,
    );
    assert.equal(
      review.images.length,
      20,
      "Review shows desktop and mobile images for all ten states",
    );
    assert.ok(
      review.images.every((image) => image.loaded),
      "Every review screenshot must load",
    );
    assert.equal(review.anchors.length, 10, "Review has ten state anchors");
    assert.ok(
      review.anchors.every((anchor) => anchor.exists),
      "Every review anchor must resolve",
    );
    results.push({ check: "Review page", width, ...review, pass: true });
  }
  assert.equal(runtimeErrors.length, 0, JSON.stringify(runtimeErrors));
  assert.equal(
    externalRequests.length,
    0,
    "Static mockup must not call a provider",
  );
  writeFileSync(
    path.join(dir, "verification.json"),
    JSON.stringify(
      {
        scope:
          "Static design only; no real OAuth, API, budget charge, or production behavior tested",
        browser: "Chromium via Playwright 1.63.0",
        runtimeErrors,
        externalRequests,
        results,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `PASS: ${results.length} layout/interaction checks; no runtime errors or external requests`,
  );
} finally {
  await browser.close();
}
