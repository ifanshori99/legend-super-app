// Lighthouse check for the guest pages /menu and /t/<token> (bead legend-wwsa).
//
//   pnpm lighthouse            builds must already exist (pnpm build)
//   pnpm lighthouse --dry-run  print the plan, start nothing
//
// Thresholds live in scripts/ci/lighthouse.config.mjs. The servers start the way
// playwright.config.ts starts them (production builds, same ports) against a
// disposable PostgreSQL server. Set STARTER_TEST_DATABASE_URL and
// STARTER_TEST_RUN, PAYOUT_GRANTOR_DATABASE_URL (and optionally APP_DATABASE_URL)
// to reuse an already migrated and seeded test database instead of Docker.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pnpmCommand, root } from "../lib.mjs";
import { provisionRoles } from "../provision-app-role.mjs";
import { ownerLabelValue, removeProject } from "../test-sweep.mjs";
import * as config from "./lighthouse.config.mjs";
import {
  categoryFloors,
  describePlan,
  evaluate,
  formatRow,
  resolvePath,
  summarizeRuns,
} from "./lighthouse-evaluate.mjs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const runsFlag = args.find((arg) => arg.startsWith("--runs="));
const runs = runsFlag ? Number(runsFlag.slice(7)) : config.runs;
if (!Number.isInteger(runs) || runs < 1)
  throw new Error("--runs must be a positive integer.");

const { ports, tenantHostname } = config;
const apiUrl = `http://localhost:${ports.api}`;
const webUrl = `http://localhost:${ports.web}`;
const lighthouseOrigin = `http://${tenantHostname}:${ports.web}`;
const reuseDatabase = Boolean(process.env.STARTER_TEST_DATABASE_URL);

if (dryRun) {
  console.log(
    describePlan({
      pages: config.pages,
      runs,
      categories: config.categories,
      metrics: config.metrics,
      ports,
      tenantHostname,
      database: reuseDatabase
        ? "reuse STARTER_TEST_DATABASE_URL (must be migrated and seeded)"
        : "start a disposable PostgreSQL with Docker, migrate, provision the app and payout grantor roles, seed the tenant",
    }),
  );
  process.exit(0);
}

for (const build of [
  "apps/api/dist/server.js",
  "apps/web/.output/server/index.mjs",
])
  if (!existsSync(resolve(root, build)))
    throw new Error(`${build} is missing. Run pnpm build first.`);

const children = new Set();
const cleanups = [];
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.once(signal, () => {
    interrupted = true;
    for (const child of children) child.kill("SIGTERM");
  });

function run(command, commandArgs, env, capture = false) {
  if (interrupted) throw new Error("Interrupted.");
  return new Promise((accept, reject) => {
    let output = "";
    const child = spawn(command, commandArgs, {
      cwd: root,
      env,
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
      shell: process.platform === "win32" && command === pnpmCommand(),
    });
    children.add(child);
    if (capture)
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
    child.once("error", reject);
    child.once("close", (code) => {
      children.delete(child);
      if (code === 0) accept(output);
      else reject(new Error(`${command} exited with status ${code}.`));
    });
  });
}

function startServer(name, script, env) {
  const child = spawn(process.execPath, [script], {
    cwd: root,
    env,
    stdio: ["ignore", "inherit", "inherit"],
  });
  children.add(child);
  let exited = false;
  child.once("exit", (code) => {
    exited = true;
    children.delete(child);
    if (!interrupted && code)
      console.error(`${name} exited with status ${code}.`);
  });
  cleanups.push(async () => {
    if (exited) return;
    child.kill("SIGTERM");
    await new Promise((done) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        done();
      }, 5000);
      child.once("exit", () => {
        clearTimeout(timer);
        done();
      });
    });
  });
  return () => exited;
}

/** GET with an explicit Host header; resolves { status } and never follows redirects. */
function get(port, path, host) {
  return new Promise((accept, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, headers: { host }, timeout: 30_000 },
      (res) => {
        res.resume();
        res.once("end", () => accept({ status: res.statusCode }));
      },
    );
    req.once("timeout", () => req.destroy(new Error("request timed out")));
    req.once("error", reject);
    req.end();
  });
}

async function waitFor(label, probe, hasExited, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hasExited?.()) throw new Error(`${label} stopped before it was ready.`);
    try {
      if (await probe()) return;
    } catch {
      // not up yet
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`${label} was not ready after ${timeoutMs / 1000}s.`);
}

