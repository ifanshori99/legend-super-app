// WS-02 edge sync conflict review + replay (bead legend-wqc6, brief 90 section
// C). Written from the brief, independent of the implementation: failing
// imports are expected until the sections merge.
//
// Assumed contracts (see the report):
//   services/edge-sync-conflict.service.ts
//     listEdgeSyncConflicts(ctx, { outletId?, edgeNodeId?, status, cursor?, limit })
//       -> { items: Conflict[], nextCursor: string | null } (a bare array is also accepted)
//     getEdgeSyncConflict(ctx, id) -> detail with `.event` (envelope) and `.resolutions[]`
//       (not visible = rejects or resolves null/undefined)
//     resolveEdgeSyncConflict(ctx, actorId, id, { action: "replay"|"dismiss", note })
//   Conflict ids are ULIDs (the table's id column is ulidInUuid); a uuid is also accepted.
//   Routes: GET /api/edge-sync-conflicts, GET /:conflictId, POST /:conflictId/resolve
//   (body { action, note }), permission device.registry.manage in the conflict's outlet.
//   Alert: on a NEW conflict (applyInbound), supervisors of the outlet are notified
//   through the notification outbox / event outbox / notifications table; the test
//   only measures row deltas in those tables for the tenant, not the exact mechanism.
//
// Fixtures: two disposable isolated tenants (A with two outlets, B with one),
// created by the migration owner. Conflicts are seeded as the owner because a
// conflict only exists when the conflict rules refused an event.
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  CoreError,
  createUlid,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  uuidToUlid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { EventEnvelope } from "@starter/shared/events";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { createDbLinkStore } from "../edge/db-link-store.ts";
import {
  EdgeApplierUnavailableError,
  setEdgeEventApplier,
  type EdgeApplyMeta,
  type EdgeEventApplier,
} from "../edge/ports.ts";
import { HttpError } from "../lib/http-error.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  authenticateEdgeCredential,
  registerEdgeNode,
  revokeEdgeNode,
} from "../services/edge-node.service.ts";
import {
  getEdgeSyncConflict,
  listEdgeSyncConflicts,
  resolveEdgeSyncConflict,
} from "../services/edge-sync-conflict.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  fixtures,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

type Member = { client: ReturnType<typeof agent>; userId: string };
type Seeded = {
  id: string; // ULID
  eventId: string; // ULID
  event: EventEnvelope;
  tenantId: string;
  outletId: string;
  edgeNodeId: string;
  createdAt: Date;
};

const actor = randomUUID();
let app: Express;
let tenantA: IsolatedTenant;
let tenantB: IsolatedTenant;
let outletA1: string;
let outletA2: string;
let nodeA1: Awaited<ReturnType<typeof registerEdgeNode>>;
let nodeA2: Awaited<ReturnType<typeof registerEdgeNode>>;
let nodeB: Awaited<ReturnType<typeof registerEdgeNode>>;
let headersA: { Host: string };
let headersB: { Host: string };
let managerTenantA: Member; // tenant-wide device.registry.manage
let managerOutletA1: Member; // device.registry.manage in outlet A1 only
let noPermissionA: Member; // signed in, no device.registry.manage
let managerTenantB: Member;
let supervisorA1: Member;
let cashierA1: Member;
let supervisorA2: Member;

// ---- helpers ------------------------------------------------------------------

const norm = (id: string) =>
  id.includes("-") ? id.toLowerCase() : ulidToUuid(id);
const sameId = (a: string, b: string) => norm(a) === norm(b);

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

/** list/detail results: `{ items }` or a bare array. */
function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const items = (result as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? (items as Array<Record<string, unknown>>) : [];
}
const idsOf = (result: unknown) => rowsOf(result).map((row) => String(row.id));
const has = (result: unknown, seeded: Seeded) =>
  idsOf(result).some((id) => sameId(id, seeded.id));
/** HTTP bodies carry the same list under `data`. */
const httpRows = (body: { data?: unknown }) => rowsOf(body.data);
const httpHas = (body: { data?: unknown }, seeded: Seeded) =>
  httpRows(body).some((row) => sameId(String(row.id), seeded.id));

async function notVisible(call: Promise<unknown>) {
  const result = await call.then(
    (value) => value,
    () => null,
  );
  expect(result ?? null).toBeNull();
}

let clock = Date.parse("2026-11-08T08:00:00.000Z");
async function seedConflict(
  where: { tenantId: string; outletId: string; edgeNodeId: string },
  overrides: { createdAt?: Date } = {},
): Promise<Seeded> {
  clock += 5_000;
  const createdAt = overrides.createdAt ?? new Date(clock);
  const id = createUlid(clock);
  const eventId = createUlid(clock + 1);
  const event: EventEnvelope = {
    id: eventId,
    tenantId: where.tenantId as EventEnvelope["tenantId"],
    outletId: where.outletId as EventEnvelope["outletId"],
    name: "order.item_added",
    version: 1,
    aggregateType: "order",
    aggregateId: randomUUID(),
    sequence: 4,
    occurredAt: createdAt.toISOString(),
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `conf-${clock}`,
    payloadSchemaRef: "order.item_added.v1",
    payload: {},
  };
  await asOwnerTenant(where.tenantId, (client) =>
    client.query(
      `INSERT INTO edge_sync_conflicts
         (id, tenant_id, outlet_id, edge_node_id, direction, event_id, aggregate_type,
          aggregate_id, aggregate_sequence, kind, reason, resolution, existing_sequence, event, created_at)
       VALUES ($1::uuid, $2, $3, $4, 'edge_to_cloud', $5::uuid, 'order', $6, 4,
               'transaction_event', 'sequence_gap', 'append_only', 1, $7::jsonb, $8)`,
      [
        ulidToUuid(id),
        where.tenantId,
        where.outletId,
        where.edgeNodeId,
        ulidToUuid(eventId),
        event.aggregateId,
        JSON.stringify(event),
        createdAt,
      ],
    ),
  );
  return { id, eventId, event, createdAt, ...where };
}

async function resolutionRows(seeded: Seeded) {
  const { rows } = await owner.query<{
    action: string;
    outcome: string;
    error: string | null;
    note: string | null;
    resolved_by: string;
  }>(
    `SELECT action, outcome, error, note, resolved_by
       FROM edge_sync_conflict_resolutions
      WHERE tenant_id = $1 AND conflict_id = $2::uuid
      ORDER BY resolved_at, id`,
    [seeded.tenantId, ulidToUuid(seeded.id)],
  );
  return rows;
}

async function conflictRowCount(tenantId: string) {
  const { rows } = await owner.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM edge_sync_conflicts WHERE tenant_id = $1",
    [tenantId],
  );
  return rows[0]!.n;
}

