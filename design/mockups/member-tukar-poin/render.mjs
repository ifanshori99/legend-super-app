import { chromium } from "../../../node_modules/.pnpm/playwright@1.63.0/node_modules/playwright/index.mjs";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const directory = new URL("./", import.meta.url);
const interactionsOnly = process.argv.includes("--interactions-only");
const report = {
  generatedAt: new Date().toISOString(),
  scope: interactionsOnly ? "targeted-interactions" : "full",
  note: "Mockup checks only; no API or real transaction is exercised.",
  screenshots: [],
  quickChecks: [],
  interactions: [],
  failures: [],
};
if (interactionsOnly) {
  const prior = JSON.parse(
    await readFile(new URL("render-report.json", directory), "utf8"),
  );
  if (prior.screenshots.length !== 30 || prior.quickChecks.length !== 7)
    throw new Error(
      "Targeted retry requires prior 30 screenshots and 7 layout checks",
    );
  report.screenshots = prior.screenshots;
  report.quickChecks = prior.quickChecks;
  report.screenshotsVerifiedAt =
    prior.screenshotsVerifiedAt || prior.generatedAt;
  report.priorInteractionFailures = prior.failures.filter((label) =>
    label.startsWith("Interaction "),
  );
  report.failures = prior.failures.filter(
    (label) => !label.startsWith("Interaction "),
  );
}
const browser = await chromium.launch({ headless: true });

function urlFor(state) {
  return new URL(
    `index.html?state=${encodeURIComponent(state)}&capture=1`,
    directory,
  ).href;
}

async function openPage(state, width, height = 900) {
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });
  const events = { pageerror: [], requestfailed: [], badResponses: [] };
  page.on("pageerror", (error) => events.pageerror.push(error.message));
  page.on("requestfailed", (request) =>
    events.requestfailed.push({
      url: request.url(),
      error: request.failure()?.errorText,
    }),
  );
  page.on("response", (response) => {
    if (response.status() >= 400)
      events.badResponses.push({
        url: response.url(),
        status: response.status(),
      });
  });
  await page.goto(urlFor(state), { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  return { page, events };
}

async function inspect(page) {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const outside = [...document.querySelectorAll("main *, header *")]
      .filter((element) => {
        const style = getComputedStyle(element);
        if (
          style.display === "none" ||
          style.position === "absolute" ||
          style.position === "fixed"
        )
          return false;
        const rect = element.getBoundingClientRect();
        return (
          rect.width > 0 && (rect.left < -1 || rect.right > innerWidth + 1)
        );
      })
      .slice(0, 20)
      .map((element) => ({
        tag: element.tagName,
        class: element.className,
        text: element.textContent.trim().slice(0, 90),
      }));
    const missingAssets = [...document.images]
      .filter((image) => !image.complete || !image.naturalWidth)
      .map((image) => image.src);
    const fonts = {
      status: document.fonts.status,
      jakartaLoaded: document.fonts.check("16px Jakarta"),
      faces: [...document.fonts].map((font) => ({
        family: font.family,
        status: font.status,
      })),
    };
    return {
      width,
      scrollWidth: document.documentElement.scrollWidth,
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
      outside,
      missingAssets,
      fonts,
      h1Count: document.querySelectorAll("h1").length,
      screenHasContent: Boolean(
        document.querySelector("#screen")?.textContent.trim(),
      ),
    };
  });
}

function recordFailure(label, details) {
  if (
    details.overflow ||
    details.outside.length ||
    details.missingAssets.length ||
    !details.fonts.jakartaLoaded ||
    !details.screenHasContent ||
    details.h1Count !== 1 ||
    details.pageerror.length ||
    details.requestfailed.length ||
    details.badResponses.length
  ) {
    report.failures.push(label);
  }
}

async function screenshotState(state, width) {
  const { page, events } = await openPage(
    state,
    width,
    width === 390 ? 844 : 900,
  );
  try {
    const exists = await page.evaluate(
      (name) => typeof window.memberViews[name] === "function",
      state,
    );
    if (!exists) report.failures.push(`Missing view: ${state}`);
    const details = {
      state,
      width,
      exists,
      ...(await inspect(page)),
      ...events,
    };
    const filename = `${state}-${width}.png`;
    await page.screenshot({
      path: fileURLToPath(new URL(filename, directory)),
      fullPage: true,
      animations: "disabled",
    });
    details.file = filename;
    report.screenshots.push(details);
    recordFailure(`${state}/${width}`, details);
    console.log(
      JSON.stringify({
        state,
        width,
        file: filename,
        overflow: details.overflow,
        errors: events.pageerror.length + events.requestfailed.length,
      }),
    );
  } finally {
    await page.close();
  }
}

async function quickCheck(state, width, zoom = 1) {
  const { page, events } = await openPage(state, width);
  try {
    if (zoom !== 1)
      await page.evaluate((value) => {
        document.documentElement.style.zoom = String(value);
      }, zoom);
    const details = { state, width, zoom, ...(await inspect(page)), ...events };
    report.quickChecks.push(details);
    recordFailure(`Quick ${state}/${width}/${zoom}`, details);
  } finally {
    await page.close();
  }
}

