import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { root } from "./lib.mjs";

// Keep each worktree's private settings isolated from the invoking process.
function readEnvironment(directory) {
  const saved = {};
  for (const name of [".env", ".env.local"]) {
    try {
      Object.assign(
        saved,
        parseEnv(readFileSync(resolve(directory, name), "utf8")),
      );
    } catch (error) {
      if (error.code !== "ENOENT")
        throw new Error("Could not read a worktree's saved environment.");
    }
  }
  return saved;
}

export function removeWorktree(
  targetPath,
  {
    cwd = root,
    exec = spawnSync,
    readEnvironment: readSaved = readEnvironment,
    realpath = realpathSync,
    discardEnv = false,
  } = {},
) {
  if (!targetPath) throw new Error("Use pnpm worktree:remove <worktree-path>.");
  const target = realpath(resolve(cwd, targetPath));
  const current = realpath(cwd);
  const run = (command, args, directory = cwd, env = process.env) =>
    exec(command, args, {
      cwd: directory,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  const listed = run("git", ["worktree", "list", "--porcelain", "-z"]);
  if (listed.error || listed.status !== 0)
    throw new Error("Could not list this repository's worktrees.");
  const worktrees = listed.stdout
    .split("\0\0")
    .filter(Boolean)
    .map((record) => {
      const fields = record.split("\0");
      return {
        path: fields.find((field) => field.startsWith("worktree "))?.slice(9),
        branch: fields.find((field) => field.startsWith("branch "))?.slice(7),
        locked: fields.some((field) => /^locked(?: |$)/.test(field)),
      };
    });
  const selected = worktrees.find((worktree) => worktree.path === target);
  if (!selected)
    throw new Error("Target must be a registered worktree of this repository.");
  if (
    target === current ||
    selected === worktrees[0] ||
    /^refs\/heads\/(main|master)$/.test(selected.branch ?? "")
  )
    throw new Error("Cannot remove the current or primary/main worktree.");
  if (selected.locked) throw new Error("Cannot remove a locked worktree.");
  const status = run(
    "git",
    ["status", "--porcelain", "--untracked-files=normal"],
    target,
  );
  if (status.error || status.status !== 0)
    throw new Error("Could not check the target worktree's status.");
  if (status.stdout.trim())
    throw new Error("Target worktree is dirty; preserve its changes first.");

  // Git's clean status omits ignored settings, which removal would discard.
  // Inventory names only, before reading private settings or stopping services.
  const ignored = run(
    "git",
    [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "-z",
      "--",
      ":(glob)**/.env*",
    ],
    target,
  );
  if (ignored.error || ignored.status !== 0)
    throw new Error(
      "Could not inventory ignored environment files; the worktree was kept.",
    );
  if (
    ignored.stdout
      .split("\0")
      .some((file) => posix.basename(file).startsWith(".env")) &&
    discardEnv !== true
  )
    throw new Error(
      "Target has ignored environment files. Preserve them first or explicitly pass --discard-env.",
    );

  const saved = readSaved(target);
  // DATABASE_URL may now point to an external server while the earlier local
  // container still runs. Clean up its saved identity without connecting to DBs.
  const localKeys = [
    "COMPOSE_PROJECT_NAME",
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
    "POSTGRES_DB",
    "POSTGRES_PORT",
  ];
  if (localKeys.some((key) => Object.hasOwn(saved, key))) {
    const project = saved.COMPOSE_PROJECT_NAME;
    if (
      localKeys.some((key) => typeof saved[key] !== "string" || !saved[key]) ||
      !/^[a-z0-9][a-z0-9_-]*$/.test(project) ||
      !/^[1-9]\d{0,4}$/.test(saved.POSTGRES_PORT) ||
      Number(saved.POSTGRES_PORT) > 65535
    )
      throw new Error(
        "Target has incomplete or invalid saved local database settings.",
      );
    for (const worktree of worktrees) {
      if (worktree === selected) continue;
      if (readSaved(worktree.path).COMPOSE_PROJECT_NAME === project)
        throw new Error(
          "Target Compose project is shared with another worktree.",
        );
    }
    // A matching project label alone is insufficient: do not stop a database
    // belonging to another checkout, including one outside this git repository.
    const owners = run("docker", [
      "ps",
      "--all",
      "--filter",
      `label=com.docker.compose.project=${project}`,
      "--format",
      '{{.ID}}\t{{.Label "com.docker.compose.project.working_dir"}}',
    ]);
    if (owners.error || owners.status !== 0)
      throw new Error("Could not verify the target Compose project's owner.");
    for (const record of owners.stdout.trim().split("\n").filter(Boolean)) {
      const owner = record.slice(record.indexOf("\t") + 1);
      if (!record.includes("\t") || !owner || realpath(owner) !== target)
        throw new Error("Target Compose project belongs to another directory.");
    }
    const composeEnv = { ...process.env };
    for (const key of Object.keys(composeEnv))
      if (key.startsWith("COMPOSE_")) delete composeEnv[key];
    Object.assign(composeEnv, saved);
    const down = run(
      "docker",
      ["compose", "--project-name", project, "-f", "compose.dev.yaml", "down"],
      target,
      composeEnv,
    );
    if (down.error || down.status !== 0)
      throw new Error(
        "Compose cleanup failed; the worktree was kept. Retry after checking Docker.",
      );
  }
  const removed = run("git", ["worktree", "remove", target]);
  if (removed.error || removed.status !== 0)
    throw new Error(
      "Git could not remove the worktree. It was not force-removed.",
    );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const args = process.argv.slice(2);
    const flags = args.filter((argument) => argument === "--discard-env");
    const targets = args.filter((argument) => !argument.startsWith("-"));
    if (
      flags.length > 1 ||
      targets.length !== 1 ||
      args.some(
        (argument) => argument.startsWith("-") && argument !== "--discard-env",
      )
    )
      throw new Error(
        "Use pnpm worktree:remove <worktree-path> [--discard-env].",
      );
    removeWorktree(targets[0], { discardEnv: flags.length === 1 });
    console.log(
      "Removed the worktree. Its persistent database volume was kept.",
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