function recordingApplier(
  calls: Array<{ event: EventEnvelope; meta: EdgeApplyMeta }>,
) {
  const applier: EdgeEventApplier = {
    async apply(_tx, event, meta) {
      calls.push({ event, meta });
    },
  };
  return applier;
}

async function member(
  tenant: IsolatedTenant,
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
      tenant.tenantId,
      userId,
      roleId,
      scope.type,
      scope.type === "outlet" ? scope.id : null,
    ],
  );
  return { client, userId };
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

/** Copies the seeded tenant's supervisor/cashier template into a tenant. */
async function copyTemplateRole(tenantId: string, templateKey: string) {
  const id = randomUUID();
  const result = await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     SELECT $1, $2, name, is_template, template_key, permissions, mfa_required, allowed_scope_types
       FROM roles WHERE tenant_id = $3 AND template_key = $4`,
    [id, tenantId, fixtures.tenant.id, templateKey],
  );
  if (result.rowCount !== 1) throw new Error(`No role template ${templateKey}`);
  return id;
}

const http = {
  list: (who: Member, headers: { Host: string }, query = "") =>
    who.client
      .get(`/api/edge-sync-conflicts${query}`)
      .set(headers)
      .set(originHeader),
  get: (who: Member, headers: { Host: string }, id: string) =>
    who.client
      .get(`/api/edge-sync-conflicts/${encodeURIComponent(id)}`)
      .set(headers)
      .set(originHeader),
  resolve: (
    who: Member,
    headers: { Host: string },
    id: string,
    body: Record<string, unknown>,
  ) =>
    who.client
      .post(`/api/edge-sync-conflicts/${encodeURIComponent(id)}/resolve`)
      .set(headers)
      .set(originHeader)
      .send(body),
};

// ---- setup ----------------------------------------------------------------------

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  setAuditWriter(coreAuditWriter);
  tenantA = await createIsolatedTenant(`esc-a-${randomUUID().slice(0, 6)}`);
  tenantB = await createIsolatedTenant(`esc-b-${randomUUID().slice(0, 6)}`);
  headersA = { Host: tenantA.hostname };
  headersB = { Host: tenantB.hostname };
  outletA1 = tenantA.outletId;
  outletA2 = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, 'ESC-A2', 'Outlet A2', 'Jl. Uji 2', 'Asia/Jakarta', $5, 'active')`,
    [
      outletA2,
      tenantA.tenantId,
      tenantA.brandId,
      tenantA.legalEntityId,
      JSON.stringify(fixtures.outlets[0].openingHours),
    ],
  );
  nodeA1 = await registerEdgeNode(
    contextOf(tenantA.tenantId, [outletA1]),
    actor,
    {
      outletId: outletA1,
      role: "primary",
      label: "Utama A1",
    },
  );
  nodeA2 = await registerEdgeNode(
    contextOf(tenantA.tenantId, [outletA2]),
    actor,
    {
      outletId: outletA2,
      role: "primary",
      label: "Utama A2",
    },
  );
  nodeB = await registerEdgeNode(
    contextOf(tenantB.tenantId, [tenantB.outletId]),
    actor,
    { outletId: tenantB.outletId, role: "primary", label: "Utama B" },
  );

  const managerRoleA = await insertRole(
    tenantA.tenantId,
    "Pengelola Perangkat",
    ["device.registry.manage"],
  );
  const plainRoleA = await insertRole(tenantA.tenantId, "Tanpa Perangkat", [
    "floor.table.view",
  ]);
  const managerRoleB = await insertRole(
    tenantB.tenantId,
    "Pengelola Perangkat",
    ["device.registry.manage"],
  );
  managerTenantA = await member(
    tenantA,
    managerRoleA,
    { type: "tenant" },
    "Manajer A",
  );
  managerOutletA1 = await member(
    tenantA,
    managerRoleA,
    { type: "outlet", id: outletA1 },
    "Manajer Outlet A1",
  );
  noPermissionA = await member(
    tenantA,
    plainRoleA,
    { type: "tenant" },
    "Tanpa Izin",
  );
  managerTenantB = await member(
    tenantB,
    managerRoleB,
    { type: "tenant" },
    "Manajer B",
  );

  const supervisorRole = await copyTemplateRole(tenantA.tenantId, "supervisor");
  const cashierRole = await copyTemplateRole(tenantA.tenantId, "cashier");
  supervisorA1 = await member(
    tenantA,
    supervisorRole,
    { type: "outlet", id: outletA1 },
    "Supervisor A1",
  );
  supervisorA2 = await member(
    tenantA,
    supervisorRole,
    { type: "outlet", id: outletA2 },
    "Supervisor A2",
  );
  cashierA1 = await member(
    tenantA,
    cashierRole,
    { type: "outlet", id: outletA1 },
    "Kasir A1",
  );
});

afterEach(() => {
  setEdgeEventApplier("edge_to_cloud", null);
  setEdgeEventApplier("cloud_to_edge", null);
});

afterAll(async () => {
  setAuditWriter(null);
  // Edge and audit rows are append-only, so the isolated tenants stay in the
  // disposable database; give them a valid creator so the platform tenant
  // list still parses them.
  for (const tenant of [tenantA, tenantB])
    await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      tenant.tenantId,
      randomUUID(),
    ]);
  await owner.end();
});

// ---- list ---------------------------------------------------------------------

