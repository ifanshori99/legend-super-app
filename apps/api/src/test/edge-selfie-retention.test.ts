// Edge selfie local retention sweep (design docs/design/hris-edge-replication.md
// section 5 "Local retention", 9 T7). Real PG under RLS (`pool`) for the sweep,
// the owner pool only to seed. Sealed files are opaque bytes here: the sweep
// never reads them.
import { randomUUID, randomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  lstat,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { createUlid, uuidToUlid, ulidToUuid } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import * as schema from "../db/schema";
import { logger } from "../lib/logger";
import { edgeSealedFilePath, edgeSealedObjectKey } from "../edge/selfie-paths";
import {
  startEdgeSelfieSweep,
  sweepEdgeSelfies,
} from "../edge/selfie-retention";

const pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 1,
});
const db = drizzle(pool, { schema });
const DAY = 86_400_000;
const MAX_AGE_DAYS = 30;
const roots: string[] = [];

const context = (tenantId: string) =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** One owner-seeded tenant, outlet, employee, edge node and selfie dir. */
async function fixture() {
  const [tenantId, brandId, legalEntityId, outletId, employeeId, nodeId] = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ];
  const tag = tenantId.slice(0, 8);
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Uji Retensi Selfie', 'lengkap', 'active', 'shared', '{"modules":[],"integrationProviders":[]}', $3, $4)`,
    [
      tenantId,
      `uji-retensi-selfie-${tag}`,
      JSON.stringify({
        maxOutlets: 1,
        maxActiveEmployees: 1,
        maxDevices: 1,
        aiRequestsPerMonth: 0,
        whatsappCostCapIdr: 0,
        aiCostCapIdr: 0,
        emailCostCapIdr: 0,
      }),
      randomUUID(),
    ],
  );
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'uji', 'Uji')",
    [brandId, tenantId],
  );
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Uji', false)",
    [legalEntityId, tenantId],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours)
     VALUES ($1, $2, $3, $4, 'U-01', 'Outlet Uji', 'Jl. Uji', '{}')`,
    [outletId, tenantId, brandId, legalEntityId],
  );
  await owner.query(
    `INSERT INTO employees (id, tenant_id, employee_no, full_name, home_outlet_id,
                            employment_type, join_date, status)
     VALUES ($1, $2, $3, 'Karyawan Retensi', $4, 'pkwtt', '2025-03-01', 'active')`,
    [employeeId, tenantId, `0000RET${tag.toUpperCase()}`, outletId],
  );
  await owner.query(
    `INSERT INTO edge_nodes (id, tenant_id, outlet_id, role, label, credential_hash)
     VALUES ($1, $2, $3, 'primary', 'Mini PC uji retensi', $4)`,
    [nodeId, tenantId, outletId, randomBytes(32).toString("hex")],
  );
  const dir = await mkdtemp(path.join(tmpdir(), "edge-selfie-retention-"));
  roots.push(dir);
  return { tenantId, outletId, employeeId, nodeId, dir };
}

afterAll(async () => {
  await pool.end();
  await owner.end();
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

const ago = (days: number) => new Date(Date.now() - days * DAY);

/** A sealed file where the edge keeps it; mtime moved back `ageDays`. */
async function writeLss(fx: Fixture, objectId: string, ageDays = 0) {
  const filePath = edgeSealedFilePath(fx.dir, fx.tenantId, objectId);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, Buffer.from(`sealed-${objectId}`), { mode: 0o600 });
  if (ageDays > 0) await utimes(filePath, ago(ageDays), ago(ageDays));
  return filePath;
}

async function insertUpload(
  fx: Fixture,
  input: {
    objectId: string;
    state: string;
    ageDays: number;
    /** Days since rejected_at; omitted leaves it NULL (legacy rows). */
    rejectedAgeDays?: number;
    filePath?: string;
  },
) {
  await owner.query(
    `INSERT INTO edge_selfie_uploads
       (tenant_id, object_id, outlet_id, attendance_log_id, file_path, sealed_sha256,
        sealed_bytes, seal_kid, state, created_at, rejected_at)
     VALUES ($1, $2, $3, NULL, $4, $5, 10, 'kid-1', $6, $7, $8)`,
    [
      fx.tenantId,
      input.objectId,
      fx.outletId,
      input.filePath ?? edgeSealedFilePath(fx.dir, fx.tenantId, input.objectId),
      randomBytes(32),
      input.state,
      ago(input.ageDays),
      input.rejectedAgeDays === undefined ? null : ago(input.rejectedAgeDays),
    ],
  );
}

async function insertStorage(fx: Fixture, objectId: string, ageDays: number) {
  await owner.query(
    `INSERT INTO core_storage_objects
       (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes, created_at)
     VALUES ($1, $2, $3, 'selfie', $4, 'image/webp', 10, $5)`,
    [
      fx.tenantId,
      fx.outletId,
      objectId,
      edgeSealedObjectKey(fx.tenantId, objectId),
      ago(ageDays),
    ],
  );
}

/** Attendance log received `ageDays` ago; returns its uuid and ULID forms. */
async function insertLog(fx: Fixture, ageDays: number) {
  const id = ulidToUuid(createUlid());
  await owner.query(
    `INSERT INTO attendance_logs
       (id, tenant_id, outlet_id, employee_id, type, method, occurred_at, received_at,
        validity, flag_reasons, business_date, client_event_id, review_status)
     VALUES ($1, $2, $3, $4, 'in', 'outlet_device', $5, $5, 'valid', '[]', '2026-01-10', $6, 'none')`,
    [id, fx.tenantId, fx.outletId, fx.employeeId, ago(ageDays), createUlid()],
  );
  return { id, ulid: uuidToUlid(id) };
}

let linkSeq = 0;
let aggregateSequence = 0;
async function insertQueue(
  fx: Fixture,
  aggregateId: string,
  status: "pending" | "acked",
) {
  linkSeq += 1;
  aggregateSequence += 1;
  await owner.query(
    `INSERT INTO edge_outbound_queue
       (tenant_id, outlet_id, edge_node_id, direction, link_seq, event_id, aggregate_type,
        aggregate_id, aggregate_sequence, kind, event, status, acked_at)
     VALUES ($1, $2, $3, 'edge_to_cloud', $4, $5, 'attendance_log', $6, $7,
             'transaction_event', '{}'::jsonb, $8, $9)`,
    [
      fx.tenantId,
      fx.outletId,
      fx.nodeId,
      linkSeq,
      ulidToUuid(createUlid()),
      aggregateId,
      aggregateSequence,
      status,
      status === "acked" ? new Date() : null,
    ],
  );
}

const sweep = (fx: Fixture, extra: { orphanMs?: number } = {}) =>
  sweepEdgeSelfies({
    database: db,
    context: context(fx.tenantId),
    dir: fx.dir,
    maxAgeDays: MAX_AGE_DAYS,
    ...extra,
  });

const exists = (filePath: string) =>
  lstat(filePath).then(
    () => true,
    () => false,
  );

async function uploadState(fx: Fixture, objectId: string) {
  const { rows } = await owner.query<{ state: string }>(
    "SELECT state FROM edge_selfie_uploads WHERE tenant_id = $1 AND object_id = $2",
    [fx.tenantId, objectId],
  );
  return rows[0]?.state ?? null;
}

async function count(table: string, fx: Fixture, idColumn: string, id: string) {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1 AND ${idColumn} = $2`,
    [fx.tenantId, id],
  );
  return rows[0]?.n ?? 0;
}