async function checkInteraction(name, callback) {
  const { page, events } = await openPage("tanpa-tagihan", 390, 844);
  try {
    const result = await callback(page);
    const passed = !events.pageerror.length && !events.requestfailed.length;
    report.interactions.push({ name, passed, result, ...events });
    if (!passed) report.failures.push(`Interaction ${name}`);
  } catch (error) {
    const diagnostic = await page
      .evaluate(() => ({
        url: location.href,
        screenTextContent: document.querySelector("#screen")?.textContent,
        disclosures: [...document.querySelectorAll(".bill-disclosure")].map(
          (details) => ({
            open: details.open,
            visible: details.checkVisibility(),
          }),
        ),
        qrBalances: [
          ...document.querySelectorAll(".context .summary .row strong"),
        ].map((balance) => ({
          textContent: balance.textContent,
          innerText: balance.innerText,
          visible: balance.checkVisibility(),
        })),
      }))
      .catch((diagnosticError) => ({ error: diagnosticError.message }));
    report.interactions.push({
      name,
      passed: false,
      error: error.message,
      diagnostic,
      ...events,
    });
    report.failures.push(`Interaction ${name}`);
  } finally {
    await page.close();
  }
}

async function clickState(page, destination) {
  const control = page
    .locator(`button[data-state="${destination}"]:visible`)
    .first();
  await control.click();
  await page.waitForURL((url) => url.searchParams.get("state") === destination);
  await page.waitForLoadState("load");
}