describe("legend-wqc6 list and detail", () => {
  let c1: Seeded;
  let c2: Seeded;
  let c3: Seeded;
  let c4: Seeded; // outlet A2
  let cb: Seeded; // tenant B

  beforeAll(async () => {
    const a1 = {
      tenantId: tenantA.tenantId,
      outletId: outletA1,
      edgeNodeId: nodeA1.edgeNode.id,
    };
    c1 = await seedConflict(a1);
    c2 = await seedConflict(a1);
    c3 = await seedConflict(a1);
    c4 = await seedConflict({
      tenantId: tenantA.tenantId,
      outletId: outletA2,
      edgeNodeId: nodeA2.edgeNode.id,
    });
    cb = await seedConflict({
      tenantId: tenantB.tenantId,
      outletId: tenantB.outletId,
      edgeNodeId: nodeB.edgeNode.id,
    });
  });

  it("lists open conflicts newest first, only of the caller's tenant", async () => {
    const result = await listEdgeSyncConflicts(
      contextOf(tenantA.tenantId, "tenant"),
      {
        status: "open",
        limit: 50,
      },
    );
    for (const seeded of [c1, c2, c3, c4])
      expect(has(result, seeded)).toBe(true);
    expect(has(result, cb)).toBe(false);
    const order = idsOf(result)
      .map((id) =>
        [c4, c3, c2, c1].findIndex((seeded) => sameId(id, seeded.id)),
      )
      .filter((index) => index >= 0);
    // c4 was seeded last, c1 first: newest first means c4, c3, c2, c1.
    expect(order).toEqual([0, 1, 2, 3]);
  });

  it("filters by outlet and by edge node", async () => {
    const context = contextOf(tenantA.tenantId, "tenant");
    const byOutlet = await listEdgeSyncConflicts(context, {
      outletId: outletA2,
      status: "open",
      limit: 50,
    });
    expect(has(byOutlet, c4)).toBe(true);
    expect(has(byOutlet, c1)).toBe(false);
    const byNode = await listEdgeSyncConflicts(context, {
      edgeNodeId: nodeA1.edgeNode.id,
      status: "open",
      limit: 50,
    });
    expect(has(byNode, c1)).toBe(true);
    expect(has(byNode, c4)).toBe(false);
  });

  it("pages with a keyset cursor without repeating or skipping rows", async () => {
    const context = contextOf(tenantA.tenantId, "tenant");
    const query = { outletId: outletA1, status: "open" as const };
    const first = await listEdgeSyncConflicts(context, { ...query, limit: 2 });
    expect(idsOf(first)).toHaveLength(2);
    const cursor = (first as { nextCursor?: string | null }).nextCursor;
    expect(cursor).toBeTruthy();
    const second = await listEdgeSyncConflicts(context, {
      ...query,
      limit: 2,
      cursor: cursor as string,
    });
    const all = [...idsOf(first), ...idsOf(second)];
    expect(new Set(all.map(norm)).size).toBe(all.length);
    for (const seeded of [c1, c2, c3])
      expect(all.some((id) => sameId(id, seeded.id))).toBe(true);
  });

  it("an outlet-scoped caller only sees its own outlet", async () => {
    const context = contextOf(tenantA.tenantId, [outletA1]);
    const result = await listEdgeSyncConflicts(context, {
      status: "open",
      limit: 50,
    });
    expect(has(result, c1)).toBe(true);
    expect(has(result, c4)).toBe(false);
    await notVisible(getEdgeSyncConflict(context, c4.id));
  });

  it("another tenant cannot list or read the conflict", async () => {
    const context = contextOf(tenantB.tenantId, "tenant");
    const result = await listEdgeSyncConflicts(context, {
      status: "all",
      limit: 50,
    });
    expect(has(result, cb)).toBe(true);
    for (const seeded of [c1, c2, c3, c4])
      expect(has(result, seeded)).toBe(false);
    await notVisible(getEdgeSyncConflict(context, c1.id));
  });

  it("detail returns the full envelope and an empty resolution history", async () => {
    const detail = (await getEdgeSyncConflict(
      contextOf(tenantA.tenantId, "tenant"),
      c1.id,
    )) as { event: EventEnvelope; resolutions: unknown[] };
    expect(detail.event.id).toBe(c1.event.id);
    expect(detail.event.aggregateId).toBe(c1.event.aggregateId);
    expect(detail.resolutions).toEqual([]);
  });
});

// ---- resolve ----------------------------------------------------------------------

