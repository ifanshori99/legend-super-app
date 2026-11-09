// Wi-Fi grant retention (bead legend-y2dg): terminal grants older than
// WIFI_GRANT_RETENTION_DAYS are purged on the edge, but never a row whose
// controller revoke is still pending (`revoke_retry_at`), never a row a kept
// row still points at (`superseded_by` self-FK), and never another tenant's or
// outlet's rows. Fixtures as the migration owner (FORCE RLS settings).
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  outletIdSchema,
  tenantIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { db } from "../db/index.ts";
import {
  purgeExpiredWifiGrants,
  WIFI_GRANT_RETENTION_DAYS,
} from "../services/edge-wifi-retention.service.ts";
import {
  createIsolatedTenant,
  owner,
  seedTenantOutlets,
} from "./floor-test-helpers.ts";

const NOW = new Date("2026-11-09T02:00:00.000Z");
const DAY_MS = 86_400_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const RETENTION_MS = WIFI_GRANT_RETENTION_DAYS * DAY_MS;
const OLD = ago(RETENTION_MS + 1_000);
const RECENT = ago(DAY_MS);
const tenantIds: string[] = [];

const ctxFor = (
  tenantId: string,
  outletIds: string[] | "tenant",
): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "session",
    }),
    outletIds === "tenant"
      ? { kind: "tenant" }
      : {
          kind: "outlets",
          outletIds: outletIds.map((id) => outletIdSchema.parse(id)),
        },
  );

async function asOwner<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

type Seed = {
  tenantId: string;
  outletId: string;
  status?: "superseded" | "revoked" | "failed" | "active";
  endedAt?: Date;
  revokeRetryAt?: Date | null;
  supersededBy?: string;
};

