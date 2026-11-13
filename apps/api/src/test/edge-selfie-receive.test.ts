// Cloud receives a sealed edge selfie (bead legend-0wvoz, C6; design
// docs/design/hris-edge-replication.md 5, 6.1, 6.3 and section 9 "T6 receive").
// `PUT /api/edge-sync/attendance-selfies/:objectId`, edge credential, real
// PostgreSQL (RLS on), a recording FakeObjectStorage and the real router behind
// the real error handler. The sealer is test/helpers/edge-selfie-seal.ts.
//
// Assumptions (the design leaves them open):
// - `X-Legend-Sealed-Sha256` is the lowercase hex SHA-256 of the request body.
// - Error bodies use the shared shape `{ error: { code } }`; only the codes the
//   design names (OBJECT_ID_TAKEN, SELFIE_SEAL_KEY_MISSING) are asserted, every
//   other refusal is asserted by HTTP status.
// - A kid the cloud holds no private key for, a body that is not LSS1 and a
//   plainSha256 that does not match the decrypted bytes are all "cannot
//   decrypt": 422, nothing stored.
// - A file whose header was edited (same fields, different bytes) fails the GCM
//   tag: 422, even though tenant and object id inside it would be right.
// - The router answers 401 without a valid edge credential.
// - Nodes of outlet A and outlet B exist; "other outlet's credential" is node B
//   uploading a file sealed for outlet A (encrypted outletId != node outlet).
import { randomBytes, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  FakeObjectStorage,
  type ObjectStorage,
} from "@starter/shared/adapters";
import { tenantIdSchema, outletIdSchema } from "@starter/shared/core";
import {
  EDGE_SELFIE_SEALED_MAX_BYTES,
  SEALED_SHA256_HEADER,
} from "@starter/shared/edge";
import { db } from "../db/index.ts";
import { errorHandler } from "../middleware/error-handler.ts";
import { tenantContext } from "../middleware/tenant.ts";
import { createEdgeSelfieReceiveRouter } from "../routes/edge-selfie-receive.routes.ts";
import { NoopMalwareScanner } from "../services/core-image.ts";
import { receiveEdgeSelfie } from "../services/edge-selfie-receive.ts";
import {
  createEdgeSelfieFixture,
  type EdgeSelfieFixture,
} from "./helpers/edge-selfie-fixture.ts";
import {
  generateSealKeyPair,
  looksLikeImage,
  openSealed,
  sampleWebp,
  sealKeysEnvValue,
  sealSelfie,
  sha256Hex,
  withBrokenTag,
  withEditedHeader,
  type SealKeyPair,
} from "./helpers/edge-selfie-seal.ts";

const BASE = "/api/edge-sync/attendance-selfies";
const SEAL_KEYS_ENV = "ATTENDANCE_SELFIE_SEAL_KEYS";

class RecordingStorage extends FakeObjectStorage {
  puts: string[] = [];
  override async put(
    ...args: Parameters<FakeObjectStorage["put"]>
  ): ReturnType<FakeObjectStorage["put"]> {
    this.puts.push(args[1].key);
    return super.put(...args);
  }
}

/**
 * The thumbnail put fails once, after the original was written, once `release`
 * is called; the cleanup delete then waits until `deleteWaitsFor` settles (or
 * 1.5 s), so a cleanup that runs after the lock is gone lands after a retry.
 */
