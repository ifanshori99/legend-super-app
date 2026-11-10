// legend-jmsdx: staff PIN pepper per OUTLET (versions >= 2), cloud rehash of
// older rows, edge reset for version 1. Acceptance tests against the shared
// contract in docs/briefs/sub-jmsdx-pepper.md and the decision "Pepper PIN per
// outlet" (docs/DECISIONS.md 2026-11-10). Tier K (PIN hashes).
//
// Criteria, one `it` each, named with their id:
//   (a) the pepper of outlet A differs from outlet B (same tenant, same version)
//   (b) an edge of outlet A without the root verifies outlet A's staff PIN, and
//       its pepper cannot verify a hash of outlet B
//   (c) the sync never sends version 1 nor another outlet's pepper
//   (d) cloud verify of a version 1 row rehashes it to the current version
//   (e) edge verify of a version 1 row is 409 STAFF_PIN_RESET_REQUIRED, no count
//   (f) the rehash keeps pin_generation_at; a newer PIN set on the edge survives
//   (g) the sync only sends versions the edge does not hold yet
//   (h) a PIN set on an edge verifies on the cloud
//
// Assumptions (the contract leaves them open):
// - The edge is simulated in-process, as the other edge PIN tests do: the
//   peppers the cloud would send (`staffPinPeppersForEdge`) are installed in
//   the edge registry (which makes the pepper module behave as an edge: no
//   root, own outlet only) and EDGE_MODE=true is set around the call. The same
//   database plays both sides; a test rewrites the row to the state the other
//   side would hold.
// - `installEdgeStaffPinPeppers(tenant, outlet, peppers)` and
//   `edgeStaffPinPepperVersionsHeld()` have the signatures of the contract.
// - The sync query `peppers=2,3` lists the versions held; `peppers=` (empty
//   string) holds none; without the parameter meta carries no `peppers`.
// - Test time never depends on a clock: row "ages" are set in SQL by >= 1 min.
import { randomUUID } from "node:crypto";
import express from "express";
import { Pool } from "pg";
import request from "supertest";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import type { StaffPinEdgeRecord } from "@starter/shared/access/override";
import {
  outletIdSchema,
  type ScopedTenantContext,
  type TenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  DEVICE_TOKEN_HEADER,
  cafeLegendPlatformFixtures,
} from "@starter/shared/platform";
import { createApp } from "../app";
import { signDeviceToken } from "../lib/device-token";
import { errorHandler } from "../middleware/error-handler";
import { tenantContext as tenantContextMiddleware } from "../middleware/tenant";
import { createStaffPinSyncRouter } from "../routes/staff-pin-sync.routes";
import { setAuditWriter } from "../services/audit-writer";
import { createDeviceOutletResolver } from "../services/device-outlet-resolver";
import {
  hashStaffPin,
  verifyStaffPinHash,
  type StaffPinBinding,
} from "../services/device-pin-hash";
import {
  currentStaffPinPepperVersion,
  staffPinPepper,
  staffPinPepperOrNull,
  staffPinPeppersForEdge,
} from "../services/device-pin-pepper";
import {
  attemptStaffPin,
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service";
import {
  applyStaffPinRecords as applyStaffPinRecordsRaw,
  listStaffPinRecordsSince,
  setEdgeCredentialVerifier,
  type VerifiedEdgeNode,
} from "../services/staff-pin-sync";
import {
  installEdgeStaffPinPeppers,
  resetEdgeStaffPinPeppers,
} from "../edge/staff-pin-pepper-registry";
import { withEdgeModeEnv } from "./edge-mode-env";
import { agent } from "./helpers";

const app = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendAccessFixtures.outletIds.bandung;
const outletB = cafeLegendAccessFixtures.outletIds.bandung2;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

const PIN = "582914";
const PIN_C = "915273";
const PIN_E = "730418";
const WRONG = "907153";
const MINUTE = 60_000;

const tenant: TenantContext = establishTenantContext({
  tenantId,
  brandId: null,
  source: "session",
});
const edgeContext: ScopedTenantContext = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "device" }),
  { kind: "outlets", outletIds: [outletIdSchema.parse(outletA)] },
);

const createdUsers: string[] = [];
const registeredDevices: string[] = [];

