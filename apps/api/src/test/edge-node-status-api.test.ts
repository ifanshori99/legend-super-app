// Back-office "Status edge" list API (legend-eo3lc, design
// docs/design/edge-status-cloud.md section 3 and tests T14-T21). Written from
// the design, independent of the implementation: failing until S3 merges.
//
// Assumed contracts (see the report):
//   GET /api/edge-node-status[?outletId=<id>] -> 200 { data: EdgeNodeStatus[], meta }
//   (DTO and schema in @starter/shared/edge/node-status, new subpath export).
//   Permission report.operational.view: tenant-wide or outlet-scoped role. No
//   permission -> 403. Outlet outside the caller's scope -> 403 or 404.
//   Not signed in -> 401.
//   Alerts table edge_node_alerts as in design D5 (seeded here by the migration
//   owner, so these tests do not depend on how alerts get raised).
//
// Fixtures: isolated tenant A (outlets A1, A2; nodes A1 primary, A1 standby, A2
// primary, one revoked A1 standby) and isolated tenant B (one node). Members use
// custom roles that hold only report.operational.view (tenant-wide stands in
// for "owner"; outlet-scoped stands in for "outlet manager").
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { edgeNodeStatusListSchema } from "@starter/shared/edge/node-status";
import { createApp } from "../app.ts";
import {
  registerEdgeNode,
  revokeEdgeNode,
} from "../services/edge-node.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  fixtures,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

type Member = { client: ReturnType<typeof agent>; userId: string };
type Node = Awaited<ReturnType<typeof registerEdgeNode>>;
type Dto = {
  id: string;
  label: string;
  role: string;
  outlet: { id: string; name: string };
  version: string | null;
  link: string;
  lastHeartbeatAt: string | null;
  alerts: Array<{ kind: string; raisedAt: string; lastSeenAt: string }>;
};

const actor = randomUUID();
const PERMISSION = "report.operational.view";

let app: Express;
let tenantA: IsolatedTenant;
let tenantB: IsolatedTenant;
let outletA1: string;
let outletA2: string;
let outletA1Name: string;
let nodeA1Primary: Node;
let nodeA1Standby: Node;
let nodeA2Primary: Node;
let nodeA1Revoked: Node;
let nodeB: Node;
let headersA: { Host: string };
let headersB: { Host: string };
let tenantWideA: Member; // report.operational.view, whole tenant
let outletManagerA1: Member; // report.operational.view, outlet A1 only
let noPermissionA: Member; // signed in, no report.operational.view
let tenantWideB: Member;

// ---- helpers ------------------------------------------------------------------

const norm = (id: string) =>
  id.includes("-") ? id.toLowerCase() : ulidToUuid(id);
const sameId = (a: string, b: string) => norm(a) === norm(b);

const contextOf = (
  tenantId: string,
  outletIds: string[],
): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "session",
    }),
    {
      kind: "outlets",
      outletIds: outletIds.map((id) => outletIdSchema.parse(id)),
    },
  );

async function asOwnerTenant<T>(
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

async function insertOutlet(
  tenant: IsolatedTenant,
  code: string,
  name: string,
): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Uji', 'Asia/Jakarta', $7, 'active')`,
    [
      id,
      tenant.tenantId,
      tenant.brandId,
      tenant.legalEntityId,
      code,
      name,
      JSON.stringify(fixtures.outlets[0].openingHours),
    ],
  );
  return id;
}

async function register(
  tenant: IsolatedTenant,
  outletId: string,
  role: "primary" | "standby",
  label: string,
): Promise<Node> {
  return registerEdgeNode(contextOf(tenant.tenantId, [outletId]), actor, {
    outletId,
    role,
    label,
  });
}

async function insertRole(
  tenantId: string,
  name: string,
  permissions: string[],
): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant","outlet"]')`,
    [id, tenantId, name, JSON.stringify(permissions)],
  );
  return id;
}

async function member(
  tenantId: string,
  roleId: string,
  scope: { type: "tenant" } | { type: "outlet"; id: string },
  label: string,
): Promise<Member> {
  const client = agent(app);
  await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [
      tenantId,
      userId,
      roleId,
      scope.type,
      scope.type === "outlet" ? scope.id : null,
    ],
  );
  return { client, userId };
}