class FailThumbnailOnceStorage extends RecordingStorage {
  private failed = false;
  private release!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  private markReached!: () => void;
  readonly reached = new Promise<void>((resolve) => {
    this.markReached = resolve;
  });
  deleteWaitsFor: Promise<unknown> = Promise.resolve();
  releaseFailure(): void {
    this.release();
  }
  override async put(
    ...args: Parameters<FakeObjectStorage["put"]>
  ): ReturnType<FakeObjectStorage["put"]> {
    if (args[1].key.endsWith("/thumbnail.webp") && !this.failed) {
      this.failed = true;
      this.markReached();
      await this.gate;
      throw new Error("storage unavailable");
    }
    return super.put(...args);
  }
  override async delete(
    ...args: Parameters<FakeObjectStorage["delete"]>
  ): ReturnType<FakeObjectStorage["delete"]> {
    await Promise.race([
      this.deleteWaitsFor,
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
    return super.delete(...args);
  }
}

let fx: EdgeSelfieFixture;
let pair: SealKeyPair;
let storage: RecordingStorage;
let app: express.Express;
let previousKeys: string | undefined;

function buildApp(
  runtimeStorage: ObjectStorage | null,
  options: { perIp?: number; perNode?: number; windowMs?: number } = {},
) {
  const instance = express();
  instance.use(
    tenantContext({
      required: false,
      resolveDomain: async () => null,
      verifyCredential: async () => null,
    }),
  );
  instance.use(
    BASE,
    createEdgeSelfieReceiveRouter({
      database: db,
      storage: runtimeStorage,
      scanner: new NoopMalwareScanner(),
      ...options,
    }),
  );
  instance.use(errorHandler);
  return instance;
}

async function seal(
  objectId: string,
  overrides: Partial<Parameters<typeof sealSelfie>[0]> = {},
) {
  return sealSelfie({
    pair,
    tenantId: fx.tenantId,
    objectId,
    meta: { outletId: fx.outletA, ownerUserId: fx.employee.userId },
    webp: await sampleWebp(randomBytes(1)[0]),
    ...overrides,
  });
}

function put(
  objectId: string,
  body: Buffer,
  options: {
    app?: express.Express;
    credential?: string | null;
    sha?: string | null;
    pathId?: string;
  } = {},
) {
  let req = request(options.app ?? app)
    .put(`${BASE}/${options.pathId ?? objectId}`)
    .set("Content-Type", "application/octet-stream");
  const credential =
    options.credential === undefined ? fx.nodeA.credential : options.credential;
  if (credential !== null)
    req = req.set("Authorization", `Bearer ${credential}`);
  const sha = options.sha === undefined ? sha256Hex(body) : options.sha;
  if (sha !== null) req = req.set(SEALED_SHA256_HEADER, sha);
  return req.send(body);
}

/** The bytes at an S3 key of outlet A, or null when nothing is there. */
async function stored(key: string, outletId: string = fx.outletA) {
  try {
    const object = await storage.get(fx.scopeOf([outletId]), {
      tenantId: tenantIdSchema.parse(fx.tenantId),
      outletId: outletIdSchema.parse(outletId),
      reference: key,
      key,
      visibility: "private",
    });
    return Buffer.from(object.content as Uint8Array);
  } catch {
    return null;
  }
}

async function expectNothingStored(objectId: string) {
  expect(await fx.objectRow(objectId)).toBeUndefined();
  expect(await fx.receiptRow(objectId)).toBeUndefined();
  expect(await stored(`${objectId}/original.webp`)).toBeNull();
  expect(await stored(`${objectId}/thumbnail.webp`)).toBeNull();
}

beforeAll(async () => {
  previousKeys = process.env[SEAL_KEYS_ENV];
  pair = generateSealKeyPair("test-kid-1");
  process.env[SEAL_KEYS_ENV] = sealKeysEnvValue(pair);
  fx = await createEdgeSelfieFixture();
}, 60_000);

beforeEach(() => {
  process.env[SEAL_KEYS_ENV] = sealKeysEnvValue(pair);
  storage = new RecordingStorage();
  app = buildApp(storage);
});

afterAll(async () => {
  if (previousKeys === undefined) delete process.env[SEAL_KEYS_ENV];
  else process.env[SEAL_KEYS_ENV] = previousKeys;
  await fx.cleanup();
}, 60_000);

describe("legend-0wvoz test sealer (proves the helper before the cloud is blamed)", () => {
  it("seals without plain image bytes and opens back to the same plainSha256", async () => {
    const webp = await sampleWebp(3);
    const objectId = randomUUID();
    const sealed = await seal(objectId, { webp });
    expect(sealed.subarray(0, 4).toString("ascii")).toBe("LSS1");
    expect(sealed.includes(webp)).toBe(false);
    expect(sealed.includes(Buffer.from("WEBP"))).toBe(false);
    const opened = openSealed(sealed, pair.privateKeyPem);
    expect(opened.header).toMatchObject({ v: 1, kid: pair.kid, objectId });
    expect(opened.meta.plainSha256).toBe(sha256Hex(webp));
    expect(opened.webp.equals(webp)).toBe(true);
    expect(() =>
      openSealed(withBrokenTag(sealed), pair.privateKeyPem),
    ).toThrow();
  });
});

describe("legend-0wvoz T6 receive: store, retry, conflict", () => {
  it("201 stores original and thumbnail under ${objectId}/original.webp and thumbnail.webp, one object row, one receipt", async () => {
    const objectId = randomUUID();
    const sealed = await seal(objectId);
    const response = await put(objectId, sealed);
    expect(response.status, JSON.stringify(response.body)).toBe(201);

    const original = await stored(`${objectId}/original.webp`);
    const thumbnail = await stored(`${objectId}/thumbnail.webp`);
    expect(original).not.toBeNull();
    expect(thumbnail).not.toBeNull();
    // The cloud stores the decrypted, re-encoded image, never the sealed file.
    expect(looksLikeImage(original!)).toBe(true);
    expect(original!.equals(sealed)).toBe(false);

    expect(await fx.objectRow(objectId)).toMatchObject({
      id: objectId,
      outlet_id: fx.outletA,
      purpose: "selfie",
      object_key: `${objectId}/original.webp`,
      thumbnail_key: `${objectId}/thumbnail.webp`,
      content_type: "image/webp",
      owner_user_id: fx.employee.userId,
      source_kind: "attendance",
      // No attendance log points at it yet: not linked to a source.
      source_id: null,
    });
    const receipt = await fx.receiptRow(objectId);
    expect(receipt).toMatchObject({
      state: "stored",
      outlet_id: fx.outletA,
      edge_node_id: fx.nodeA.verified.edgeNodeId,
    });
    expect(receipt!.sealed_sha256.toString("hex")).toBe(sha256Hex(sealed));
  });

  // core_storage_objects.uploaded_by records the verified uploader. The cloud
  // receiver has no user actor (the edge node is the sender), so it stays NULL;
  // the selfie's subject is recorded in owner_user_id from the sealed meta.
  it("201 leaves uploaded_by NULL and sets owner_user_id to the sealed meta ownerUserId", async () => {
    const objectId = randomUUID();
    const sealed = await seal(objectId);
    const response = await put(objectId, sealed);
    expect(response.status, JSON.stringify(response.body)).toBe(201);

    const { rows } = await fx.asTenant((client) =>
      client.query<{
        uploaded_by: string | null;
        owner_user_id: string | null;
      }>(
        `SELECT uploaded_by, owner_user_id
           FROM core_storage_objects WHERE tenant_id = $1 AND id = $2`,
        [fx.tenantId, objectId],
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.uploaded_by).toBeNull();
    expect(rows[0]!.owner_user_id).toBe(fx.employee.userId);
  });

  it("201 then 200 on a retry with the same bytes, and the retry writes nothing", async () => {
    const objectId = randomUUID();
    const sealed = await seal(objectId);
    expect((await put(objectId, sealed)).status).toBe(201);
    const putsAfterFirst = storage.puts.length;
    const row = await fx.objectRow(objectId);

    expect((await put(objectId, sealed)).status).toBe(200);
    expect(storage.puts).toHaveLength(putsAfterFirst);
    expect(await fx.objectRow(objectId)).toEqual(row);
    const receipts = await fx.asTenant((client) =>
      client.query(
        "SELECT 1 FROM edge_received_selfies WHERE tenant_id = $1 AND object_id = $2",
        [fx.tenantId, objectId],
      ),
    );
    expect(receipts.rowCount).toBe(1);
  });

  it("a failure after the S3 put cleans up under the lock: a concurrent retry that stores its files keeps them", async () => {
    const flaky = new FailThumbnailOnceStorage();
    storage = flaky;
    app = buildApp(flaky);
    const objectId = randomUUID();
    const sealed = await seal(objectId);

    const first = put(objectId, sealed).then((response) => response);
    await flaky.reached;
    const retry = put(objectId, sealed).then((response) => response);
    flaky.deleteWaitsFor = retry;
    // Let the retry reach the object lock the first call still holds.
    await new Promise((resolve) => setTimeout(resolve, 200));
    flaky.releaseFailure();

    const [firstResponse, retryResponse] = await Promise.all([first, retry]);
    expect(firstResponse.status).toBe(500);
    expect(retryResponse.status, JSON.stringify(retryResponse.body)).toBe(201);
    expect(await stored(`${objectId}/original.webp`)).not.toBeNull();
    expect(await stored(`${objectId}/thumbnail.webp`)).not.toBeNull();
    expect(await fx.objectRow(objectId)).toBeDefined();
    expect(await fx.receiptRow(objectId)).toBeDefined();
  });

  it("409 for the same object id with different sealed bytes, the stored selfie is untouched", async () => {
    const objectId = randomUUID();
    const first = await seal(objectId);
    expect((await put(objectId, first)).status).toBe(201);
    const original = await stored(`${objectId}/original.webp`);
    const putsAfterFirst = storage.puts.length;

    // Same id, a different image: another sealed hash.
    const second = await seal(objectId, { webp: await sampleWebp(200) });
    expect(sha256Hex(second)).not.toBe(sha256Hex(first));
    const response = await put(objectId, second);
    expect(response.status).toBe(409);
    expect(storage.puts).toHaveLength(putsAfterFirst);
    expect((await stored(`${objectId}/original.webp`))!.equals(original!)).toBe(
      true,
    );
    expect((await fx.receiptRow(objectId))!.sealed_sha256.toString("hex")).toBe(
      sha256Hex(first),
    );
  });

  it("two concurrent PUTs of one object give one 201 and one 200, never a 500", async () => {
    const objectId = randomUUID();
    const sealed = await seal(objectId);
    const responses = await Promise.all([
      put(objectId, sealed),
      put(objectId, sealed),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 201,
    ]);
    // Exactly one run wrote: original + thumbnail once, one row, one receipt.
    expect(storage.puts.sort()).toEqual([
      `${objectId}/original.webp`,
      `${objectId}/thumbnail.webp`,
    ]);
    expect(await fx.objectRow(objectId)).toBeDefined();
    expect(await fx.receiptRow(objectId)).toBeDefined();
  });

  it("409 OBJECT_ID_TAKEN for the id of an existing phone selfie, its S3 object stays untouched", async () => {
    const objectId = randomUUID();
    const phoneBytes = Buffer.from("phone-selfie-original");
    await storage.put(fx.scopeOf([fx.outletA]), {
      tenantId: tenantIdSchema.parse(fx.tenantId),
      outletId: outletIdSchema.parse(fx.outletA),
      reference: objectId,
      key: `${objectId}/original.webp`,
      contentType: "image/webp",
      content: new Uint8Array(phoneBytes),
      visibility: "private",
    });
    storage.puts = [];
    // A phone upload: an object row with no edge receipt.
    await fx.asTenant((client) =>
      client.query(
        `INSERT INTO core_storage_objects
           (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes,
            thumbnail_key, owner_user_id)
         VALUES ($1, $2, $3, 'selfie', $4, 'image/webp', 21, $5, $6)`,
        [
          fx.tenantId,
          fx.outletA,
          objectId,
          `${objectId}/original.webp`,
          `${objectId}/thumbnail.webp`,
          fx.employee.userId,
        ],
      ),
    );

    const response = await put(objectId, await seal(objectId));
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("OBJECT_ID_TAKEN");
    expect(storage.puts).toEqual([]);
    expect(
      (await stored(`${objectId}/original.webp`))!.equals(phoneBytes),
    ).toBe(true);
    expect(await fx.receiptRow(objectId)).toBeUndefined();
  });

  it("409 OBJECT_ID_TAKEN for an object id held at another outlet (hidden by RLS), nothing written to storage", async () => {
    const objectId = randomUUID();
    await fx.asTenant((client) =>
      client.query(
        `INSERT INTO core_storage_objects
           (tenant_id, outlet_id, id, purpose, object_key, content_type, size_bytes,
            thumbnail_key, owner_user_id)
         VALUES ($1, $2, $3, 'selfie', $4, 'image/webp', 21, $5, $6)`,
        [
          fx.tenantId,
          fx.outletB,
          objectId,
          `${objectId}/original.webp`,
          `${objectId}/thumbnail.webp`,
          fx.employee.userId,
        ],
      ),
    );
    storage.puts = [];
    const response = await put(objectId, await seal(objectId));
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("OBJECT_ID_TAKEN");
    expect(storage.puts).toEqual([]);
    expect(await fx.receiptRow(objectId)).toBeUndefined();
  });
});

describe("legend-0wvoz T6 receive: scope refusals (403)", () => {
  it("403 when the sealed header names another tenant", async () => {
    const objectId = randomUUID();
    const sealed = await seal(objectId, { tenantId: randomUUID() });
    expect((await put(objectId, sealed)).status).toBe(403);
    await expectNothingStored(objectId);
  });

  it("403 when the sealed header names another object than the path", async () => {
    const objectId = randomUUID();
    const sealed = await seal(randomUUID());
    expect((await put(objectId, sealed)).status).toBe(403);
    await expectNothingStored(objectId);
  });

  it("403 when the encrypted outletId is not the credential's outlet", async () => {
    const objectId = randomUUID();
    const sealed = await seal(objectId, {
      meta: { outletId: fx.outletB, ownerUserId: fx.employee.userId },
    });
    // Node A may not store a selfie that says it belongs to outlet B.
    expect((await put(objectId, sealed)).status).toBe(403);
    await expectNothingStored(objectId);
  });

  it("403 for another outlet's credential: node B cannot upload a selfie of outlet A", async () => {
    const objectId = randomUUID();
    const sealed = await seal(objectId); // meta.outletId = outlet A
    const response = await put(objectId, sealed, {
      credential: fx.nodeB.credential,
    });
    expect(response.status).toBe(403);
    await expectNothingStored(objectId);
    // The same file from the right node is accepted.
    expect((await put(objectId, sealed)).status).toBe(201);
  });

  it("403 when ownerUserId is not the user of an employee of the tenant", async () => {
    const objectId = randomUUID();
    const sealed = await seal(objectId, {
      meta: { outletId: fx.outletA, ownerUserId: randomUUID() },
    });
    expect((await put(objectId, sealed)).status).toBe(403);
    await expectNothingStored(objectId);
  });

  it("401 without a credential or with an unknown one", async () => {
    const objectId = randomUUID();
    const sealed = await seal(objectId);
    expect((await put(objectId, sealed, { credential: null })).status).toBe(
      401,
    );
    expect(
      (await put(objectId, sealed, { credential: `edge-${randomUUID()}` }))
        .status,
    ).toBe(401);
    await expectNothingStored(objectId);
  });
});

describe("legend-0wvoz T6 receive: cannot decrypt (422), transport (400), availability (503), size (413)", () => {
  it("422 for a broken GCM tag", async () => {
    const objectId = randomUUID();
    const response = await put(objectId, withBrokenTag(await seal(objectId)));
    expect(response.status).toBe(422);
    await expectNothingStored(objectId);
  });

  it("422 for an edited header: same fields, different bytes break the tag", async () => {
    const objectId = randomUUID();
    const edited = withEditedHeader(await seal(objectId), (header) => {
      const { alg, ...rest } = header;
      return { ...rest, alg };
    });
    expect((await put(objectId, edited)).status).toBe(422);
    await expectNothingStored(objectId);
  });

  it("422 for a kid the cloud holds no key for, a body that is not LSS1, and a wrong plainSha256", async () => {
    const stranger = generateSealKeyPair("unknown-kid");
    const objectId = randomUUID();
    expect(
      (await put(objectId, await seal(objectId, { pair: stranger }))).status,
    ).toBe(422);
    const garbage = randomBytes(300);
    expect((await put(objectId, garbage)).status).toBe(422);
    expect(
      (
        await put(
          objectId,
          await seal(objectId, { plainSha256: "0".repeat(64) }),
        )
      ).status,
    ).toBe(422);
    await expectNothingStored(objectId);
  });

  it("400 when X-Legend-Sealed-Sha256 does not match the body", async () => {
    const objectId = randomUUID();
    const response = await put(objectId, await seal(objectId), {
      sha: sha256Hex(Buffer.from("something else")),
    });
    expect(response.status).toBe(400);
    await expectNothingStored(objectId);
  });

  it("503 SELFIE_SEAL_KEY_MISSING when the cloud has no seal keys configured", async () => {
    delete process.env[SEAL_KEYS_ENV];
    const objectId = randomUUID();
    const response = await put(objectId, await seal(objectId));
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("SELFIE_SEAL_KEY_MISSING");
    await expectNothingStored(objectId);
    // The key is read per call: once configured, the same upload works.
    process.env[SEAL_KEYS_ENV] = sealKeysEnvValue(pair);
    expect((await put(objectId, await seal(objectId))).status).toBe(201);
  });

  it("503 when the app has no object storage runtime", async () => {
    const objectId = randomUUID();
    const response = await put(objectId, await seal(objectId), {
      app: buildApp(null),
    });
    expect(response.status).toBe(503);
    expect(await fx.receiptRow(objectId)).toBeUndefined();
  });

  it("413 for a body over the sealed size cap", async () => {
    const objectId = randomUUID();
    const response = await put(
      objectId,
      Buffer.alloc(EDGE_SELFIE_SEALED_MAX_BYTES + 1, 7),
    );
    expect(response.status).toBe(413);
    await expectNothingStored(objectId);
  });

  it("429 when one IP floods the endpoint before authentication", async () => {
    const limited = buildApp(storage, { perIp: 2, windowMs: 60_000 });
    const objectId = randomUUID();
    const sealed = await seal(objectId);
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++)
      statuses.push(
        (await put(objectId, sealed, { app: limited, credential: null }))
          .status,
      );
    expect(statuses).toEqual([401, 401, 429]);
  });
});

describe("legend-0wvoz T6 receive: linking with the attendance log in either order (6.3)", () => {
  it("event then selfie: the log is linked when the selfie arrives", async () => {
    const objectId = randomUUID();
    const { event, attendanceLogId } = fx.attendanceEvent({
      selfieObjectId: objectId,
    });
    await fx.applyEvent(event);
    expect((await fx.logByClientEvent(attendanceLogId))!.photo_key).toBe(
      objectId,
    );

    expect((await put(objectId, await seal(objectId))).status).toBe(201);
    const log = (await fx.logByClientEvent(attendanceLogId))!;
    expect(log.photo_key).toBe(objectId);
    expect(log.flag_reasons).not.toContain("selfie_unlinked");
    expect(await fx.objectRow(objectId)).toMatchObject({
      source_kind: "attendance",
      source_id: log.id,
    });
  });

  it("selfie then event: the log is linked when the event arrives", async () => {
    const objectId = randomUUID();
    expect((await put(objectId, await seal(objectId))).status).toBe(201);
    expect((await fx.objectRow(objectId))!.source_id).toBeNull();

    const { event, attendanceLogId } = fx.attendanceEvent({
      selfieObjectId: objectId,
    });
    await fx.applyEvent(event);
    const log = (await fx.logByClientEvent(attendanceLogId))!;
    expect(log.photo_key).toBe(objectId);
    expect(log.flag_reasons).not.toContain("selfie_unlinked");
    expect(await fx.objectRow(objectId)).toMatchObject({
      source_kind: "attendance",
      source_id: log.id,
    });
  });

  it("owner is not the log's employee, event then selfie: upload still 201, log kept with photo_key NULL and selfie_unlinked", async () => {
    const objectId = randomUUID();
    const { event, attendanceLogId } = fx.attendanceEvent({
      selfieObjectId: objectId,
    });
    await fx.applyEvent(event);
    const response = await put(
      objectId,
      await seal(objectId, {
        meta: { outletId: fx.outletA, ownerUserId: fx.otherEmployee.userId },
      }),
    );
    // Linking is best effort: it never refuses the upload.
    expect(response.status).toBe(201);
    const log = (await fx.logByClientEvent(attendanceLogId))!;
    expect(log.photo_key).toBeNull();
    expect(log.flag_reasons).toEqual(
      expect.arrayContaining(["offline_unverified", "selfie_unlinked"]),
    );
    expect(log.review_status).toBe("pending");
    expect((await fx.objectRow(objectId))!.source_id).toBeNull();
  });

  it("owner is not the log's employee, selfie then event: the event is applied, log kept with photo_key NULL and selfie_unlinked", async () => {
    const objectId = randomUUID();
    expect(
      (
        await put(
          objectId,
          await seal(objectId, {
            meta: {
              outletId: fx.outletA,
              ownerUserId: fx.otherEmployee.userId,
            },
          }),
        )
      ).status,
    ).toBe(201);
    const { event, attendanceLogId } = fx.attendanceEvent({
      selfieObjectId: objectId,
    });
    await fx.applyEvent(event);
    const log = (await fx.logByClientEvent(attendanceLogId))!;
    expect(log).toBeDefined();
    expect(log.photo_key).toBeNull();
    expect(log.flag_reasons).toEqual(
      expect.arrayContaining(["offline_unverified", "selfie_unlinked"]),
    );
    expect(log.review_status).toBe("pending");
    expect(await fx.logCount()).toBeGreaterThanOrEqual(1);
  });

  it("a failed link keeps a leave_approved flag that lands while it runs (atomic append, no lost update)", async () => {
    const objectId = randomUUID();
    const { event, attendanceLogId } = fx.attendanceEvent({
      selfieObjectId: objectId,
    });
    await fx.applyEvent(event);
    const before = (await fx.logByClientEvent(attendanceLogId))!;

    // A concurrent transaction flags the log for leave and commits only after
    // the link has read the old flag_reasons and queued on the row.
    const a = await fx.owner.connect();
    let committed = false;
    let upload: ReturnType<typeof put> | null = null;
    try {
      await a.query("BEGIN");
      await a.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [fx.tenantId],
      );
      await a.query(
        `UPDATE attendance_logs
            SET validity = 'flagged', review_status = 'pending',
                flag_reasons = flag_reasons || '["leave_approved"]'::jsonb
          WHERE tenant_id = $1 AND id = $2`,
        [fx.tenantId, before.id],
      );
      upload = put(
        objectId,
        await seal(objectId, {
          meta: { outletId: fx.outletA, ownerUserId: fx.otherEmployee.userId },
        }),
      );
      const settled = upload.then(
        (value) => value,
        (error) => error,
      );
      const deadline = Date.now() + 20_000;
      for (;;) {
        const { rows } = await fx.owner.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_locks
            WHERE NOT granted AND locktype IN ('transactionid', 'tuple')`,
        );
        if (rows[0]!.n > 0) break;
        if (Date.now() > deadline)
          throw new Error("the link never queued on the log row");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await a.query("COMMIT");
      committed = true;
      expect((await settled).status).toBe(201);
    } finally {
      if (!committed) await a.query("ROLLBACK").catch(() => undefined);
      a.release();
      if (upload) await Promise.resolve(upload).catch(() => undefined);
    }
    const log = (await fx.logByClientEvent(attendanceLogId))!;
    expect(log.photo_key).toBeNull();
    expect(log.flag_reasons).toEqual(
      expect.arrayContaining([
        "offline_unverified",
        "selfie_unlinked",
        "leave_approved",
      ]),
    );
    expect(
      log.flag_reasons.filter((reason: string) => reason === "selfie_unlinked"),
    ).toHaveLength(1);
  });
});

describe("legend-0wvoz receiveEdgeSelfie service", () => {
  it("returns {status: 201} for a new object and {status: 200} for the same bytes again", async () => {
    const objectId = randomUUID();
    const sealed = await seal(objectId);
    const deps = {
      database: db,
      storage,
      scanner: new NoopMalwareScanner(),
    };
    const input = {
      objectId,
      body: sealed,
      sealedSha256Header: sha256Hex(sealed),
    };
    expect(await receiveEdgeSelfie(deps, fx.nodeA.verified, input)).toEqual({
      status: 201,
    });
    expect(await receiveEdgeSelfie(deps, fx.nodeA.verified, input)).toEqual({
      status: 200,
    });
  });

  it("refuses a sha header that does not match the body before touching anything", async () => {
    const objectId = randomUUID();
    const sealed = await seal(objectId);
    await expect(
      receiveEdgeSelfie(
        { database: db, storage, scanner: new NoopMalwareScanner() },
        fx.nodeA.verified,
        {
          objectId,
          body: sealed,
          sealedSha256Header: sha256Hex(Buffer.from("other")),
        },
      ),
    ).rejects.toBeTruthy();
    await expectNothingStored(objectId);
  });
});
