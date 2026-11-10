// Edge selfie uploader (design docs/design/hris-edge-replication.md section 5,
// 9 T7). One sealed file at a time goes to the cloud PUT; the cloud is a fake
// fetch. Rows live in a real database under RLS, files in a temp dir.
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { SEALED_SHA256_HEADER } from "@starter/shared/edge";
import * as schema from "../db/schema";
import { withTenant } from "../db/tenant";
import { logger } from "../lib/logger";
import { sealSelfie } from "../lib/selfie-seal";
import { edgeSealedFilePath, edgeSealedObjectKey } from "../edge/selfie-paths";
import { enqueueEdgeSelfieUpload } from "../edge/selfie-queue";
import { createEdgeSelfieUploader } from "../edge/selfie-uploader";

const pool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 1,
});
const db = drizzle(pool, { schema });
const KID = "kid-2026-11";
const CLOUD_URL = "wss://cloud.example/api/edge-link";
const CREDENTIAL = "edge-credential-secret";
const INTERVAL_MS = 1000;
const MAX_BACKOFF_MS = 4000;
// A new row's next_attempt_at defaults to the database clock, and a Docker VM
// clock can run ahead of the host. Tests inject a clock past that skew.
const CLOCK_AHEAD_MS = 60_000;

let keys: { publicKey: string; privateKey: string };
const dirs: string[] = [];

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  keys = generateKeyPairSync("rsa", {
    modulusLength: 3072,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}, 60_000);

