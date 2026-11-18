import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const cli = "/test/project/node_modules/@playwright/test/cli.js";

// Execute the configured entry point with the process boundary replaced. The
// legacy direct command is included so the separator regression fails against
// its actual arguments, before a wrapper exists. No browser or server starts.
function dispatch(args = [], result = { status: 0 }) {
  const calls = [];
  const messages = [];
  const exit = Symbol("exit");
  const fakeProcess = {
    argv: ["node", "scripts/e2e-mock.mjs", ...args],
    execPath: "/test/node",
    env: { LEGEND_MOCK_PORT: "3299" },
    exitCode: undefined,
    exit(status) {
      this.exitCode = status;
      throw exit;
    },
  };
  const spawnSync = (command, forwarded, options) => {
    calls.push({ command, args: forwarded, options });
    return result;
  };
  if (
    packageJson.scripts["test:e2e:mock"] ===
    "playwright test --config=playwright.mock.config.ts"
  ) {
    spawnSync(
      fakeProcess.execPath,
      [cli, "test", "--config=playwright.mock.config.ts", ...args],
      { cwd: "/test/project", env: fakeProcess.env, stdio: "inherit" },
    );
    fakeProcess.exitCode = result.status ?? 1;
  } else {
    assert.equal(
      packageJson.scripts["test:e2e:mock"],
      "node scripts/e2e-mock.mjs",
    );
    const source = readFileSync(
      new URL("../scripts/e2e-mock.mjs", import.meta.url),
      "utf8",
    ).replace(/import[\s\S]*?from "[^"]+";/g, "");
    try {
      new Function(
        "process",
        "spawnSync",
        "resolve",
        "root",
        "console",
        source,
      )(fakeProcess, spawnSync, resolve, "/test/project", {
        error: (...parts) => messages.push(parts.join(" ")),
      });
    } catch (error) {
      if (error !== exit) throw error;
    }
  }
  return { calls, status: fakeProcess.exitCode, messages };
}

test("Mock runner forwards a selected file after pnpm's separator", () => {
  const { calls, status } = dispatch(["--", "e2e/example.mock.spec.ts"]);
  assert.deepEqual(calls[0].args, [
    cli,
    "test",
    "--config=playwright.mock.config.ts",
    "e2e/example.mock.spec.ts",
  ]);
  assert.equal(status, 0);
});

test("Mock runner forwards multiple files and Playwright options unchanged", () => {
  const args = [
    "e2e/first.mock.spec.ts",
    "e2e/second.mock.spec.ts",
    "--grep",
    "a selected test",
    "--list",
  ];
  assert.deepEqual(dispatch(args).calls[0].args, [
    cli,
    "test",
    "--config=playwright.mock.config.ts",
    ...args,
  ]);
});

test("Mock runner keeps the full suite when no file is selected", () => {
  for (const args of [[], ["--"]]) {
    const { calls } = dispatch(args);
    assert.deepEqual(calls[0].args, [
      cli,
      "test",
      "--config=playwright.mock.config.ts",
    ]);
    assert.equal(calls[0].command, "/test/node");
    assert.deepEqual(calls[0].options, {
      cwd: "/test/project",
      env: { LEGEND_MOCK_PORT: "3299" },
      stdio: "inherit",
    });
  }
});

test("Mock runner preserves the child failure status", () => {
  assert.equal(dispatch([], { status: 7 }).status, 7);
  assert.equal(dispatch([], { status: null }).status, 1);
});

test("Mock runner reports a child startup error as failure", () => {
  const { status, messages } = dispatch([], {
    status: null,
    error: new Error("spawn failed"),
  });
  assert.equal(status, 1);
  assert.ok(messages.some((message) => message.includes("spawn failed")));
});

test("Mock package script uses the argument-forwarding wrapper", () => {
  assert.equal(
    packageJson.scripts["test:e2e:mock"],
    "node scripts/e2e-mock.mjs",
  );
});