describe("sweepEdgeSelfies: upload rows", () => {
  it("expires a pending row older than maxAgeDays, deletes its file and alerts with counts only", async () => {
    const fx = await fixture();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const old = randomUUID();
    const young = randomUUID();
    const oldFile = await writeLss(fx, old);
    const youngFile = await writeLss(fx, young);
    await insertUpload(fx, { objectId: old, state: "pending", ageDays: 31 });
    await insertUpload(fx, { objectId: young, state: "pending", ageDays: 29 });

    const result = await sweep(fx);

    expect(result.expiredPending).toBe(1);
    expect(await exists(oldFile)).toBe(false);
    expect(await uploadState(fx, old)).toBe("expired");
    expect(await exists(youngFile)).toBe(true);
    expect(await uploadState(fx, young)).toBe("pending");
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain("expiredPending");
    expect(logged).not.toContain(old);
    expect(logged).not.toContain(fx.tenantId);
  });

  it("deletes the file of a rejected row older than 7 days and keeps a younger one", async () => {
    const fx = await fixture();
    const old = randomUUID();
    const young = randomUUID();
    const oldFile = await writeLss(fx, old);
    const youngFile = await writeLss(fx, young);
    await insertUpload(fx, { objectId: old, state: "rejected", ageDays: 8 });
    await insertUpload(fx, { objectId: young, state: "rejected", ageDays: 3 });

    const result = await sweep(fx);

    expect(result.expiredRejected).toBe(1);
    expect(await exists(oldFile)).toBe(false);
    expect(await uploadState(fx, old)).toBe("expired");
    expect(await exists(youngFile)).toBe(true);
    expect(await uploadState(fx, young)).toBe("rejected");
  });

  it("counts the 7 days of a rejected row from rejected_at, falling back to created_at when it is NULL", async () => {
    const fx = await fixture();
    const recentlyRejected = randomUUID();
    const longRejected = randomUUID();
    const legacyOld = randomUUID();
    const legacyYoung = randomUUID();
    const recentFile = await writeLss(fx, recentlyRejected);
    const longFile = await writeLss(fx, longRejected);
    const legacyOldFile = await writeLss(fx, legacyOld);
    const legacyYoungFile = await writeLss(fx, legacyYoung);
    await insertUpload(fx, {
      objectId: recentlyRejected,
      state: "rejected",
      ageDays: 8,
      rejectedAgeDays: 2,
    });
    await insertUpload(fx, {
      objectId: longRejected,
      state: "rejected",
      ageDays: 9,
      rejectedAgeDays: 8,
    });
    await insertUpload(fx, {
      objectId: legacyOld,
      state: "rejected",
      ageDays: 8,
    });
    await insertUpload(fx, {
      objectId: legacyYoung,
      state: "rejected",
      ageDays: 3,
    });

    const result = await sweep(fx);

    expect(result.expiredRejected).toBe(2);
    expect(await exists(recentFile)).toBe(true);
    expect(await uploadState(fx, recentlyRejected)).toBe("rejected");
    expect(await exists(longFile)).toBe(false);
    expect(await uploadState(fx, longRejected)).toBe("expired");
    expect(await exists(legacyOldFile)).toBe(false);
    expect(await uploadState(fx, legacyOld)).toBe("expired");
    expect(await exists(legacyYoungFile)).toBe(true);
    expect(await uploadState(fx, legacyYoung)).toBe("rejected");
  });

  it("removes the leftover file of an uploaded or expired row and keeps the row", async () => {
    const fx = await fixture();
    const uploaded = randomUUID();
    const expired = randomUUID();
    const uploadedFile = await writeLss(fx, uploaded);
    const expiredFile = await writeLss(fx, expired);
    await insertUpload(fx, {
      objectId: uploaded,
      state: "uploaded",
      ageDays: 1,
    });
    await insertUpload(fx, { objectId: expired, state: "expired", ageDays: 1 });

    const result = await sweep(fx);

    expect(result.leftoverFiles).toBe(2);
    expect(await exists(uploadedFile)).toBe(false);
    expect(await exists(expiredFile)).toBe(false);
    expect(await uploadState(fx, uploaded)).toBe("uploaded");
    expect(await uploadState(fx, expired)).toBe("expired");
  });

  it("expires a pending row whose file is already gone without failing", async () => {
    const fx = await fixture();
    const old = randomUUID();
    await insertUpload(fx, { objectId: old, state: "pending", ageDays: 31 });

    await expect(sweep(fx)).resolves.toMatchObject({ expiredPending: 1 });
    expect(await uploadState(fx, old)).toBe("expired");
  });
});

