import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { removeWorktree } from "../scripts/worktree-remove.mjs";

function fixture({
  dirty = false,
  shared = false,
  downFails = false,
  owner = "/repo/task",
  locked = false,
  mainBranch = false,
  ignoredFiles = [],
  ignoredStatus = 0,
} = {}) {
  const calls = [];
  const saved = {
    COMPOSE_PROJECT_NAME: "ngodingpakeai-pg-task",
    POSTGRES_USER: "starter",
    POSTGRES_PASSWORD: "test-only",
    POSTGRES_DB: "starter",
    POSTGRES_PORT: "55432",
    DATABASE_URL: "postgresql://starter:test-only@127.0.0.1:55432/starter",
  };
  const dependencies = {
    cwd: "/repo/current",
    realpath: (path) => path,
    readEnvironment: (path) =>
      path === "/repo/task" || (shared && path === "/repo/current")
        ? saved
        : {},
    exec(command, args, options) {
      calls.push({ command, args, options });
      if (args.includes("list"))
        return {
          status: 0,
          stdout: `worktree /repo\0branch refs/heads/main\0\0worktree /repo/current\0branch refs/heads/current\0\0worktree /repo/task\0branch refs/heads/${mainBranch ? "main" : "task"}\0${locked ? "locked initializing\0" : ""}\0`,
        };
      if (args.includes("status"))
        return { status: 0, stdout: dirty ? " M tracked.txt\n" : "" };
      if (args.includes("ls-files"))
        return {
          status: ignoredStatus,
          stdout: ignoredFiles.map((file) => `${file}\0`).join(""),
        };
      if (command === "docker" && args[0] === "ps")
        return { status: 0, stdout: `test-container\t${owner}\n` };
      if (args.includes("down") && downFails)
        return { status: 1, stdout: "", stderr: "private failure" };
      return { status: 0, stdout: "" };
    },
  };
  return { calls, dependencies };
}

test("Stops only the target Compose project before removing its worktree, keeping volumes", () => {
  const { calls, dependencies } = fixture();
  removeWorktree("/repo/task", dependencies);
  const down = calls.findIndex((call) => call.args.includes("down"));
  const remove = calls.findIndex((call) => call.args.includes("remove"));
  assert.ok(down >= 0 && remove > down);
  assert.equal(calls[down].options.cwd, "/repo/task");
  assert.ok(calls[down].args.includes("ngodingpakeai-pg-task"));
  assert.equal(calls[down].args.includes("--volumes"), false);
  assert.equal(calls[down].args.includes("-v"), false);
  assert.deepEqual(calls[remove].args, ["worktree", "remove", "/repo/task"]);
});

test("Uses saved target settings without mutating the caller's Compose environment", () => {
  const originalProject = process.env.COMPOSE_PROJECT_NAME;
  const originalFile = process.env.COMPOSE_FILE;
  process.env.COMPOSE_PROJECT_NAME = "keep-caller-project";
  process.env.COMPOSE_FILE = "/caller/compose.yaml";
  try {
    const { calls, dependencies } = fixture();
    removeWorktree("/repo/task", dependencies);
    const down = calls.find((call) => call.args.includes("down"));
    assert.equal(
      down.options.env.COMPOSE_PROJECT_NAME,
      "ngodingpakeai-pg-task",
    );
    assert.equal(down.options.env.COMPOSE_FILE, undefined);
    assert.equal(process.env.COMPOSE_PROJECT_NAME, "keep-caller-project");
    assert.equal(process.env.COMPOSE_FILE, "/caller/compose.yaml");
  } finally {
    if (originalProject === undefined) delete process.env.COMPOSE_PROJECT_NAME;
    else process.env.COMPOSE_PROJECT_NAME = originalProject;
    if (originalFile === undefined) delete process.env.COMPOSE_FILE;
    else process.env.COMPOSE_FILE = originalFile;
  }
});

