import { chromium, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Static mockup verification only. No API requests, real credentials, or money movement.
// Playwright API checked against Context7 /microsoft/playwright/v1.63.0.
const dir = path.dirname(fileURLToPath(import.meta.url));
const source = pathToFileURL(path.join(dir, "payout-recon-clearance.html"));
const states = ["normal", "empty", "loading", "error", "validation", "success"];
const devices = [
  { name: "desktop", width: 1280, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
];
const report = {
  source: "payout-recon-clearance.html",
  contractCommit: "74e142d8b",
  screenshots: [],
  layoutChecks: [],
  interactionChecks: [],
  runtimeErrors: [],
  passed: false,
};
let browser;

function urlFor(state = "normal", view) {
  const url = new URL(source);
  url.searchParams.set("state", state);
  if (view) url.searchParams.set("view", view);
  return url.href;
}

async function open(page, state = "normal", view) {
  await page.goto(urlFor(state, view));
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator("html")).toHaveAttribute("lang", "id");
}

async function checkLayout(page, context) {
  const geometry = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    viewport: innerWidth,
    contentLength: document.body.innerText.trim().length,
  }));
  expect(
    geometry.scrollWidth,
    `Horizontal overflow: ${JSON.stringify(context)}`,
  ).toBeLessThanOrEqual(geometry.viewport);
  expect(
    geometry.contentLength,
    `Missing content: ${JSON.stringify(context)}`,
  ).toBeGreaterThan(100);
  report.layoutChecks.push({ ...context, ...geometry, passed: true });
}

async function newPage(viewport) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  page.on("pageerror", (error) =>
    report.runtimeErrors.push({ url: page.url(), message: error.message }),
  );
  page.on("console", (message) => {
    if (message.type() === "error")
      report.runtimeErrors.push({ url: page.url(), message: message.text() });
  });
  return page;
}

// Keep behavior checks separate from the screenshot loop: screenshots retain each fixture state.
async function checkInteractions(page, device) {
  await open(page);
  const reason = page.locator("#clearance-reason");
  const password = page.locator("#clearance-password");
  await expect(reason).toHaveAttribute("required", "");
  await expect(reason).toHaveAttribute("minlength", "10");
  await expect(reason).toHaveAttribute("maxlength", "500");
  await expect(password).toHaveAttribute("type", "password");
  await expect(password).toHaveAttribute("required", "");
  await reason.fill("");
  await password.fill("");
  expect(await reason.evaluate((field) => field.validity.valueMissing)).toBe(
    true,
  );
  expect(await password.evaluate((field) => field.validity.valueMissing)).toBe(
    true,
  );
  await page.locator("#propose-clearance").click();
  await expect(page.locator("#propose-clearance")).toBeVisible();
  await expect(page.locator("#changed-alert")).toHaveCount(0);
  report.interactionChecks.push({
    device,
    name: "Empty reason and password refuse proposal",
    passed: true,
  });

  await reason.fill("Singkat");
  expect(await reason.evaluate((field) => field.validity.tooShort)).toBe(true);
  const proposalReason =
    "Bukti transfer telah diperiksa dan biaya sesuai rekening koran.";
  await reason.fill(proposalReason);
  await password.fill("contoh-kata-sandi-mockup");
  expect(await reason.evaluate((field) => field.checkValidity())).toBe(true);
  expect(await password.evaluate((field) => field.checkValidity())).toBe(true);
  await page.locator("#propose-clearance").click();
  await expect(
    page.getByText(/Usulan.*(terkirim|dikirim|berhasil)/i).first(),
  ).toBeVisible();
  await expect(
    page.locator('article[data-flag-id="RF-001"] .pill'),
  ).toContainText("Diusulkan");
  await expect(page.locator(".selection")).toContainText("RF-001");
  await expect(page.locator(".proposal blockquote")).toContainText(
    proposalReason,
  );
  await page.locator('article[data-flag-id="RF-002"] .text-button').click();
  await expect(page.locator(".proposal blockquote")).not.toContainText(
    proposalReason,
  );
  report.interactionChecks.push({
    device,
    name: "Valid proposal has success feedback",
    passed: true,
  });

  await open(page, "normal", "approve");
  await expect(page.locator("#approve-clearance")).toBeEnabled();
  await page.locator("#clearance-password").fill("contoh-kata-sandi-mockup");
  await page.locator("#approve-clearance").click();
  await expect(
    page.getByText(/Clearance.*(disetujui|berhasil)/i).first(),
  ).toBeVisible();
  await expect(
    page.locator('article[data-flag-id="RF-002"] .pill'),
  ).toContainText("Disetujui");
  await expect(
    page.locator('article[data-flag-id="RF-001"] .pill'),
  ).toContainText("Terbuka");
  await expect(page.locator("#propose-clearance")).toHaveCount(0);
  await page.locator('article[data-flag-id="RF-002"] .text-button').click();
  await expect(
    page.locator('article[data-flag-id="RF-002"] .pill'),
  ).toContainText("Disetujui");
  report.interactionChecks.push({
    device,
    name: "Another person can approve with password",
    passed: true,
  });

  await open(page, "normal", "self");
  await expect(page.locator("#approve-clearance")).toBeDisabled();
  await expect(page.locator("#self-approval-reason")).toContainText(
    /(sendiri|orang lain)/i,
  );
  report.interactionChecks.push({
    device,
    name: "Proposer cannot approve own clearance and sees why",
    passed: true,
  });

  await open(page, "normal", "changed");
  await expect(page.locator("#changed-alert")).toContainText(/berubah/i);
  await page
    .getByRole("button", { name: "Buat usulan baru", exact: true })
    .click();
  await expect(page.locator("#clearance-reason")).toBeVisible();
  report.interactionChecks.push({
    device,
    name: "Changed data directs finance to a new proposal",
    passed: true,
  });

  await open(page, "normal", "reopened");
  await expect(
    page.getByText(/Clearance lama tidak berlaku/i).first(),
  ).toBeVisible();
  await page
    .locator("#clearance-reason")
    .fill(
      "Bukti pengganti telah ditinjau setelah perubahan data rekonsiliasi.",
    );
  await page.locator("#clearance-password").fill("contoh-kata-sandi-mockup");
  await page.locator("#propose-clearance").click();
  await expect(page.locator('article[data-flag-id="RF-004"]')).toContainText(
    "Diusulkan",
  );
  await expect(page.locator('article[data-flag-id="RF-004"]')).toContainText(
    /(Terbuka ulang|Clearance lama tidak berlaku)/i,
  );
  report.interactionChecks.push({
    device,
    name: "Reopened flag explains old clearance no longer applies",
    passed: true,
  });

  await open(page, "error");
  await expect(page.locator(".batch-meta")).not.toContainText("12.750.000");
  await page.getByRole("button", { name: "Coba lagi", exact: true }).click();
  await expect(page.locator("#propose-clearance")).toBeVisible();
  report.interactionChecks.push({
    device,
    name: "Load failure hides unverified counts and can retry",
    passed: true,
  });

  await page.locator("#batch").selectOption("clear");
  await expect(page.locator("#batch")).toHaveValue("clear");
  await expect(
    page.getByRole("heading", {
      name: "Tidak ada flag rekonsiliasi",
      exact: true,
    }),
  ).toBeVisible();
  report.interactionChecks.push({
    device,
    name: "Empty batch keeps the selected batch visible",
    passed: true,
  });
}

