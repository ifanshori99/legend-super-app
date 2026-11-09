import test from "node:test";
import assert from "node:assert/strict";
import {
  ownerIsAlive,
  ownerLabelValue,
  parseOwner,
  removeProject,
  sweepStaleTestResources,
} from "../scripts/test-sweep.mjs";

// legend-yw90: the sweep must remove only runs whose owner process is gone.

const NOW = Date.parse("2026-11-09T10:00:00Z");

function fakeDocker({ containers = [], networks = [], failRm = false } = {}) {
  const calls = [];
  const exec = (command, args) => {
    calls.push([command, ...args]);
    if (command === "ps")
      return { status: 0, stdout: "Mon_Nov_9_09:00:00_2026\n", stderr: "" };
    const line = (r) => `${r.id}\t${r.name}\t${r.label}\t${r.createdAt ?? ""}`;
    if (args[0] === "ps")
      return { status: 0, stdout: containers.map(line).join("\n"), stderr: "" };
    if (args[0] === "network" && args[1] === "ls")
      return { status: 0, stdout: networks.map(line).join("\n"), stderr: "" };
    if (failRm) return { status: 1, stdout: "", stderr: "permission denied" };
    return { status: 0, stdout: "", stderr: "" };
  };
  return {
    exec,
    calls,
    removed: () => calls.filter((c) => c[1] === "rm" || c[2] === "rm"),
  };
}

const alivePids = new Set([100]);
const kill = (pid) => {
  if (!alivePids.has(pid))
    throw Object.assign(new Error("gone"), { code: "ESRCH" });
};
// Every live process "started" at the token below.
const sameStart = (command) =>
  command === "ps"
    ? { status: 0, stdout: "Mon Nov  9 09:00:00 2026\n", stderr: "" }
    : { status: 1, stdout: "", stderr: "" };

test("parseOwner reads pid and start token", () => {
  assert.deepEqual(parseOwner("123.Mon_Nov__9"), {
    pid: 123,
    token: "Mon_Nov__9",
  });
  assert.deepEqual(parseOwner("123"), { pid: 123, token: "" });
  assert.equal(parseOwner(""), null);
  assert.equal(parseOwner("abc"), null);
});

test("ownerLabelValue includes this process pid", () => {
  assert.ok(ownerLabelValue().startsWith(`${process.pid}`));
  assert.equal(parseOwner(ownerLabelValue())?.pid, process.pid);
});

test("ownerIsAlive: dead pid is dead, live pid is alive, reused pid is dead", () => {
  assert.equal(ownerIsAlive("999", { kill }), false);
  assert.equal(ownerIsAlive("100", { kill }), true);
  const exec = sameStart;
  assert.equal(
    ownerIsAlive("100.Mon_Nov_9_09:00:00_2026", { kill, exec }),
    true,
  );
  assert.equal(
    ownerIsAlive("100.Sun_Nov__1_01:00:00_2026", { kill, exec }),
    false,
  );
  // No permission to signal means the process exists.
  const eperm = () => {
    throw Object.assign(new Error("no"), { code: "EPERM" });
  };
  assert.equal(ownerIsAlive("100", { kill: eperm }), true);
  // Unparseable label: keep it.
  assert.equal(ownerIsAlive("garbage", { kill }), true);
});

test("sweep removes dead-owner resources and keeps live and unlabeled ones", () => {
  const docker = fakeDocker({
    containers: [
      { id: "c1", name: "starter-pg-test-aaaa-postgres-1", label: "999" },
      { id: "c2", name: "starter-pg-test-bbbb-postgres-1", label: "100" },
      { id: "c3", name: "starter-pg-test-cccc-postgres-1", label: "" },
      { id: "c4", name: "unrelated-postgres-1", label: "999" },
    ],
    networks: [
      { id: "n1", name: "starter-pg-test-aaaa_default", label: "999" },
      { id: "n2", name: "starter-pg-test-bbbb_default", label: "100" },
      { id: "n3", name: "starter-pg-test-cccc_default", label: "" },
    ],
  });
  const result = sweepStaleTestResources({ exec: docker.exec, kill, now: NOW });
  assert.deepEqual(result.removed, [
    "container starter-pg-test-aaaa-postgres-1",
    "network starter-pg-test-aaaa_default",
  ]);
  assert.deepEqual(result.kept, [
    "starter-pg-test-bbbb-postgres-1",
    "starter-pg-test-bbbb_default",
  ]);
  assert.deepEqual(result.skippedUnlabeled, [
    "starter-pg-test-cccc-postgres-1",
    "starter-pg-test-cccc_default",
  ]);
  const rm = docker.calls.filter(
    (c) => c[0] === "docker" && (c[1] === "rm" || c[2] === "rm"),
  );
  assert.deepEqual(
    rm.map((c) => c.at(-1)),
    ["c1", "n1"],
  );
});

test("sweep dry run removes nothing", () => {
  const docker = fakeDocker({
    containers: [
      { id: "c1", name: "starter-pg-test-aaaa-postgres-1", label: "999" },
    ],
  });
  const result = sweepStaleTestResources({
    exec: docker.exec,
    kill,
    dryRun: true,
  });
  assert.equal(result.removed.length, 1);
  assert.equal(docker.calls.filter((c) => c[1] === "rm").length, 0);
});

test("legacy unlabeled resources are swept only past the explicit age", () => {
  const old = {
    id: "c1",
    name: "starter-pg-test-old-postgres-1",
    label: "",
    createdAt: "2026-11-09 06:00:00 +0000 UTC",
  };
  const fresh = {
    id: "c2",
    name: "starter-pg-test-new-postgres-1",
    label: "",
    createdAt: "2026-11-09 09:50:00 +0000 UTC",
  };
  const docker = fakeDocker({ containers: [old, fresh] });
  const result = sweepStaleTestResources({
    exec: docker.exec,
    kill,
    now: NOW,
    legacyOlderThanMin: 120,
  });
  assert.deepEqual(result.removed, [
    "container starter-pg-test-old-postgres-1",
  ]);
});

test("sweep reports a docker failure without throwing", () => {
  const result = sweepStaleTestResources({
    exec: () => ({ status: 1, stdout: "", stderr: "daemon down" }),
  });
  assert.equal(result.error, "docker is not reachable");
});

test("a failed removal is logged, not counted as removed", () => {
  const logs = [];
  const docker = fakeDocker({
    containers: [
      { id: "c1", name: "starter-pg-test-aaaa-postgres-1", label: "999" },
    ],
    failRm: true,
  });
  const result = sweepStaleTestResources({
    exec: docker.exec,
    kill,
    log: (m) => logs.push(m),
  });
  assert.deepEqual(result.removed, []);
  assert.equal(logs.length, 1);
});

test("removeProject force-removes containers by compose project then the network", () => {
  const calls = [];
  const exec = (command, args) => {
    calls.push(args);
    return {
      status: 0,
      stdout: args[0] === "ps" ? "abc\ndef\n" : "",
      stderr: "",
    };
  };
  assert.equal(removeProject("starter-pg-test-x", exec), true);
  assert.deepEqual(calls[1], ["rm", "-f", "--volumes", "abc", "def"]);
  assert.deepEqual(calls[2], ["network", "rm", "starter-pg-test-x_default"]);
});