test("Refuses current, primary, and unregistered directories before Docker", () => {
  for (const target of ["/repo/current", "/repo", "/elsewhere"]) {
    const { calls, dependencies } = fixture();
    assert.throws(() => removeWorktree(target, dependencies));
    assert.equal(
      calls.some((call) => call.command === "docker"),
      false,
    );
    assert.equal(
      calls.some((call) => call.args.includes("remove")),
      false,
    );
  }
});

test("Refuses a dirty worktree before stopping its database", () => {
  const { calls, dependencies } = fixture({ dirty: true });
  assert.throws(() => removeWorktree("/repo/task", dependencies), /dirty/i);
  assert.equal(
    calls.some((call) => call.command === "docker"),
    false,
  );
});

test("Refuses ignored .env files at any depth before Docker or Git removal", () => {
  for (const file of [
    ".env",
    ".env.local",
    "apps/api/.env.production",
    "nested/deeper/.env.backup",
    "nested/.envrc",
  ]) {
    const { calls, dependencies } = fixture({ ignoredFiles: [file] });
    assert.throws(
      () => removeWorktree("/repo/task", dependencies),
      /--discard-env/,
    );
    const inventory = calls.find((call) => call.args.includes("ls-files"));
    assert.ok(inventory.args.includes("--ignored"));
    assert.ok(inventory.args.includes("--others"));
    assert.ok(inventory.args.includes("--exclude-standard"));
    assert.ok(inventory.args.includes("-z"));
    assert.equal(inventory.options.cwd, "/repo/task");
    assert.equal(
      calls.some((call) => call.command === "docker"),
      false,
    );
    assert.equal(
      calls.some((call) => call.args.includes("remove")),
      false,
    );
  }
});

test("Explicit discardEnv permits removal with ignored environment files", () => {
  const { calls, dependencies } = fixture({
    ignoredFiles: [".env.local", "nested/.env.production"],
  });
  removeWorktree("/repo/task", { ...dependencies, discardEnv: true });
  const down = calls.findIndex((call) => call.args.includes("down"));
  const remove = calls.findIndex((call) => call.args.includes("remove"));
  assert.ok(down >= 0 && remove > down);
  assert.equal(calls[down].args.includes("--volumes"), false);
  assert.equal(calls[down].args.includes("-v"), false);
});

test("Unrelated ignored build files do not require discardEnv", () => {
  const { calls, dependencies } = fixture({
    ignoredFiles: ["node_modules/.cache", "apps/web/dist/index.html"],
  });
  removeWorktree("/repo/task", dependencies);
  assert.ok(calls.some((call) => call.args.includes("remove")));
});

test("Ignored-file inventory failure preserves the worktree before Docker", () => {
  const { calls, dependencies } = fixture({ ignoredStatus: 1 });
  assert.throws(() => removeWorktree("/repo/task", dependencies));
  assert.equal(
    calls.some((call) => call.command === "docker"),
    false,
  );
  assert.equal(
    calls.some((call) => call.args.includes("remove")),
    false,
  );
});