async function prepareDatabase(baseEnv) {
  if (reuseDatabase) {
    const url = process.env.STARTER_TEST_DATABASE_URL;
    if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
      throw new Error(
        "STARTER_TEST_RUN must start with starter-pg-test- when STARTER_TEST_DATABASE_URL is set.",
      );
    if (!process.env.PAYOUT_GRANTOR_DATABASE_URL?.trim())
      throw new Error(
        "PAYOUT_GRANTOR_DATABASE_URL is required when reusing a test database.",
      );
    return {
      ...baseEnv,
      MIGRATION_DATABASE_URL: process.env.MIGRATION_DATABASE_URL ?? url,
      APP_DATABASE_URL: process.env.APP_DATABASE_URL ?? url,
      DATABASE_URL: process.env.APP_DATABASE_URL ?? url,
      PAYOUT_GRANTOR_DATABASE_URL: process.env.PAYOUT_GRANTOR_DATABASE_URL,
    };
  }
  const project = `starter-pg-test-${randomBytes(8).toString("hex")}`;
  const password = randomBytes(24).toString("hex");
  const dockerEnv = {
    ...baseEnv,
    STARTER_TEST_PASSWORD: password,
    STARTER_TEST_OWNER: ownerLabelValue(),
  };
  const dockerArgs = ["compose", "-p", project, "-f", "compose.test.yaml"];
  cleanups.push(async () => {
    const result = spawnSync(
      "docker",
      [...dockerArgs, "down", "--volumes", "--remove-orphans"],
      { cwd: root, env: dockerEnv, stdio: "inherit" },
    );
    if ((result.error || result.status !== 0) && !removeProject(project))
      console.error(`Remove the disposable Docker Compose project ${project}.`);
  });
  await run(
    "docker",
    [...dockerArgs, "up", "-d", "--wait", "--wait-timeout", "60", "postgres"],
    dockerEnv,
  );
  const address = await run(
    "docker",
    [...dockerArgs, "port", "postgres", "5432"],
    dockerEnv,
    true,
  );
  const port = address.trim().match(/^127\.0\.0\.1:(\d+)$/)?.[1];
  if (!port) throw new Error("Could not determine the PostgreSQL port.");
  const url = `postgresql://starter_test:${password}@127.0.0.1:${port}/starter_test`;
  const appUrl = new URL(url);
  appUrl.username = `legend_runtime_${randomBytes(8).toString("hex")}`;
  appUrl.password = randomBytes(24).toString("hex");
  const grantorUrl = new URL(url);
  grantorUrl.username = `legend_grant_${randomBytes(8).toString("hex")}`;
  grantorUrl.password = randomBytes(24).toString("hex");
  const env = {
    ...dockerEnv,
    DATABASE_URL: appUrl.toString(),
    APP_DATABASE_URL: appUrl.toString(),
    PAYOUT_GRANTOR_DATABASE_URL: grantorUrl.toString(),
    MIGRATION_DATABASE_URL: url,
    STARTER_TEST_DATABASE_URL: url,
    STARTER_TEST_RUN: project,
  };
  await run(pnpmCommand(), ["run", "db:migrate"], env);
  await provisionRoles({
    adminUrl: url,
    appUrl: appUrl.toString(),
    grantorUrl: grantorUrl.toString(),
  });
  await run(
    pnpmCommand(),
    ["--filter", "@starter/api", "exec", "tsx", "src/db/seed-dev-tenant.ts"],
    env,
  );
  return env;
}

async function startChrome() {
  const { chromium } = await import("@playwright/test");
  const executable =
    process.env.LIGHTHOUSE_CHROME_PATH ?? chromium.executablePath();
  const profile = mkdtempSync(join(tmpdir(), "legend-lighthouse-"));
  const port = 9300 + Math.floor(Math.random() * 500);
  const child = spawn(
    executable,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      `--host-resolver-rules=MAP ${tenantHostname} 127.0.0.1`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  children.add(child);
  cleanups.push(async () => {
    child.kill("SIGTERM");
    rmSync(profile, { recursive: true, force: true });
  });
  await waitFor(
    "Chromium",
    async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).ok,
    () => child.exitCode !== null,
    30_000,
  );
  return port;
}

