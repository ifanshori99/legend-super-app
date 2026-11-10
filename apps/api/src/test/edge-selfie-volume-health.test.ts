// legend-svy91: GET /api/edge/health shows an informational `selfieVolume`
// check of EDGE_SELFIE_DIR: it exists, is writable, is private (0700 dir, no
// group/other bits on tenant dirs and .lss files) and has room for the byte
// budget. It never changes the health status or HTTP code and carries no
// paths, ids or personal data. Real temp dirs with chmod.
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkSelfieVolume,
  getSelfieVolumeHealth,
  resetSelfieVolumeHealthCache,
} from "../edge/selfie-volume-health";
import { edgeRouter } from "../routes/edge.routes";

// The health route reads EDGE_SELFIE_DIR from the validated env: point it at a
// directory that does not exist.
vi.hoisted(() => {
  process.env.EDGE_SELFIE_DIR = "/nonexistent-svy91/edge-selfies";
});

vi.mock("../db/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db/index.ts")>()),
  checkDatabase: async () => undefined,
}));
vi.mock("../edge/runtime.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../edge/runtime.ts")>()),
  getEdgeRuntimeState: () => ({
    edgeMode: true,
    identity: {},
    link: { cloudLink: "connected" },
  }),
  getDeviceRegistrySyncState: () => null,
}));

const TENANT = "11111111-1111-4111-8111-111111111111";
const OBJECT = "22222222-2222-4222-8222-222222222222";
const MAX = 2_147_483_648;
const isRoot = process.getuid?.() === 0;

let root: string;
let dir: string;

beforeEach(() => {
  resetSelfieVolumeHealthCache();
  root = mkdtempSync(join(tmpdir(), "svy91-"));
  dir = join(root, "edge-selfies");
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o700);
});

afterEach(() => {
  chmodSync(dir, 0o700);
  rmSync(root, { recursive: true, force: true });
});

function addSelfie(bytes: number, mode = 0o600, tenantMode = 0o700) {
  const tenantDir = join(dir, TENANT);
  mkdirSync(tenantDir, { recursive: true });
  chmodSync(tenantDir, tenantMode);
  const file = join(tenantDir, `${OBJECT}.lss`);
  writeFileSync(file, Buffer.alloc(bytes), { mode });
  chmodSync(file, mode);
}

describe("checkSelfieVolume", () => {
  it("is ok for a private, writable directory and reports free and used bytes", async () => {
    addSelfie(1000);
    const health = await checkSelfieVolume({ dir, maxBytes: MAX });
    expect(health.dir).toBe("ok");
    expect(health.usedBytes).toBe(1000);
    expect(health.maxBytes).toBe(MAX);
    expect(health.freeBytes).toBeGreaterThan(0);
    expect(typeof health.spaceShort).toBe("boolean");
  });

  it("is ok for an empty directory", async () => {
    const health = await checkSelfieVolume({ dir, maxBytes: MAX });
    expect(health.dir).toBe("ok");
    expect(health.usedBytes).toBe(0);
  });

  it("says missing when the directory does not exist", async () => {
    const health = await checkSelfieVolume({
      dir: join(root, "nope"),
      maxBytes: MAX,
    });
    expect(health.dir).toBe("missing");
    expect(health.freeBytes).toBeNull();
    expect(health.usedBytes).toBeNull();
  });

  it("says missing when the path is a file, not a directory", async () => {
    const file = join(root, "a-file");
    writeFileSync(file, "x");
    expect((await checkSelfieVolume({ dir: file, maxBytes: MAX })).dir).toBe(
      "missing",
    );
  });

  it.skipIf(isRoot)("says not_writable for a read-only directory", async () => {
    chmodSync(dir, 0o500);
    expect((await checkSelfieVolume({ dir, maxBytes: MAX })).dir).toBe(
      "not_writable",
    );
  });

  it.each([0o750, 0o770, 0o755, 0o707])(
    "says loose_permissions for a directory with mode %o",
    async (mode) => {
      chmodSync(dir, mode);
      expect((await checkSelfieVolume({ dir, maxBytes: MAX })).dir).toBe(
        "loose_permissions",
      );
    },
  );

  it("says loose_permissions for a tenant directory open to the group", async () => {
    addSelfie(10, 0o600, 0o750);
    expect((await checkSelfieVolume({ dir, maxBytes: MAX })).dir).toBe(
      "loose_permissions",
    );
  });

  it.each([0o640, 0o644, 0o604])(
    "says loose_permissions for a .lss file with mode %o",
    async (mode) => {
      addSelfie(10, mode);
      expect((await checkSelfieVolume({ dir, maxBytes: MAX })).dir).toBe(
        "loose_permissions",
      );
    },
  );

  it("flags spaceShort when the free space cannot hold the byte budget", async () => {
    const health = await checkSelfieVolume({
      dir,
      maxBytes: Number.MAX_SAFE_INTEGER,
    });
    expect(health.spaceShort).toBe(true);
  });

  it("holds only the dir state and byte counts: no paths, ids or names", async () => {
    addSelfie(10);
    const health = await checkSelfieVolume({ dir, maxBytes: MAX });
    expect(Object.keys(health).sort()).toEqual([
      "dir",
      "freeBytes",
      "maxBytes",
      "spaceShort",
      "usedBytes",
    ]);
    const text = JSON.stringify(health);
    expect(text).not.toContain(root);
    expect(text).not.toContain(TENANT);
    expect(text).not.toContain(OBJECT);
  });
});

describe("getSelfieVolumeHealth cache", () => {
  it("reuses the result for 30 seconds, then looks at the disk again", async () => {
    const t0 = 1_000_000;
    const first = await getSelfieVolumeHealth({ dir, maxBytes: MAX }, t0);
    expect(first.usedBytes).toBe(0);
    addSelfie(500);
    const cached = await getSelfieVolumeHealth(
      { dir, maxBytes: MAX },
      t0 + 29_000,
    );
    expect(cached.usedBytes).toBe(0);
    const fresh = await getSelfieVolumeHealth(
      { dir, maxBytes: MAX },
      t0 + 30_001,
    );
    expect(fresh.usedBytes).toBe(500);
  });

  it("does not reuse a result for another directory", async () => {
    const t0 = 1_000_000;
    await getSelfieVolumeHealth({ dir, maxBytes: MAX }, t0);
    const other = await getSelfieVolumeHealth(
      { dir: join(root, "nope"), maxBytes: MAX },
      t0 + 1,
    );
    expect(other.dir).toBe("missing");
  });
});

describe("GET /api/edge/health selfieVolume field", () => {
  const app = express().use("/api/edge", edgeRouter);

  it("is informational: a missing volume never changes status or HTTP code", async () => {
    const res = await request(app).get("/api/edge/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.selfieVolume.dir).toBe("missing");
    expect(res.body.selfie).toBeDefined();
  });

  it("carries no filesystem path", async () => {
    const res = await request(app).get("/api/edge/health");
    expect(JSON.stringify(res.body.selfieVolume)).not.toContain("/");
  });
});