test("Real Git finds ignored root/nested environment files with NUL-safe paths before reading settings", (t) => {
  const temporary = realpathSync(
    mkdtempSync(join(tmpdir(), "legend-env-guard-")),
  );
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const current = join(temporary, "current");
  const target = join(temporary, "task");
  mkdirSync(current);
  mkdirSync(target);
  mkdirSync(join(target, "nested"));
  mkdirSync(join(target, "line\nbreak"));
  writeFileSync(join(target, ".gitignore"), ".env*\n");
  for (const file of [
    ".env.dummy",
    "nested/.env.dummy",
    "line\nbreak/.env.dummy",
  ])
    writeFileSync(join(target, file), "DUMMY_ENV=synthetic-only\n");
  const initialized = spawnSync("git", ["init", "--quiet"], {
    cwd: target,
    encoding: "utf8",
  });
  assert.equal(
    initialized.status,
    0,
    "The fixture owns its temporary Git repository",
  );

  for (const scenario of ["default", "truthy-string", "query-failure"]) {
    const calls = [];
    let reads = 0;
    let inventory;
    const dependencies = {
      cwd: current,
      readEnvironment() {
        reads += 1;
        throw new Error(
          "Saved environment must remain unread on a rejected removal.",
        );
      },
      exec(command, args, options) {
        calls.push({ command, args });
        if (command === "git" && args.includes("list"))
          return {
            status: 0,
            stdout: `worktree ${current}\0branch refs/heads/main\0\0worktree ${target}\0branch refs/heads/task\0\0`,
          };
        if (command === "git" && args.includes("status"))
          return { status: 0, stdout: "" };
        if (command === "git" && args.includes("ls-files")) {
          const result = spawnSync(
            command,
            args,
            scenario === "query-failure"
              ? {
                  ...options,
                  env: { ...options.env, GIT_DIR: join(target, "missing.git") },
                }
              : options,
          );
          inventory = result;
          return result;
        }
        throw new Error("Docker and removal must remain unreachable.");
      },
      ...(scenario === "truthy-string" ? { discardEnv: "true" } : {}),
    };
    assert.throws(
      () => removeWorktree(target, dependencies),
      scenario === "query-failure" ? /ignored|inventory/i : /--discard-env/,
    );
    if (scenario === "query-failure") assert.notEqual(inventory.status, 0);
    else {
      assert.equal(
        inventory.status,
        0,
        "The inventory runs real Git in the fixture",
      );
      for (const file of [
        ".env.dummy",
        "nested/.env.dummy",
        "line\nbreak/.env.dummy",
      ])
        assert.ok(
          inventory.stdout.includes(`${file}\0`),
          "Git preserves complete NUL-delimited paths",
        );
    }
    assert.equal(reads, 0);
    assert.equal(
      calls.some((call) => call.command === "docker"),
      false,
    );
    assert.equal(
      calls.some((call) => call.args.includes("remove")),
      false,
    );
  }
});

// Exercise the real CLI entrypoint with a spy in place of removal. The source
// contains no private configuration, and no environment file or subprocess runs.
function runCli(args) {
  const moduleUrl = new URL("../scripts/worktree-remove.mjs", import.meta.url);
  const source = readFileSync(moduleUrl, "utf8");
  const start = source.lastIndexOf("\nif (");
  assert.ok(start >= 0, "The CLI entrypoint is present");
  const cliSource = source
    .slice(start)
    .replaceAll("import.meta.url", "moduleUrl");
  const calls = [];
  const fakeProcess = {
    argv: ["node", fileURLToPath(moduleUrl), ...args],
    exitCode: undefined,
  };
  new Function(
    "process",
    "resolve",
    "fileURLToPath",
    "moduleUrl",
    "removeWorktree",
    "console",
    cliSource,
  )(
    fakeProcess,
    resolve,
    fileURLToPath,
    moduleUrl,
    (target, options) => calls.push({ target, options }),
    { log() {}, error() {} },
  );
  return { calls, process: fakeProcess };
}

test("CLI --discard-env passes explicit permission to the removal helper", () => {
  for (const args of [
    ["/repo/task", "--discard-env"],
    ["--discard-env", "/repo/task"],
  ]) {
    const result = runCli(args);
    assert.equal(result.process.exitCode, undefined);
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].target, "/repo/task");
    assert.equal(result.calls[0].options.discardEnv, true);
  }
});

test("CLI rejects unknown options or a discard flag without a target", () => {
  for (const args of [["--discard-env"], ["/repo/task", "--unknown"]]) {
    const result = runCli(args);
    assert.equal(result.process.exitCode, 1);
    assert.equal(result.calls.length, 0);
  }
});