// ------------------------------------------------------------------ helpers

/** A cashier of the given outlets. */
async function newStaff(outlets: string[]): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Staf Pepper Outlet', $2)`,
    [id, `${id}@example.test`],
  );
  createdUsers.push(id);
  const role = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'cashier'",
    [tenantId],
  );
  for (const outlet of outlets)
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
      [tenantId, id, role.rows[0]!.id, outlet],
    );
  return id;
}

const setPin = (userId: string, outletId: string, pin: string) =>
  setStaffPin(tenant, userId, { outletId, userId }, { pin });

type PinRow = {
  id: string;
  pin_hash: string;
  pin_salt: string;
  kdf_n: number;
  kdf_r: number;
  kdf_p: number;
  pepper_version: number;
  failed_attempts: number;
  locked_until: Date | null;
  pin_generation_at: Date;
  pin_set_at: Date;
  cloud_generation_at: Date | null;
  generation_edge_node_id: string | null;
  generation_edge_sequence: string | null;
  updated_at: Date;
};

async function rowOf(userId: string, outletId: string): Promise<PinRow> {
  const { rows } = await owner.query<PinRow>(
    `SELECT id, pin_hash, pin_salt, kdf_n, kdf_r, kdf_p, pepper_version,
            failed_attempts, locked_until, pin_generation_at, pin_set_at,
            cloud_generation_at, generation_edge_node_id,
            generation_edge_sequence::text AS generation_edge_sequence,
            updated_at
       FROM staff_pins
      WHERE tenant_id = $1 AND outlet_id = $2 AND user_id = $3`,
    [tenantId, outletId, userId],
  );
  return rows[0]!;
}

const bindingOf = (userId: string, outletId: string): StaffPinBinding => ({
  tenantId,
  outletId,
  userId,
});

const storedOf = (row: PinRow) => ({
  salt: row.pin_salt,
  pinHash: row.pin_hash,
  params: {
    N: row.kdf_n,
    r: row.kdf_r,
    p: row.kdf_p,
    keyLength: 32 as const,
  },
});

/**
 * Rewrites the row as a version 1 row (hash under the per-tenant pepper), the
 * way dev and staging data from before this change look. Generation columns
 * stay as they are; `updated_at` goes one hour into the past.
 */
async function downgradeToV1(userId: string, outletId: string, pin: string) {
  const hashed = await hashStaffPin({
    pepper: staffPinPepper(tenantId, outletId, 1),
    binding: bindingOf(userId, outletId),
    pin,
  });
  await owner.query(
    `UPDATE staff_pins
        SET pin_hash = $4, pin_salt = $5, kdf_n = $6, kdf_r = $7, kdf_p = $8,
            pepper_version = 1, updated_at = now() - interval '1 hour'
      WHERE tenant_id = $1 AND outlet_id = $2 AND user_id = $3`,
    [
      tenantId,
      outletId,
      userId,
      hashed.pinHash,
      hashed.salt,
      hashed.params.N,
      hashed.params.r,
      hashed.params.p,
    ],
  );
}

/**
 * Runs `run` as the edge node of `outletId`: the registry holds exactly what
 * the cloud would send that outlet (no root, own outlet only, no version 1)
 * and EDGE_MODE is on. Computed on the cloud side first, then switched.
 */
async function asEdgeNode<T>(
  outletId: string,
  run: () => Promise<T>,
): Promise<T> {
  const { rows } = await owner.query<{ pepper_version: number }>(
    `SELECT DISTINCT pepper_version FROM staff_pins WHERE tenant_id = $1 AND outlet_id = $2`,
    [tenantId, outletId],
  );
  const delivered = staffPinPeppersForEdge(
    tenantId,
    outletId,
    [],
    rows.map((row) => row.pepper_version),
  );
  installEdgeStaffPinPeppers(
    tenantId,
    outletId,
    delivered.map((entry) => ({
      version: entry.version,
      pepper: Buffer.from(entry.pepper, "base64"),
    })),
  );
  const previous = process.env.EDGE_MODE;
  process.env.EDGE_MODE = "true";
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.EDGE_MODE;
    else process.env.EDGE_MODE = previous;
    resetEdgeStaffPinPeppers();
  }
}

