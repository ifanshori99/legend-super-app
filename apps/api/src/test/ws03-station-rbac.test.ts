// Station-aware RBAC context (bead legend-ra7s; PRD v1.7 §3.7 role table, §6
// B role_assignments, TEN-03).
//
// The resolver half of station scope: `loadTenantAccess` puts the tenant's
// live stations in the org index, a station target resolves to exactly its
// outlet (`contextFor`), the station id stays separate for KDS routes
// (`stationsFor`), and an unknown, soft-deleted or out-of-brand station fails
// closed. The HTTP and service halves of station-bound routes are proven in
// station-auth.test.ts (legend-fsb7). Real PostgreSQL, RLS and Better Auth.
import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendFixtures } from "@starter/shared/core";
import type { PermissionCode } from "@starter/shared/access";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { createApp } from "../app";
import { db } from "../db";
import { stations } from "../db/schema";
import { withTenant } from "../db/tenant";
import {
  loadTenantAccess,
  resolveAccessSnapshot,
} from "../services/permission-resolver";
import { agent, signUp } from "./helpers";

const app = createApp();
const { tenant, outlets } = cafeLegendFixtures;
const tenantId = tenant.id;
const outletA = outlets[0].id;
const outletB = outlets[1].id;
const VIEW: PermissionCode = "menu.item.view";
const ownerPool = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

/** Owner-side writes need the tenant local setting because RLS is FORCED. */
async function asOwnerTenant<T>(
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await ownerPool.connect();
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

const createdUserIds: string[] = [];
const createdRoleIds: string[] = [];
const createdStationIds: string[] = [];

async function createStation(outletId: string): Promise<string> {
  const result = await asOwnerTenant((client) =>
    client.query<{ id: string }>(
      `INSERT INTO stations (tenant_id, outlet_id, name, type)
       VALUES ($1, $2, $3, 'hot_kitchen') RETURNING id`,
      [tenantId, outletId, `Uji ${randomUUID().slice(0, 8)}`],
    ),
  );
  const id = result.rows[0].id;
  createdStationIds.push(id);
  return id;
}

async function softDeleteStation(stationId: string): Promise<void> {
  await asOwnerTenant((client) =>
    client.query("UPDATE stations SET deleted_at = now() WHERE id = $1", [
      stationId,
    ]),
  );
}

async function customRole(permissions: readonly string[]): Promise<string> {
  const roleId = randomUUID();
  await ownerPool.query(
    `INSERT INTO roles
       (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4::jsonb, false, $5::jsonb)`,
    [
      roleId,
      tenantId,
      `Uji ${roleId.slice(0, 8)}`,
      JSON.stringify(permissions),
      JSON.stringify(["tenant", "brand", "outlet", "station"]),
    ],
  );
  createdRoleIds.push(roleId);
  return roleId;
}

/** A signed-up user holding one role at one scope; returns the user id. */
async function holder(
  roleId: string,
  scope: { type: "outlet" | "station"; id: string },
): Promise<string> {
  const client = agent(app);
  await signUp(client, "Station RBAC User");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUserIds.push(userId);
  await ownerPool.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [tenantId, userId, roleId, scope.type, scope.id],
  );
  return userId;
}

/** The resolver as a request sees it: tenant context, then the snapshot. */
async function snapshotFor(userId: string, brandId: string | null = null) {
  const tenantContext = establishTenantContext({
    tenantId,
    brandId,
    source: "session",
  });
  const scoped = establishScopedTenantContext(tenantContext, {
    kind: "tenant",
  });
  const data = await loadTenantAccess(scoped, userId);
  return {
    data,
    snapshot: resolveAccessSnapshot({
      tenant: tenantContext,
      userId,
      ...data,
      mfaVerified: false,
      now: new Date(),
    }),
  };
}

const lower = (ids: readonly string[]) => ids.map((id) => id.toLowerCase());

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterAll(async () => {
  if (createdUserIds.length > 0)
    await ownerPool.query(
      "DELETE FROM role_assignments WHERE user_id = ANY($1::text[])",
      [createdUserIds],
    );
  if (createdRoleIds.length > 0)
    await ownerPool.query("DELETE FROM roles WHERE id = ANY($1::uuid[])", [
      createdRoleIds,
    ]);
  if (createdStationIds.length > 0)
    await asOwnerTenant((client) =>
      client.query("DELETE FROM stations WHERE id = ANY($1::uuid[])", [
        createdStationIds,
      ]),
    );
  await ownerPool.end();
});