/** Heartbeat set from the API process clock (the database clock can drift). */
const setHeartbeat = (
  tenantId: string,
  node: Node,
  ageSeconds: number | null,
) =>
  asOwnerTenant(tenantId, (client) =>
    client.query("UPDATE edge_nodes SET last_heartbeat_at = $2 WHERE id = $1", [
      node.edgeNode.id,
      ageSeconds === null ? null : new Date(Date.now() - ageSeconds * 1000),
    ]),
  );

async function insertAlert(
  where: { tenantId: string; outletId: string; node: Node },
  alert: {
    kind: "device_registry_hard_stale" | "receipt_run_alert";
    raisedAt: Date;
    lastSeenAt: Date;
    resolvedAt?: Date;
  },
) {
  await asOwnerTenant(where.tenantId, (client) =>
    client.query(
      `INSERT INTO edge_node_alerts
         (id, tenant_id, outlet_id, edge_node_id, kind, raised_at, last_seen_at, resolved_at, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '{}'::jsonb)`,
      [
        randomUUID(),
        where.tenantId,
        where.outletId,
        where.node.edgeNode.id,
        alert.kind,
        alert.raisedAt,
        alert.lastSeenAt,
        alert.resolvedAt ?? null,
      ],
    ),
  );
}

const list = (who: Member, headers: { Host: string }, query = "") =>
  who.client
    .get(`/api/edge-node-status${query}`)
    .set(headers)
    .set(originHeader);

const dataOf = (body: { data?: unknown }) => (body.data ?? []) as Dto[];
const find = (rows: Dto[], node: Node) =>
  rows.find((row) => sameId(row.id, node.edgeNode.id));

// ---- setup ----------------------------------------------------------------------

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  tenantA = await createIsolatedTenant(`ens-a-${randomUUID().slice(0, 6)}`);
  tenantB = await createIsolatedTenant(`ens-b-${randomUUID().slice(0, 6)}`);
  headersA = { Host: tenantA.hostname };
  headersB = { Host: tenantB.hostname };
  outletA1 = tenantA.outletId;
  const { rows } = await owner.query<{ name: string }>(
    "SELECT name FROM outlets WHERE id = $1",
    [outletA1],
  );
  outletA1Name = rows[0]!.name;
  outletA2 = await insertOutlet(tenantA, "ENS-A2", "Outlet Status A2");

  nodeA1Primary = await register(tenantA, outletA1, "primary", "Utama A1");
  // An outlet has one active node per role: the revoked standby is registered
  // and revoked first, then the live standby takes the role.
  nodeA1Revoked = await register(tenantA, outletA1, "standby", "Dicabut A1");
  await revokeEdgeNode(contextOf(tenantA.tenantId, [outletA1]), actor, {
    edgeNodeId: nodeA1Revoked.edgeNode.id,
    reason: "Perangkat hilang",
  });
  nodeA1Standby = await register(tenantA, outletA1, "standby", "Siaga A1");
  nodeA2Primary = await register(tenantA, outletA2, "primary", "Utama A2");
  nodeB = await register(tenantB, tenantB.outletId, "primary", "Utama B");

  // The column default is "unknown": the API must show it as no version.
  await asOwnerTenant(tenantA.tenantId, (client) =>
    client.query("UPDATE edge_nodes SET version = $2 WHERE id = $1", [
      nodeA1Primary.edgeNode.id,
      "2.3.1",
    ]),
  );

  const viewerA = await insertRole(tenantA.tenantId, "Pemantau Edge", [
    PERMISSION,
  ]);
  const plainA = await insertRole(tenantA.tenantId, "Tanpa Status Edge", [
    "floor.table.view",
  ]);
  const viewerB = await insertRole(tenantB.tenantId, "Pemantau Edge", [
    PERMISSION,
  ]);
  tenantWideA = await member(
    tenantA.tenantId,
    viewerA,
    { type: "tenant" },
    "Pemilik A",
  );
  outletManagerA1 = await member(
    tenantA.tenantId,
    viewerA,
    { type: "outlet", id: outletA1 },
    "Manajer Outlet A1",
  );
  noPermissionA = await member(
    tenantA.tenantId,
    plainA,
    { type: "tenant" },
    "Tanpa Izin",
  );
  tenantWideB = await member(
    tenantB.tenantId,
    viewerB,
    { type: "tenant" },
    "Pemilik B",
  );
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

