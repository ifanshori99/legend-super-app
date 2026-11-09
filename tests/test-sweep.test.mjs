import test from "node:test";
import assert from "node:assert/strict";
import {
  START_TOLERANCE_SEC,
  currentNamespace,
  ownerIsAlive,
  ownerLabelValue,
  parseOwner,
  processStartToken,
  removeProject,
  sweepStaleTestResources,
} from "../scripts/test-sweep.mjs";

// legend-yw90: the sweep must remove only runs whose owner process is gone.

const NOW = Date.parse("2026-11-09T10:00:00Z");
const LSTART = "Mon Nov  9 09:00:00 2026";
const START_EPOCH = Math.round(Date.parse(LSTART) / 1000);

function fakeDocker({ containers = [], networks = [], failRm = false } = {}) {
  const calls = [];
  const exec = (command, args) => {
    calls.push([command, ...args]);
    if (command === "ps")
      return { status: 0, stdout: `${LSTART}\n`, stderr: "" };
    const line = (r) => `${r.id}\t${r.name}\t${r.label}\t${r.createdAt ?? ""}`;
    if (args[0] === "ps")
      return { status: 0, stdout: containers.map(line).join("\n"), stderr: "" };
    if (args[0] === "network" && args[1] === "ls")
      return { status: 0, stdout: networks.map(line).join("\n"), stderr: "" };
    if (failRm) return { status: 1, stdout: "", stderr: "permission denied" };
    return { status: 0, stdout: "", stderr: "" };
  };
  return { exec, calls };
}

const alivePids = new Set([100]);
const kill = (pid) => {
  if (!alivePids.has(pid))
    throw Object.assign(new Error("gone"), { code: "ESRCH" });
};
// A macOS-like host called "h": ps-based start tokens, no PID namespace.
const host = { platform: "darwin", hostname: () => "h", kill };
const psAt = (epoch) => (command) =>
  command === "ps"
    ? {
        status: 0,
        stdout: `${new Date(epoch * 1000).toString()}\n`,
        stderr: "",
      }
    : { status: 1, stdout: "", stderr: "" };

test("parseOwner reads pid, start token and namespace", () => {
  assert.deepEqual(parseOwner("123.p456.h-pid__4026"), {
    pid: 123,
    token: "p456",
    namespace: "h-pid__4026",
  });
  assert.deepEqual(parseOwner("123.t789.h"), {
    pid: 123,
    token: "t789",
    namespace: "h",
  });
  assert.deepEqual(parseOwner("123.x.h"), {
    pid: 123,
    token: "",
    namespace: "h",
  });
  // Earlier formats carry no namespace, or none we can parse.
  assert.equal(parseOwner("123.p456")?.namespace, "");
  assert.equal(parseOwner("123")?.namespace ?? "", "");
  assert.equal(parseOwner("123.Mon_Nov__9"), null);
  assert.equal(parseOwner(""), null);
  assert.equal(parseOwner("abc"), null);
});

test("ownerLabelValue round-trips this process", () => {
  const owner = parseOwner(ownerLabelValue());
  assert.equal(owner?.pid, process.pid);
  assert.equal(owner?.namespace, currentNamespace());
  assert.equal(ownerIsAlive(ownerLabelValue()), true);
});

test("currentNamespace adds the PID namespace on Linux only", () => {
  const readLink = () => "pid:[4026531836]";
  assert.equal(
    currentNamespace({
      platform: "linux",
      hostname: () => "box.local",
      readLink,
    }),
    "box_local-pid__4026531836_",
  );
  assert.equal(
    currentNamespace({
      platform: "darwin",
      hostname: () => "box.local",
      readLink,
    }),
    "box_local",
  );
  const noProc = () => {
    throw new Error("ENOENT");
  };
  assert.equal(
    currentNamespace({
      platform: "linux",
      hostname: () => "box",
      readLink: noProc,
    }),
    "box",
  );
});

test("processStartToken reads /proc starttime on Linux, ps elsewhere", () => {
  // Field 2 holds spaces and ")" on purpose; starttime is field 22.
  const stat =
    "42 (a (b) c) S 1 42 42 0 -1 4194560 100 0 0 0 1 1 0 0 20 0 1 0 987654 1000 100 18446744073709551615";
  assert.equal(
    processStartToken(42, { platform: "linux", readFile: () => stat }),
    "p987654",
  );
  // /proc unreadable: falls back to ps.
  const noProc = () => {
    throw new Error("ENOENT");
  };
  assert.equal(
    processStartToken(42, {
      platform: "linux",
      readFile: noProc,
      exec: psAt(START_EPOCH),
    }),
    `t${START_EPOCH}`,
  );
  assert.equal(
    processStartToken(42, { platform: "darwin", exec: psAt(START_EPOCH) }),
    `t${START_EPOCH}`,
  );
  assert.equal(processStartToken(42, { platform: "win32" }), "");
  assert.equal(
    processStartToken(42, {
      platform: "darwin",
      exec: () => ({ status: 1, stdout: "", stderr: "" }),
    }),
    "",
  );
});

test("ownerIsAlive: dead pid is dead, live pid is alive", () => {
  assert.equal(ownerIsAlive("999.x.h", host), false);
  assert.equal(ownerIsAlive("100.x.h", host), true);
  // No permission to signal means the process exists.
  const eperm = () => {
    throw Object.assign(new Error("no"), { code: "EPERM" });
  };
  assert.equal(ownerIsAlive("100.x.h", { ...host, kill: eperm }), true);
  // Unparseable label: keep it.
  assert.equal(ownerIsAlive("garbage", host), true);
});