/** A device enrolled at the outlet in the real registry, and its token. */
async function deviceTokenAt(outletId: string): Promise<string> {
  const deviceId = randomUUID();
  const issuedAt = Math.floor(Date.now() / 1000);
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    await client.query(
      `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
       VALUES ($1, $2, $3, 'pos', 'Kasir pepper outlet', $4)`,
      [deviceId, tenantId, outletId, new Date(issuedAt * 1000)],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  registeredDevices.push(deviceId);
  return signDeviceToken({
    version: 1,
    tenantId,
    brandId: null,
    deviceId,
    issuedAt,
  });
}

const verifyOverHttp = (token: string, userId: string, pin: string) =>
  agent(app)
    .post("/api/staff-pins/verify")
    .set(DEVICE_TOKEN_HEADER, token)
    .send({ userId, pin });

const applyStaffPinRecords = (
  ...args: Parameters<typeof applyStaffPinRecordsRaw>
) => withEdgeModeEnv(() => applyStaffPinRecordsRaw(...args));

// ----------------------------------------------------- sync (cloud export)

const syncPath = "/api/edge-sync/staff-pin-records";
const syncNode: VerifiedEdgeNode = {
  tenantId,
  outletId: outletIdSchema.parse(outletA),
  edgeNodeId: randomUUID(),
};
const CREDENTIAL = `edge-${randomUUID()}`;
const bearer = { Authorization: `Bearer ${CREDENTIAL}` };
const syncApp = express();
syncApp.use(
  tenantContextMiddleware({
    required: false,
    resolveDomain: async () => null,
    verifyCredential: async () => null,
  }),
);
syncApp.use(
  syncPath,
  createStaffPinSyncRouter({ perIp: 10_000, perNode: 10_000 }),
);
syncApp.use(errorHandler);

type SyncBody = {
  data: Array<{ userId: string }>;
  meta: { peppers?: Array<{ version: number; pepper: string }> };
};

async function pullPeppers(query: string | null): Promise<{
  status: number;
  text: string;
  body: SyncBody;
}> {
  const response = await request(syncApp)
    .get(query === null ? syncPath : `${syncPath}?peppers=${query}`)
    .set(bearer);
  return {
    status: response.status,
    text: response.text,
    body: response.body as SyncBody,
  };
}

/** One export pass of outlet A to the end (records of every page). */
async function exportAll(): Promise<StaffPinEdgeRecord[]> {
  const records: StaffPinEdgeRecord[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const result = await listStaffPinRecordsSince(syncNode, {
      since: cursor,
      limit: 100,
    });
    records.push(...result.data);
    if (result.meta.nextCursor === null) break;
    cursor = result.meta.nextCursor;
  }
  return records;
}

/**
 * Exports until the staff member's record shows up: a transaction of another
 * test file that is still open holds the commit watermark back for a moment,
 * so a positive assertion polls instead of reading once.
 */
async function exportRecordOf(userId: string): Promise<StaffPinEdgeRecord> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const found = (await exportAll()).find((row) => row.userId === userId);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The staff pin record was not exported");
}

// ----------------------------------------------- fresh module graph (pure)

type PepperModule = typeof import("../services/device-pin-pepper");
type RegistryModule = typeof import("../edge/staff-pin-pepper-registry");
let loadedRegistry: RegistryModule | null = null;

/** Fresh pepper + registry modules; `currentVersion` mocks the env value. */
async function loadFresh(
  currentVersion: number,
): Promise<{ pepper: PepperModule; registry: RegistryModule }> {
  vi.resetModules();
  // A plain stand-in: the real module parses process.env at import time.
  vi.doMock("../config/env", () => ({
    env: {
      EDGE_MODE: false,
      isProduction: false,
      STAFF_PIN_PEPPER: undefined,
      STAFF_PIN_PEPPER_CURRENT_VERSION: currentVersion,
    },
  }));
  const pepper = await import("../services/device-pin-pepper");
  const registry = await import("../edge/staff-pin-pepper-registry");
  loadedRegistry = registry;
  return { pepper, registry };
}