async function main() {
  const baseEnv = { ...process.env };
  // Settings for real deployments must not leak into a measurement run.
  for (const key of ["COOKIE_DOMAIN", "TRUSTED_ORIGINS", "API_INTERNAL_URL"])
    delete baseEnv[key];
  const secret = randomBytes(32).toString("hex");
  const env = await prepareDatabase({
    ...baseEnv,
    DEPLOYMENT_MODE: "development",
    DATA_CLASSIFICATION: "synthetic",
    BETTER_AUTH_SECRET: secret,
    BETTER_AUTH_URL: apiUrl,
    // The browser calls the API cross-origin from the tenant hostname.
    WEB_URL: lighthouseOrigin,
    VITE_API_URL: apiUrl,
  });

  const seedOutput = await run(
    pnpmCommand(),
    ["--filter", "@starter/api", "exec", "tsx", "src/test/lighthouse-seed.ts"],
    { ...env, NODE_ENV: "test", LOG_LEVEL: "silent" },
    true,
  );
  const token = JSON.parse(seedOutput.trim().split("\n").at(-1)).token;

  const apiExited = startServer("API", "apps/api/dist/server.js", {
    ...env,
    NODE_ENV: "production",
    PORT: String(ports.api),
    // The web server forwards the visitor's Host in X-Forwarded-Host (TEN-02);
    // the API honors it only from a loopback peer.
    TRUST_PROXY: "loopback",
    STAFF_PIN_PEPPER:
      process.env.STAFF_PIN_PEPPER ??
      "lighthouse-only-staff-pin-pepper-not-a-secret-000",
    LOG_LEVEL: "warn",
  });
  const webExited = startServer("web", "apps/web/.output/server/index.mjs", {
    ...env,
    NODE_ENV: "production",
    PORT: String(ports.web),
    API_INTERNAL_URL: apiUrl,
    LOG_LEVEL: "warn",
  });
  await waitFor(
    "API",
    async () => (await fetch(`${apiUrl}/api/health`)).ok,
    apiExited,
  );
  await waitFor(
    "web",
    async () => (await fetch(`${webUrl}/sign-in`)).ok,
    webExited,
  );

  const chromePort = await startChrome();
  const { default: lighthouse } = await import("lighthouse");
  const outDir = resolve(root, "test-results/lighthouse");
  mkdirSync(outDir, { recursive: true });

  const results = [];
  for (const page of config.pages) {
    const path = resolvePath(page.path, token);
    // Warm the server render and fail early on an error page: Lighthouse would
    // happily score a 404 page.
    const warm = await get(ports.web, path, `${tenantHostname}:${ports.web}`);
    if (warm.status !== 200)
      throw new Error(`${page.path} answered ${warm.status}, expected 200.`);
    const lhrs = [];
    for (let index = 1; index <= runs; index += 1) {
      const result = await lighthouse(`${lighthouseOrigin}${path}`, {
        port: chromePort,
        output: "json",
        logLevel: "error",
        formFactor: "mobile",
        skipAudits: config.skippedAudits,
        onlyCategories: Object.keys(
          categoryFloors(config.categories, page.categories),
        ),
      });
      const lhr = result?.lhr;
      if (!lhr || lhr.runtimeError)
        throw new Error(
          `Lighthouse failed on ${page.path}: ${lhr?.runtimeError?.message ?? "no result"}`,
        );
      lhrs.push(lhr);
    }
    const summary = summarizeRuns(lhrs);
    const verdict = evaluate(summary, {
      categories: categoryFloors(config.categories, page.categories),
      metrics: config.metrics,
    });
    results.push({
      page: page.name,
      path: page.path,
      runs,
      summary,
      ...verdict,
    });
    console.log(`\n${page.name} ${page.path} (median of ${runs} runs)`);
    for (const row of verdict.rows) console.log(`  ${formatRow(row)}`);
    // Name the audits that cost points (last run) so a failing category is
    // actionable without opening the saved report.
    const lastRun = lhrs.at(-1);
    for (const [categoryId, category] of Object.entries(
      lastRun.categories ?? {},
    )) {
      const lost = category.auditRefs
        .map((ref) => lastRun.audits[ref.id])
        .filter(
          (audit) =>
            audit &&
            typeof audit.score === "number" &&
            audit.score < 1 &&
            audit.scoreDisplayMode !== "informative",
        )
        .map((audit) => audit.id);
      if (lost.length > 0)
        console.log(`  ${categoryId} audits below 1: ${lost.join(", ")}`);
    }
    writeFileSync(
      join(outDir, `${page.name}.lhr.json`),
      JSON.stringify(lastRun),
    );
  }
  writeFileSync(
    join(outDir, "summary.json"),
    `${JSON.stringify(results, null, 2)}\n`,
  );
  const failed = results.filter((result) => !result.pass);
  if (failed.length > 0) {
    console.error(
      `\nLighthouse below threshold: ${failed.map((result) => result.page).join(", ")}`,
    );
    process.exitCode = 1;
  } else console.log("\nLighthouse thresholds met.");
}

try {
  await main();
} catch (error) {
  console.error(`Lighthouse stopped: ${error.message}`);
  process.exitCode = interrupted ? 130 : 1;
} finally {
  for (const cleanup of cleanups.reverse()) await cleanup();
}