/** One grant row; terminal by default, ended at `endedAt`. */
async function seed(input: Seed): Promise<string> {
  const id = randomUUID();
  const status = input.status ?? (input.supersededBy ? "superseded" : "failed");
  const terminal = status !== "active";
  const mac = randomUUID().replace(/-/g, "").slice(0, 12);
  const hash = createHash("sha256")
    .update(`${input.tenantId}:${mac}`)
    .digest("hex");
  await asOwner(input.tenantId, (client) =>
    client.query(
      `INSERT INTO wifi_device_grants
        (id, tenant_id, outlet_id, wifi_session_id, device_hash, controller_device_id,
         speed_tier, bandwidth_kbps, base_bandwidth_kbps, duration_seconds, status,
         renew_until, requested_at, authorized_at, expires_at, revoke_requested_at,
         end_reason, ended_at, superseded_by, revoke_retry_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'full', 20000, 2000, 3900, $7,
         $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        id,
        input.tenantId,
        input.outletId,
        randomUUID(),
        hash,
        terminal ? null : mac,
        status,
        new Date(NOW.getTime() + 8 * 3_600_000),
        ago(60 * DAY_MS),
        status === "active" ? NOW : null,
        status === "active" ? new Date(NOW.getTime() + 3_600_000) : null,
        status === "revoked" ? (input.endedAt ?? NOW) : null,
        status === "revoked" ? "session_ended" : null,
        terminal ? (input.endedAt ?? NOW) : null,
        input.supersededBy ?? null,
        input.revokeRetryAt ?? null,
      ],
    ),
  );
  return id;
}

async function existing(tenantId: string, ids: string[]): Promise<string[]> {
  return asOwner(tenantId, async (client) => {
    const result = await client.query<{ id: string }>(
      "SELECT id FROM wifi_device_grants WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenantId, ids],
    );
    return result.rows.map((row) => row.id);
  });
}

async function tenantWithOutlets(outletCount: number) {
  const tenantId = randomUUID();
  const outletIds = await seedTenantOutlets(tenantId, outletCount);
  tenantIds.push(tenantId);
  return { tenantId, outletIds };
}

afterAll(async () => {
  await owner.end();
});

describe("Wi-Fi grant retention (legend-y2dg)", () => {
  it("keeps the retention at 30 days", () => {
    expect(WIFI_GRANT_RETENTION_DAYS).toBe(30);
  });

  it("deletes terminal rows only after the 30 day boundary", async () => {
    const { tenantId, outletIds } = await tenantWithOutlets(1);
    const outletId = outletIds[0]!;
    const base = { tenantId, outletId };
    const pastBoundary = await seed({ ...base, endedAt: OLD });
    const revokedOld = await seed({
      ...base,
      status: "revoked",
      endedAt: ago(RETENTION_MS + 1),
    });
    const atBoundary = await seed({ ...base, endedAt: ago(RETENTION_MS) });
    const recent = await seed({ ...base, endedAt: RECENT });
    const live = await seed({ ...base, status: "active" });
    const purged = await purgeExpiredWifiGrants(
      db,
      ctxFor(tenantId, [outletId]),
      NOW,
    );
    expect(purged).toBe(2);
    expect(
      (
        await existing(tenantId, [
          pastBoundary,
          revokedOld,
          atBoundary,
          recent,
          live,
        ])
      ).sort(),
    ).toEqual([atBoundary, recent, live].sort());
    // A second run finds nothing.
    expect(
      await purgeExpiredWifiGrants(db, ctxFor(tenantId, [outletId]), NOW),
    ).toBe(0);
  });

  it("keeps an old revoked row whose controller revoke is still pending", async () => {
    const { tenantId, outletIds } = await tenantWithOutlets(1);
    const outletId = outletIds[0]!;
    const base = { tenantId, outletId, endedAt: OLD };
    const pending = await seed({
      ...base,
      status: "revoked",
      revokeRetryAt: ago(DAY_MS),
    });
    const done = await seed({ ...base, status: "revoked" });
    const purged = await purgeExpiredWifiGrants(
      db,
      ctxFor(tenantId, [outletId]),
      NOW,
    );
    expect(purged).toBe(1);
    expect(await existing(tenantId, [pending, done])).toEqual([pending]);
    // Once the revoke succeeded (retry cleared) the row is purged on the next run.
    await asOwner(tenantId, (client) =>
      client.query(
        "UPDATE wifi_device_grants SET revoke_retry_at = NULL WHERE id = $1",
        [pending],
      ),
    );
    expect(
      await purgeExpiredWifiGrants(db, ctxFor(tenantId, [outletId]), NOW),
    ).toBe(1);
    expect(await existing(tenantId, [pending])).toEqual([]);
  });

  it("never breaks the superseded_by self-FK", async () => {
    const { tenantId, outletIds } = await tenantWithOutlets(1);
    const outletId = outletIds[0]!;
    const base = { tenantId, outletId };
    // Chain, all old: A -> B -> C. The whole chain is purged in one statement.
    const cOld = await seed({ ...base, status: "revoked", endedAt: OLD });
    const bOld = await seed({ ...base, supersededBy: cOld, endedAt: OLD });
    const aOld = await seed({ ...base, supersededBy: bOld, endedAt: OLD });
    // Recent row R -> old M -> old N -> old Q: R is kept, so M, N and Q stay.
    const q = await seed({ ...base, status: "revoked", endedAt: OLD });
    const n = await seed({ ...base, supersededBy: q, endedAt: OLD });
    const m = await seed({ ...base, supersededBy: n, endedAt: OLD });
    const r = await seed({ ...base, supersededBy: m, endedAt: RECENT });
    // Old row pointing at a live successor: purged, successor untouched.
    const successor = await seed({ ...base, status: "active" });
    const old = await seed({ ...base, supersededBy: successor, endedAt: OLD });
    // Old row referenced by an old retry row: the retry row is kept, so is its target.
    const target = await seed({ ...base, status: "revoked", endedAt: OLD });
    const retry = await seed({
      ...base,
      supersededBy: target,
      endedAt: OLD,
      revokeRetryAt: ago(DAY_MS),
    });
    const all = [cOld, bOld, aOld, q, n, m, r, successor, old, target, retry];
    const purged = await purgeExpiredWifiGrants(
      db,
      ctxFor(tenantId, [outletId]),
      NOW,
    );
    expect(purged).toBe(4);
    expect((await existing(tenantId, all)).sort()).toEqual(
      [q, n, m, r, successor, target, retry].sort(),
    );
  });

  it("leaves other tenants and other outlets untouched", async () => {
    const { tenantId, outletIds } = await tenantWithOutlets(2);
    const [outletA, outletB] = [outletIds[0]!, outletIds[1]!];
    const other = await createIsolatedTenant(
      `wifiret-${randomUUID().slice(0, 8)}`,
    );
    tenantIds.push(other.tenantId);
    const inA = await seed({ tenantId, outletId: outletA, endedAt: OLD });
    const inB = await seed({ tenantId, outletId: outletB, endedAt: OLD });
    const foreign = await seed({
      tenantId: other.tenantId,
      outletId: other.outletId,
      endedAt: OLD,
    });
    // Outlet-scoped context: only its outlet.
    expect(
      await purgeExpiredWifiGrants(db, ctxFor(tenantId, [outletA]), NOW),
    ).toBe(1);
    expect(await existing(tenantId, [inA, inB])).toEqual([inB]);
    expect(await existing(other.tenantId, [foreign])).toEqual([foreign]);
    // A context for a foreign outlet of the same tenant purges nothing here.
    expect(
      await purgeExpiredWifiGrants(db, ctxFor(tenantId, [randomUUID()]), NOW),
    ).toBe(0);
    expect(await existing(tenantId, [inB])).toEqual([inB]);
    // Tenant-wide context: all outlets of the tenant, never the other tenant.
    expect(
      await purgeExpiredWifiGrants(db, ctxFor(tenantId, "tenant"), NOW),
    ).toBe(1);
    expect(await existing(tenantId, [inB])).toEqual([]);
    expect(await existing(other.tenantId, [foreign])).toEqual([foreign]);
  });
});