afterAll(async () => {
  await pool.end();
  await owner.end();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

/** A fresh tenant with one outlet per test, so queues never mix. */
async function setup() {
  const [tenantId, brandId, legalEntityId, outletId] = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ];
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Uji Uploader Edge', 'lengkap', 'active', 'shared', '{"modules":[],"integrationProviders":[]}', $3, $4)`,
    [
      tenantId,
      `uji-uploader-${tenantId.slice(0, 8)}`,
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
  const dir = await mkdtemp(path.join(tmpdir(), "edge-selfie-uploader-"));
  dirs.push(dir);
  const context = establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
  return { tenantId, outletId, dir, context };
}
type Env = Awaited<ReturnType<typeof setup>>;

/** Seals a fake webp, writes the file and enqueues it as the edge would. */
async function queueSelfie(env: Env) {
  const objectId = randomUUID();
  const webp = Buffer.from(`not-really-webp-${objectId}`);
  const sealed = sealSelfie({
    kid: KID,
    publicKeyPem: keys.publicKey,
    tenantId: env.tenantId,
    objectId,
    meta: {
      outletId: env.outletId,
      ownerUserId: randomUUID(),
      contentType: "image/webp",
      width: 64,
      height: 48,
      plainSha256: createHash("sha256").update(webp).digest("hex"),
      createdAt: new Date().toISOString(),
    },
    webp,
  });
  const filePath = edgeSealedFilePath(env.dir, env.tenantId, objectId);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, sealed, { mode: 0o600 });
  await withTenant(db, env.context, (tx) =>
    enqueueEdgeSelfieUpload(tx, {
      tenantId: env.tenantId,
      outletId: env.outletId,
      attendanceLogId: randomUUID(),
      objectKey: edgeSealedObjectKey(env.tenantId, objectId),
      dir: env.dir,
    }),
  );
  return { objectId, sealed, filePath };
}

type Row = {
  state: string;
  attempts: number;
  last_error: string | null;
  uploaded_at: Date | null;
  rejected_at: Date | null;
  next_attempt_at: Date;
};

async function rowOf(env: Env, objectId: string): Promise<Row> {
  const { rows } = await owner.query(
    `SELECT state, attempts, last_error, uploaded_at, rejected_at, next_attempt_at
     FROM edge_selfie_uploads WHERE tenant_id = $1 AND object_id = $2`,
    [env.tenantId, objectId],
  );
  return rows[0] as Row;
}

async function exists(file: string) {
  return access(file).then(
    () => true,
    () => false,
  );
}

type Call = {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: Buffer;
  init: RequestInit;
};

/** Fake cloud: answers each PUT with the next status, or throws an Error. */
function fakeCloud(...answers: Array<number | Error>) {
  const calls: Call[] = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const request = init ?? {};
    calls.push({
      url: String(input),
      method: request.method,
      headers: request.headers as Record<string, string>,
      body: Buffer.from(request.body as Uint8Array),
      init: request,
    });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (answer instanceof Error) throw answer;
    return new Response(answer === undefined ? null : "cloud-body-secret", {
      status: answer ?? 201,
    });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function uploaderFor(
  env: Env,
  fetchImpl: typeof fetch,
  extra: Partial<Parameters<typeof createEdgeSelfieUploader>[0]> = {},
) {
  return createEdgeSelfieUploader({
    context: env.context,
    cloudUrl: CLOUD_URL,
    credential: CREDENTIAL,
    fetchImpl,
    intervalMs: INTERVAL_MS,
    maxBackoffMs: MAX_BACKOFF_MS,
    now: () => new Date(Date.now() + CLOCK_AHEAD_MS),
    ...extra,
  });
}

describe("edge selfie uploader", () => {
  it("answers idle and calls nothing when no upload is pending", async () => {
    const env = await setup();
    const cloud = fakeCloud(201);

    expect(await uploaderFor(env, cloud.fetchImpl).runOnce()).toBe("idle");
    expect(cloud.calls).toHaveLength(0);
  });

  it("PUTs the whole sealed file, marks it uploaded, then deletes it", async () => {
    const env = await setup();
    const { objectId, sealed, filePath } = await queueSelfie(env);
    const cloud = fakeCloud(201);

    const outcome = await uploaderFor(env, cloud.fetchImpl).runOnce();

    expect(outcome).toBe("uploaded");
    expect(cloud.calls).toHaveLength(1);
    const [call] = cloud.calls;
    expect(call?.url).toBe(
      `https://cloud.example/api/edge-sync/attendance-selfies/${objectId}`,
    );
    expect(call?.method).toBe("PUT");
    expect(call?.headers).toMatchObject({
      Authorization: `Bearer ${CREDENTIAL}`,
      "Content-Type": "application/octet-stream",
      [SEALED_SHA256_HEADER]: createHash("sha256").update(sealed).digest("hex"),
    });
    expect(call?.body.equals(sealed)).toBe(true);
    expect(call?.init.redirect).toBe("error");
    const row = await rowOf(env, objectId);
    expect(row.state).toBe("uploaded");
    expect(row.uploaded_at).toBeInstanceOf(Date);
    expect(row.last_error).toBeNull();
    expect(await exists(filePath)).toBe(false);
  });

  it("treats 200 (same hash again) like 201", async () => {
    const env = await setup();
    const { objectId, filePath } = await queueSelfie(env);

    const outcome = await uploaderFor(env, fakeCloud(200).fetchImpl).runOnce();

    expect(outcome).toBe("uploaded");
    expect((await rowOf(env, objectId)).state).toBe("uploaded");
    expect(await exists(filePath)).toBe(false);
  });

  it("uploads one file per run, oldest first", async () => {
    const env = await setup();
    const first = await queueSelfie(env);
    const second = await queueSelfie(env);
    await owner.query(
      `UPDATE edge_selfie_uploads SET next_attempt_at = now() - interval '1 hour'
       WHERE tenant_id = $1 AND object_id = $2`,
      [env.tenantId, second.objectId],
    );
    const cloud = fakeCloud(201);
    const uploader = uploaderFor(env, cloud.fetchImpl);

    await uploader.runOnce();
    expect(cloud.calls).toHaveLength(1);
    expect(cloud.calls[0]?.url.endsWith(second.objectId)).toBe(true);
    expect((await rowOf(env, first.objectId)).state).toBe("pending");

    await uploader.runOnce();
    expect(cloud.calls).toHaveLength(2);
    expect((await rowOf(env, first.objectId)).state).toBe("uploaded");
  });

  it("does not retry an uploaded row whose file delete never happened (crash)", async () => {
    const env = await setup();
    const { objectId, filePath } = await queueSelfie(env);
    // State after a crash between the commit and the delete.
    await owner.query(
      `UPDATE edge_selfie_uploads SET state = 'uploaded', uploaded_at = now()
       WHERE tenant_id = $1 AND object_id = $2`,
      [env.tenantId, objectId],
    );
    const cloud = fakeCloud(201);

    expect(await uploaderFor(env, cloud.fetchImpl).runOnce()).toBe("idle");

    expect(cloud.calls).toHaveLength(0);
    expect(await exists(filePath)).toBe(true);
  });

  it("keeps the row pending with jittered, capped backoff on 5xx", async () => {
    const env = await setup();
    const { objectId, filePath } = await queueSelfie(env);
    const now = new Date(Date.now() + CLOCK_AHEAD_MS);
    const cloud = fakeCloud(503);
    const uploader = uploaderFor(env, cloud.fetchImpl, {
      now: () => now,
      random: () => 0.5,
    });

    expect(await uploader.runOnce()).toBe("retry");
    let row = await rowOf(env, objectId);
    expect(row).toMatchObject({
      state: "pending",
      attempts: 1,
      last_error: "HTTP_503",
    });
    // delay 1000: floor(500 + 0.5 * 500) = 750
    expect(row.next_attempt_at.getTime()).toBe(now.getTime() + 750);
    expect(await exists(filePath)).toBe(true);

    // Not due yet: the next run leaves it alone.
    expect(await uploader.runOnce()).toBe("idle");
    expect(cloud.calls).toHaveLength(1);

    // Second failure doubles the delay: 2000 -> 1500.
    await owner.query(
      `UPDATE edge_selfie_uploads SET next_attempt_at = $3
       WHERE tenant_id = $1 AND object_id = $2`,
      [env.tenantId, objectId, new Date(now.getTime() - 1)],
    );
    expect(await uploader.runOnce()).toBe("retry");
    row = await rowOf(env, objectId);
    expect(row.attempts).toBe(2);
    expect(row.next_attempt_at.getTime()).toBe(now.getTime() + 1500);

    // Many failures: delay is capped at maxBackoffMs (4000 -> 3000).
    await owner.query(
      `UPDATE edge_selfie_uploads SET attempts = 9, next_attempt_at = $3
       WHERE tenant_id = $1 AND object_id = $2`,
      [env.tenantId, objectId, new Date(now.getTime() - 1)],
    );
    expect(await uploader.runOnce()).toBe("retry");
    row = await rowOf(env, objectId);
    expect(row.attempts).toBe(10);
    expect(row.next_attempt_at.getTime()).toBe(now.getTime() + 3000);
  });

  it("applies the jitter floor and ceiling from random()", async () => {
    const env = await setup();
    const low = await queueSelfie(env);
    const now = new Date(Date.now() + CLOCK_AHEAD_MS);
    await uploaderFor(env, fakeCloud(500).fetchImpl, {
      now: () => now,
      random: () => 0,
    }).runOnce();
    expect((await rowOf(env, low.objectId)).next_attempt_at.getTime()).toBe(
      now.getTime() + 500,
    );

    const env2 = await setup();
    const high = await queueSelfie(env2);
    await uploaderFor(env2, fakeCloud(500).fetchImpl, {
      now: () => now,
      random: () => 0.999999,
    }).runOnce();
    const delay =
      (await rowOf(env2, high.objectId)).next_attempt_at.getTime() -
      now.getTime();
    expect(delay).toBeGreaterThanOrEqual(999);
    expect(delay).toBeLessThanOrEqual(1000);
  });

  it("retries on a network failure and on 401 (credential problem), never rejects", async () => {
    const env = await setup();
    const { objectId, filePath } = await queueSelfie(env);
    const now = new Date(Date.now() + CLOCK_AHEAD_MS);
    const answers = fakeCloud(new TypeError("fetch failed: secret-host"), 401);
    const uploader = uploaderFor(env, answers.fetchImpl, {
      now: () => now,
      random: () => 0,
    });

    expect(await uploader.runOnce()).toBe("retry");
    expect(await rowOf(env, objectId)).toMatchObject({
      state: "pending",
      attempts: 1,
      last_error: "NETWORK",
    });

    await owner.query(
      `UPDATE edge_selfie_uploads SET next_attempt_at = $3
       WHERE tenant_id = $1 AND object_id = $2`,
      [env.tenantId, objectId, new Date(now.getTime() - 1)],
    );
    expect(await uploader.runOnce()).toBe("retry");
    expect(await rowOf(env, objectId)).toMatchObject({
      state: "pending",
      attempts: 2,
      last_error: "HTTP_401",
    });
    expect(await exists(filePath)).toBe(true);
  });

  it.each([409, 403, 413, 422, 400])(
    "rejects on %i, keeps the file and raises an alert without body or ids",
    async (status) => {
      const env = await setup();
      const { objectId, filePath } = await queueSelfie(env);
      const rejected: unknown[] = [];
      const cloud = fakeCloud(status);
      const clock = new Date(Date.now() + CLOCK_AHEAD_MS);

      const outcome = await uploaderFor(env, cloud.fetchImpl, {
        onRejected: (info) => rejected.push(info),
        now: () => clock,
      }).runOnce();

      expect(outcome).toBe("rejected");
      const row = await rowOf(env, objectId);
      expect(row).toMatchObject({
        state: "rejected",
        last_error: `HTTP_${status}`,
      });
      expect(row.rejected_at?.getTime()).toBe(clock.getTime());
      expect(await exists(filePath)).toBe(true);
      expect(rejected).toEqual([{ objectId, reason: `HTTP_${status}` }]);
      expect(JSON.stringify(rejected)).not.toContain("cloud-body-secret");

      // Rejected is final: no more PUTs.
      expect(await uploaderFor(env, cloud.fetchImpl).runOnce()).toBe("idle");
      expect(cloud.calls).toHaveLength(1);
    },
  );

  it("marks a pending row whose file is gone as expired, without a PUT", async () => {
    const env = await setup();
    const { objectId, filePath } = await queueSelfie(env);
    await rm(filePath);
    const cloud = fakeCloud(201);
    const uploader = uploaderFor(env, cloud.fetchImpl);

    expect(await uploader.runOnce()).toBe("expired");

    expect(cloud.calls).toHaveLength(0);
    expect(await rowOf(env, objectId)).toMatchObject({
      state: "expired",
      last_error: "ENOENT",
    });
    expect(await uploader.runOnce()).toBe("idle");
  });

  it("rejects with FILE_HASH_MISMATCH when the file no longer matches its row", async () => {
    const env = await setup();
    const { objectId, filePath } = await queueSelfie(env);
    await writeFile(filePath, Buffer.from("tampered"), { mode: 0o600 });
    const cloud = fakeCloud(201);
    const rejected: unknown[] = [];
    const clock = new Date(Date.now() + CLOCK_AHEAD_MS);

    const outcome = await uploaderFor(env, cloud.fetchImpl, {
      onRejected: (info) => rejected.push(info),
      now: () => clock,
    }).runOnce();

    expect(outcome).toBe("rejected");
    expect(cloud.calls).toHaveLength(0);
    const row = await rowOf(env, objectId);
    expect(row).toMatchObject({
      state: "rejected",
      last_error: "FILE_HASH_MISMATCH",
    });
    expect(row.rejected_at?.getTime()).toBe(clock.getTime());
    expect(await exists(filePath)).toBe(true);
    expect(rejected).toEqual([{ objectId, reason: "FILE_HASH_MISMATCH" }]);
  });

  it("only touches the edge's own tenant", async () => {
    const mine = await setup();
    const other = await setup();
    const theirs = await queueSelfie(other);
    const cloud = fakeCloud(201);

    expect(await uploaderFor(mine, cloud.fetchImpl).runOnce()).toBe("idle");

    expect(cloud.calls).toHaveLength(0);
    expect((await rowOf(other, theirs.objectId)).state).toBe("pending");
  });

  it("stop() aborts the in-flight PUT and leaves the row untouched", async () => {
    const env = await setup();
    const { objectId, filePath } = await queueSelfie(env);
    let started!: () => void;
    const fetchStarted = new Promise<void>((resolve) => (started = resolve));
    const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        started();
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      })) as typeof fetch;
    const errors: unknown[] = [];
    const uploader = uploaderFor(env, fetchImpl, {
      onError: (error) => errors.push(error),
    });

    const run = uploader.runOnce();
    await fetchStarted;
    await uploader.stop();

    expect(await run).toBe("aborted");
    expect(await rowOf(env, objectId)).toMatchObject({
      state: "pending",
      attempts: 0,
      last_error: null,
    });
    expect(await exists(filePath)).toBe(true);
    expect(errors).toEqual([]);
    // Stopped for good.
    expect(await uploader.runOnce()).toBe("idle");
  });

  it("keeps the cloud's answer when the sweep expired the row during the PUT, and logs the class only", async () => {
    const env = await setup();
    const { objectId, filePath } = await queueSelfie(env);
    const fetchImpl = (async () => {
      // The retention sweep expires the row and deletes the file mid-PUT.
      await owner.query(
        `UPDATE edge_selfie_uploads SET state = 'expired', last_error = 'RETENTION'
         WHERE tenant_id = $1 AND object_id = $2`,
        [env.tenantId, objectId],
      );
      await rm(filePath, { force: true });
      return new Response(null, { status: 201 });
    }) as typeof fetch;
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const errors: unknown[] = [];

    try {
      const outcome = await uploaderFor(env, fetchImpl, {
        onError: (error) => errors.push(error),
      }).runOnce();

      expect(outcome).toBe("uploaded");
      expect(errors).toEqual([]);
      // The row is the sweep's: the uploader never rewrites a finished row.
      expect(await rowOf(env, objectId)).toMatchObject({
        state: "expired",
        last_error: "RETENTION",
      });
      expect(warn).toHaveBeenCalledWith(
        { objectId, reason: "ROW_NOT_PENDING" },
        expect.any(String),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("start() runs at once, re-arms the timer, and stop() clears it", async () => {
    const env = await setup();
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const clearTimer = vi.fn();
    const cloud = fakeCloud(201);
    const uploader = uploaderFor(env, cloud.fetchImpl, {
      setTimer: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length;
      },
      clearTimer,
    });

    uploader.start();
    uploader.start(); // idempotent
    await vi.waitFor(() => expect(timers).toHaveLength(1));
    expect(timers[0]?.ms).toBe(INTERVAL_MS);

    await uploader.stop();
    expect(clearTimer).toHaveBeenCalledWith(1);
  });

  it("start() drains a queue without waiting a full interval between files", async () => {
    const env = await setup();
    const a = await queueSelfie(env);
    const b = await queueSelfie(env);
    const timers: number[] = [];
    const cloud = fakeCloud(201);
    const uploader = uploaderFor(env, cloud.fetchImpl, {
      setTimer: (fn, ms) => {
        timers.push(ms);
        // Fire the zero-delay drain on a real tick, hold the idle interval.
        if (ms === 0) setTimeout(fn, 0);
        return timers.length;
      },
    });

    uploader.start();
    await vi.waitFor(() => expect(timers).toContain(INTERVAL_MS));
    await uploader.stop();

    expect((await rowOf(env, a.objectId)).state).toBe("uploaded");
    expect((await rowOf(env, b.objectId)).state).toBe("uploaded");
  });

  it("reports an unexpected failure through onError and backs off the loop", async () => {
    const env = await setup();
    const errors: unknown[] = [];
    const timers: number[] = [];
    const uploader = uploaderFor(env, fakeCloud(201).fetchImpl, {
      context: {} as Env["context"], // broken context: every run throws
      onError: (error) => errors.push(error),
      random: () => 0.5,
      setTimer: (_fn, ms) => {
        timers.push(ms);
        return timers.length;
      },
    });

    uploader.start();
    await vi.waitFor(() => expect(timers).toHaveLength(1));
    await uploader.stop();

    expect(errors).toHaveLength(1);
    expect(timers[0]).toBe(750); // first failure: floor(500 + 0.5 * 500)
  });
});