describe("legend-ra7s station-aware RBAC context", () => {
  it("legend-ra7s loadTenantAccess indexes live stations with their outlet", async () => {
    const stationA = await createStation(outletA);
    const stationB = await createStation(outletB);
    const deleted = await createStation(outletA);
    await softDeleteStation(deleted);
    const userId = await holder(await customRole([VIEW]), {
      type: "station",
      id: stationA,
    });

    const { data } = await snapshotFor(userId);
    const byId = new Map(
      data.org.stations.map((row) => [
        row.id.toLowerCase(),
        row.outletId.toLowerCase(),
      ]),
    );
    expect(byId.get(stationA.toLowerCase())).toBe(outletA.toLowerCase());
    expect(byId.get(stationB.toLowerCase())).toBe(outletB.toLowerCase());
    expect(byId.has(deleted.toLowerCase())).toBe(false);
  });

  it("legend-ra7s TEN-03 a station holder reaches only its station's outlet", async () => {
    const stationA = await createStation(outletA);
    const siblingA = await createStation(outletA);
    const stationB = await createStation(outletB);
    const userId = await holder(await customRole([VIEW]), {
      type: "station",
      id: stationA,
    });
    const { snapshot } = await snapshotFor(userId);

    // Station target: the context carries exactly the station's outlet.
    const context = snapshot.contextFor(VIEW, {
      type: "station",
      id: stationA,
    });
    expect(context).not.toBeNull();
    expect(context?.outletScope).toMatchObject({ kind: "outlets" });
    expect(
      lower(
        (context?.outletScope as { outletIds: readonly string[] }).outletIds,
      ),
    ).toEqual([outletA.toLowerCase()]);
    // The station id stays separate for KDS routes.
    expect(lower(snapshot.stationsFor(VIEW))).toEqual([stationA.toLowerCase()]);

    // Other outlet: denied. A sibling station or the whole outlet: denied
    // too, because station scope never becomes outlet-wide reach.
    expect(snapshot.allows(VIEW, { type: "outlet", id: outletB })).toBe(false);
    expect(snapshot.contextFor(VIEW, { type: "outlet", id: outletB })).toBe(
      null,
    );
    expect(snapshot.contextFor(VIEW, { type: "station", id: stationB })).toBe(
      null,
    );
    expect(snapshot.contextFor(VIEW, { type: "station", id: siblingA })).toBe(
      null,
    );
    expect(snapshot.contextFor(VIEW, { type: "outlet", id: outletA })).toBe(
      null,
    );
    // A permission the role does not hold mints nothing either.
    expect(
      snapshot.contextFor("menu.item.manage", {
        type: "station",
        id: stationA,
      }),
    ).toBe(null);

    // RLS under the minted context shows only that outlet's stations.
    if (context === null) throw new Error("station context expected");
    const visible = await withTenant(db, context, (tx) =>
      tx.select({ outletId: stations.outletId }).from(stations),
    );
    expect(visible.length).toBeGreaterThan(0);
    expect(new Set(lower(visible.map((row) => row.outletId)))).toEqual(
      new Set([outletA.toLowerCase()]),
    );
  });

  it("legend-ra7s an outlet holder keeps every station of its outlet, never another outlet", async () => {
    const stationA = await createStation(outletA);
    const stationB = await createStation(outletB);
    const userId = await holder(await customRole([VIEW]), {
      type: "outlet",
      id: outletA,
    });
    const { snapshot } = await snapshotFor(userId);

    expect(lower(snapshot.stationsFor(VIEW))).toContain(stationA.toLowerCase());
    expect(lower(snapshot.stationsFor(VIEW))).not.toContain(
      stationB.toLowerCase(),
    );
    expect(
      snapshot.contextFor(VIEW, { type: "station", id: stationA }),
    ).not.toBeNull();
    expect(snapshot.contextFor(VIEW, { type: "station", id: stationB })).toBe(
      null,
    );
    expect(snapshot.contextFor(VIEW, { type: "outlet", id: outletB })).toBe(
      null,
    );
  });

  it("legend-ra7s fails closed on an unknown, soft-deleted or out-of-brand station", async () => {
    const stationA = await createStation(outletA);
    const doomed = await createStation(outletA);
    const roleId = await customRole([VIEW]);
    const outletHolder = await holder(roleId, { type: "outlet", id: outletA });
    const doomedHolder = await holder(roleId, { type: "station", id: doomed });
    await softDeleteStation(doomed);

    // Unknown id: not in the org index, so nothing even for an outlet holder.
    const unknown = "00000000-0000-4000-8000-00000000a7a5";
    const outletSnapshot = (await snapshotFor(outletHolder)).snapshot;
    expect(outletSnapshot.allows(VIEW, { type: "station", id: unknown })).toBe(
      false,
    );
    expect(
      outletSnapshot.contextFor(VIEW, { type: "station", id: unknown }),
    ).toBe(null);

    // Soft-deleted station: its own assignment grants nothing anymore.
    const doomedSnapshot = (await snapshotFor(doomedHolder)).snapshot;
    expect(
      doomedSnapshot.contextFor(VIEW, { type: "station", id: doomed }),
    ).toBe(null);
    expect(doomedSnapshot.stationsFor(VIEW)).toEqual([]);

    // A brand pin the outlets do not belong to: no outlets, no stations.
    const pinned = await snapshotFor(outletHolder, randomUUID());
    expect(pinned.data.org.stations).toEqual([]);
    expect(
      pinned.snapshot.contextFor(VIEW, { type: "station", id: stationA }),
    ).toBe(null);
    expect(pinned.snapshot.stationsFor(VIEW)).toEqual([]);
  });
});