describe("sweepEdgeSelfies: stored file path", () => {
  it("removes the file at the path stored on the row when EDGE_SELFIE_DIR has changed", async () => {
    const fx = await fixture();
    const oldDir = await mkdtemp(path.join(tmpdir(), "edge-selfie-olddir-"));
    roots.push(oldDir);
    const objectId = randomUUID();
    const oldPath = await writeLss({ ...fx, dir: oldDir }, objectId);
    await insertUpload(fx, {
      objectId,
      state: "pending",
      ageDays: 31,
      filePath: oldPath,
    });

    const result = await sweep(fx);

    expect(result.expiredPending).toBe(1);
    expect(await exists(oldPath)).toBe(false);
    expect(await uploadState(fx, objectId)).toBe("expired");
  });

  it("skips a row whose stored path is not <dir>/<tenantId>/<objectId>.lss and leaves it pending", async () => {
    const fx = await fixture();
    const elsewhere = await mkdtemp(path.join(tmpdir(), "edge-selfie-else-"));
    roots.push(elsewhere);
    const wrongName = path.join(elsewhere, fx.tenantId, `${randomUUID()}.lss`);
    const wrongTenant = path.join(elsewhere, randomUUID(), "x.lss");
    const traversal = `${elsewhere}/${fx.tenantId}/../other/x.lss`;
    for (const filePath of [wrongName, wrongTenant, traversal]) {
      const objectId = randomUUID();
      const stored = filePath.endsWith("x.lss")
        ? filePath.replace("x.lss", `${objectId}.lss`)
        : filePath;
      await mkdir(path.dirname(stored), { recursive: true });
      await writeFile(stored, "keep");
      await insertUpload(fx, {
        objectId,
        state: "pending",
        ageDays: 31,
        filePath: stored,
      });

      const result = await sweep(fx);

      expect(result.expiredPending).toBe(0);
      expect(await exists(stored)).toBe(true);
      expect(await uploadState(fx, objectId)).toBe("pending");
    }
  });
});