describe("legend-wqc6 replay and dismiss", () => {
  const context = () => contextOf(tenantA.tenantId, "tenant");
  const freshA1 = () =>
    seedConflict({
      tenantId: tenantA.tenantId,
      outletId: outletA1,
      edgeNodeId: nodeA1.edgeNode.id,
    });

  it("a successful replay applies the envelope, records `applied` and closes the conflict", async () => {
    const seeded = await freshA1();
    const calls: Array<{ event: EventEnvelope; meta: EdgeApplyMeta }> = [];
    setEdgeEventApplier("edge_to_cloud", recordingApplier(calls));
    const before = await conflictRowCount(tenantA.tenantId);

    await resolveEdgeSyncConflict(context(), actor, seeded.id, {
      action: "replay",
      note: "Diulang setelah cek manual",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.event.id).toBe(seeded.event.id);
    expect(calls[0]!.meta.direction).toBe("edge_to_cloud");
    expect(calls[0]!.meta.edgeNodeId).toBe(seeded.edgeNodeId);
    expect(await resolutionRows(seeded)).toEqual([
      expect.objectContaining({
        action: "replayed",
        outcome: "applied",
        error: null,
        note: "Diulang setelah cek manual",
        resolved_by: actor,
      }),
    ]);
    // Append-only: the conflict itself is still there, but no longer open.
    expect(await conflictRowCount(tenantA.tenantId)).toBe(before);
    const open = await listEdgeSyncConflicts(context(), {
      status: "open",
      limit: 100,
    });
    const resolved = await listEdgeSyncConflicts(context(), {
      status: "resolved",
      limit: 100,
    });
    const all = await listEdgeSyncConflicts(context(), {
      status: "all",
      limit: 100,
    });
    expect(has(open, seeded)).toBe(false);
    expect(has(resolved, seeded)).toBe(true);
    expect(has(all, seeded)).toBe(true);
    const detail = (await getEdgeSyncConflict(context(), seeded.id)) as {
      resolutions: Array<{ outcome: string }>;
    };
    expect(detail.resolutions.map((row) => row.outcome)).toEqual(["applied"]);
  });

  it("a replay that throws is recorded `failed` with the error, the conflict stays open, and the request still succeeds", async () => {
    const seeded = await freshA1();
    // `SELECT 1/0` aborts a bare transaction: the failed row can only be
    // saved when the replay ran inside a savepoint.
    setEdgeEventApplier("edge_to_cloud", {
      async apply(tx) {
        await (tx as { execute: (query: unknown) => Promise<unknown> }).execute(
          sql`SELECT 1/0`,
        );
      },
    });
    // The failure is reported in the result, never thrown to the caller.
    await resolveEdgeSyncConflict(context(), actor, seeded.id, {
      action: "replay",
      note: "Percobaan pertama",
    });
    const failed = await resolutionRows(seeded);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ action: "replayed", outcome: "failed" });
    expect(failed[0]!.error ?? "").not.toBe("");
    const open = await listEdgeSyncConflicts(context(), {
      status: "open",
      limit: 100,
    });
    expect(has(open, seeded)).toBe(true);

    // A throwing applier with a plain message.
    const second = await freshA1();
    setEdgeEventApplier("edge_to_cloud", {
      async apply() {
        throw new Error("pesanan tidak ditemukan");
      },
    });
    await resolveEdgeSyncConflict(context(), actor, second.id, {
      action: "replay",
      note: "Coba",
    });
    const secondRows = await resolutionRows(second);
    expect(secondRows[0]).toMatchObject({ outcome: "failed" });
    expect(secondRows[0]!.error).toContain("pesanan tidak ditemukan");

    // The failure is history, not a lock: a later replay can succeed.
    const calls: Array<{ event: EventEnvelope; meta: EdgeApplyMeta }> = [];
    setEdgeEventApplier("edge_to_cloud", recordingApplier(calls));
    await resolveEdgeSyncConflict(context(), actor, seeded.id, {
      action: "replay",
      note: "Percobaan kedua",
    });
    expect(calls).toHaveLength(1);
    expect((await resolutionRows(seeded)).map((row) => row.outcome)).toEqual([
      "failed",
      "applied",
    ]);
    const openAfter = await listEdgeSyncConflicts(context(), {
      status: "open",
      limit: 100,
    });
    expect(has(openAfter, seeded)).toBe(false);
  });

  it("dismiss closes the conflict without applying anything and is idempotent", async () => {
    const seeded = await freshA1();
    const calls: Array<{ event: EventEnvelope; meta: EdgeApplyMeta }> = [];
    setEdgeEventApplier("edge_to_cloud", recordingApplier(calls));
    await resolveEdgeSyncConflict(context(), actor, seeded.id, {
      action: "dismiss",
      note: "Duplikat, diabaikan",
    });
    expect(await resolutionRows(seeded)).toEqual([
      expect.objectContaining({
        action: "dismissed",
        outcome: "dismissed",
        note: "Duplikat, diabaikan",
      }),
    ]);
    // Same call again, and a replay on a closed conflict: nothing changes.
    await resolveEdgeSyncConflict(context(), actor, seeded.id, {
      action: "dismiss",
      note: "Duplikat, diabaikan",
    });
    await resolveEdgeSyncConflict(context(), actor, seeded.id, {
      action: "replay",
      note: "Terlambat",
    });
    expect(await resolutionRows(seeded)).toHaveLength(1);
    expect(calls).toEqual([]);
    const open = await listEdgeSyncConflicts(context(), {
      status: "open",
      limit: 100,
    });
    expect(has(open, seeded)).toBe(false);
  });

  it("a replay of an already applied conflict does not apply twice, even when raced", async () => {
    const seeded = await freshA1();
    const calls: Array<{ event: EventEnvelope; meta: EdgeApplyMeta }> = [];
    setEdgeEventApplier("edge_to_cloud", recordingApplier(calls));
    await Promise.all([
      resolveEdgeSyncConflict(context(), actor, seeded.id, {
        action: "replay",
        note: "A",
      }),
      resolveEdgeSyncConflict(context(), actor, seeded.id, {
        action: "replay",
        note: "B",
      }),
    ]);
    await resolveEdgeSyncConflict(context(), actor, seeded.id, {
      action: "replay",
      note: "C",
    });
    expect(calls).toHaveLength(1);
    expect(await resolutionRows(seeded)).toHaveLength(1);
  });

  it("another tenant and an outlet-scoped caller of another outlet cannot resolve it", async () => {
    const seeded = await freshA1();
    const calls: Array<{ event: EventEnvelope; meta: EdgeApplyMeta }> = [];
    setEdgeEventApplier("edge_to_cloud", recordingApplier(calls));
    await expect(
      resolveEdgeSyncConflict(
        contextOf(tenantB.tenantId, "tenant"),
        actor,
        seeded.id,
        {
          action: "dismiss",
          note: "Bukan tenant saya",
        },
      ),
    ).rejects.toThrow();
    await expect(
      resolveEdgeSyncConflict(
        contextOf(tenantA.tenantId, [outletA2]),
        actor,
        seeded.id,
        {
          action: "replay",
          note: "Bukan outlet saya",
        },
      ),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
    expect(await resolutionRows(seeded)).toEqual([]);
  });
});

// ---- HTTP: permission, outlet scope, tenant isolation ---------------------------------

describe("legend-wqc6 routes", () => {
  let mine: Seeded;
  let other: Seeded; // outlet A2
  let foreign: Seeded; // tenant B

  beforeAll(async () => {
    mine = await seedConflict({
      tenantId: tenantA.tenantId,
      outletId: outletA1,
      edgeNodeId: nodeA1.edgeNode.id,
    });
    other = await seedConflict({
      tenantId: tenantA.tenantId,
      outletId: outletA2,
      edgeNodeId: nodeA2.edgeNode.id,
    });
    foreign = await seedConflict({
      tenantId: tenantB.tenantId,
      outletId: tenantB.outletId,
      edgeNodeId: nodeB.edgeNode.id,
    });
  });

  it("requires a signed-in user", async () => {
    const anonymous = agent(app);
    expect(
      (await anonymous.get("/api/edge-sync-conflicts").set(headersA)).status,
    ).toBe(401);
    expect(
      (
        await anonymous
          .post(`/api/edge-sync-conflicts/${mine.id}/resolve`)
          .set(headersA)
          .set(originHeader)
          .send({ action: "dismiss", note: "x" })
      ).status,
    ).toBe(401);
  });

  it("a user without device.registry.manage is refused on list, detail and resolve", async () => {
    expect((await http.list(noPermissionA, headersA)).status).toBe(403);
    expect((await http.get(noPermissionA, headersA, mine.id)).status).toBe(403);
    const resolve = await http.resolve(noPermissionA, headersA, mine.id, {
      action: "dismiss",
      note: "Tanpa izin",
    });
    expect(resolve.status).toBe(403);
    expect(await resolutionRows(mine)).toEqual([]);
  });

  it("an outlet manager lists and reads only the conflicts of their outlet", async () => {
    const list = await http.list(managerOutletA1, headersA, "?status=open");
    expect(list.status).toBe(200);
    expect(httpHas(list.body, mine)).toBe(true);
    expect(httpHas(list.body, other)).toBe(false);
    expect(httpHas(list.body, foreign)).toBe(false);
    expect((await http.get(managerOutletA1, headersA, mine.id)).status).toBe(
      200,
    );
    expect([403, 404]).toContain(
      (await http.get(managerOutletA1, headersA, other.id)).status,
    );
  });

  it("an outlet manager cannot resolve a conflict of another outlet", async () => {
    const refused = await http.resolve(managerOutletA1, headersA, other.id, {
      action: "dismiss",
      note: "Outlet lain",
    });
    expect([403, 404]).toContain(refused.status);
    expect(await resolutionRows(other)).toEqual([]);
  });

  it("another tenant gets 404/403 and sees only its own conflicts", async () => {
    const list = await http.list(managerTenantB, headersB, "?status=all");
    expect(list.status).toBe(200);
    expect(httpHas(list.body, foreign)).toBe(true);
    expect(httpHas(list.body, mine)).toBe(false);
    expect([403, 404]).toContain(
      (await http.get(managerTenantB, headersB, mine.id)).status,
    );
    const resolve = await http.resolve(managerTenantB, headersB, mine.id, {
      action: "dismiss",
      note: "Tenant lain",
    });
    expect([403, 404]).toContain(resolve.status);
    expect(await resolutionRows(mine)).toEqual([]);
  });

  it("an unknown conflict id is 404", async () => {
    expect(
      (await http.get(managerTenantA, headersA, createUlid())).status,
    ).toBe(404);
  });

  it("a note longer than 500 characters or an unknown action is rejected", async () => {
    const longNote = await http.resolve(managerTenantA, headersA, mine.id, {
      action: "dismiss",
      note: "x".repeat(501),
    });
    expect([400, 422]).toContain(longNote.status);
    const badAction = await http.resolve(managerTenantA, headersA, mine.id, {
      action: "delete",
      note: "x",
    });
    expect([400, 422]).toContain(badAction.status);
    expect(await resolutionRows(mine)).toEqual([]);
  });

  it("a manager dismisses over HTTP; the detail shows the resolution and a repeat is a no-op", async () => {
    const resolved = await http.resolve(managerOutletA1, headersA, mine.id, {
      action: "dismiss",
      note: "Sudah dicek",
    });
    expect(resolved.status).toBe(200);
    const again = await http.resolve(managerOutletA1, headersA, mine.id, {
      action: "dismiss",
      note: "Sudah dicek",
    });
    expect(again.status).toBe(200);
    expect(await resolutionRows(mine)).toHaveLength(1);
    const detail = await http.get(managerOutletA1, headersA, mine.id);
    expect(detail.status).toBe(200);
    expect(detail.body.data.event.id).toBe(mine.event.id);
    expect(detail.body.data.resolutions).toHaveLength(1);
    const open = await http.list(managerOutletA1, headersA, "?status=open");
    expect(httpHas(open.body, mine)).toBe(false);
    const resolvedList = await http.list(
      managerOutletA1,
      headersA,
      "?status=resolved",
    );
    expect(httpHas(resolvedList.body, mine)).toBe(true);
  });

  it("a replay that fails still answers 200 and leaves the conflict open", async () => {
    const seeded = await seedConflict({
      tenantId: tenantA.tenantId,
      outletId: outletA1,
      edgeNodeId: nodeA1.edgeNode.id,
    });
    setEdgeEventApplier("edge_to_cloud", {
      async apply() {
        throw new Error("gagal diterapkan");
      },
    });
    const response = await http.resolve(managerTenantA, headersA, seeded.id, {
      action: "replay",
      note: "Coba lagi",
    });
    expect(response.status).toBe(200);
    expect((await resolutionRows(seeded))[0]).toMatchObject({
      outcome: "failed",
    });
    const open = await http.list(managerTenantA, headersA, "?status=open");
    expect(httpHas(open.body, seeded)).toBe(true);
  });
});