test("Refuses locked worktrees and a linked main branch before Docker", () => {
  for (const options of [{ locked: true }, { mainBranch: true }]) {
    const { calls, dependencies } = fixture(options);
    assert.throws(() => removeWorktree("/repo/task", dependencies));
    assert.equal(
      calls.some((call) => call.command === "docker"),
      false,
    );
  }
});

test("Refuses a saved Compose project shared with another registered worktree", () => {
  const { calls, dependencies } = fixture({ shared: true });
  assert.throws(() => removeWorktree("/repo/task", dependencies), /shared/i);
  assert.equal(
    calls.some((call) => call.command === "docker"),
    false,
  );
});

test("Refuses containers whose project belongs to another directory", () => {
  for (const owner of ["/repo/other", ""]) {
    const { calls, dependencies } = fixture({ owner });
    assert.throws(
      () => removeWorktree("/repo/task", dependencies),
      /another directory/i,
    );
    assert.equal(
      calls.some((call) => call.args.includes("down")),
      false,
    );
  }
});

test("Aborts worktree removal when Compose cleanup fails without exposing its output", () => {
  const { calls, dependencies } = fixture({ downFails: true });
  assert.throws(
    () => removeWorktree("/repo/task", dependencies),
    (error) => {
      assert.match(error.message, /cleanup failed/i);
      assert.doesNotMatch(error.message, /private failure/);
      return true;
    },
  );
  assert.equal(
    calls.some((call) => call.args.includes("remove")),
    false,
  );
});

test("Removes a worktree without managed Compose settings without calling Docker", () => {
  const { calls, dependencies } = fixture();
  dependencies.readEnvironment = () => ({});
  removeWorktree("/repo/task", dependencies);
  assert.equal(
    calls.some((call) => call.command === "docker"),
    false,
  );
  assert.ok(calls.some((call) => call.args.includes("remove")));
});

test("Stops the former local project after switching DATABASE_URL to an external database", () => {
  const { calls, dependencies } = fixture();
  const read = dependencies.readEnvironment;
  dependencies.readEnvironment = (path) => ({
    ...read(path),
    DATABASE_URL: "postgresql://remote:example@outside.invalid/database",
  });
  removeWorktree("/repo/task", dependencies);
  const down = calls.findIndex((call) => call.args.includes("down"));
  const remove = calls.findIndex((call) => call.args.includes("remove"));
  assert.ok(down >= 0 && remove > down);
  assert.ok(calls[down].args.includes("ngodingpakeai-pg-task"));
  assert.ok(calls.every((call) => ["git", "docker"].includes(call.command)));
});

test("Skips Docker for an external database without a saved local project identity", () => {
  const { calls, dependencies } = fixture();
  dependencies.readEnvironment = () => ({
    DATABASE_URL: "postgresql://remote:example@outside.invalid/database",
  });
  removeWorktree("/repo/task", dependencies);
  assert.equal(
    calls.some((call) => call.command === "docker"),
    false,
  );
  assert.ok(calls.some((call) => call.args.includes("remove")));
});

test("Refuses incomplete or invalid saved local identity before Docker or removal", () => {
  for (const mismatch of [
    { POSTGRES_PASSWORD: "" },
    { COMPOSE_PROJECT_NAME: "" },
    { COMPOSE_PROJECT_NAME: "invalid/project" },
    { POSTGRES_PORT: "not-a-port" },
    { POSTGRES_PORT: "65536" },
  ]) {
    const { calls, dependencies } = fixture();
    const read = dependencies.readEnvironment;
    dependencies.readEnvironment = (path) =>
      path === "/repo/task" ? { ...read(path), ...mismatch } : read(path);
    assert.throws(
      () => removeWorktree("/repo/task", dependencies),
      /saved local/i,
    );
    assert.equal(
      calls.some((call) => call.command === "docker"),
      false,
    );
    assert.equal(
      calls.some((call) => call.args.includes("remove")),
      false,
    );
  }
});
