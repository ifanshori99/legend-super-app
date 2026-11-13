// Run from this worktree: heavy node design/mockups/payout/render.mjs
// Uses installed Chrome and Node's WebSocket; no app server or dependencies.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const mockups = fileURLToPath(new URL("../", import.meta.url));
// Package the review as standalone HTML for Ghostex, which embeds local images
// but rejects local font URLs. Keep the editable CSS/JS alongside the artifact.
const payoutFile = path.join(mockups, "payout", "review.html");
const font = await readFile(
  path.join(mockups, "assets", "plus-jakarta-sans-latin.woff2"),
);
const styles = (
  await readFile(path.join(mockups, "payout", "styles.css"), "utf8")
).replace(
  /url\(['"]\.\.\/assets\/plus-jakarta-sans-latin\.woff2['"]\)/,
  `url('data:font/woff2;base64,${font.toString("base64")}')`,
);
const script = await readFile(
  path.join(mockups, "payout", "review.js"),
  "utf8",
);
let payoutHtml = await readFile(payoutFile, "utf8");
payoutHtml = payoutHtml.replace(
  /<link rel="stylesheet" href="styles.css"\s*\/>|<style id="app-styles">[\s\S]*?<\/style>/,
  () => `<style id="app-styles">${styles}</style>`,
);
payoutHtml = payoutHtml.replace(
  /<script src="review.js"><\/script>|<script id="app-script">[\s\S]*?<\/script>/,
  () => `<script id="app-script">${script}</script>`,
);
await writeFile(payoutFile, payoutHtml);
const profile = await mkdtemp(path.join(tmpdir(), "legend-mockup-chrome-"));
const chrome = spawn(
  process.env.CHROME_PATH ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let socket;
const report = [];
const interactions = [];
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try {
      port = (
        await readFile(path.join(profile, "DevToolsActivePort"), "utf8")
      ).split("\n")[0];
      break;
    } catch {
      await pause(100);
    }
  }
  assert.ok(port, "Chrome did not start");
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  socket = new WebSocket(
    tabs.find((tab) => tab.type === "page").webSocketDebuggerUrl,
  );
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  const exceptions = [];
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === "Runtime.exceptionThrown")
      exceptions.push(message.params.exceptionDetails.text);
    if (!message.id) return;
    const callbacks = pending.get(message.id);
    pending.delete(message.id);
    if (message.error)
      callbacks.reject(new Error(JSON.stringify(message.error)));
    else callbacks.resolve(message.result);
  });
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const requestId = ++id;
      pending.set(requestId, { resolve, reject });
      socket.send(JSON.stringify({ id: requestId, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    assert.equal(
      result.exceptionDetails,
      undefined,
      "Browser evaluation failed",
    );
    return result.result.value;
  };
  await call("Page.enable");
  await call("Runtime.enable");
  let captures = 0;
  for (const area of ["payout", "finance-exceptions"]) {
    const cases =
      area === "payout"
        ? ["runs", "approval", "status", "settings"]
            .flatMap((view) =>
              ["normal", "empty", "error", "loading"].map((state) => ({
                view,
                state,
              })),
            )
            .concat([
              { view: "settings", state: "inactive-source" },
              { view: "approval", state: "inactive-source" },
              { view: "runs", state: "duitku-off" },
              { view: "status", state: "unknown" },
            ])
        : ["normal", "empty", "error", "loading"].map((state) => ({ state }));
    for (const { state, view } of cases) {
      for (const width of [1440, 390, 320]) {
        const errorStart = exceptions.length;
        await call("Emulation.setDeviceMetricsOverride", {
          width,
          height: 1000,
          deviceScaleFactor: 1,
          mobile: false,
        });
        const url = pathToFileURL(path.join(mockups, area, "review.html"));
        url.searchParams.set("state", state);
        if (view) url.searchParams.set("view", view);
        await call("Page.navigate", { url: url.href });
        for (let i = 0; i < 100; i++) {
          if (
            await evaluate(
              `document.readyState === 'complete' && location.href === ${JSON.stringify(url.href)}`,
            )
          )
            break;
          await pause(50);
        }
        await evaluate("document.fonts.ready.then(() => true)");
        await pause(100);
        const metrics = await evaluate(
          `({width: innerWidth, contentWidth: document.documentElement.scrollWidth, title: document.title, body: document.body.innerText, controls: [...document.querySelectorAll('button,input,select,a[href]')].filter(el => el.getBoundingClientRect().width && !el.disabled).length})`,
        );
        assert.ok(metrics.title, `${area}: missing title`);
        const content = await evaluate(
          `document.querySelector(${JSON.stringify(area === "payout" ? "#page" : "#results")})?.innerText || ''`,
        );
        assert.ok(
          content.length > 40,
          `${area}/${state}: missing state content`,
        );
        assert.ok(
          metrics.contentWidth <= width + 1,
          `${area}/${state}/${width}: horizontal overflow ${metrics.contentWidth}`,
        );
        assert.equal(
          exceptions.length,
          errorStart,
          `${area}/${state}: JavaScript exception`,
        );
        const entry = {
          area,
          view,
          state,
          width,
          contentWidth: metrics.contentWidth,
          controls: metrics.controls,
          exceptions: exceptions.length - errorStart,
        };
        if (width !== 320) {
          const layout = await call("Page.getLayoutMetrics");
          const capture = await call("Page.captureScreenshot", {
            format: "png",
            captureBeyondViewport: true,
            clip: {
              x: 0,
              y: 0,
              width,
              height: Math.ceil(layout.cssContentSize.height),
              scale: 1,
            },
          });
          const name = `${area}${view ? `-${view}` : ""}-${state}-${width === 1440 ? "desktop" : "mobile"}.png`;
          await writeFile(
            path.join(mockups, area, name),
            Buffer.from(capture.data, "base64"),
          );
          entry.screenshot = name;
          captures++;
        }
        report.push(entry);
      }
    }
  }
  const open = async (area, view, state = "normal") => {
    const url = pathToFileURL(path.join(mockups, area, "review.html"));
    url.searchParams.set("state", state);
    if (view) url.searchParams.set("view", view);
    await call("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await call("Page.navigate", { url: url.href });
    for (let i = 0; i < 100; i++) {
      if (
        await evaluate(
          `document.readyState === 'complete' && location.href === ${JSON.stringify(url.href)}`,
        )
      )
        break;
      await pause(50);
    }
  };
  await open("finance-exceptions");
  assert.ok(
    await evaluate('document.querySelectorAll("td.unavailable").length > 0'),
    "Unknown item values must remain unavailable",
  );
  await evaluate(
    'document.querySelector("#outlet").value="kemang";document.querySelector("#filters").requestSubmit()',
  );
  assert.ok(
    await evaluate(
      '[...document.querySelectorAll("td.outlet")].every(el=>el.textContent!=="Seluruh PT")',
    ),
    "Outlet filter must exclude tenant-wide payout fees",
  );
  await evaluate(
    'document.querySelector("#from").value="2026-01-01";document.querySelector("#to").value="2026-11-14";document.querySelector("#filters").requestSubmit()',
  );
  assert.ok(
    await evaluate(
      '!document.querySelector("#date-error").hidden && document.querySelector("#date-error").textContent.includes("92")',
    ),
    "Reject date range beyond 92 days",
  );
  interactions.push(
    "Finance: unknown values, outlet fee scope, and invalid date range verified",
  );
  await open("payout", "settings", "inactive-source");
  for (const [value, disabled] of [
    ["mandiri", false],
    ["bca", true],
  ]) {
    await evaluate(
      `document.querySelector('#source').value=${JSON.stringify(value)};document.querySelector('#source').dispatchEvent(new Event('change',{bubbles:true}))`,
    );
    assert.equal(
      await evaluate(
        "document.querySelector('[data-action=\"save-settings\"]').disabled",
      ),
      disabled,
      "Re-selecting inactive source must disable save",
    );
  }
  await evaluate(
    "document.querySelector('#tabs a[href*=\"view=runs\"]').click()",
  );
  await pause(150);
  await evaluate(
    "document.querySelector('[data-action=\"approval\"]').click()",
  );
  assert.ok(
    await evaluate('location.search.includes("inactive-source")'),
    "Navigation must preserve inactive source",
  );
  await evaluate(
    'document.querySelector("#checked").checked=true;document.querySelector("#checked").dispatchEvent(new Event("change",{bubbles:true}))',
  );
  assert.ok(
    await evaluate(
      "document.querySelector('[data-action=\"approve\"]').disabled",
    ),
    "Inactive source must still reject approval after review checkbox",
  );
  interactions.push(
    "Payout: active/inactive re-selection and navigation preserve payment rejection",
  );
  await open("payout", "settings");
  await evaluate(
    'document.querySelector("#method").value="duitku";document.querySelector("#method").dispatchEvent(new Event("change",{bubbles:true}))',
  );
  assert.equal(
    await evaluate('document.querySelector("#method").value'),
    "manual",
    "Duitku must remain unavailable",
  );
  await evaluate(
    'document.querySelector("#dialog").close();document.querySelector("#entity").selectedIndex=1;document.querySelector("#entity").dispatchEvent(new Event("change",{bubbles:true}))',
  );
  assert.equal(
    await evaluate('document.querySelector("#entity").selectedIndex'),
    0,
    "Unavailable PT must not relabel current payment context",
  );
  interactions.push(
    "Payout: unavailable Duitku and PT cannot relabel active payment context",
  );
  await open("payout", "approval");
  assert.ok(
    await evaluate(
      "document.querySelector('[data-action=\"approve\"]').disabled",
    ),
    "Approval must initially require review",
  );
  await evaluate(
    'document.querySelector("#checked").checked=true;document.querySelector("#checked").dispatchEvent(new Event("change",{bubbles:true}));document.querySelector(\'[data-action="approve"]\').click()',
  );
  assert.ok(
    await evaluate(
      'document.querySelector("#dialog").open && document.querySelector("#dialog").innerText.includes("Tidak ada persetujuan atau pembayaran nyata")',
    ),
    "Review action must stop at simulation",
  );
  await open("payout", "status", "unknown");
  assert.ok(
    await evaluate(
      "!document.querySelector('[data-action=\"manual-result\"]') && !!document.querySelector('[data-action=\"check-status\"]')",
    ),
    "Unknown result cannot be reclassified as manual payment",
  );
  interactions.push(
    "Payout: review gating, simulation boundary and uncertain payment follow-up verified",
  );
  assert.equal(
    exceptions.length,
    0,
    "No runtime exceptions during interaction checks",
  );
  await writeFile(
    path.join(mockups, "payout", "verification.json"),
    `${JSON.stringify({ command: "heavy node design/mockups/payout/render.mjs", checks: ["All four states at 1440, 390, 320", "No horizontal page overflow", "No JavaScript exceptions", "Local fonts settled before capture"], interactions, results: report }, null, 2)}\n`,
  );
  console.log(
    `PASS: ${report.length} state/viewport checks; ${captures} screenshots.`,
  );
} finally {
  socket?.close();
  chrome.kill("SIGTERM");
  await new Promise((resolve) => chrome.once("exit", resolve));
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  });
}