describe("sweepEdgeSelfies: orphans", () => {
  it("keeps an object a clock has linked even with no upload row yet (file and row)", async () => {
    const fx = await fixture();
    const objectId = randomUUID();
    const filePath = await writeLss(fx, objectId);
    await insertStorage(fx, objectId, 2);
    await owner.query(
      `UPDATE core_storage_objects SET source_kind = 'attendance', source_id = $3
       WHERE tenant_id = $1 AND id = $2`,
      [fx.tenantId, objectId, randomUUID()],
    );

    const result = await sweep(fx);

    expect(result.orphanObjects).toBe(0);
    expect(await exists(filePath)).toBe(true);
    expect(await count("core_storage_objects", fx, "id", objectId)).toBe(1);
  });

  it("keeps an object just past the 24h clock photo limit: default grace is above it", async () => {
    const fx = await fixture();
    const objectId = randomUUID();
    const filePath = await writeLss(fx, objectId);
    await insertStorage(fx, objectId, 1.02);

    const result = await sweep(fx);

    expect(result.orphanObjects).toBe(0);
    expect(await exists(filePath)).toBe(true);
    expect(await count("core_storage_objects", fx, "id", objectId)).toBe(1);
  });

  it("deletes an edge-sealed object with no upload row older than 24h (file and storage row)", async () => {
    const fx = await fixture();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const old = randomUUID();
    const young = randomUUID();
    const withClock = randomUUID();
    const oldFile = await writeLss(fx, old);
    const youngFile = await writeLss(fx, young);
    const clockFile = await writeLss(fx, withClock);
    await insertStorage(fx, old, 2);
    await insertStorage(fx, young, 0);
    await insertStorage(fx, withClock, 2);
    await insertUpload(fx, {
      objectId: withClock,
      state: "pending",
      ageDays: 2,
    });

    const result = await sweep(fx);

    expect(result.orphanObjects).toBe(1);
    expect(await exists(oldFile)).toBe(false);
    expect(await count("core_storage_objects", fx, "id", old)).toBe(0);
    expect(await exists(youngFile)).toBe(true);
    expect(await count("core_storage_objects", fx, "id", young)).toBe(1);
    expect(await exists(clockFile)).toBe(true);
    expect(await count("core_storage_objects", fx, "id", withClock)).toBe(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(old);
  });

  it("deletes stray .lss and .tmp files with no row older than 24h, nothing else", async () => {
    const fx = await fixture();
    const tenantDir = path.join(fx.dir, fx.tenantId);
    const outside = path.join(fx.dir, "outside-target.lss");
    await mkdir(tenantDir, { recursive: true });
    await writeFile(outside, "must survive");
    await utimes(outside, ago(5), ago(5));

    const strayOld = await writeLss(fx, randomUUID(), 2);
    const strayYoung = await writeLss(fx, randomUUID(), 0);
    const withRow = randomUUID();
    const withRowFile = await writeLss(fx, withRow, 2);
    await insertUpload(fx, { objectId: withRow, state: "pending", ageDays: 2 });
    const tmpOld = path.join(
      tenantDir,
      `${randomUUID()}.lss.${randomUUID()}.tmp`,
    );
    const tmpYoung = path.join(
      tenantDir,
      `${randomUUID()}.lss.${randomUUID()}.tmp`,
    );
    await writeFile(tmpOld, "x");
    await utimes(tmpOld, ago(2), ago(2));
    await writeFile(tmpYoung, "x");
    // Not ours: wrong name, a symlink named like a sealed file, a directory.
    const notes = path.join(tenantDir, "notes.txt");
    await writeFile(notes, "x");
    await utimes(notes, ago(5), ago(5));
    const link = path.join(tenantDir, `${randomUUID()}.lss`);
    await symlink(outside, link);
    const dirNamedTmp = path.join(tenantDir, "folder.tmp");
    await mkdir(dirNamedTmp);

    const result = await sweep(fx);

    expect(result.orphanFiles).toBe(2);
    expect(await exists(strayOld)).toBe(false);
    expect(await exists(tmpOld)).toBe(false);
    expect(await exists(strayYoung)).toBe(true);
    expect(await exists(tmpYoung)).toBe(true);
    expect(await exists(withRowFile)).toBe(true);
    expect(await exists(notes)).toBe(true);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await exists(outside)).toBe(true);
    expect((await lstat(dirNamedTmp)).isDirectory()).toBe(true);
  });

  it("honours a custom orphanMs", async () => {
    const fx = await fixture();
    const stray = await writeLss(fx, randomUUID(), 0);
    await utimes(
      stray,
      new Date(Date.now() - 5_000),
      new Date(Date.now() - 5_000),
    );

    await sweep(fx, { orphanMs: 60_000 });
    expect(await exists(stray)).toBe(true);
    await sweep(fx, { orphanMs: 1_000 });
    expect(await exists(stray)).toBe(false);
  });

  it("never touches another tenant's files or rows", async () => {
    const mine = await fixture();
    const theirs = await fixture();
    const theirFile = await writeLss(theirs, randomUUID(), 5);
    const theirObject = randomUUID();
    await writeLss(theirs, theirObject);
    await insertUpload(theirs, {
      objectId: theirObject,
      state: "pending",
      ageDays: 60,
    });

    await sweep(mine);

    expect(await exists(theirFile)).toBe(true);
    expect(await uploadState(theirs, theirObject)).toBe("pending");
  });
});