try {
  const { page: discovery } = await openPage("tagihan-aktif", 390, 844);
  const discovered = await discovery.evaluate(() =>
    Object.keys(window.memberViews),
  );
  await discovery.close();
  const states = [
    ...new Set([...discovered, "qr-member", "poin-setelah", "kode-hasil"]),
  ];
  report.states = states;
  if (!interactionsOnly) {
    for (const state of states)
      for (const width of [390, 1280]) await screenshotState(state, width);
    for (const state of ["pilih-poin", "qr-aktif", "perbandingan-alur"]) {
      await quickCheck(state, 320);
      await quickCheck(state, 1280, 2);
    }
    await quickCheck("tagihan-aktif", 320);
  }
  await checkInteraction(
    "Member QR → tagihan → pilih poin → QR penukaran",
    async (page) => {
      for (const destination of [
        "qr-member",
        "tagihan-aktif",
        "pilih-poin",
        "qr-aktif",
      ])
        await clickState(page, destination);
      const text = await page.locator("#screen").innerText();
      if (!text.includes("500 poin") || !text.includes("02:00"))
        throw new Error("QR amount or frozen 120-second timer missing");
      return {
        state: new URL(page.url()).searchParams.get("state"),
        timer: "02:00",
      };
    },
  );
  await checkInteraction(
    "Input poin memperbarui nilai dan membatasi saldo",
    async (page) => {
      await page.goto(urlFor("pilih-poin"));
      const input = page.locator("#redeem-points");
      await input.fill("600");
      let text = await page.locator("#screen").innerText();
      if (!text.includes("Rp60.000") || !text.includes("Rp125.000"))
        throw new Error(
          "600 points must show Rp60.000 and remainder Rp125.000",
        );
      await input.fill("1500");
      const create = page.locator('[data-state="qr-aktif"]');
      if (!(await create.isDisabled()))
        throw new Error("Invalid balance must disable QR creation");
      await input.fill("500");
      if (await create.isDisabled())
        throw new Error("Valid 500-point value should enable QR creation");
      text = await page.locator("#screen").innerText();
      if (!text.includes("Rp50.000") || !text.includes("Rp135.000"))
        throw new Error(
          "500 points must restore Rp50.000 and remainder Rp135.000",
        );
      return {
        validInput: 500,
        excessiveInput: 1500,
        excessiveInputBlocked: true,
      };
    },
  );
  await checkInteraction(
    "Alternatif kode → konfirmasi tagihan → pilih poin",
    async (page) => {
      await page.goto(urlFor("kode-tagihan"));
      if (
        !(
          (await page.locator("#kode-tagihan").getAttribute("readonly")) !==
          null
        )
      )
        throw new Error("Example code input should be readonly");
      await clickState(page, "kode-hasil");
      await clickState(page, "pilih-poin");
      return { state: new URL(page.url()).searchParams.get("state") };
    },
  );
  await checkInteraction(
    "740 poin → sisa 500 poin pada QR, berhasil, dan navigasi header",
    async (page) => {
      const selectedUrl = new URL(urlFor("qr-aktif"));
      selectedUrl.searchParams.set("points", "740");
      await page.goto(selectedUrl.href);
      const beforeDisclosureUrl = page.url();
      let disclosureNavigations = 0;
      const countDisclosureNavigation = (frame) => {
        if (frame === page.mainFrame()) disclosureNavigations += 1;
      };
      page.on("framenavigated", countDisclosureNavigation);
      const billDisclosure = page.locator(".bill-disclosure");
      if (
        (await billDisclosure.count()) &&
        !(await billDisclosure.evaluate((details) => details.open))
      )
        await billDisclosure.locator("summary").click();
      await page.waitForFunction(
        () => {
          const details = document.querySelector(".bill-disclosure");
          const balances = [
            ...document.querySelectorAll(".context .summary .row strong"),
          ];
          const balance = balances.at(-1);
          return (
            (!details || details.open) &&
            balance?.checkVisibility() &&
            balance.innerText.trim() === "500 poin"
          );
        },
        null,
        { timeout: 5000 },
      );
      page.off("framenavigated", countDisclosureNavigation);
      if (page.url() !== beforeDisclosureUrl || disclosureNavigations !== 0)
        throw new Error("Opening bill disclosure must not navigate");
      const qrRemaining = await page
        .locator(".context .summary .row")
        .last()
        .locator("strong")
        .innerText();
      if (qrRemaining.trim() !== "500 poin")
        throw new Error(`QR balance should be 500, received: ${qrRemaining}`);
      const qrText = await page.locator("#screen").innerText();
      if (!qrText.includes("Rp74.000") || !qrText.includes("Rp111.000"))
        throw new Error("740 points must reduce Rp74.000 and leave Rp111.000");
      selectedUrl.searchParams.set("state", "sudah-dipakai");
      await page.goto(selectedUrl.href);
      const successBalance = await page
        .locator(".context .summary .amount")
        .innerText();
      if (successBalance.trim() !== "500 poin")
        throw new Error(
          `Success balance should be 500, received: ${successBalance}`,
        );
      const headerDestinations = [];
      const countHeaderNavigation = (frame) => {
        if (frame === page.mainFrame()) headerDestinations.push(frame.url());
      };
      page.on("framenavigated", countHeaderNavigation);
      await page.locator("header .member-nav").click();
      await page.waitForURL(
        (url) => url.searchParams.get("state") === "poin-setelah",
      );
      await page.waitForLoadState("load");
      page.off("framenavigated", countHeaderNavigation);
      if (
        headerDestinations.length !== 1 ||
        new URL(headerDestinations[0]).searchParams.get("state") !==
          "poin-setelah"
      )
        throw new Error(
          `Header must navigate once to poin-setelah: ${JSON.stringify(headerDestinations)}`,
        );
      const afterBalance = await page
        .locator(".context .summary .amount")
        .innerText();
      if (
        new URL(page.url()).searchParams.get("points") !== "740" ||
        afterBalance.trim() !== "500 poin"
      )
        throw new Error(
          "Header navigation must preserve 740 selected points and 500-point remaining balance",
        );
      return {
        selectedPoints: 740,
        qrRemaining,
        successBalance,
        afterBalance,
        disclosureNavigations,
        headerDestinations,
      };
    },
  );
  await checkInteraction(
    "QR kedaluwarsa memerlukan pemeriksaan status sebelum penukaran baru",
    async (page) => {
      await page.goto(urlFor("qr-kedaluwarsa"));
      if (
        await page
          .locator(
            '#screen [data-state="pilih-poin"], #screen [data-state="qr-aktif"], #screen .qr',
          )
          .count()
      )
        throw new Error(
          "Expired QR must not expose direct choose-points, mint, or QR controls",
        );
      await clickState(page, "loading");
      return { nextState: "loading", directRedeemBlocked: true };
    },
  );
  await checkInteraction(
    "Hitung mundur langsung 02:00 → 01:59 → kedaluwarsa tanpa QR",
    async (page) => {
      // Playwright 1.63 clock.runFor fires every interval tick; fastForward fires due timers only once.
      const start = new Date("2026-11-19T05:00:00.000Z");
      await page.clock.install({ time: start });
      await page.clock.pauseAt(new Date(start.getTime() + 1000));
      const liveUrl = new URL(urlFor("qr-aktif"));
      liveUrl.searchParams.delete("capture");
      await page.goto(liveUrl.href);
      if ((await page.getByRole("timer").innerText()).trim() !== "02:00")
        throw new Error("Live QR must begin at 02:00");
      await page.clock.runFor(1000);
      if ((await page.getByRole("timer").innerText()).trim() !== "01:59")
        throw new Error("Live QR must show 01:59 after one second");
      await page.clock.runFor(119000);
      await page.waitForURL(
        (url) => url.searchParams.get("state") === "qr-kedaluwarsa",
      );
      if (await page.locator("#screen .qr").count())
        throw new Error("Expired page must remove QR illustration");
      return {
        ticks: ["02:00", "01:59", "00:00"],
        finalState: "qr-kedaluwarsa",
        qrRemoved: true,
      };
    },
  );
} catch (error) {
  report.failures.push(`Renderer: ${error.message}`);
} finally {
  await browser.close();
  report.passed = report.failures.length === 0;
  await writeFile(
    new URL("render-report.json", directory),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(
    JSON.stringify({
      passed: report.passed,
      screenshots: report.screenshots.length,
      quickChecks: report.quickChecks.length,
      interactions: report.interactions.length,
      failures: report.failures,
    }),
  );
  if (!report.passed) process.exitCode = 1;
}