// Review point 1: a clock step must not make a live run look dead.
test("ownerIsAlive tolerates wall-clock drift but not a reused PID (ps tokens)", () => {
  const label = (epoch) => `100.t${epoch}.h`;
  const at = (epoch) => ({ ...host, exec: psAt(epoch) });
  assert.equal(ownerIsAlive(label(START_EPOCH), at(START_EPOCH)), true);
  // NTP/suspend moved the reported start by a few seconds.
  assert.equal(
    ownerIsAlive(label(START_EPOCH), at(START_EPOCH + START_TOLERANCE_SEC)),
    true,
  );
  assert.equal(
    ownerIsAlive(label(START_EPOCH), at(START_EPOCH - START_TOLERANCE_SEC)),
    true,
  );
  // Beyond tolerance: a different process owns the PID now.
  assert.equal(
    ownerIsAlive(label(START_EPOCH), at(START_EPOCH + START_TOLERANCE_SEC + 1)),
    false,
  );
  assert.equal(ownerIsAlive(label(START_EPOCH), at(START_EPOCH + 3600)), false);
  // ps unavailable: assume alive.
  const noPs = { ...host, exec: () => ({ status: 1, stdout: "", stderr: "" }) };
  assert.equal(ownerIsAlive(label(START_EPOCH), noPs), true);
});

test("ownerIsAlive compares Linux /proc starttime exactly", () => {
  const stat = (ticks) =>
    `100 (node) S 1 100 100 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${ticks} 1 1 1`;
  const linux = (ticks) => ({
    platform: "linux",
    hostname: () => "h",
    readLink: () => "pid:[1]",
    readFile: () => stat(ticks),
    kill,
  });
  const ns = currentNamespace(linux(500));
  assert.equal(ownerIsAlive(`100.p500.${ns}`, linux(500)), true);
  assert.equal(ownerIsAlive(`100.p500.${ns}`, linux(501)), false);
});

// Review point 2: PIDs from another PID namespace or host are not ours to judge.
test("ownerIsAlive never judges a label from another namespace", () => {
  assert.equal(ownerIsAlive("999.x.devcontainer-pid__4026", host), true);
  assert.equal(ownerIsAlive("999.p1.other_host", host), true);
  // A label without namespace (earlier format) is foreign too.
  assert.equal(ownerIsAlive("999.p1", host), true);
  // Same host name but a different PID namespace on Linux.
  const linux = (inode) => ({
    platform: "linux",
    hostname: () => "h",
    readLink: () => `pid:[${inode}]`,
    kill,
  });
  const label = ownerLabelValue(999, { ...linux(1), readFile: () => "" });
  assert.equal(ownerIsAlive(label, linux(1)), false);
  assert.equal(ownerIsAlive(label, linux(2)), true);
});

test("sweep removes dead-owner resources and keeps live, foreign and unlabeled ones", () => {
  const docker = fakeDocker({
    containers: [
      { id: "c1", name: "starter-pg-test-aaaa-postgres-1", label: "999.x.h" },
      { id: "c2", name: "starter-pg-test-bbbb-postgres-1", label: "100.x.h" },
      { id: "c3", name: "starter-pg-test-cccc-postgres-1", label: "" },
      { id: "c4", name: "unrelated-postgres-1", label: "999.x.h" },
      {
        id: "c5",
        name: "starter-pg-test-dddd-postgres-1",
        label: "999.x.elsewhere",
      },
    ],
    networks: [
      { id: "n1", name: "starter-pg-test-aaaa_default", label: "999.x.h" },
      { id: "n2", name: "starter-pg-test-bbbb_default", label: "100.x.h" },
      { id: "n3", name: "starter-pg-test-cccc_default", label: "" },
    ],
  });
  const result = sweepStaleTestResources({
    ...host,
    exec: docker.exec,
    now: NOW,
  });
  assert.deepEqual(result.removed, [
    "container starter-pg-test-aaaa-postgres-1",
    "network starter-pg-test-aaaa_default",
  ]);
  assert.deepEqual(result.kept, [
    "starter-pg-test-bbbb-postgres-1",
    "starter-pg-test-dddd-postgres-1",
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
      { id: "c1", name: "starter-pg-test-aaaa-postgres-1", label: "999.x.h" },
    ],
  });
  const result = sweepStaleTestResources({
    ...host,
    exec: docker.exec,
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
    ...host,
    exec: docker.exec,
    now: NOW,
    legacyOlderThanMin: 120,
  });
  assert.deepEqual(result.removed, [
    "container starter-pg-test-old-postgres-1",
  ]);
});

// Review point 3: 0, empty, NaN, negative would match every unlabeled resource.
test("legacy age below 1 minute or not a number is refused before touching docker", () => {
  for (const bad of [
    0,
    0.5,
    -5,
    NaN,
    Number(""),
    Number(undefined),
    Infinity,
  ]) {
    const docker = fakeDocker({
      containers: [
        {
          id: "c1",
          name: "starter-pg-test-live-postgres-1",
          label: "",
          createdAt: "2026-11-09 09:59:00 +0000 UTC",
        },
      ],
    });
    const result = sweepStaleTestResources({
      ...host,
      exec: docker.exec,
      now: NOW,
      legacyOlderThanMin: bad,
    });
    assert.match(result.error ?? "", /minutes >= 1/, `value ${bad}`);
    assert.deepEqual(result.removed, []);
    assert.equal(docker.calls.length, 0, `value ${bad} reached docker`);
  }
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
      { id: "c1", name: "starter-pg-test-aaaa-postgres-1", label: "999.x.h" },
    ],
    failRm: true,
  });
  const result = sweepStaleTestResources({
    ...host,
    exec: docker.exec,
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