describe("sweepEdgeSelfies: attendance retention", () => {
  it("deletes logs older than 35 days only when every outbox event is acked", async () => {
    const fx = await fixture();
    const acked = await insertLog(fx, 40);
    const fresh = await insertLog(fx, 10);
    const pendingToo = await insertLog(fx, 40);
    const noQueue = await insertLog(fx, 40);
    const corrected = await insertLog(fx, 40);
    await insertQueue(fx, acked.ulid, "acked");
    await insertQueue(fx, fresh.ulid, "acked");
    await insertQueue(fx, pendingToo.ulid, "acked");
    await insertQueue(fx, pendingToo.ulid, "pending");
    await insertQueue(fx, corrected.ulid, "acked");
    await owner.query(
      `INSERT INTO attendance_corrections
         (tenant_id, outlet_id, employee_id, attendance_log_id, requested_type,
          requested_occurred_at, reason, requested_by, idempotency_key)
       VALUES ($1, $2, $3, $4, 'out', now(), 'lupa absen', 'user-uji', $5)`,
      [fx.tenantId, fx.outletId, fx.employeeId, corrected.id, randomUUID()],
    );

    const result = await sweep(fx);

    expect(result.logsPurged).toBe(1);
    expect(await count("attendance_logs", fx, "id", acked.id)).toBe(0);
    for (const kept of [fresh, pendingToo, noQueue, corrected])
      expect(await count("attendance_logs", fx, "id", kept.id)).toBe(1);
  });

  it("purges terminal upload rows and their edge-sealed objects older than 35 days", async () => {
    const fx = await fixture();
    const oldUploaded = randomUUID();
    const oldRejected = randomUUID();
    const youngUploaded = randomUUID();
    const oldPending = randomUUID();
    for (const id of [oldUploaded, oldRejected, youngUploaded, oldPending])
      await insertStorage(fx, id, 40);
    await insertUpload(fx, {
      objectId: oldUploaded,
      state: "uploaded",
      ageDays: 36,
    });
    await insertUpload(fx, {
      objectId: oldRejected,
      state: "expired",
      ageDays: 36,
    });
    await insertUpload(fx, {
      objectId: youngUploaded,
      state: "uploaded",
      ageDays: 20,
    });
    // Pending and still inside maxAgeDays: not terminal, so never purged.
    await insertUpload(fx, {
      objectId: oldPending,
      state: "pending",
      ageDays: 20,
    });
    await writeLss(fx, oldPending);

    const result = await sweep(fx);

    expect(result.uploadRowsPurged).toBe(2);
    for (const gone of [oldUploaded, oldRejected]) {
      expect(await uploadState(fx, gone)).toBeNull();
      expect(await count("core_storage_objects", fx, "id", gone)).toBe(0);
    }
    expect(await uploadState(fx, youngUploaded)).toBe("uploaded");
    expect(await count("core_storage_objects", fx, "id", youngUploaded)).toBe(
      1,
    );
    expect(await uploadState(fx, oldPending)).toBe("pending");
    expect(await count("core_storage_objects", fx, "id", oldPending)).toBe(1);
  });

  it("leaves nothing behind in the selfie dir for a swept tenant but the live files", async () => {
    const fx = await fixture();
    const live = randomUUID();
    const liveFile = await writeLss(fx, live);
    await insertUpload(fx, { objectId: live, state: "pending", ageDays: 1 });

    await sweep(fx);

    expect(await readdir(path.join(fx.dir, fx.tenantId))).toEqual([
      path.basename(liveFile),
    ]);
  });
});

