// Staff pin replication cloud -> edge (bead legend-obh5, from legend-dxb; PRD
// v1.7 §3 F6 "Staf — PIN Perangkat", §6 B staff_pins "(T, E)", §5 "cloud
// wins", EDG-02, TEN-01..03). Service tests run the real services on the
// disposable PostgreSQL (RLS on); the HTTP tests mount the real router behind
// the real tenant middleware and error handler. In tests the "edge" database
// is the same database, so the apply tests delete the cloud row first.
import { randomUUID } from "node:crypto";
import express from "express";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import type { StaffPinEdgeRecord } from "@starter/shared/access/override";
import type { TenantContext, TenantId } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { errorHandler } from "../middleware/error-handler.ts";
import { tenantContext } from "../middleware/tenant.ts";
import { staffPinSyncRouter } from "../routes/staff-pin-sync.routes.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import {
  hashStaffPin,
  verifyStaffPinOffline,
} from "../services/device-pin-hash.ts";
import { staffPinPepper } from "../services/device-pin-pepper.ts";
import {
  attemptStaffPin,
  setStaffPin,
} from "../services/device-pin.service.ts";
import {
  applyStaffPinRecords,
  listStaffPinRecordsSince,
  setEdgeCredentialVerifier,
  type VerifiedEdgeNode,
} from "../services/staff-pin-sync.ts";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const bandung = cafeLegendAccessFixtures.outletIds.bandung;
const bandung2 = cafeLegendAccessFixtures.outletIds.bandung2;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const createdUserIds: string[] = [];
const PIN = "582914";
const NEW_PIN = "730418";

const tenant: TenantContext = establishTenantContext({
  tenantId,
  brandId: null,
  source: "session",
});
const bandungNode: VerifiedEdgeNode = {
  tenantId,
  outletId: bandung,
  edgeNodeId: randomUUID(),
};
const bandung2Node: VerifiedEdgeNode = {
  tenantId,
  outletId: bandung2,
  edgeNodeId: randomUUID(),
};
/** The edge's own outlet-scoped context (apply side). */
const edgeContext = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "device" }),
  { kind: "outlets", outletIds: [bandung] },
);

/** legend-2pi stand-in: credential -> verified edge node. */
const credentials = new Map<string, VerifiedEdgeNode>();
const BANDUNG_CREDENTIAL = `edge-${randomUUID()}`;
credentials.set(BANDUNG_CREDENTIAL, bandungNode);

async function roleIdOf(templateKey: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantId, templateKey],
  );
  if (!rows[0]) throw new Error(`No ${templateKey} role`);
  return rows[0].id;
}

