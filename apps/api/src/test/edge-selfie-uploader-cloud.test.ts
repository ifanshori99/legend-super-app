// Edge selfie uploader against the REAL cloud receive route (bead legend-0wvoz
// C6 route, C7 uploader; design docs/design/hris-edge-replication.md section 5,
// 9 T7). The cloud side is the real createEdgeSelfieReceiveRouter behind the
// real error handler, a FakeObjectStorage and real PostgreSQL. The edge side is
// the real uploader with a real queue row and a real sealed .lss file in a temp
// dir. Only the socket is bridged: `fetchImpl` forwards the uploader's request
// (path, method, headers, body bytes) into supertest and wraps the answer in a
// `Response`.
//
// One database and one tenant: the edge rows are seeded for the cloud
// fixture's tenant and outlet A (node A's outlet), so a single DB plays both
// the edge and the cloud. Both sides reach it through the shared `db`.
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeObjectStorage } from "@starter/shared/adapters";
import { outletIdSchema, tenantIdSchema } from "@starter/shared/core";
import { SEALED_SHA256_HEADER } from "@starter/shared/edge";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  edgeSealedFilePath,
  edgeSealedObjectKey,
} from "../edge/selfie-paths.ts";
import { enqueueEdgeSelfieUpload } from "../edge/selfie-queue.ts";
import { uploadNextSelfie } from "../edge/selfie-uploader.ts";
import { errorHandler } from "../middleware/error-handler.ts";
import { tenantContext } from "../middleware/tenant.ts";
import { createEdgeSelfieReceiveRouter } from "../routes/edge-selfie-receive.routes.ts";
import { NoopMalwareScanner } from "../services/core-image.ts";
import {
  createEdgeSelfieFixture,
  type EdgeSelfieFixture,
} from "./helpers/edge-selfie-fixture.ts";
import {
  generateSealKeyPair,
  sampleWebp,
  sealKeysEnvValue,
  sealSelfie,
  sha256Hex,
  type SealKeyPair,
} from "./helpers/edge-selfie-seal.ts";

const SEAL_KEYS_ENV = "ATTENDANCE_SELFIE_SEAL_KEYS";
// The edge link URL; the uploader derives the https origin from it and the
// bridge only uses the path.
const CLOUD_URL = "wss://cloud.example/api/edge-link";
const INTERVAL_MS = 1000;
const MAX_BACKOFF_MS = 4000;
// A new row's next_attempt_at defaults to the database clock, which can run
// ahead of the host. The injected clock is moved past that skew.
const CLOCK_AHEAD_MS = 60_000;

let fx: EdgeSelfieFixture;
let pair: SealKeyPair;
let storage: FakeObjectStorage;
let app: express.Express;
let previousKeys: string | undefined;
let dir: string;

beforeAll(async () => {
  previousKeys = process.env[SEAL_KEYS_ENV];
  pair = generateSealKeyPair("test-kid-1");
  process.env[SEAL_KEYS_ENV] = sealKeysEnvValue(pair);
  fx = await createEdgeSelfieFixture();
  dir = await mkdtemp(path.join(tmpdir(), "edge-selfie-uploader-cloud-"));
}, 60_000);

beforeEach(() => {
  process.env[SEAL_KEYS_ENV] = sealKeysEnvValue(pair);
  storage = new FakeObjectStorage();
  app = express();
  app.use(
    tenantContext({
      required: false,
      resolveDomain: async () => null,
      verifyCredential: async () => null,
    }),
  );
  app.use(
    "/api/edge-sync/attendance-selfies",
    createEdgeSelfieReceiveRouter({
      database: db,
      storage,
      scanner: new NoopMalwareScanner(),
    }),
  );
  app.use(errorHandler);
});

afterAll(async () => {
  if (previousKeys === undefined) delete process.env[SEAL_KEYS_ENV];
  else process.env[SEAL_KEYS_ENV] = previousKeys;
  await rm(dir, { recursive: true, force: true });
  // The fixture cleanup does not know the edge queue table.
  await fx.asTenant((client) =>
    client.query("DELETE FROM edge_selfie_uploads WHERE tenant_id = $1", [
      fx.tenantId,
    ]),
  );
  await fx.cleanup();
}, 60_000);

/** Forwards the uploader's request into the express app and returns a real Response. */
const bridgeFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const headers = new Headers(init?.headers);
  const method = (init?.method ?? "GET").toLowerCase();
  if (method !== "put") throw new Error(`Unexpected method ${method}`);
  let req = request(app).put(url.pathname);
  headers.forEach((value, name) => {
    req = req.set(name, value);
  });
  const res = await req.send(Buffer.from(init?.body as Uint8Array));
  return new Response(res.text === "" ? null : res.text, {
    status: res.status,
  });
};

const uploadOptions = () => ({
  context: fx.scopeOf([fx.outletA]),
  cloudUrl: CLOUD_URL,
  credential: fx.nodeA.credential,
  fetchImpl: bridgeFetch,
  intervalMs: INTERVAL_MS,
  maxBackoffMs: MAX_BACKOFF_MS,
  now: () => new Date(Date.now() + CLOCK_AHEAD_MS),
  random: () => 0.5,
});