// ---- tests ----------------------------------------------------------------------

describe("legend-eo3lc edge node status list", () => {
  it("T14 a tenant-wide viewer sees all active nodes of all outlets with name, outlet, role and version", async () => {
    const response = await list(tenantWideA, headersA);
    expect(response.status).toBe(200);
    const rows = dataOf(response.body);

    const a1 = find(rows, nodeA1Primary);
    const a1s = find(rows, nodeA1Standby);
    const a2 = find(rows, nodeA2Primary);
    expect(a1).toBeDefined();
    expect(a1s).toBeDefined();
    expect(a2).toBeDefined();
    expect(a1!.label).toBe("Utama A1");
    expect(a1!.role).toBe("primary");
    expect(a1!.outlet.name).toBe(outletA1Name);
    expect(sameId(a1!.outlet.id, outletA1)).toBe(true);
    expect(a1!.version).toBe("2.3.1");
    expect(a1s!.label).toBe("Siaga A1");
    expect(a1s!.role).toBe("standby");
    expect(a1s!.version).toBeNull(); // column default "unknown"
    expect(a2!.label).toBe("Utama A2");
    expect(a2!.outlet.name).toBe("Outlet Status A2");
    expect(sameId(a2!.outlet.id, outletA2)).toBe(true);

    // Revoked nodes and other tenants' nodes are absent.
    expect(find(rows, nodeA1Revoked)).toBeUndefined();
    expect(find(rows, nodeB)).toBeUndefined();
  });

  it("T14 within one outlet the primary node comes before the standby", async () => {
    const rows = dataOf((await list(tenantWideA, headersA)).body);
    const inOutlet = rows.filter((row) => sameId(row.outlet.id, outletA1));
    expect(inOutlet.map((row) => row.role)).toEqual(["primary", "standby"]);
  });

  it("T15 an outlet-scoped viewer sees only its own outlet", async () => {
    const response = await list(outletManagerA1, headersA);
    expect(response.status).toBe(200);
    const rows = dataOf(response.body);
    expect(find(rows, nodeA1Primary)).toBeDefined();
    expect(find(rows, nodeA1Standby)).toBeDefined();
    expect(find(rows, nodeA2Primary)).toBeUndefined();

    const own = await list(outletManagerA1, headersA, `?outletId=${outletA1}`);
    expect(own.status).toBe(200);
    expect(find(dataOf(own.body), nodeA1Primary)).toBeDefined();
    expect(find(dataOf(own.body), nodeA2Primary)).toBeUndefined();

    // The tenant-wide viewer can narrow to one outlet.
    const narrowed = await list(tenantWideA, headersA, `?outletId=${outletA2}`);
    expect(narrowed.status).toBe(200);
    expect(find(dataOf(narrowed.body), nodeA2Primary)).toBeDefined();
    expect(find(dataOf(narrowed.body), nodeA1Primary)).toBeUndefined();
  });

  it("T15 an outlet outside the viewer's scope is refused", async () => {
    const refused = await list(
      outletManagerA1,
      headersA,
      `?outletId=${outletA2}`,
    );
    expect([403, 404]).toContain(refused.status);
    expect(JSON.stringify(refused.body)).not.toContain("Utama A2");
  });

  it("T16 a user without report.operational.view is refused, and so is a visitor who is not signed in", async () => {
    expect((await list(noPermissionA, headersA)).status).toBe(403);
    const withOutlet = await list(
      noPermissionA,
      headersA,
      `?outletId=${outletA1}`,
    );
    expect(withOutlet.status).toBe(403);
    const anonymous = await agent(app)
      .get("/api/edge-node-status")
      .set(headersA)
      .set(originHeader);
    expect(anonymous.status).toBe(401);
  });

  it("T16 a malformed outletId is a validation error, not a list", async () => {
    const response = await list(tenantWideA, headersA, "?outletId=bukan-id");
    expect([400, 422]).toContain(response.status);
  });

  it("T17 tenant B sees only its own nodes, also when asking for tenant A's outlet", async () => {
    const response = await list(tenantWideB, headersB);
    expect(response.status).toBe(200);
    const rows = dataOf(response.body);
    expect(find(rows, nodeB)).toBeDefined();
    for (const node of [nodeA1Primary, nodeA1Standby, nodeA2Primary])
      expect(find(rows, node)).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain("Utama A1");

    const foreign = await list(tenantWideB, headersB, `?outletId=${outletA1}`);
    expect([403, 404]).toContain(foreign.status);
    expect(JSON.stringify(foreign.body)).not.toContain("Utama A1");
  });

  it("T18 link is connected up to 45 s after the last heartbeat and disconnected after that or when none", async () => {
    // Margins of 5 s each side of the default 45 s limit keep this stable even
    // when a request takes a moment. Assumes EDGE_LINK_STALE_SECONDS is unset.
    await setHeartbeat(tenantA.tenantId, nodeA1Primary, 40);
    await setHeartbeat(tenantA.tenantId, nodeA1Standby, 50);
    await setHeartbeat(tenantA.tenantId, nodeA2Primary, null);

    const response = await list(tenantWideA, headersA);
    expect(response.status).toBe(200);
    const rows = dataOf(response.body);

    const fresh = find(rows, nodeA1Primary)!;
    expect(fresh.link).toBe("connected");
    expect(fresh.lastHeartbeatAt).not.toBeNull();
    const heartbeatAge = Date.now() - Date.parse(fresh.lastHeartbeatAt!);
    expect(heartbeatAge).toBeGreaterThan(30_000);
    expect(heartbeatAge).toBeLessThan(60_000);

    const stale = find(rows, nodeA1Standby)!;
    expect(stale.link).toBe("disconnected");
    expect(stale.lastHeartbeatAt).not.toBeNull();

    const never = find(rows, nodeA2Primary)!;
    expect(never.link).toBe("disconnected");
    expect(never.lastHeartbeatAt).toBeNull();
  });

  it("T19 only open alerts appear", async () => {
    const t = (iso: string) => new Date(iso);
    const a1 = {
      tenantId: tenantA.tenantId,
      outletId: outletA1,
      node: nodeA1Primary,
    };
    const a2 = {
      tenantId: tenantA.tenantId,
      outletId: outletA2,
      node: nodeA2Primary,
    };
    // A1 primary: open hard-stale + an older resolved receipt-run alert.
    await insertAlert(a1, {
      kind: "device_registry_hard_stale",
      raisedAt: t("2026-11-17T01:00:00.000Z"),
      lastSeenAt: t("2026-11-17T02:00:00.000Z"),
    });
    await insertAlert(a1, {
      kind: "receipt_run_alert",
      raisedAt: t("2026-11-10T01:00:00.000Z"),
      lastSeenAt: t("2026-11-10T02:00:00.000Z"),
      resolvedAt: t("2026-11-12T01:00:00.000Z"),
    });
    // A2 primary: an open receipt-run alert and a resolved hard-stale one.
    await insertAlert(a2, {
      kind: "receipt_run_alert",
      raisedAt: t("2026-11-18T01:00:00.000Z"),
      lastSeenAt: t("2026-11-18T03:00:00.000Z"),
    });
    await insertAlert(a2, {
      kind: "device_registry_hard_stale",
      raisedAt: t("2026-11-01T01:00:00.000Z"),
      lastSeenAt: t("2026-11-01T02:00:00.000Z"),
      resolvedAt: t("2026-11-02T01:00:00.000Z"),
    });

    const rows = dataOf((await list(tenantWideA, headersA)).body);
    const one = find(rows, nodeA1Primary)!;
    expect(one.alerts).toHaveLength(1);
    expect(one.alerts[0]!.kind).toBe("device_registry_hard_stale");
    expect(Date.parse(one.alerts[0]!.raisedAt)).toBe(
      Date.parse("2026-11-17T01:00:00.000Z"),
    );
    expect(Date.parse(one.alerts[0]!.lastSeenAt)).toBe(
      Date.parse("2026-11-17T02:00:00.000Z"),
    );

    const two = find(rows, nodeA2Primary)!;
    expect(two.alerts).toHaveLength(1);
    expect(two.alerts[0]!.kind).toBe("receipt_run_alert");
    expect(Date.parse(two.alerts[0]!.lastSeenAt)).toBe(
      Date.parse("2026-11-18T03:00:00.000Z"),
    );

    expect(find(rows, nodeA1Standby)!.alerts).toEqual([]);
  });

  it("T19 another tenant's alerts never show up", async () => {
    await insertAlert(
      { tenantId: tenantB.tenantId, outletId: tenantB.outletId, node: nodeB },
      {
        kind: "receipt_run_alert",
        raisedAt: new Date("2026-11-18T01:00:00.000Z"),
        lastSeenAt: new Date("2026-11-18T02:00:00.000Z"),
      },
    );
    const rows = dataOf((await list(tenantWideA, headersA)).body);
    expect(rows.some((row) => sameId(row.id, nodeB.edgeNode.id))).toBe(false);
    const own = dataOf((await list(tenantWideB, headersB)).body);
    expect(find(own, nodeB)!.alerts).toHaveLength(1);
  });

  it("T20 the response parses with the shared schema and exposes no credential, instance or cursor data", async () => {
    const response = await list(tenantWideA, headersA);
    expect(response.status).toBe(200);
    const parsed = edgeNodeStatusListSchema.safeParse(response.body);
    expect(parsed.success).toBe(true);
    expect(Object.keys(response.body).sort()).toEqual(["data", "meta"]);
    expect(Object.keys(response.body.meta).sort()).toEqual([
      "generatedAt",
      "truncated",
    ]);
    expect(response.body.meta.truncated).toBe(false);

    const allowed = [
      "alerts",
      // 1271 F4: the outlet's open failover window (null when none).
      "failover",
      "id",
      "label",
      "lastHeartbeatAt",
      "link",
      "outlet",
      "role",
      "version",
    ];
    for (const row of dataOf(response.body))
      expect(Object.keys(row).sort()).toEqual(allowed);

    const text = JSON.stringify(response.body).toLowerCase();
    for (const secret of [
      "credential",
      "instance",
      "cursor",
      "registered",
      "revoke",
      "hash",
    ])
      expect(text).not.toContain(secret);
  });

  it("T21 more than 500 nodes returns 500 and marks the list as truncated", async () => {
    const bulk = await createIsolatedTenant(
      `ens-bulk-${randomUUID().slice(0, 6)}`,
    );
    try {
      const extra = await owner.query<{ id: string }>(
        `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
           SELECT gen_random_uuid(), $1, $2, $3, 'BK' || g, 'Outlet Bulk ' || lpad(g::text, 3, '0'),
                  'Jl. Uji', 'Asia/Jakarta', $4::jsonb, 'active'
             FROM generate_series(1, 250) AS g
           RETURNING id`,
        [
          bulk.tenantId,
          bulk.brandId,
          bulk.legalEntityId,
          JSON.stringify(fixtures.outlets[0].openingHours),
        ],
      );
      // 251 outlets x (primary + standby) = 502 active nodes (> 500).
      const outlets = [bulk.outletId, ...extra.rows.map((row) => row.id)];
      const jobs = outlets.flatMap((outletId) => [
        () => register(bulk, outletId, "primary", "Utama"),
        () => register(bulk, outletId, "standby", "Siaga"),
      ]);
      for (let i = 0; i < jobs.length; i += 10)
        await Promise.all(jobs.slice(i, i + 10).map((job) => job()));

      const roleId = await insertRole(bulk.tenantId, "Pemantau Edge", [
        PERMISSION,
      ]);
      const viewer = await member(
        bulk.tenantId,
        roleId,
        { type: "tenant" },
        "Pemilik Bulk",
      );
      const response = await list(viewer, { Host: bulk.hostname });
      expect(response.status).toBe(200);
      expect(dataOf(response.body)).toHaveLength(500);
      expect(response.body.meta.truncated).toBe(true);
      expect(edgeNodeStatusListSchema.safeParse(response.body).success).toBe(
        true,
      );
    } finally {
      await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
        bulk.tenantId,
        randomUUID(),
      ]);
    }
  }, 300_000);
});
