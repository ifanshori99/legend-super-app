import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Removes disposable test PostgreSQL containers and networks left behind by
// `pnpm test` runs that were killed without a chance to clean up (SIGKILL,
// crash, closed terminal). legend-yw90.
//
// Every run labels its containers and its network with its owner:
// `legend.test.owner=<pid>.<process start>` (see compose.test.yaml). A project
// is swept only when that owner process is gone, so a run that is still alive
// (this agent's or another agent's) is never touched. Resources without the
// label (made by an older scripts/test.mjs) are never swept automatically; see
// --legacy-older-than-min for the manual option.

export const PROJECT_PREFIX = "starter-pg-test-";
export const OWNER_LABEL = "legend.test.owner";

// Process start time as ps prints it, with whitespace collapsed to "_". Used to
// tell the owner from an unrelated process that reuses its PID.
export function processStartToken(pid, exec = defaultExec) {
  if (process.platform === "win32") return "";
  const result = exec("ps", ["-o", "lstart=", "-p", String(pid)], {
    LC_ALL: "C",
  });
  if (result.status !== 0) return "";
  return result.stdout.trim().replace(/\s+/g, "_");
}

export function ownerLabelValue(pid = process.pid, exec = defaultExec) {
  const token = processStartToken(pid, exec);
  return token ? `${pid}.${token}` : String(pid);
}

export function parseOwner(label) {
  const match = /^(\d+)(?:\.(.+))?$/.exec(label ?? "");
  if (!match) return null;
  return { pid: Number(match[1]), token: match[2] ?? "" };
}

// True unless the owner is certainly gone: when in doubt a run counts as alive.
export function ownerIsAlive(label, deps = {}) {
  const owner = parseOwner(label);
  if (!owner) return true;
  const kill = deps.kill ?? process.kill.bind(process);
  try {
    kill(owner.pid, 0);
  } catch (error) {
    return error?.code !== "ESRCH";
  }
  if (!owner.token) return true;
  const current = processStartToken(owner.pid, deps.exec ?? defaultExec);
  // A different start time means the PID now belongs to some other process.
  return current === "" || current === owner.token;
}

function defaultExec(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
    timeout: 60000,
  });
  return {
    status: result.error ? 1 : result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function rows(output) {
  return output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => line.split("\t"));
}

function listResources(exec) {
  const owner = `{{.Label "${OWNER_LABEL}"}}`;
  const containers = exec("docker", [
    "ps",
    "-a",
    "--filter",
    `name=${PROJECT_PREFIX}`,
    "--format",
    `{{.ID}}\t{{.Names}}\t${owner}\t{{.CreatedAt}}`,
  ]);
  if (containers.status !== 0) return null;
  const networks = exec("docker", [
    "network",
    "ls",
    "--filter",
    `name=${PROJECT_PREFIX}`,
    "--format",
    `{{.ID}}\t{{.Name}}\t${owner}\t{{.CreatedAt}}`,
  ]);
  if (networks.status !== 0) return null;
  const toItem = ([id, name, label, createdAt]) => ({
    id,
    name,
    label: label ?? "",
    createdAt: createdAt ?? "",
  });
  return {
    containers: rows(containers.stdout)
      .map(toItem)
      .filter((item) => item.name.startsWith(PROJECT_PREFIX)),
    networks: rows(networks.stdout)
      .map(toItem)
      .filter((item) => item.name.startsWith(PROJECT_PREFIX)),
  };
}

function ageMinutes(createdAt, now) {
  // docker prints "2026-11-09 10:00:00 +0700 WIB" for both containers and
  // networks (networks: ISO-like with a "T" in some versions).
  const parsed = Date.parse(
    createdAt.replace(/ [A-Z]{2,5}$/, "").replace(/^(\S+) (\S+) /, "$1T$2"),
  );
  return Number.isNaN(parsed) ? 0 : (now - parsed) / 60000;
}

// Returns { removed: string[], kept: string[], skippedUnlabeled: string[],
// error?: string }. Never throws: a sweep problem must not block a test run.
export function sweepStaleTestResources(options = {}) {
  const exec = options.exec ?? defaultExec;
  const now = options.now ?? Date.now();
  const log = options.log ?? (() => {});
  const result = { removed: [], kept: [], skippedUnlabeled: [] };
  const listed = listResources(exec);
  if (!listed) return { ...result, error: "docker is not reachable" };
  const alive = (label) => ownerIsAlive(label, options);
  const stale = (item) => {
    if (item.label) return !alive(item.label);
    if (options.legacyOlderThanMin === undefined) {
      result.skippedUnlabeled.push(item.name);
      return false;
    }
    return ageMinutes(item.createdAt, now) >= options.legacyOlderThanMin;
  };
  const remove = (kind, item) => {
    const args =
      kind === "container"
        ? ["rm", "-f", "--volumes", item.id]
        : ["network", "rm", item.id];
    if (options.dryRun) {
      result.removed.push(`${kind} ${item.name} (dry run)`);
      return;
    }
    const outcome = exec("docker", args);
    // Another sweeper may have won the race; that also counts as gone.
    if (outcome.status === 0 || /No such/i.test(outcome.stderr))
      result.removed.push(`${kind} ${item.name}`);
    else log(`Could not remove ${kind} ${item.name}: ${outcome.stderr.trim()}`);
  };
  for (const item of listed.containers)
    if (stale(item)) remove("container", item);
    else if (item.label) result.kept.push(item.name);
  // Networks go after containers, which hold them while they exist.
  for (const item of listed.networks)
    if (stale(item)) remove("network", item);
    else if (item.label) result.kept.push(item.name);
  return result;
}

// Last resort when `docker compose down` fails: force-remove this run's
// resources by project name.
export function removeProject(project, exec = defaultExec) {
  const containers = exec("docker", [
    "ps",
    "-aq",
    "--filter",
    `label=com.docker.compose.project=${project}`,
  ]);
  const ids = containers.stdout.split("\n").filter(Boolean);
  let ok = containers.status === 0;
  if (ids.length > 0)
    ok = exec("docker", ["rm", "-f", "--volumes", ...ids]).status === 0 && ok;
  const network = exec("docker", ["network", "rm", `${project}_default`]);
  if (network.status !== 0 && !/No such|not found/i.test(network.stderr))
    ok = false;
  return ok;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const legacy = args.find((arg) => arg.startsWith("--legacy-older-than-min="));
  const outcome = sweepStaleTestResources({
    dryRun: args.includes("--dry-run"),
    legacyOlderThanMin: legacy ? Number(legacy.split("=")[1]) : undefined,
    log: console.error,
  });
  if (outcome.error) {
    console.error(`Sweep skipped: ${outcome.error}.`);
    process.exitCode = 1;
  } else {
    for (const line of outcome.removed) console.log(`removed ${line}`);
    for (const name of outcome.kept) console.log(`kept (owner alive) ${name}`);
    for (const name of outcome.skippedUnlabeled)
      console.log(`skipped (no owner label, older script) ${name}`);
  }
}