async function sealFor(objectId: string, seed: number): Promise<Buffer> {
  return sealSelfie({
    pair,
    tenantId: fx.tenantId,
    objectId,
    meta: { outletId: fx.outletA, ownerUserId: fx.employee.userId },
    webp: await sampleWebp(seed),
  });
}

/** Writes the sealed file and queues it as the edge would. */
async function queue(objectId: string, sealed: Buffer): Promise<string> {
  const filePath = edgeSealedFilePath(dir, fx.tenantId, objectId);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, sealed, { mode: 0o600 });
  await withTenant(db, fx.scopeOf([fx.outletA]), (tx) =>
    enqueueEdgeSelfieUpload(tx, {
      tenantId: fx.tenantId,
      outletId: fx.outletA,
      attendanceLogId: randomUUID(),
      objectKey: edgeSealedObjectKey(fx.tenantId, objectId),
      dir,
    }),
  );
  return filePath;
}

type UploadRow = {
  state: string;
  attempts: number;
  last_error: string | null;
  uploaded_at: Date | null;
};

async function uploadRow(objectId: string): Promise<UploadRow> {
  const { rows } = await fx.asTenant((client) =>
    client.query<UploadRow>(
      `SELECT state, attempts, last_error, uploaded_at
         FROM edge_selfie_uploads WHERE tenant_id = $1 AND object_id = $2`,
      [fx.tenantId, objectId],
    ),
  );
  return rows[0]!;
}

async function resetToPending(objectId: string): Promise<void> {
  await fx.asTenant((client) =>
    client.query(
      `UPDATE edge_selfie_uploads
          SET state = 'pending', attempts = 0, last_error = NULL,
              uploaded_at = NULL, next_attempt_at = now()
        WHERE tenant_id = $1 AND object_id = $2`,
      [fx.tenantId, objectId],
    ),
  );
}

const exists = (filePath: string) =>
  access(filePath).then(
    () => true,
    () => false,
  );

/** The bytes the cloud holds at `${objectId}/original.webp`, or null. */
async function cloudOriginal(objectId: string): Promise<Buffer | null> {
  const key = `${objectId}/original.webp`;
  try {
    const object = await storage.get(fx.scopeOf([fx.outletA]), {
      tenantId: tenantIdSchema.parse(fx.tenantId),
      outletId: outletIdSchema.parse(fx.outletA),
      reference: key,
      key,
      visibility: "private",
    });
    return Buffer.from(object.content as Uint8Array);
  } catch {
    return null;
  }
}

describe("edge selfie uploader -> real cloud receive route", () => {
  it("201 from the real route: row uploaded, local file deleted, cloud has the object", async () => {
    const objectId = randomUUID();
    const filePath = await queue(objectId, await sealFor(objectId, 5));

    expect(await uploadNextSelfie(uploadOptions())).toBe("uploaded");

    expect(await uploadRow(objectId)).toMatchObject({
      state: "uploaded",
      last_error: null,
    });
    expect((await uploadRow(objectId)).uploaded_at).not.toBeNull();
    expect(await exists(filePath)).toBe(false);
    expect(await cloudOriginal(objectId)).not.toBeNull();
    expect(await fx.objectRow(objectId)).toMatchObject({
      id: objectId,
      outlet_id: fx.outletA,
    });
    expect(await fx.receiptRow(objectId)).toMatchObject({ state: "stored" });
  });

  it("200 on a repeat with the same file: the row ends uploaded again, nothing new is stored", async () => {
    const objectId = randomUUID();
    const sealed = await sealFor(objectId, 9);
    const filePath = await queue(objectId, sealed);
    expect(await uploadNextSelfie(uploadOptions())).toBe("uploaded");
    const original = await cloudOriginal(objectId);

    // The edge lost its `uploaded` mark (for example a restored database) and
    // still, or again, has the same file.
    await writeFile(filePath, sealed, { mode: 0o600 });
    await resetToPending(objectId);
    expect(await uploadNextSelfie(uploadOptions())).toBe("uploaded");

    expect(await uploadRow(objectId)).toMatchObject({
      state: "uploaded",
      last_error: null,
    });
    expect(await exists(filePath)).toBe(false);
    expect((await cloudOriginal(objectId))!.equals(original!)).toBe(true);
  });

  it("409 for the same object id with different bytes: row rejected, file kept, cloud copy untouched", async () => {
    const objectId = randomUUID();
    // The cloud already holds sealed bytes A for this object id...
    const first = await sealFor(objectId, 20);
    const firstPut = await request(app)
      .put(`/api/edge-sync/attendance-selfies/${objectId}`)
      .set("Authorization", `Bearer ${fx.nodeA.credential}`)
      .set("Content-Type", "application/octet-stream")
      .set(SEALED_SHA256_HEADER, sha256Hex(first))
      .send(first);
    expect(firstPut.status).toBe(201);
    const original = await cloudOriginal(objectId);

    // ...and the edge queued different bytes B under the same id.
    const second = await sealFor(objectId, 200);
    const filePath = await queue(objectId, second);

    expect(await uploadNextSelfie(uploadOptions())).toBe("rejected");

    expect(await uploadRow(objectId)).toMatchObject({
      state: "rejected",
      last_error: "HTTP_409",
    });
    expect(await exists(filePath)).toBe(true);
    expect((await cloudOriginal(objectId))!.equals(original!)).toBe(true);
  });
});