try {
  browser = await chromium.launch({ headless: true });
  for (const { name, width, height } of devices) {
    const page = await newPage({ width, height });
    for (const state of states) {
      await open(page, state);
      await checkLayout(page, { device: name, state, width });
      const filename = `payout-recon-clearance-${state}-${name}.png`;
      await page.screenshot({ path: path.join(dir, filename), fullPage: true });
      report.screenshots.push({
        filename,
        width,
        height,
        state,
        fullPage: true,
      });
      console.log(`Rendered ${state} ${name} (${width}px)`);
    }
    for (const view of ["approve", "self", "changed", "reopened"]) {
      await open(page, "normal", view);
      await checkLayout(page, { device: name, state: "normal", view, width });
      const filename = `payout-recon-clearance-${view}-${name}.png`;
      await page.screenshot({ path: path.join(dir, filename), fullPage: true });
      report.screenshots.push({
        filename,
        width,
        height,
        state: "normal",
        view,
        fullPage: true,
      });
      console.log(`Rendered ${view} ${name} (${width}px)`);
    }
    await checkInteractions(page, name);
    await page.close();
  }
  const narrowPage = await newPage({ width: 320, height: 844 });
  for (const state of states) {
    await open(narrowPage, state);
    await checkLayout(narrowPage, { device: "narrow", state, width: 320 });
  }
  for (const view of ["approve", "self", "changed", "reopened"]) {
    await open(narrowPage, "normal", view);
    await checkLayout(narrowPage, {
      device: "narrow",
      state: "normal",
      view,
      width: 320,
    });
  }
  await narrowPage.close();
  expect(report.runtimeErrors).toEqual([]);
  expect(report.screenshots).toHaveLength(20);
  report.passed = true;
  console.log(
    `PASS: ${report.screenshots.length} PNG, ${report.layoutChecks.length} layout checks, ${report.interactionChecks.length} interaction checks, no runtime errors.`,
  );
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  await browser?.close();
  await writeFile(
    path.join(dir, "payout-recon-clearance-verification.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
}