// ---- alert on a new conflict ---------------------------------------------------------

describe("legend-wqc6 alert to supervisors", () => {
  async function alertCounts() {
    const count = async (text: string, params: unknown[]) =>
      (
        await asOwnerTenant(tenantA.tenantId, (client) =>
          client.query<{ n: number }>(text, params),
        )
      ).rows[0]!.n;
    return {
      notificationOutbox: await count(
        "SELECT count(*)::int AS n FROM notification_outbox WHERE tenant_id = $1",
        [tenantA.tenantId],
      ),
      eventOutbox: await count(
        "SELECT count(*)::int AS n FROM domain_event_outbox WHERE tenant_id = $1",
        [tenantA.tenantId],
      ),
      notifications: await count(
        "SELECT count(*)::int AS n FROM notifications WHERE tenant_id = $1",
        [tenantA.tenantId],
      ),
    };
  }
  const delta = (
    after: Awaited<ReturnType<typeof alertCounts>>,
    before: Awaited<ReturnType<typeof alertCounts>>,
  ) => ({
    notificationOutbox: after.notificationOutbox - before.notificationOutbox,
    eventOutbox: after.eventOutbox - before.eventOutbox,
    notifications: after.notifications - before.notifications,
  });

  let clockMs = Date.parse("2026-11-08T10:00:00.000Z");
  function gapEvent(aggregateId: string): EventEnvelope {
    clockMs += 10;
    return {
      id: createUlid(clockMs),
      tenantId: tenantA.tenantId as EventEnvelope["tenantId"],
      outletId: outletA1 as EventEnvelope["outletId"],
      name: "order.item_added",
      version: 1,
      aggregateType: "order",
      aggregateId,
      // First event of the aggregate with sequence 3: a hole before it.
      sequence: 3,
      occurredAt: new Date(clockMs).toISOString(),
      actor: { type: "system" },
      deviceId: null,
      idempotencyKey: `alert-${clockMs}`,
      payloadSchemaRef: "order.item_added.v1",
      payload: {},
    };
  }

  async function store() {
    const node = await authenticateEdgeCredential(nodeA1.credential);
    return createDbLinkStore({
      database: db,
      context: node!.context,
      node: node!.scope,
      outboundDirection: "cloud_to_edge",
      applier: { async apply() {} },
      classify: () => "transaction_event",
    });
  }

  async function deliver(events: EventEnvelope[]) {
    const link = await store();
    const from = await link.lastReceivedInbound();
    await link.applyInbound({
      fromSeq: from,
      toSeq: from + events.length,
      events: events.map((event, index) => ({
        linkSeq: from + index + 1,
        event,
      })),
    });
  }

  it("emits one alert per NEW conflict and none for a re-delivered one", async () => {
    const first = gapEvent(randomUUID());
    const conflictsBefore = await conflictRowCount(tenantA.tenantId);
    const before = await alertCounts();
    await deliver([first]);
    expect(await conflictRowCount(tenantA.tenantId)).toBe(conflictsBefore + 1);
    const afterFirst = await alertCounts();
    const firstDelta = delta(afterFirst, before);
    // Some channel (outbox rows or in-app notifications) received the alert.
    expect(
      firstDelta.notificationOutbox +
        firstDelta.eventOutbox +
        firstDelta.notifications,
    ).toBeGreaterThan(0);

    // The sender resends the same event: skipped as already received, no new
    // conflict row, no second alert.
    await deliver([first]);
    expect(await conflictRowCount(tenantA.tenantId)).toBe(conflictsBefore + 1);
    expect(delta(await alertCounts(), afterFirst)).toEqual({
      notificationOutbox: 0,
      eventOutbox: 0,
      notifications: 0,
    });

    // A second, different conflict alerts exactly once more, the same way.
    await deliver([gapEvent(randomUUID())]);
    expect(await conflictRowCount(tenantA.tenantId)).toBe(conflictsBefore + 2);
    expect(delta(await alertCounts(), afterFirst)).toEqual(firstDelta);
  });

  it("when in-app notifications are created they go to supervisors of the outlet only", async () => {
    // Capture existing IDs: the DB clock can lag behind the host clock.
    const before = await asOwnerTenant(tenantA.tenantId, (client) =>
      client.query<{ id: string }>(
        "SELECT id FROM notifications WHERE tenant_id = $1",
        [tenantA.tenantId],
      ),
    );
    await deliver([gapEvent(randomUUID())]);
    const { rows } = await asOwnerTenant(tenantA.tenantId, (client) =>
      client.query<{ user_id: string; outlet_id: string | null }>(
        "SELECT user_id, outlet_id FROM notifications WHERE tenant_id = $1 AND NOT (id = ANY($2::uuid[]))",
        [tenantA.tenantId, before.rows.map((row) => row.id)],
      ),
    );
    const recipients = rows.map((row) => row.user_id);
    expect(recipients).not.toContain(cashierA1.userId);
    expect(recipients).not.toContain(supervisorA2.userId);
    for (const row of rows)
      expect(row.outlet_id === null || row.outlet_id === outletA1).toBe(true);
    if (recipients.length > 0)
      expect(recipients).toContain(supervisorA1.userId);
  });
});