describe("startEdgeSelfieSweep", () => {
  type Timer = { fn: () => void; ms: number; cleared: boolean };

  function harness(fx: Fixture) {
    const timers: Timer[] = [];
    const sweeper = startEdgeSelfieSweep({
      database: db,
      context: context(fx.tenantId),
      dir: fx.dir,
      maxAgeDays: MAX_AGE_DAYS,
      setTimer: (fn, ms) => {
        const timer = { fn, ms, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimer: (handle) => {
        (handle as Timer).cleared = true;
      },
    });
    return { sweeper, timers };
  }

  it("sweeps at start, then schedules the next run hourly, without overlap", async () => {
    const fx = await fixture();
    const old = randomUUID();
    const oldFile = await writeLss(fx, old);
    await insertUpload(fx, { objectId: old, state: "pending", ageDays: 40 });
    const { sweeper, timers } = harness(fx);

    const first = sweeper.runOnce();
    const second = sweeper.runOnce();
    expect(second).toBe(first);
    await first;

    expect(await exists(oldFile)).toBe(false);
    expect(timers).toHaveLength(1);
    expect(timers[0]?.ms).toBe(3_600_000);
    await sweeper.stop();
  });

  it("stop() cancels the timer and no sweep runs after it", async () => {
    const fx = await fixture();
    const { sweeper, timers } = harness(fx);
    await sweeper.runOnce();
    const next = timers[0] as Timer;

    await sweeper.stop();
    expect(next.cleared).toBe(true);

    const late = randomUUID();
    const lateFile = await writeLss(fx, late);
    await insertUpload(fx, { objectId: late, state: "pending", ageDays: 40 });
    next.fn();
    await sweeper.runOnce();
    expect(await exists(lateFile)).toBe(true);
  });

  it("treats a tenant with no rows and no selfie dir as a quiet sweep", async () => {
    const fx = await fixture();
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const timers: Timer[] = [];
    const sweeper = startEdgeSelfieSweep({
      database: db,
      context: context(randomUUID()),
      dir: path.join(fx.dir, "missing"),
      maxAgeDays: MAX_AGE_DAYS,
      setTimer: (fn, ms) => {
        const timer = { fn, ms, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimer: () => undefined,
    });
    await sweeper.runOnce();
    expect(timers).toHaveLength(1);
    expect(error).not.toHaveBeenCalled();
    await sweeper.stop();
  });
});