// -------------------------------------------------------------------- hooks

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter({ record: async () => {} });
  setDeviceOutletResolver(createDeviceOutletResolver());
  setEdgeCredentialVerifier(async ({ credential }) =>
    credential === CREDENTIAL ? syncNode : null,
  );
});

afterEach(() => {
  loadedRegistry?.resetEdgeStaffPinPeppers();
  loadedRegistry = null;
  vi.doUnmock("../config/env");
  resetEdgeStaffPinPeppers();
  delete process.env.EDGE_MODE;
});

afterAll(async () => {
  setAuditWriter(null);
  setDeviceOutletResolver(null);
  setEdgeCredentialVerifier(null);
  if (registeredDevices.length > 0) {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenantId],
      );
      await client.query(
        "DELETE FROM device_pin_throttle WHERE tenant_id = $1 AND device_id = ANY($2::uuid[])",
        [tenantId, registeredDevices],
      );
      await client.query("DELETE FROM devices WHERE id = ANY($1::uuid[])", [
        registeredDevices,
      ]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  await owner.query(
    `DELETE FROM staff_pins WHERE tenant_id = $1 AND user_id = ANY($2::text[])`,
    [tenantId, createdUsers],
  );
  await owner.query(
    "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
    [tenantId, createdUsers],
  );
  await owner.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [
    createdUsers,
  ]);
  await owner.end();
});

// -------------------------------------------------------------------- tests

