import { spawnSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";

// Removes disposable test PostgreSQL containers and networks left behind by
// `pnpm test` runs that were killed without a chance to clean up (SIGKILL,
// crash, closed terminal). legend-yw90.
//
// Every run labels its containers and its network with its owner:
// `legend.test.owner=<pid>.<start>.<namespace>` (see compose.test.yaml). A project
// is swept only when that owner process is gone, so a run that is still alive
// (this agent's or another agent's) is never touched. Resources without the
// label (made by an older scripts/test.mjs) are never swept automatically; see
// --legacy-older-than-min for the manual option.

export const PROJECT_PREFIX = "starter-pg-test-";
export const OWNER_LABEL = "legend.test.owner";

// Tolerance for ps `lstart` (1 s resolution, derived from the wall clock): NTP
// steps or a suspend can move it. A real PID reuse starts far later than this.
export const START_TOLERANCE_SEC = 5;

function sanitize(text) {
  return String(text).replace(/[^A-Za-z0-9_-]/g, "_");
}

// Where this process runs: hostname plus PID namespace id on Linux. A PID from
// another namespace (devcontainer, other host sharing one Docker daemon) means
// nothing here, so such labels are never swept.
export function currentNamespace(deps = {}) {
  const readLink = deps.readLink ?? ((path) => readlinkSync(path));
  const host = (deps.hostname ?? hostname)();
  let pidNs = "";
  if ((deps.platform ?? process.platform) === "linux") {
    try {
      pidNs = readLink("/proc/self/ns/pid");
    } catch {
      pidNs = "";
    }
  }
  return sanitize(pidNs ? `${host}-${pidNs}` : host);
}

// Start-time token that tells the owner from an unrelated process reusing its
// PID. Linux: `p<ticks>` from /proc/<pid>/stat field 22 (ticks since boot, not
// affected by wall-clock changes). Elsewhere: `t<epoch seconds>` from ps.
// Empty string when unknown.
export function processStartToken(pid, deps = {}) {
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") return "";
  if (platform === "linux") {
    try {
      const stat = (deps.readFile ?? ((path) => readFileSync(path, "utf8")))(
        `/proc/${pid}/stat`,
      );
      // The command name (field 2) may contain spaces and parentheses.
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      // fields[0] is field 3 (state), so starttime (field 22) is fields[19].
      if (/^\d+$/.test(fields[19] ?? "")) return `p${fields[19]}`;
    } catch {
      // Fall through to ps.
    }
  }
  const exec = deps.exec ?? defaultExec;
  const result = exec("ps", ["-o", "lstart=", "-p", String(pid)], {
    LC_ALL: "C",
  });
  if (result.status !== 0) return "";
  const started = Date.parse(result.stdout.trim());
  return Number.isNaN(started) ? "" : `t${Math.round(started / 1000)}`;
}

export function ownerLabelValue(pid = process.pid, deps = {}) {
  return `${pid}.${processStartToken(pid, deps) || "x"}.${currentNamespace(deps)}`;
}

// Label: <pid>.<token|x>.<namespace>. A label without a namespace (earlier
// format) cannot be tied to this namespace and is treated as foreign.
export function parseOwner(label) {
  const match = /^(\d+)\.([ptx][0-9]*)(?:\.([A-Za-z0-9_-]+))?$/.exec(
    label ?? "",
  );
  if (!match) return null;
  return {
    pid: Number(match[1]),
    token: match[2] === "x" ? "" : match[2],
    namespace: match[3] ?? "",
  };
}

function sameProcess(recorded, current) {
  if (!recorded || !current) return true;
  if (recorded[0] !== current[0]) return true; // different kind: cannot compare
  if (recorded[0] === "p") return recorded === current;
  return (
    Math.abs(Number(recorded.slice(1)) - Number(current.slice(1))) <=
    START_TOLERANCE_SEC
  );
}

// True unless the owner is certainly gone: when in doubt a run counts as alive.
export function ownerIsAlive(label, deps = {}) {
  const owner = parseOwner(label);
  if (!owner) return true;
  if (owner.namespace !== currentNamespace(deps)) return true;
  const kill = deps.kill ?? process.kill.bind(process);
  try {
    kill(owner.pid, 0);
  } catch (error) {
    return error?.code !== "ESRCH";
  }
  if (!owner.token) return true;
  // A different start time means the PID now belongs to some other process.
  return sameProcess(owner.token, processStartToken(owner.pid, deps));
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
  const legacy = options.legacyOlderThanMin;
  // 0, empty, NaN or negative would match every unlabeled resource, live runs
  // included.
  if (legacy !== undefined && !(Number.isFinite(legacy) && legacy >= 1))
    return { ...result, error: "legacy age must be a number of minutes >= 1" };
  const listed = listResources(exec);
  if (!listed) return { ...result, error: "docker is not reachable" };
  const alive = (label) => ownerIsAlive(label, options);
  const stale = (item) => {
    if (item.label) return !alive(item.label);
    if (legacy === undefined) {
      result.skippedUnlabeled.push(item.name);
      return false;
    }
    return ageMinutes(item.createdAt, now) >= legacy;
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
  const legacy = args.find((arg) => arg.startsWith("--legacy-older-than-min"));
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
