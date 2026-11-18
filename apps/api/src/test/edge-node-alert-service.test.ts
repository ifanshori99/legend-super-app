// Edge node alert state (legend-uux9k, design docs/design/edge-status-cloud.md
// D5 and section 6 T1-T4). Written from the design, independent of the
// implementation: failing imports are expected until the S1 slice merges.
//
// Assumed contracts (see the report):
//   services/edge-node-alert.service.ts
//     raiseEdgeNodeAlert(tx, { tenantId, outletId, edgeNodeId, kind, at, detail, sourceEventId? })
//       -> Promise<{ opened: boolean }>
//     resolveEdgeNodeAlerts(tx, { tenantId, edgeNodeId, kind, at, quietSince? })
//       -> Promise<number> (rows closed)
//   Table edge_node_alerts: id, tenant_id, outlet_id, edge_node_id, kind, raised_at,
//   last_seen_at, resolved_at (null = open), detail, ... Row-level security by
//   tenant and outlet scope. `tx` is the transaction handed out by withTenant.
//
// Fixtures: one isolated tenant A with two outlets, one isolated tenant B. Every
// test registers its own edge node(s), so open-alert state never leaks between
// tests (one open alert per node and kind).
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import { withTenant } from "../db/tenant.ts";
import { registerEdgeNode } from "../services/edge-node.service.ts";
import {
  raiseEdgeNodeAlert,
  resolveEdgeNodeAlerts,
} from "../services/edge-node-alert.service.ts";
import {
  createIsolatedTenant,
  fixtures,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

type Node = Awaited<ReturnType<typeof registerEdgeNode>>;
type Placed = { node: Node; tenantId: string; outletId: string };

const actor = randomUUID();
const HARD_STALE = "device_registry_hard_stale" as const;
const RECEIPT_RUN = "receipt_run_alert" as const;

let tenantA: IsolatedTenant;
let tenantB: IsolatedTenant;

const contextOf = (
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

/** A new active outlet in the tenant (tests need one primary node per outlet). */
async function newOutlet(tenant: IsolatedTenant): Promise<string> {
  const outletId = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Uji', 'Asia/Jakarta', $7, 'active')`,
    [
      outletId,
      tenant.tenantId,
      tenant.brandId,
      tenant.legalEntityId,
      `AL${randomUUID().slice(0, 8)}`.toUpperCase(),
      `Outlet alert ${outletId.slice(0, 6)}`,
      JSON.stringify(fixtures.outlets[0].openingHours),
    ],
  );
  return outletId;
}

async function newNode(
  tenant: IsolatedTenant,
  outletId?: string,
): Promise<Placed> {
  const outlet = outletId ?? (await newOutlet(tenant));
  const node = await registerEdgeNode(
    contextOf(tenant.tenantId, [outlet]),
    actor,
    { outletId: outlet, role: "primary", label: "Node uji alert" },
  );
  return { node, tenantId: tenant.tenantId, outletId: outlet };
}

const raise = (
  where: Placed,
  input: { kind?: typeof HARD_STALE | typeof RECEIPT_RUN; at: Date },
  scope: ScopedTenantContext = contextOf(where.tenantId, "tenant"),
) =>
  withTenant(db, scope, (tx) =>
    raiseEdgeNodeAlert(tx, {
      tenantId: tenantIdSchema.parse(where.tenantId),
      outletId: outletIdSchema.parse(where.outletId),
      edgeNodeId: where.node.edgeNode.id,
      kind: input.kind ?? HARD_STALE,
      at: input.at,
      detail: { lastPulledAt: null, maxStaleSeconds: 259_200 },
    }),
  );

const resolve = (
  where: Placed,
  input: {
    kind?: typeof HARD_STALE | typeof RECEIPT_RUN;
    at: Date;
    quietSince?: Date;
  },
  scope: ScopedTenantContext = contextOf(where.tenantId, "tenant"),
) =>
  withTenant(db, scope, (tx) =>
    resolveEdgeNodeAlerts(tx, {
      tenantId: tenantIdSchema.parse(where.tenantId),
      edgeNodeId: where.node.edgeNode.id,
      kind: input.kind ?? HARD_STALE,
      at: input.at,
      ...(input.quietSince ? { quietSince: input.quietSince } : {}),
    }),
  );

type AlertRow = {
  kind: string;
  raised_at: Date;
  last_seen_at: Date;
  resolved_at: Date | null;
};

/** Rows as the migration owner sees them (bypasses RLS on purpose). */
async function rowsOf(where: Placed, kind: string = HARD_STALE) {
  const { rows } = await owner.query<AlertRow>(
    `SELECT kind, raised_at, last_seen_at, resolved_at
       FROM edge_node_alerts
      WHERE tenant_id = $1 AND edge_node_id = $2 AND kind = $3
      ORDER BY raised_at, created_at`,
    [where.tenantId, where.node.edgeNode.id, kind],
  );
  return rows;
}

const at = (iso: string) => new Date(iso);
const T0 = at("2026-11-18T01:00:00.000Z");
const T1 = at("2026-11-18T02:00:00.000Z");
const T2 = at("2026-11-18T03:00:00.000Z");

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  tenantA = await createIsolatedTenant(`ena-a-${randomUUID().slice(0, 6)}`);
  tenantB = await createIsolatedTenant(`ena-b-${randomUUID().slice(0, 6)}`);
});