describe("legend-jmsdx staff PIN pepper per outlet", () => {
  it("(a) the pepper of outlet A differs from outlet B for the same tenant and version", async () => {
    const { pepper } = await loadFresh(2);
    const a = pepper.staffPinPepper(tenantId, outletA, 2);
    const b = pepper.staffPinPepper(tenantId, outletB, 2);
    expect(a).toHaveLength(32);
    expect(b).toHaveLength(32);
    expect(a.equals(b)).toBe(false);
    // Deterministic per outlet.
    expect(a.equals(pepper.staffPinPepper(tenantId, outletA, 2))).toBe(true);
    // Another tenant at the same outlet id gets another pepper too.
    expect(a.equals(pepper.staffPinPepper(randomUUID(), outletA, 2))).toBe(
      false,
    );
    // Version 1 stays per tenant: it does not depend on the outlet.
    expect(
      pepper
        .staffPinPepper(tenantId, outletA, 1)
        .equals(pepper.staffPinPepper(tenantId, outletB, 1)),
    ).toBe(true);
    expect(pepper.staffPinPepper(tenantId, outletA, 1).equals(a)).toBe(false);
  });

  it("(b) an edge of outlet A without the root verifies outlet A's staff PIN, and its pepper cannot verify a hash of outlet B", async () => {
    const userId = await newStaff([outletA, outletB]);
    await setPin(userId, outletA, PIN);
    await setPin(userId, outletB, PIN);
    const rowA = await rowOf(userId, outletA);
    const rowB = await rowOf(userId, outletB);
    expect(rowA.pepper_version).toBe(currentStaffPinPepperVersion());
    expect(rowB.pepper_version).toBe(currentStaffPinPepperVersion());

    // Outlet B's hash needs outlet B's pepper: outlet A's pepper fails.
    const version = currentStaffPinPepperVersion();
    const pepperA = staffPinPepper(tenantId, outletA, version);
    const pepperB = staffPinPepper(tenantId, outletB, version);
    expect(
      await verifyStaffPinHash({
        pepper: pepperB,
        binding: bindingOf(userId, outletB),
        pin: PIN,
        stored: storedOf(rowB),
      }),
    ).toBe(true);
    expect(
      await verifyStaffPinHash({
        pepper: pepperA,
        binding: bindingOf(userId, outletB),
        pin: PIN,
        stored: storedOf(rowB),
      }),
    ).toBe(false);

    await asEdgeNode(outletA, async () => {
      // No root: nothing but outlet A's own delivered peppers.
      expect(() => staffPinPeppersForEdge(tenantId, outletA, [], [])).toThrow();
      expect(
        staffPinPepperOrNull(tenantId, outletA, version)?.equals(pepperA),
      ).toBe(true);
      expect(staffPinPepperOrNull(tenantId, outletB, version)).toBeNull();
      expect(staffPinPepperOrNull(tenantId, outletA, 1)).toBeNull();
      // The edge verifies its own outlet's PIN...
      expect(
        await attemptStaffPin(tenant, { outletId: outletA, userId, pin: PIN }),
      ).toEqual({ kind: "ok", userId });
      // ...and cannot verify the hash of outlet B, even with the right PIN.
      expect(
        await attemptStaffPin(tenant, { outletId: outletB, userId, pin: PIN }),
      ).toEqual({ kind: "invalid" });
    });
  });

  it("(c) the sync never sends version 1 or another outlet's pepper", async () => {
    const staffA1 = await newStaff([outletA]);
    const staffA2 = await newStaff([outletA]);
    const staffB = await newStaff([outletB]);
    await setPin(staffA1, outletA, PIN);
    await setPin(staffA2, outletA, PIN);
    await setPin(staffB, outletB, PIN);
    // Outlet A has a version 1 row; the edge must still never get version 1.
    await downgradeToV1(staffA2, outletA, PIN);

    const current = currentStaffPinPepperVersion();
    const foreign = [
      staffPinPepper(tenantId, outletB, current).toString("base64"),
      staffPinPepper(tenantId, outletB, 2).toString("base64"),
      staffPinPepper(tenantId, outletA, 1).toString("base64"),
    ];

    for (const query of ["", "1", "2", "2,3", "1,2"]) {
      const answer = await pullPeppers(query);
      expect(answer.status, answer.text).toBe(200);
      const peppers = answer.body.meta.peppers ?? [];
      const held = query === "" ? [] : query.split(",").map(Number);
      for (const entry of peppers) {
        expect(entry.version).toBeGreaterThanOrEqual(2);
        expect(held).not.toContain(entry.version);
        expect(
          Buffer.from(entry.pepper, "base64").equals(
            staffPinPepper(tenantId, outletA, entry.version),
          ),
        ).toBe(true);
      }
      for (const secret of foreign) expect(answer.text).not.toContain(secret);
    }

    // An edge holding nothing is sent the current version of its own outlet.
    const none = await pullPeppers("");
    expect(
      (none.body.meta.peppers ?? []).map((entry) => entry.version),
    ).toContain(current);
    // An edge holding every version it needs is sent nothing.
    const all = await pullPeppers(
      Array.from({ length: current - 1 }, (_, index) => index + 2).join(","),
    );
    expect(all.body.meta.peppers).toEqual([]);
    // Without the parameter the edge asked for no pepper at all.
    const absent = await pullPeppers(null);
    expect(absent.status).toBe(200);
    expect(Object.keys(absent.body.meta)).not.toContain("peppers");
  });

  it("(d) a cloud verify of a version 1 row makes it a current-version row and the PIN stays correct", async () => {
    const userId = await newStaff([outletA]);
    await setPin(userId, outletA, PIN);
    await downgradeToV1(userId, outletA, PIN);
    const token = await deviceTokenAt(outletA);
    const before = await rowOf(userId, outletA);
    expect(before.pepper_version).toBe(1);

    // A wrong PIN never rehashes.
    const wrong = await verifyOverHttp(token, userId, WRONG);
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe("PIN_INVALID");
    const afterWrong = await rowOf(userId, outletA);
    expect(afterWrong.pepper_version).toBe(1);
    expect(afterWrong.pin_hash).toBe(before.pin_hash);

    // The right PIN does, in the same request.
    const ok = await verifyOverHttp(token, userId, PIN);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data).toMatchObject({
      outletId: outletA,
      user: { id: userId },
    });
    const current = currentStaffPinPepperVersion();
    const after = await rowOf(userId, outletA);
    expect(after.pepper_version).toBe(current);
    expect(after.pin_hash).not.toBe(before.pin_hash);
    expect(after.pin_salt).not.toBe(before.pin_salt);
    expect(after.failed_attempts).toBe(0);
    expect(after.updated_at.getTime()).toBeGreaterThan(
      before.updated_at.getTime() + 30 * MINUTE,
    );
    // The new hash is the outlet's pepper at the current version.
    expect(
      await verifyStaffPinHash({
        pepper: staffPinPepper(tenantId, outletA, current),
        binding: bindingOf(userId, outletA),
        pin: PIN,
        stored: storedOf(after),
      }),
    ).toBe(true);

    // Afterwards the same PIN still works, and a wrong one still does not.
    expect((await verifyOverHttp(token, userId, PIN)).status).toBe(200);
    const wrongAgain = await verifyOverHttp(token, userId, WRONG);
    expect(wrongAgain.status).toBe(401);
    expect(wrongAgain.body.error.code).toBe("PIN_INVALID");
    expect((await rowOf(userId, outletA)).pepper_version).toBe(current);
  });

  it("(e) an edge verify of a version 1 row is 409 STAFF_PIN_RESET_REQUIRED and counts no failed attempt", async () => {
    const userId = await newStaff([outletA]);
    await setPin(userId, outletA, PIN);
    await downgradeToV1(userId, outletA, PIN);
    const before = await rowOf(userId, outletA);
    const token = await deviceTokenAt(outletA);

    await asEdgeNode(outletA, async () => {
      // Wrong PIN, right PIN, wrong PIN: the same answer, none is counted.
      for (const pin of [WRONG, PIN, WRONG]) {
        const response = await verifyOverHttp(token, userId, pin);
        expect(response.status, JSON.stringify(response.body)).toBe(409);
        expect(response.body.error.code).toBe("STAFF_PIN_RESET_REQUIRED");
        expect(response.body.error.message).toContain("PIN perlu diatur ulang");
      }
    });

    const after = await rowOf(userId, outletA);
    expect(after.failed_attempts).toBe(0);
    expect(after.locked_until).toBeNull();
    // The edge never rehashes.
    expect(after.pepper_version).toBe(1);
    expect(after.pin_hash).toBe(before.pin_hash);
    expect(after.pin_salt).toBe(before.pin_salt);
  });

  it("(f) the rehash keeps pin_generation_at, and a newer PIN set on the edge is not overwritten by it", async () => {
    const userId = await newStaff([outletA]);
    await setPin(userId, outletA, PIN_C);
    await downgradeToV1(userId, outletA, PIN_C);
    const old = await rowOf(userId, outletA);
    const token = await deviceTokenAt(outletA);

    expect((await verifyOverHttp(token, userId, PIN_C)).status).toBe(200);
    const rehashed = await rowOf(userId, outletA);
    expect(rehashed.pepper_version).toBe(currentStaffPinPepperVersion());
    expect(rehashed.pin_hash).not.toBe(old.pin_hash);
    // Only the hash material moved: the generation of the PIN did not.
    expect(rehashed.pin_generation_at).toEqual(old.pin_generation_at);
    expect(rehashed.pin_set_at).toEqual(old.pin_set_at);
    expect(rehashed.cloud_generation_at).toEqual(old.cloud_generation_at);
    expect(rehashed.generation_edge_node_id).toBe(old.generation_edge_node_id);
    expect(rehashed.generation_edge_sequence).toBe(
      old.generation_edge_sequence,
    );

    // The export carries the new material with the unchanged generation key.
    const record = await exportRecordOf(userId);
    expect(record.pinHash).toBe(rehashed.pin_hash);
    expect(record.salt).toBe(rehashed.pin_salt);
    expect(record.pepperVersion).toBe(rehashed.pepper_version);
    expect(Date.parse(record.pinGenerationAt)).toBe(
      rehashed.pin_generation_at.getTime(),
    );

    // An edge holding the old material under the same key takes the rehash.
    await owner.query(
      `UPDATE staff_pins SET pin_hash = $2, pin_salt = $3, pepper_version = 1
        WHERE id = $1`,
      [old.id, old.pin_hash, old.pin_salt],
    );
    await asEdgeNode(outletA, async () => {
      const result = await applyStaffPinRecords(edgeContext, [record]);
      expect(result.applied).toBe(1);
    });
    const taken = await rowOf(userId, outletA);
    expect(taken.pin_hash).toBe(record.pinHash);
    expect(taken.pepper_version).toBe(record.pepperVersion);
    expect(taken.pin_generation_at).toEqual(old.pin_generation_at);

    // An edge that set a newer PIN meanwhile (larger key) keeps it.
    const current = currentStaffPinPepperVersion();
    const edgePin = await hashStaffPin({
      pepper: staffPinPepper(tenantId, outletA, current),
      binding: bindingOf(userId, outletA),
      pin: PIN_E,
    });
    await owner.query(
      `UPDATE staff_pins
          SET pin_hash = $2, pin_salt = $3, pepper_version = $4,
              pin_generation_at = pin_generation_at + interval '10 minutes',
              pin_set_at = pin_set_at + interval '10 minutes',
              cloud_generation_at = NULL
        WHERE id = $1`,
      [old.id, edgePin.pinHash, edgePin.salt, current],
    );
    const edgeRow = await rowOf(userId, outletA);
    await asEdgeNode(outletA, async () => {
      await applyStaffPinRecords(edgeContext, [record]);
      const kept = await rowOf(userId, outletA);
      expect(kept.pin_hash).toBe(edgeRow.pin_hash);
      expect(kept.pin_salt).toBe(edgeRow.pin_salt);
      expect(kept.pin_generation_at).toEqual(edgeRow.pin_generation_at);
      expect(
        await attemptStaffPin(tenant, {
          outletId: outletA,
          userId,
          pin: PIN_E,
        }),
      ).toEqual({ kind: "ok", userId });
      expect(
        await attemptStaffPin(tenant, {
          outletId: outletA,
          userId,
          pin: PIN_C,
        }),
      ).toEqual({ kind: "invalid" });
    });
  });

  it("(f2) a cloud rehash under the same key takes the new hash but keeps the edge's failed attempts and lock", async () => {
    const userId = await newStaff([outletA]);
    await setPin(userId, outletA, PIN_C);
    await downgradeToV1(userId, outletA, PIN_C);
    const oldA = await rowOf(userId, outletA);
    const token = await deviceTokenAt(outletA);
    expect((await verifyOverHttp(token, userId, PIN_C)).status).toBe(200);
    const record = await exportRecordOf(userId);
    const rehashed = await rowOf(userId, outletA);
    expect(record.pinHash).toBe(rehashed.pin_hash);
    expect(record.pinHash).not.toBe(oldA.pin_hash);
    expect(record.failedAttempts).toBe(0);
    expect(record.lockedUntil).toBeNull();

    // The edge still holds the old material under the same key, with its own
    // count of wrong guesses.
    const holdOldMaterial = (
      old: PinRow,
      failed: number,
      lockedMinutes: number | null,
    ) =>
      owner.query(
        `UPDATE staff_pins
            SET pin_hash = $2, pin_salt = $3, pepper_version = 1,
                failed_attempts = $4,
                locked_until = CASE WHEN $5::int IS NULL THEN NULL
                                    ELSE now() + make_interval(mins => $5::int) END,
                cloud_failed_attempts = NULL, cloud_locked_until = NULL,
                cloud_attempt_revision = NULL
          WHERE id = $1`,
        [old.id, old.pin_hash, old.pin_salt, failed, lockedMinutes],
      );
    const current = currentStaffPinPepperVersion();
    const verifiesWithNewMaterial = async () =>
      verifyStaffPinHash({
        pepper: staffPinPepper(tenantId, outletA, current),
        binding: bindingOf(userId, outletA),
        pin: PIN_C,
        stored: storedOf(await rowOf(userId, outletA)),
      });

    // Four wrong guesses on the edge stay four.
    await holdOldMaterial(oldA, 4, null);
    await asEdgeNode(outletA, async () => {
      expect((await applyStaffPinRecords(edgeContext, [record])).applied).toBe(
        1,
      );
    });
    const counted = await rowOf(userId, outletA);
    expect(counted.pin_hash).toBe(record.pinHash);
    expect(counted.pin_salt).toBe(record.salt);
    expect(counted.pepper_version).toBe(record.pepperVersion);
    expect(counted.failed_attempts).toBe(4);
    expect(counted.pin_generation_at).toEqual(oldA.pin_generation_at);
    expect(await verifiesWithNewMaterial()).toBe(true);

    // A locked edge stays locked.
    await holdOldMaterial(oldA, 5, 10);
    const lockedBefore = (await rowOf(userId, outletA)).locked_until;
    expect(lockedBefore!.getTime()).toBeGreaterThan(Date.now() + MINUTE);
    await asEdgeNode(outletA, async () => {
      await applyStaffPinRecords(edgeContext, [record]);
      const locked = await rowOf(userId, outletA);
      expect(locked.pin_hash).toBe(record.pinHash);
      expect(locked.failed_attempts).toBe(5);
      expect(locked.locked_until).toEqual(lockedBefore);
      expect(
        (
          await attemptStaffPin(tenant, {
            outletId: outletA,
            userId,
            pin: PIN_C,
          })
        ).kind,
      ).toBe("locked");
    });

    // After the lock passes the right PIN verifies with the new material.
    await owner.query(
      `UPDATE staff_pins SET locked_until = now() - interval '1 minute'
        WHERE id = $1`,
      [oldA.id],
    );
    expect(await verifiesWithNewMaterial()).toBe(true);
    await asEdgeNode(outletA, async () => {
      expect(
        await attemptStaffPin(tenant, {
          outletId: outletA,
          userId,
          pin: PIN_C,
        }),
      ).toEqual({ kind: "ok", userId });
    });
  });

  it("(g) an edge holding versions 2 and 3 with current 3 is sent only what it lacks", async () => {
    const { pepper, registry } = await loadFresh(3);

    // The edge asks with nothing and is sent {2, 3} (its rows use 2, current is 3).
    const first = pepper.staffPinPeppersForEdge(tenantId, outletA, [], [2]);
    expect(first.map((entry) => entry.version)).toEqual([2, 3]);
    registry.installEdgeStaffPinPeppers(
      tenantId,
      outletA,
      first.map((entry) => ({
        version: entry.version,
        pepper: Buffer.from(entry.pepper, "base64"),
      })),
    );
    const held = registry.edgeStaffPinPepperVersionsHeld();
    expect(held).toEqual([2, 3]);
    // Back to the cloud's view of the same modules (an edge cannot derive).
    registry.resetEdgeStaffPinPeppers();

    // It holds everything it needs: nothing is sent, version 1 rows included.
    expect(
      pepper.staffPinPeppersForEdge(tenantId, outletA, held, [2, 3]),
    ).toEqual([]);
    expect(
      pepper.staffPinPeppersForEdge(tenantId, outletA, held, [1, 2]),
    ).toEqual([]);
    // Only the missing version is sent.
    expect(
      pepper
        .staffPinPeppersForEdge(tenantId, outletA, [3], [2, 3])
        .map((entry) => entry.version),
    ).toEqual([2]);

    // After a rotation to 4: only {4}, with the outlet's own pepper.
    const next = await loadFresh(4);
    const diff = next.pepper.staffPinPeppersForEdge(
      tenantId,
      outletA,
      held,
      [2, 3],
    );
    expect(diff.map((entry) => entry.version)).toEqual([4]);
    expect(diff[0]!.pepper).toBe(
      next.pepper.staffPinPepper(tenantId, outletA, 4).toString("base64"),
    );
    expect(diff[0]!.pepper).not.toBe(
      next.pepper.staffPinPepper(tenantId, outletB, 4).toString("base64"),
    );
  });

  it("(h) a PIN set on an edge verifies on the cloud", async () => {
    const userId = await newStaff([outletA]);
    // The edge is online with the cloud's PIN history of this staff first.
    await setPin(userId, outletA, PIN_C);
    await asEdgeNode(outletA, () => setPin(userId, outletA, PIN_E));

    const row = await rowOf(userId, outletA);
    const current = currentStaffPinPepperVersion();
    expect(row.pepper_version).toBe(current);
    // The cloud derives the same outlet pepper from the root and verifies it.
    expect(
      await verifyStaffPinHash({
        pepper: staffPinPepper(tenantId, outletA, current),
        binding: bindingOf(userId, outletA),
        pin: PIN_E,
        stored: storedOf(row),
      }),
    ).toBe(true);
    const token = await deviceTokenAt(outletA);
    const ok = await verifyOverHttp(token, userId, PIN_E);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data).toMatchObject({ user: { id: userId } });
    const stale = await verifyOverHttp(token, userId, PIN_C);
    expect(stale.status).toBe(401);
    expect(stale.body.error.code).toBe("PIN_INVALID");
  });
});