// ---- replay re-checks the append-only rule (review finding) -------------------------

describe("legend-wqc6 replay guards", () => {
  const context = () => contextOf(tenantA.tenantId, "tenant");
  const freshA1 = () =>
    seedConflict({
      tenantId: tenantA.tenantId,
      outletId: outletA1,
      edgeNodeId: nodeA1.edgeNode.id,
    });

  /** The domain already holds aggregate sequence `held` (applier hook). */
  function applierHolding(
    held: number,
    calls: Array<{ event: EventEnvelope; meta: EdgeApplyMeta }>,
  ): EdgeEventApplier {
    return {
      async apply(_tx, event, meta) {
        calls.push({ event, meta });
      },
      async lastSequence() {
        return held;
      },
    };
  }

  it("refuses to replay a sequence_collision with a different event: 409, no resolution row, conflict stays open", async () => {
    const seeded = await freshA1(); // sequence 4
    const calls: Array<{ event: EventEnvelope; meta: EdgeApplyMeta }> = [];
    // Sequence 4 is already taken by another event (none identical on file).
    setEdgeEventApplier("edge_to_cloud", applierHolding(4, calls));

    await expect(
      resolveEdgeSyncConflict(context(), actor, seeded.id, {
        action: "replay",
        note: "Percobaan tabrakan",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(calls).toEqual([]);
    expect(await resolutionRows(seeded)).toEqual([]);
    const open = await listEdgeSyncConflicts(context(), {
      status: "open",
      limit: 100,
    });
    expect(has(open, seeded)).toBe(true);

    // Same refusal over HTTP.
    const http409 = await http.resolve(managerTenantA, headersA, seeded.id, {
      action: "replay",
      note: "Percobaan tabrakan",
    });
    expect(http409.status).toBe(409);
    expect(await resolutionRows(seeded)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("an identical event already held is marked applied without calling the applier", async () => {
    const seeded = await freshA1();
    const calls: Array<{ event: EventEnvelope; meta: EdgeApplyMeta }> = [];
    setEdgeEventApplier("edge_to_cloud", applierHolding(4, calls));
    // The domain's own copy: same aggregate, sequence, name, version and
    // payload, different event id (so it is a collision, not a duplicate).
    const held = {
      ...seeded.event,
      id: createUlid(),
      idempotencyKey: `held-${seeded.eventId}`,
    };
    await owner.query(
      `INSERT INTO domain_event_outbox
         (tenant_id, id, outlet_id, event_id, aggregate_type, aggregate_id, sequence, event, destination)
       VALUES ($1, $2::uuid, $3, $4::uuid, 'order', $5::uuid, 4, $6::jsonb, 'cloud-sync')`,
      [
        seeded.tenantId,
        ulidToUuid(createUlid()),
        seeded.outletId,
        ulidToUuid(held.id),
        seeded.event.aggregateId,
        JSON.stringify(held),
      ],
    );

    await resolveEdgeSyncConflict(context(), actor, seeded.id, {
      action: "replay",
      note: "Sudah ada, identik",
    });

    expect(calls).toEqual([]);
    expect(await resolutionRows(seeded)).toEqual([
      expect.objectContaining({
        action: "replayed",
        outcome: "applied",
        error: null,
      }),
    ]);
    const open = await listEdgeSyncConflicts(context(), {
      status: "open",
      limit: 100,
    });
    expect(has(open, seeded)).toBe(false);
  });

  it("after replaying a gap conflict at sequence N, an inbound N+1 is applied, not a new sequence_gap", async () => {
    const aggregateId = randomUUID();
    let ms = Date.parse("2026-11-08T12:00:00.000Z");
    const eventAt = (sequence: number): EventEnvelope => {
      ms += 10;
      return {
        id: createUlid(ms),
        tenantId: tenantA.tenantId as EventEnvelope["tenantId"],
        outletId: outletA1 as EventEnvelope["outletId"],
        name: "order.item_added",
        version: 1,
        aggregateType: "order",
        aggregateId,
        sequence,
        occurredAt: new Date(ms).toISOString(),
        actor: { type: "system" },
        deviceId: null,
        idempotencyKey: `replay-next-${ms}`,
        payloadSchemaRef: "order.item_added.v1",
        payload: {},
      };
    };
    const applied: EventEnvelope[] = [];
    async function deliver(event: EventEnvelope) {
      const node = await authenticateEdgeCredential(nodeA1.credential);
      const link = createDbLinkStore({
        database: db,
        context: node!.context,
        node: node!.scope,
        outboundDirection: "cloud_to_edge",
        applier: {
          async apply(_tx, received) {
            applied.push(received);
          },
        },
        classify: () => "transaction_event",
      });
      const from = await link.lastReceivedInbound();
      await link.applyInbound({
        fromSeq: from,
        toSeq: from + 1,
        events: [{ linkSeq: from + 1, event }],
      });
    }
    const conflictsOf = async () =>
      (
        await owner.query<{
          id: string;
          aggregate_sequence: number;
          reason: string;
        }>(
          `SELECT id, aggregate_sequence::int AS aggregate_sequence, reason FROM edge_sync_conflicts
            WHERE tenant_id = $1 AND aggregate_id = $2 ORDER BY aggregate_sequence`,
          [tenantA.tenantId, aggregateId],
        )
      ).rows.map((row) => ({ ...row, id: uuidToUlid(row.id) }));

    // Sequence 3 arrives first: a hole before it, recorded as a conflict.
    const third = eventAt(3);
    await deliver(third);
    const [gap, ...rest] = await conflictsOf();
    expect(rest).toEqual([]);
    expect(gap).toMatchObject({
      aggregate_sequence: 3,
      reason: "sequence_gap",
    });
    expect(applied).toEqual([]);

    // The supervisor replays it (the installed applier accepts it).
    const calls: Array<{ event: EventEnvelope; meta: EdgeApplyMeta }> = [];
    setEdgeEventApplier("edge_to_cloud", recordingApplier(calls));
    await resolveEdgeSyncConflict(context(), actor, gap!.id, {
      action: "replay",
      note: "Terima celah urutan",
    });
    expect(calls).toHaveLength(1);

    // Sequence 4 now follows what the cloud holds: applied, no new conflict.
    const fourth = eventAt(4);
    await deliver(fourth);
    expect(applied.map((event) => event.id)).toEqual([fourth.id]);
    expect(await conflictsOf()).toHaveLength(1);
    const { rows } = await owner.query<{ outcome: string }>(
      `SELECT outcome FROM edge_inbound_events
        WHERE tenant_id = $1 AND aggregate_id = $2 AND aggregate_sequence = 4`,
      [tenantA.tenantId, aggregateId],
    );
    expect(rows.map((row) => row.outcome)).toEqual(["applied"]);
  });
});

// ---- applier refusal becomes a conflict; replay order; revoked node -------------------

describe("legend-wqc6 applier refusal and replay preconditions", () => {
  const context = () => contextOf(tenantA.tenantId, "tenant");
  let ms = Date.parse("2026-11-08T14:00:00.000Z");
  const eventOf = (aggregateId: string, sequence: number): EventEnvelope => {
    ms += 10;
    return {
      id: createUlid(ms),
      tenantId: tenantA.tenantId as EventEnvelope["tenantId"],
      outletId: outletA1 as EventEnvelope["outletId"],
      name: "order.item_added",
      version: 1,
      aggregateType: "order",
      aggregateId,
      sequence,
      occurredAt: new Date(ms).toISOString(),
      actor: { type: "system" },
      deviceId: null,
      idempotencyKey: `refuse-${ms}`,
      payloadSchemaRef: "order.item_added.v1",
      payload: {},
    };
  };

  async function deliverBatch(
    events: EventEnvelope[],
    apply: EdgeEventApplier["apply"],
  ) {
    const node = await authenticateEdgeCredential(nodeA1.credential);
    const link = createDbLinkStore({
      database: db,
      context: node!.context,
      node: node!.scope,
      outboundDirection: "cloud_to_edge",
      applier: { apply },
      classify: () => "transaction_event",
    });
    const from = await link.lastReceivedInbound();
    await link.applyInbound({
      fromSeq: from,
      toSeq: from + events.length,
      events: events.map((event, index) => ({
        linkSeq: from + index + 1,
        event,
      })),
    });
    return { link, from, to: from + events.length };
  }

  const conflictsOf = async (aggregateId: string) =>
    (
      await owner.query<{
        id: string;
        aggregate_sequence: number;
        reason: string;
        detail: string | null;
        kind: string;
      }>(
        `SELECT id, aggregate_sequence::int AS aggregate_sequence, reason, detail, kind FROM edge_sync_conflicts
          WHERE tenant_id = $1 AND aggregate_id = $2 ORDER BY aggregate_sequence`,
        [tenantA.tenantId, aggregateId],
      )
    ).rows.map((row) => ({ ...row, id: uuidToUlid(row.id) }));
  const receiptOutcomes = async (aggregateId: string) =>
    (
      await owner.query<{ aggregate_sequence: number; outcome: string }>(
        `SELECT aggregate_sequence::int AS aggregate_sequence, outcome FROM edge_inbound_events
          WHERE tenant_id = $1 AND aggregate_id = $2 ORDER BY aggregate_sequence`,
        [tenantA.tenantId, aggregateId],
      )
    ).rows;
  const alertsFor = async (conflictId: string) =>
    (
      await owner.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM notification_outbox WHERE tenant_id = $1 AND source_event_id = $2::uuid",
        [tenantA.tenantId, ulidToUuid(conflictId)],
      )
    ).rows[0]!.n;

  it.each([
    [
      "CoreError",
      () => new CoreError("NOT_FOUND", "Item pesanan tidak ditemukan."),
    ],
    [
      "HttpError 4xx",
      () =>
        new HttpError(422, "VALIDATION_ERROR", "Item pesanan tidak ditemukan."),
    ],
  ])(
    "a domain refusal (%s) is recorded as an applier_refused conflict, alerted, and the rest of the batch goes on",
    async (_name, refusal) => {
      const [aggA, aggB, aggC] = [randomUUID(), randomUUID(), randomUUID()];
      const events = [eventOf(aggA, 1), eventOf(aggB, 1), eventOf(aggC, 1)];
      const applied: string[] = [];

      const { link, to } = await deliverBatch(events, async (_tx, event) => {
        if (event.aggregateId === aggB) throw refusal();
        applied.push(event.aggregateId);
      });

      // The batch committed: the cursor moved, so the sender can ack it.
      expect(await link.lastReceivedInbound()).toBe(to);
      expect(applied).toEqual([aggA, aggC]);
      const [conflict, ...rest] = await conflictsOf(aggB);
      expect(rest).toEqual([]);
      expect(conflict).toMatchObject({
        reason: "applier_refused",
        aggregate_sequence: 1,
        kind: "transaction_event",
        detail: "Item pesanan tidak ditemukan.",
      });
      expect(await conflictsOf(aggA)).toEqual([]);
      expect(await receiptOutcomes(aggB)).toEqual([
        { aggregate_sequence: 1, outcome: "conflict" },
      ]);
      expect(await receiptOutcomes(aggA)).toEqual([
        { aggregate_sequence: 1, outcome: "applied" },
      ]);
      expect(await alertsFor(conflict!.id)).toBe(1);
      const open = await listEdgeSyncConflicts(context(), {
        status: "open",
        limit: 100,
      });
      expect(idsOf(open).some((id) => sameId(id, conflict!.id))).toBe(true);
      const shown = rowsOf(open).find((row) =>
        sameId(String(row.id), conflict!.id),
      );
      expect(shown).toMatchObject({
        reason: "applier_refused",
        detail: "Item pesanan tidak ditemukan.",
      });
    },
  );

  it("an applier_refused conflict replays through the normal path and the next sequence then applies", async () => {
    const aggregateId = randomUUID();
    const first = eventOf(aggregateId, 1);
    await deliverBatch([first], async () => {
      throw new CoreError("NOT_FOUND", "Batch tidak ditemukan.");
    });
    const [conflict] = await conflictsOf(aggregateId);
    expect(conflict).toMatchObject({ reason: "applier_refused" });

    // The cause was fixed; the supervisor replays.
    const calls: Array<{ event: EventEnvelope; meta: EdgeApplyMeta }> = [];
    setEdgeEventApplier("edge_to_cloud", recordingApplier(calls));
    await resolveEdgeSyncConflict(context(), actor, conflict!.id, {
      action: "replay",
      note: "Batch sudah dibuat",
    });
    expect(calls.map((call) => call.event.id)).toEqual([first.id]);

    const applied: string[] = [];
    await deliverBatch([eventOf(aggregateId, 2)], async (_tx, event) => {
      applied.push(event.id);
    });
    expect(applied).toHaveLength(1);
    expect(await conflictsOf(aggregateId)).toHaveLength(1);
  });

  it("anything that is not a domain refusal still aborts the batch: nothing recorded, cursor unmoved", async () => {
    const failures: Array<[string, () => Error]> = [
      ["plain Error", () => new Error("database terputus")],
      [
        "EdgeApplierUnavailableError",
        () => new EdgeApplierUnavailableError("edge_to_cloud"),
      ],
      [
        "CoreError 5xx",
        () => new CoreError("INTERNAL_ERROR", "Gagal internal."),
      ],
      [
        "HttpError 5xx",
        () => new HttpError(503, "SERVICE_UNAVAILABLE", "Tidak tersedia."),
      ],
    ];
    for (const [, make] of failures) {
      const aggregateId = randomUUID();
      const node = await authenticateEdgeCredential(nodeA1.credential);
      const probe = createDbLinkStore({
        database: db,
        context: node!.context,
        node: node!.scope,
        outboundDirection: "cloud_to_edge",
        applier: { async apply() {} },
        classify: () => "transaction_event",
      });
      const before = await probe.lastReceivedInbound();
      await expect(
        deliverBatch([eventOf(aggregateId, 1)], async () => {
          throw make();
        }),
      ).rejects.toBeTruthy();
      expect(await conflictsOf(aggregateId)).toEqual([]);
      expect(await receiptOutcomes(aggregateId)).toEqual([]);
      expect(await probe.lastReceivedInbound()).toBe(before);
    }
  });

  it("refuses to replay while a lower-sequence conflict of the same aggregate is open (409), then allows it in order", async () => {
    const aggregateId = randomUUID();
    // 3 and 4 both arrive before 1 and 2: two sequence_gap conflicts.
    await deliverBatch(
      [eventOf(aggregateId, 3), eventOf(aggregateId, 4)],
      async () => {},
    );
    const [c3, c4] = await conflictsOf(aggregateId);
    expect([c3?.aggregate_sequence, c4?.aggregate_sequence]).toEqual([3, 4]);

    const calls: Array<{ event: EventEnvelope; meta: EdgeApplyMeta }> = [];
    setEdgeEventApplier("edge_to_cloud", recordingApplier(calls));
    await expect(
      resolveEdgeSyncConflict(context(), actor, c4!.id, {
        action: "replay",
        note: "Terlalu dini",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const http409 = await http.resolve(managerTenantA, headersA, c4!.id, {
      action: "replay",
      note: "Terlalu dini",
    });
    expect(http409.status).toBe(409);
    expect(calls).toEqual([]);
    expect(
      (
        await owner.query(
          "SELECT 1 FROM edge_sync_conflict_resolutions WHERE tenant_id = $1 AND conflict_id = $2::uuid",
          [tenantA.tenantId, ulidToUuid(c4!.id)],
        )
      ).rows,
    ).toEqual([]);

    // Dismissing is not ordered; the lower conflict replays; then 4 may.
    await resolveEdgeSyncConflict(context(), actor, c3!.id, {
      action: "replay",
      note: "Urutan 3",
    });
    await resolveEdgeSyncConflict(context(), actor, c4!.id, {
      action: "replay",
      note: "Urutan 4",
    });
    expect(calls.map((call) => call.event.sequence)).toEqual([3, 4]);
  });

  it("a lower open conflict does not block dismissing, and a closed one does not block replay", async () => {
    const aggregateId = randomUUID();
    await deliverBatch(
      [eventOf(aggregateId, 3), eventOf(aggregateId, 4)],
      async () => {},
    );
    const [c3, c4] = await conflictsOf(aggregateId);
    setEdgeEventApplier("edge_to_cloud", recordingApplier([]));
    // Dismiss the later one while the lower is open: allowed.
    await resolveEdgeSyncConflict(context(), actor, c4!.id, {
      action: "dismiss",
      note: "Abaikan 4",
    });
    // Close the lower by dismissal, then a (new) higher one is replayable.
    await resolveEdgeSyncConflict(context(), actor, c3!.id, {
      action: "dismiss",
      note: "Abaikan 3",
    });
    const open = await listEdgeSyncConflicts(context(), {
      status: "open",
      limit: 100,
    });
    expect(
      idsOf(open).some((id) => sameId(id, c3!.id) || sameId(id, c4!.id)),
    ).toBe(false);
  });

  it("refuses to replay a conflict of a revoked node (409) but still lets it be dismissed", async () => {
    const standby = await registerEdgeNode(
      contextOf(tenantA.tenantId, [outletA1]),
      actor,
      { outletId: outletA1, role: "standby", label: "Cadangan A1" },
    );
    const replayed = await seedConflict({
      tenantId: tenantA.tenantId,
      outletId: outletA1,
      edgeNodeId: standby.edgeNode.id,
    });
    const dismissed = await seedConflict({
      tenantId: tenantA.tenantId,
      outletId: outletA1,
      edgeNodeId: standby.edgeNode.id,
    });
    await revokeEdgeNode(contextOf(tenantA.tenantId, [outletA1]), actor, {
      edgeNodeId: standby.edgeNode.id,
      reason: "Perangkat hilang",
    });
    const calls: Array<{ event: EventEnvelope; meta: EdgeApplyMeta }> = [];
    setEdgeEventApplier("edge_to_cloud", recordingApplier(calls));

    await expect(
      resolveEdgeSyncConflict(context(), actor, replayed.id, {
        action: "replay",
        note: "Node dicabut",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(calls).toEqual([]);
    expect(await resolutionRows(replayed)).toEqual([]);

    await resolveEdgeSyncConflict(context(), actor, dismissed.id, {
      action: "dismiss",
      note: "Node dicabut",
    });
    expect(await resolutionRows(dismissed)).toEqual([
      expect.objectContaining({ action: "dismissed", outcome: "dismissed" }),
    ]);
  });
});