afterAll(async () => {
  // Edge rows are append-only: the isolated tenants stay in the disposable
  // database; give them a valid creator so the platform tenant list parses.
  for (const tenant of [tenantA, tenantB])
    await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      tenant.tenantId,
      randomUUID(),
    ]);
  await owner.end();
});

describe("legend-uux9k edge node alert service", () => {
  it("T1 raising twice for one node and kind keeps one open row and moves last_seen_at forward", async () => {
    const where = await newNode(tenantA);
    const first = await raise(where, { at: T0 });
    expect(first.opened).toBe(true);
    const second = await raise(where, { at: T1 });
    expect(second.opened).toBe(false);

    const rows = await rowsOf(where);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.resolved_at).toBeNull();
    expect(rows[0]!.raised_at.getTime()).toBe(T0.getTime());
    expect(rows[0]!.last_seen_at.getTime()).toBe(T1.getTime());

    // An older confirmation (clock skew, replay) never moves last_seen_at back.
    const older = await raise(where, { at: T0 });
    expect(older.opened).toBe(false);
    expect((await rowsOf(where))[0]!.last_seen_at.getTime()).toBe(T1.getTime());
  });

  it("T1 a different kind on the same node is a separate open alert", async () => {
    const where = await newNode(tenantA);
    expect((await raise(where, { at: T0 })).opened).toBe(true);
    expect((await raise(where, { kind: RECEIPT_RUN, at: T0 })).opened).toBe(
      true,
    );
    expect(await rowsOf(where, HARD_STALE)).toHaveLength(1);
    expect(await rowsOf(where, RECEIPT_RUN)).toHaveLength(1);
  });

  it("T2 resolve then raise again gives two rows: one resolved, one open", async () => {
    const where = await newNode(tenantA);
    await raise(where, { at: T0 });
    expect(await resolve(where, { at: T1 })).toBe(1);
    const reopened = await raise(where, { at: T2 });
    expect(reopened.opened).toBe(true);

    const rows = await rowsOf(where);
    expect(rows).toHaveLength(2);
    const resolved = rows.filter((row) => row.resolved_at !== null);
    const open = rows.filter((row) => row.resolved_at === null);
    expect(resolved).toHaveLength(1);
    expect(open).toHaveLength(1);
    expect(resolved[0]!.resolved_at!.getTime()).toBe(T1.getTime());
    expect(open[0]!.raised_at.getTime()).toBe(T2.getTime());
  });

  it("T3 resolve with no open row returns 0 and changes nothing", async () => {
    const where = await newNode(tenantA);
    expect(await resolve(where, { at: T1 })).toBe(0);
    expect(await rowsOf(where)).toHaveLength(0);

    // Already resolved: a second resolve closes nothing more.
    await raise(where, { at: T0 });
    expect(await resolve(where, { at: T1 })).toBe(1);
    expect(await resolve(where, { at: T2 })).toBe(0);
    expect((await rowsOf(where))[0]!.resolved_at!.getTime()).toBe(T1.getTime());
  });

  it("T3 resolved_at is never before raised_at", async () => {
    const where = await newNode(tenantA);
    await raise(where, { at: T1 });
    // The resolve time is earlier than the episode start (skewed edge clock).
    expect(await resolve(where, { at: T0 })).toBe(1);
    const row = (await rowsOf(where))[0]!;
    expect(row.resolved_at!.getTime()).toBeGreaterThanOrEqual(
      row.raised_at.getTime(),
    );
  });

  it("T3 quietSince keeps a recently seen row open and closes a quiet one", async () => {
    const where = await newNode(tenantA);
    await raise(where, { kind: RECEIPT_RUN, at: T1 });

    // Last seen at T1, which is after quietSince T0: not quiet yet, stays open.
    expect(
      await resolve(where, { kind: RECEIPT_RUN, at: T2, quietSince: T0 }),
    ).toBe(0);
    expect((await rowsOf(where, RECEIPT_RUN))[0]!.resolved_at).toBeNull();

    // quietSince T2 is after the last sighting: closes.
    expect(
      await resolve(where, { kind: RECEIPT_RUN, at: T2, quietSince: T2 }),
    ).toBe(1);
    expect((await rowsOf(where, RECEIPT_RUN))[0]!.resolved_at!.getTime()).toBe(
      T2.getTime(),
    );
  });

  it("T4 tenant B cannot read or change tenant A alerts", async () => {
    const where = await newNode(tenantA);
    await raise(where, { at: T0 });
    const contextB = contextOf(tenantB.tenantId, "tenant");
    const nodeId = where.node.edgeNode.id;

    const seen = await withTenant(db, contextB, (tx) =>
      tx.execute(
        sql`SELECT id FROM edge_node_alerts WHERE edge_node_id = ${nodeId}`,
      ),
    );
    expect(seen.rows).toHaveLength(0);

    const updated = await withTenant(db, contextB, (tx) =>
      tx.execute(
        sql`UPDATE edge_node_alerts SET resolved_at = now() WHERE edge_node_id = ${nodeId}`,
      ),
    );
    expect(updated.rowCount).toBe(0);

    // The service under tenant B's context also cannot close tenant A's row.
    expect(await resolve(where, { at: T1 }, contextB)).toBe(0);
    // Nor can it write a row for tenant A.
    await expect(
      raise(where, { kind: RECEIPT_RUN, at: T1 }, contextB),
    ).rejects.toThrow();
    expect(await rowsOf(where, RECEIPT_RUN)).toHaveLength(0);

    const row = (await rowsOf(where))[0]!;
    expect(row.resolved_at).toBeNull();
  });

  it("T4 an outlet-scoped context sees and changes only its own outlets", async () => {
    const outletOne = await newNode(tenantA);
    const outletTwo = await newNode(tenantA);
    await raise(outletOne, { at: T0 });
    await raise(outletTwo, { at: T0 });

    const scopeOne = contextOf(tenantA.tenantId, [outletOne.outletId]);
    const ids = [outletOne.node.edgeNode.id, outletTwo.node.edgeNode.id];
    const seen = await withTenant(db, scopeOne, (tx) =>
      tx.execute(
        sql`SELECT edge_node_id FROM edge_node_alerts WHERE edge_node_id IN (${ids[0]}, ${ids[1]})`,
      ),
    );
    expect(seen.rows).toHaveLength(1);
    expect(String(seen.rows[0]!.edge_node_id)).toBe(String(ids[0]));

    // Resolving the other outlet's alert from outlet one's scope closes nothing.
    expect(await resolve(outletTwo, { at: T1 }, scopeOne)).toBe(0);
    expect((await rowsOf(outletTwo))[0]!.resolved_at).toBeNull();
    // Its own outlet is closable.
    expect(await resolve(outletOne, { at: T1 }, scopeOne)).toBe(1);
  });
});
