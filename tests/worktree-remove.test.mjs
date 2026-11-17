import assert from "node:assert/strict";
import test from "node:test";
import { removeWorktree } from "../scripts/worktree-remove.mjs";

function fixture({
  dirty = false,
  shared = false,
  downFails = false,
  owner = "/repo/task",
  locked = false,
  mainBranch = false,
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