/** A cashier at the outlet whose pin was set at `at`. */
async function staffWithPin(
  at: Date,
  outletId: string = bandung,
  pin: string = PIN,
): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Staf sync', $2)`,
    [id, `${id}@example.test`],
  );
  createdUserIds.push(id);
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '2 hours', $2)`,
    [tenantId, id, await roleIdOf("cashier"), outletId],
  );
  await setStaffPin(tenant, id, { outletId, userId: id }, { pin }, { now: at });
  return id;
}

/** Follows nextCursor to the end; returns every record and the watermark. */
async function pullAll(
  node: VerifiedEdgeNode,
  since: string | undefined,
  options: { limit?: number; now?: Date; settleMs?: number } = {},
) {
  const records: StaffPinEdgeRecord[] = [];
  let cursor = since;
  let watermark: string | null = since ?? null;
  for (let page = 0; page < 1000; page++) {
    const result = await listStaffPinRecordsSince(
      node,
      { since: cursor, limit: options.limit ?? 100 },
      { now: options.now, settleMs: options.settleMs ?? 0 },
    );
    records.push(...result.data);
    watermark = result.meta.watermark;
    if (result.meta.nextCursor === null) break;
    expect(result.meta.nextCursor).toBe(result.meta.watermark);
    cursor = result.meta.nextCursor;
  }
  return { records, watermark: watermark ?? undefined };
}

async function recordOf(userId: string, outletId: string = bandung) {
  const node = outletId === bandung ? bandungNode : bandung2Node;
  const { records } = await pullAll(node, undefined);
  const record = records.find((row) => row.userId === userId);
  if (!record) throw new Error("record not exported");
  return record;
}

async function pinRow(userId: string, outletId: string = bandung) {
  const { rows } = await owner.query<{
    id: string;
    pin_hash: string;
    failed_attempts: number;
    created_at: Date;
    updated_at: Date;
  }>(
    "SELECT * FROM staff_pins WHERE tenant_id = $1 AND outlet_id = $2 AND user_id = $3",
    [tenantId, outletId, userId],
  );
  return rows[0];
}

async function deletePin(userId: string) {
  await owner.query(
    "DELETE FROM staff_pins WHERE tenant_id = $1 AND user_id = $2",
    [tenantId, userId],
  );
}

const ago = (ms: number) => new Date(Date.now() - ms);
const bearer = (credential: string) => ({
  Authorization: `Bearer ${credential}`,
});

beforeAll(() => {
  setAuditWriter({ record: async () => {} });
  setEdgeCredentialVerifier(
    async ({ credential }) => credentials.get(credential) ?? null,
  );
});

afterEach(() => {
  setEdgeCredentialVerifier(
    async ({ credential }) => credentials.get(credential) ?? null,
  );
});

afterAll(async () => {
  setAuditWriter(null);
  setEdgeCredentialVerifier(null);
  await owner.query(
    `DELETE FROM staff_pins WHERE tenant_id = $1 AND user_id = ANY($2::text[])`,
    [tenantId, createdUserIds],
  );
  await owner.query(
    "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
    [tenantId, createdUserIds],
  );
  await owner.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [
    createdUserIds,
  ]);
  await owner.end();
});

// ------------------------------------------------------------------ export

describe("legend-obh5 staff pin edge export (§6 B staff_pins (T, E))", () => {
  it("legend-obh5 EDG-02 watermark paging returns each changed record once in (updatedAt, id) order, then only later changes", async () => {
    const base = Date.now() - 10 * 60_000;
    const users = [
      await staffWithPin(new Date(base + 1_000)),
      await staffWithPin(new Date(base + 2_000)),
      await staffWithPin(new Date(base + 3_000)),
    ];
    const first = await pullAll(bandungNode, undefined, { limit: 2 });
    const mine = first.records.filter((row) => users.includes(row.userId));
    expect(mine.map((row) => row.userId)).toEqual(users);
    expect(new Set(first.records.map((row) => row.id)).size).toBe(
      first.records.length,
    );
    expect(first.watermark).toBeDefined();

    // Nothing changed since the watermark: none of ours again.
    const idle = await pullAll(bandungNode, first.watermark);
    expect(idle.records.filter((row) => users.includes(row.userId))).toEqual(
      [],
    );
    expect(idle.watermark).toBe(first.watermark);

    // One reset later: only that staff member, with the new hash.
    const before = mine[1]!;
    await setStaffPin(
      tenant,
      users[1]!,
      { outletId: bandung, userId: users[1]! },
      { pin: NEW_PIN },
      { now: new Date() },
    );
    const next = await pullAll(bandungNode, first.watermark);
    const changed = next.records.filter((row) => users.includes(row.userId));
    expect(changed.map((row) => row.userId)).toEqual([users[1]]);
    expect(changed[0]?.pinHash).not.toBe(before.pinHash);
    expect(changed[0]?.id).toBe(before.id);
  });

  it("legend-obh5 EDG-02 the settle window holds back a row updated moments ago, then releases it", async () => {
    const now = new Date();
    const user = await staffWithPin(now);
    const held = await listStaffPinRecordsSince(
      bandungNode,
      { limit: 100 },
      { now, settleMs: 5_000 },
    );
    expect(held.data.some((row) => row.userId === user)).toBe(false);
    const { records } = await pullAll(bandungNode, undefined, {
      now: new Date(now.getTime() + 6_000),
      settleMs: 5_000,
    });
    expect(records.some((row) => row.userId === user)).toBe(true);
  });

  it("legend-obh5 §3 F6 records are hash-only: no raw pin, no pepper, exact record keys, and they verify offline with the separately provisioned pepper", async () => {
    const user = await staffWithPin(ago(60_000));
    const page = await pullAll(bandungNode, undefined);
    const serialized = JSON.stringify(page);
    const pepper = staffPinPepper(tenantId);
    for (const secret of [
      `"${PIN}"`,
      pepper.toString("hex"),
      pepper.toString("base64"),
      pepper.toString("base64url"),
    ])
      expect(serialized).not.toContain(secret);
    const record = page.records.find((row) => row.userId === user)!;
    expect(Object.keys(record).sort()).toEqual(
      [
        "algorithm",
        "failedAttempts",
        "id",
        "lockedUntil",
        "outletId",
        "params",
        "pepperVersion",
        "pinHash",
        "salt",
        "tenantId",
        "updatedAt",
        "userId",
      ].sort(),
    );
    const offline = await verifyStaffPinOffline({
      record,
      pepper,
      pin: PIN,
      now: new Date(),
    });
    expect(offline.outcome).toBe("ok");
  });

  it("legend-obh5 TEN-03 an edge node of another outlet never receives this outlet's records", async () => {
    const user = await staffWithPin(ago(60_000));
    const other = await pullAll(bandung2Node, undefined);
    expect(other.records.some((row) => row.userId === user)).toBe(false);
    expect(other.records.every((row) => row.outletId === bandung2)).toBe(true);
  });

  it("legend-obh5 TEN-01 an edge node naming another tenant is refused; a tampered cursor is a validation error", async () => {
    await staffWithPin(ago(60_000));
    await expect(
      listStaffPinRecordsSince(
        {
          tenantId: randomUUID() as TenantId,
          outletId: bandung,
          edgeNodeId: randomUUID(),
        },
        { limit: 10 },
        { settleMs: 0 },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      listStaffPinRecordsSince(
        bandungNode,
        { since: "bm90LWEtY3Vyc29y", limit: 10 },
        { settleMs: 0 },
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

// -------------------------------------------------------------------- HTTP

describe("legend-obh5 GET /api/edge-sync/staff-pin-records", () => {
  let domainTenant: string | null = null;
  const app = express();
  app.use(
    tenantContext({
      required: false,
      resolveDomain: async () =>
        domainTenant ? { tenantId: domainTenant, brandId: null } : null,
      verifyCredential: async () => null,
    }),
  );
  app.use("/api/edge-sync/staff-pin-records", staffPinSyncRouter);
  app.use(errorHandler);
  const path = "/api/edge-sync/staff-pin-records";

  afterEach(() => {
    domainTenant = null;
  });

  it("legend-obh5 TEN-02 no credential, an unknown credential, the default deny-all verifier or a failing verifier all answer 401", async () => {
    expect((await request(app).get(path)).status).toBe(401);
    const unknown = await request(app)
      .get(path)
      .set(bearer(`edge-${randomUUID()}`));
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.code).toBe("UNAUTHORIZED");
    setEdgeCredentialVerifier(null);
    expect(
      (await request(app).get(path).set(bearer(BANDUNG_CREDENTIAL))).status,
    ).toBe(401);
    setEdgeCredentialVerifier(async () => {
      throw new Error("registry down");
    });
    expect(
      (await request(app).get(path).set(bearer(BANDUNG_CREDENTIAL))).status,
    ).toBe(401);
    // A verifier answer of the wrong shape is a denial too.
    setEdgeCredentialVerifier(
      async () => ({ tenantId }) as unknown as VerifiedEdgeNode,
    );
    expect(
      (await request(app).get(path).set(bearer(BANDUNG_CREDENTIAL))).status,
    ).toBe(401);
  });

  it("legend-obh5 §6 B staff_pins (T, E) a verified edge node pages its outlet's hash-only records, no-store", async () => {
    const user = await staffWithPin(ago(60_000));
    const response = await request(app)
      .get(`${path}?limit=100`)
      .set(bearer(BANDUNG_CREDENTIAL));
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(response.body.meta).toMatchObject({ limit: 100 });
    expect(
      (response.body.data as StaffPinEdgeRecord[]).every(
        (row) => row.outletId === bandung && row.tenantId === tenantId,
      ),
    ).toBe(true);
    let records = response.body.data as StaffPinEdgeRecord[];
    let cursor: string | null = response.body.meta.nextCursor;
    while (cursor !== null) {
      const more = await request(app)
        .get(path)
        .query({ since: cursor })
        .set(bearer(BANDUNG_CREDENTIAL));
      records = records.concat(more.body.data);
      cursor = more.body.meta.nextCursor;
    }
    expect(records.some((row) => row.userId === user)).toBe(true);
    expect(JSON.stringify(records)).not.toContain(`"${PIN}"`);
  });

  it("legend-obh5 TEN-02 the query is strict, and a domain of another tenant is refused", async () => {
    const strict = await request(app)
      .get(path)
      .query({ tenantId: randomUUID() })
      .set(bearer(BANDUNG_CREDENTIAL));
    expect(strict.status).toBe(422);
    const limit = await request(app)
      .get(path)
      .query({ limit: 0 })
      .set(bearer(BANDUNG_CREDENTIAL));
    expect(limit.status).toBe(422);
    domainTenant = randomUUID();
    const mismatch = await request(app)
      .get(path)
      .set(bearer(BANDUNG_CREDENTIAL));
    expect(mismatch.status).toBe(403);
    expect(mismatch.body.error.code).toBe("TENANT_MISMATCH");
  });
});

// ------------------------------------------------------------------- apply

describe("legend-obh5 staff pin edge apply (cloud wins, version monotonic)", () => {
  it("legend-obh5 EDG-02 an unknown record is inserted under the cloud id, a replay is a no-op, and the pin verifies on the edge", async () => {
    const user = await staffWithPin(ago(120_000));
    const record = await recordOf(user);
    await deletePin(user);
    expect(await applyStaffPinRecords(edgeContext, [record])).toEqual({
      applied: 1,
      skipped: 0,
    });
    const row = await pinRow(user);
    expect(row?.id).toBe(record.id);
    expect(row?.pin_hash).toBe(record.pinHash);
    expect(await applyStaffPinRecords(edgeContext, [record])).toEqual({
      applied: 0,
      skipped: 1,
    });
    expect((await pinRow(user))?.updated_at).toEqual(row?.updated_at);
    expect(
      await attemptStaffPin(tenant, {
        outletId: bandung,
        userId: user,
        pin: PIN,
      }),
    ).toEqual({ kind: "ok", userId: user });
  });

  it("legend-obh5 §3 F6 lock state is version monotonic: an older record never regresses it, a newer one wins", async () => {
    const user = await staffWithPin(ago(120_000));
    const record = await recordOf(user);
    const at = Date.parse(record.updatedAt);
    const older = await applyStaffPinRecords(edgeContext, [
      {
        ...record,
        failedAttempts: 3,
        updatedAt: new Date(at - 1_000).toISOString(),
      },
    ]);
    expect(older).toEqual({ applied: 0, skipped: 1 });
    expect((await pinRow(user))?.failed_attempts).toBe(0);
    const newer = await applyStaffPinRecords(edgeContext, [
      {
        ...record,
        failedAttempts: 2,
        updatedAt: new Date(at + 1_000).toISOString(),
      },
    ]);
    expect(newer).toEqual({ applied: 1, skipped: 0 });
    expect((await pinRow(user))?.failed_attempts).toBe(2);
  });

  it("legend-obh5 §5 cloud wins: a reset replaces the stored generation despite a newer local attempt; an older generation replayed late never wins", async () => {
    const user = await staffWithPin(ago(30 * 60_000));
    const generation1 = await recordOf(user);
    await deletePin(user);
    await applyStaffPinRecords(edgeContext, [generation1]);
    const t1 = Date.parse(generation1.updatedAt);
    // A failed attempt on the edge bumped updated_at past the coming reset.
    await owner.query(
      `UPDATE staff_pins SET failed_attempts = 1, updated_at = $3
       WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, user, new Date(t1 + 20 * 60_000)],
    );
    // The supervisor resets the pin on the cloud at t1 + 10 min.
    const hashed = await hashStaffPin({
      pepper: staffPinPepper(tenantId),
      binding: { tenantId, outletId: bandung, userId: user },
      pin: NEW_PIN,
    });
    const generation2: StaffPinEdgeRecord = {
      ...generation1,
      salt: hashed.salt,
      pinHash: hashed.pinHash,
      params: hashed.params,
      failedAttempts: 0,
      lockedUntil: null,
      updatedAt: new Date(t1 + 10 * 60_000).toISOString(),
    };
    expect(await applyStaffPinRecords(edgeContext, [generation2])).toEqual({
      applied: 1,
      skipped: 0,
    });
    expect(await pinRow(user)).toMatchObject({
      pin_hash: generation2.pinHash,
      failed_attempts: 0,
    });
    // The old generation arrives again (late page): ignored.
    expect(await applyStaffPinRecords(edgeContext, [generation1])).toEqual({
      applied: 0,
      skipped: 1,
    });
    expect((await pinRow(user))?.pin_hash).toBe(generation2.pinHash);
    expect(
      await attemptStaffPin(tenant, {
        outletId: bandung,
        userId: user,
        pin: NEW_PIN,
      }),
    ).toEqual({ kind: "ok", userId: user });
  });

  it("legend-obh5 TEN-01 TEN-03 a page with a foreign tenant, an out-of-scope outlet, a raw pin field or a repeated record applies nothing", async () => {
    const user = await staffWithPin(ago(120_000));
    const record = await recordOf(user);
    const elsewhere = await staffWithPin(ago(120_000), bandung2);
    const outOfScope = await recordOf(elsewhere, bandung2);
    await deletePin(user);
    await expect(
      applyStaffPinRecords(edgeContext, [
        record,
        { ...record, id: randomUUID(), tenantId: randomUUID() },
      ]),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      applyStaffPinRecords(edgeContext, [record, outOfScope]),
    ).rejects.toMatchObject({ code: "OUTLET_OUT_OF_SCOPE" });
    await expect(
      applyStaffPinRecords(edgeContext, [{ ...record, pin: PIN }]),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      applyStaffPinRecords(edgeContext, [record, record]),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await pinRow(user)).toBeUndefined();
  });
});
