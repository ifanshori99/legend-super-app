// Cloud adoption of edge pin sets (beads legend-rucdm, legend-kgbw, tier K).
// rucdm: a node's own later set (higher aggregate sequence) is adopted even
// when an edge clock stepping back gave it an older key. kgbw: a refused edge
// set whose material differs from the cloud row re-exports the cloud row, so
// the edge replaces the refused pin. These tests run the real services on the
// disposable PostgreSQL; the same database plays the edge (EDGE_MODE sets,
// `applyStaffPinRecords`) and the cloud (`applyStaffPinSet`, the export), so a
// test rewrites the row to the state the other side would hold.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { StaffPinEdgeRecord } from "@starter/shared/access/override";
import {
  createUlid,
  outletIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { EventEnvelope } from "@starter/shared/events";
import { MAX_STAFF_PIN_ATTEMPTS } from "@starter/shared/identity";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  applyStaffPinLocked,
  applyStaffPinSet,
} from "../edge/access-applier.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { setStaffPin } from "../services/device-pin.service.ts";
import {
  authenticateEdgeCredential,
  registerEdgeNode,
  type AuthenticatedEdgeNode,
} from "../services/edge-node.service.ts";
import {
  applyStaffPinRecords as applyStaffPinRecordsRaw,
  listStaffPinRecordsSince,
  type VerifiedEdgeNode,
} from "../services/staff-pin-sync.ts";
import { withEdgeModeEnv } from "./edge-mode-env.ts";

// legend-oark: the edge applier refuses to run outside EDGE_MODE.
const applyStaffPinRecords = (
  ...args: Parameters<typeof applyStaffPinRecordsRaw>
) => withEdgeModeEnv(() => applyStaffPinRecordsRaw(...args));

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const actor = randomUUID();
const tenantId = randomUUID();
const outletA = randomUUID();
const staffRoleId = randomUUID();
const createdUsers: string[] = [];
let primary: AuthenticatedEdgeNode;
let standby: AuthenticatedEdgeNode;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const PIN_E1 = "482916";
const PIN_E2 = "730418";
const PIN_C = "915273";

const tenant = establishTenantContext({
  tenantId,
  brandId: null,
  source: "session",
});
const scope: ScopedTenantContext = establishScopedTenantContext(tenant, {
  kind: "outlets",
  outletIds: [outletIdSchema.parse(outletA)],
});
const edgeContext: ScopedTenantContext = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "device" }),
  { kind: "outlets", outletIds: [outletIdSchema.parse(outletA)] },
);

async function newUser(): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email, email_verified, banned) VALUES ($1, 'Staf Adopsi', $2, true, false)`,
    [id, `adopt-${randomBytes(4).toString("hex")}@example.test`],
  );
  createdUsers.push(id);
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 day', $2)`,
    [tenantId, id, staffRoleId, outletA],
  );
  return id;
}

type PinRow = {
  id: string;
  pin_hash: string;
  pin_salt: string;
  pin_generation_at: Date;
  generation_edge_node_id: string | null;
  generation_edge_sequence: string | null;
  failed_attempts: number;
  locked_until: Date | null;
  sync_xid: string;
};

async function pinRow(userId: string): Promise<PinRow> {
  const { rows } = await owner.query<PinRow>(
    `SELECT id, pin_hash, pin_salt, pin_generation_at, generation_edge_node_id,
            generation_edge_sequence::text AS generation_edge_sequence,
            failed_attempts, locked_until,
            sync_xid::text AS sync_xid
       FROM staff_pins WHERE tenant_id = $1 AND user_id = $2`,
    [tenantId, userId],
  );
  return rows[0]!;
}

type SetMaterial = { pinHash: string; salt: string; setAt: string };

/** This staff member's `staff_pin.set` events, oldest first. */
async function setEvents(userId: string): Promise<EventEnvelope[]> {
  const { rows } = await owner.query<{ event: EventEnvelope }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND aggregate_type = 'staff_pin'
        AND event->>'name' = 'staff_pin.set' AND event->'payload'->>'userId' = $2
      ORDER BY sequence`,
    [tenantId, userId],
  );
  return rows.map((row) => row.event);
}

const materialOf = (event: EventEnvelope) =>
  (event.payload as { material: SetMaterial }).material;

async function asEdge<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.EDGE_MODE;
  process.env.EDGE_MODE = "true";
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.EDGE_MODE;
    else process.env.EDGE_MODE = previous;
  }
}

const setPin = (userId: string, pin: string, now?: Date) =>
  setStaffPin(
    tenant,
    userId,
    { outletId: outletA, userId },
    { pin },
    now ? { now } : {},
  );

/** The cloud's applier, fed one event of `node` (the edge -> cloud path). */
function applyOnCloud(event: EventEnvelope, node: AuthenticatedEdgeNode) {
  return withTenant(db, node.context, (tx) =>
    applyStaffPinSet(tx, event, {
      edgeNodeId: node.scope.edgeNodeId,
      direction: "edge_to_cloud",
      kind: "transaction_event",
      context: node.context,
    }),
  );
}

/**
 * A `staff_pin.locked` of the same aggregate stream as `set` (the edge row:
 * set and lock events share one sequence per staff pin), at `sequence`.
 */
function lockedEvent(
  set: EventEnvelope,
  input: { sequence: number; occurredAtMs: number; lockedUntilMs: number },
): EventEnvelope {
  const payload = set.payload as { staffPinId: string; userId: string };
  return {
    ...set,
    id: createUlid(Date.now()) as EventEnvelope["id"],
    name: "staff_pin.locked",
    sequence: input.sequence,
    occurredAt: new Date(input.occurredAtMs).toISOString(),
    idempotencyKey: `staff_pin.locked:${set.aggregateId}:${input.sequence}`,
    payloadSchemaRef: "staff_pin.locked.v1",
    payload: {
      staffPinId: payload.staffPinId,
      userId: payload.userId,
      lockedUntil: new Date(input.lockedUntilMs).toISOString(),
    } as EventEnvelope["payload"],
  };
}

/** The cloud's lock applier, fed one event of `node`. */
function lockOnCloud(event: EventEnvelope, node: AuthenticatedEdgeNode) {
  return withTenant(db, node.context, (tx) =>
    applyStaffPinLocked(tx, event, {
      edgeNodeId: node.scope.edgeNodeId,
      direction: "edge_to_cloud",
      kind: "transaction_event",
      context: node.context,
    }),
  );
}

function exportNode(): VerifiedEdgeNode {
  return {
    tenantId: tenant.tenantId,
    outletId: outletIdSchema.parse(outletA),
    edgeNodeId: primary.scope.edgeNodeId,
  };
}

/** One export pass to the end; the watermark is the last cursor seen. */
async function pull(since?: string) {
  const records: StaffPinEdgeRecord[] = [];
  let cursor = since;
  let watermark: string | undefined = since;
  for (let page = 0; page < 1000; page++) {
    const result = await listStaffPinRecordsSince(exportNode(), {
      since: cursor,
      limit: 100,
    });
    records.push(...result.data);
    watermark = result.meta.watermark ?? undefined;
    if (result.meta.nextCursor === null) break;
    cursor = result.meta.nextCursor;
  }
  return { records, watermark };
}

/**
 * Pulls until the staff member was exported. A transaction of another test
 * file that is open at this moment holds the commit watermark back for a
 * moment, so a positive assertion polls instead of reading once.
 */
async function pullUntil(userId: string, since?: string) {
  let last = await pull(since);
  for (let attempt = 0; attempt < 50; attempt++) {
    if (last.records.some((row) => row.userId === userId)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
    last = await pull(since);
  }
  return last;
}

async function registerNode(role: "primary" | "standby") {
  const registered = await registerEdgeNode(scope, actor, {
    outletId: outletA,
    role,
    label: `Adopsi ${role}`,
  });
  const authenticated = await authenticateEdgeCredential(registered.credential);
  if (!authenticated) throw new Error("Edge node did not authenticate");
  return authenticated;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter({ record: async () => {} });
  const brand = randomUUID();
  const entity = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Tenant Adopsi', plan, 'active', deployment_mode, feature_flags, limits, $3
       FROM tenants WHERE id = $4`,
    [
      tenantId,
      `adopt-${randomBytes(4).toString("hex")}`,
      actor,
      cafeLegendPlatformFixtures.tenant.id,
    ],
  );
  await owner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand')`,
    [brand, tenantId, `adopt-${randomBytes(3).toString("hex")}`],
  );
  await owner.query(
    `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Uji', false)`,
    [entity, tenantId],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, $5, 'Jl. Uji', '{}', 'active')`,
    [
      outletA,
      tenantId,
      brand,
      entity,
      `ADP-${randomBytes(3).toString("hex").toUpperCase()}`,
    ],
  );
  const role = await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     SELECT $1, $2, name, is_template, template_key, permissions, mfa_required, allowed_scope_types
       FROM roles WHERE tenant_id = $3 AND template_key = 'cashier'`,
    [staffRoleId, tenantId, cafeLegendPlatformFixtures.tenant.id],
  );
  if (role.rowCount !== 1) throw new Error("No cashier role template");
  primary = await registerNode("primary");
  standby = await registerNode("standby");
});

afterEach(() => {
  delete process.env.EDGE_MODE;
});

afterAll(async () => {
  setAuditWriter(null);
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const table of [
      "domain_event_outbox",
      "edge_received_events",
      "edge_sync_conflicts",
      "edge_deferred_events",
      "edge_outbound_queue",
      "edge_nodes",
      "audit_logs",
      "staff_pins", // before "user"
      "role_assignments", // before "user"
      "roles",
      "outlets",
      "legal_entities",
      "brands",
    ])
      await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [
        tenantId,
      ]);
    await client.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
    if (createdUsers.length > 0)
      await client.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [
        createdUsers,
      ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await owner.end();
  }
});

describe("legend-rucdm the cloud adopts a node's own later set whatever its clock", () => {
  it("edge offline sets E1, its clock steps back 1 hour, sets E2 with an older key: the cloud applies E1 then E2 and holds E2", async () => {
    const userId = await newUser();
    const now = Date.now();
    // The edge, offline: E1, then its clock steps back an hour and E2.
    await asEdge(() => setPin(userId, PIN_E1, new Date(now - 10 * MINUTE)));
    await asEdge(() => setPin(userId, PIN_E2, new Date(now - 70 * MINUTE)));
    const [e1, e2] = await setEvents(userId);
    const m1 = materialOf(e1!);
    const m2 = materialOf(e2!);
    expect(e2!.sequence).toBeGreaterThan(e1!.sequence);
    expect(Date.parse(m2.setAt)).toBeLessThan(Date.parse(m1.setAt));

    // The cloud still holds an older pin of this staff member.
    const row = await pinRow(userId);
    await owner.query(
      `UPDATE staff_pins SET pin_hash = $2, pin_generation_at = $3,
              generation_edge_node_id = NULL, generation_edge_sequence = NULL
        WHERE id = $1`,
      [row.id, "0".repeat(64), new Date(now - 3 * HOUR)],
    );

    expect(await applyOnCloud(e1!, primary)).toBe("applied");
    const afterE1 = await pinRow(userId);
    expect(afterE1.pin_hash).toBe(m1.pinHash);
    expect(afterE1.generation_edge_node_id).toBe(primary.scope.edgeNodeId);
    expect(afterE1.generation_edge_sequence).toBe(String(e1!.sequence));

    // Another node's set with the older key is refused: only the node that
    // gave the generation may move it by sequence.
    expect(await applyOnCloud(e2!, standby)).toBe("not_applicable");
    expect((await pinRow(userId)).pin_hash).toBe(m1.pinHash);

    expect(await applyOnCloud(e2!, primary)).toBe("applied");
    const afterE2 = await pinRow(userId);
    expect(afterE2.pin_hash).toBe(m2.pinHash);
    expect(afterE2.pin_salt).toBe(m2.salt);
    expect(afterE2.generation_edge_sequence).toBe(String(e2!.sequence));
    // The cloud key stays monotonic: never below E1's.
    expect(afterE2.pin_generation_at.getTime()).toBeGreaterThan(
      afterE1.pin_generation_at.getTime(),
    );

    // A redelivered E1 (lower sequence, older key) changes nothing material,
    // and a replay of the identical E2 writes nothing at all.
    expect(await applyOnCloud(e1!, primary)).toBe("not_applicable");
    expect((await pinRow(userId)).pin_hash).toBe(m2.pinHash);
    const before = (await pinRow(userId)).sync_xid;
    expect(await applyOnCloud(e2!, primary)).toBe("not_applicable");
    expect((await pinRow(userId)).sync_xid).toBe(before);
  });

  it("a cloud set clears the edge provenance, so a later sequence of the node no longer wins over it", async () => {
    const userId = await newUser();
    const now = Date.now();
    await asEdge(() => setPin(userId, PIN_E1, new Date(now - 10 * MINUTE)));
    await asEdge(() => setPin(userId, PIN_E2, new Date(now - 70 * MINUTE)));
    const [e1, e2] = await setEvents(userId);
    const row = await pinRow(userId);
    await owner.query(
      `UPDATE staff_pins SET pin_hash = $2, pin_generation_at = $3 WHERE id = $1`,
      [row.id, "0".repeat(64), new Date(now - 3 * HOUR)],
    );
    expect(await applyOnCloud(e1!, primary)).toBe("applied");

    await setPin(userId, PIN_C);
    const cloud = await pinRow(userId);
    expect(cloud.generation_edge_node_id).toBeNull();
    expect(cloud.generation_edge_sequence).toBeNull();

    expect(await applyOnCloud(e2!, primary)).toBe("not_applicable");
    expect((await pinRow(userId)).pin_hash).toBe(cloud.pin_hash);
  });

  it("R2 an older set of the node (lower sequence, higher key) arriving after its later set was adopted is refused", async () => {
    const userId = await newUser();
    const now = Date.now();
    // E1 (lower sequence, higher key), then the clock steps back and E2.
    await asEdge(() => setPin(userId, PIN_E1, new Date(now - 10 * MINUTE)));
    await asEdge(() => setPin(userId, PIN_E2, new Date(now - 70 * MINUTE)));
    const [e1, e2] = await setEvents(userId);
    const m2 = materialOf(e2!);
    expect(e1!.sequence).toBeLessThan(e2!.sequence);
    expect(Date.parse(materialOf(e1!).setAt)).toBeGreaterThan(
      Date.parse(m2.setAt),
    );
    const row = await pinRow(userId);
    await owner.query(
      `UPDATE staff_pins SET pin_hash = $2, pin_generation_at = $3,
              generation_edge_node_id = NULL, generation_edge_sequence = NULL
        WHERE id = $1`,
      [row.id, "0".repeat(64), new Date(now - 3 * HOUR)],
    );

    // Delivered out of order: E2 first (adopted by key), E1 late.
    expect(await applyOnCloud(e2!, primary)).toBe("applied");
    expect(await applyOnCloud(e1!, primary)).toBe("not_applicable");
    const after = await pinRow(userId);
    expect(after.pin_hash).toBe(m2.pinHash);
    expect(after.pin_salt).toBe(m2.salt);
    expect(after.generation_edge_sequence).toBe(String(e2!.sequence));
  });

  it("F1 the node's later lock is applied after an adoption by sequence moved the cloud key ahead of its clock; another node's older lock is not", async () => {
    const userId = await newUser();
    const now = Date.now();
    await asEdge(() => setPin(userId, PIN_E1, new Date(now - 10 * MINUTE)));
    await asEdge(() => setPin(userId, PIN_E2, new Date(now - 70 * MINUTE)));
    const [e1, e2] = await setEvents(userId);
    const row = await pinRow(userId);
    await owner.query(
      `UPDATE staff_pins SET pin_hash = $2, pin_generation_at = $3,
              generation_edge_node_id = NULL, generation_edge_sequence = NULL,
              failed_attempts = 0, locked_until = NULL
        WHERE id = $1`,
      [row.id, "0".repeat(64), new Date(now - 3 * HOUR)],
    );
    expect(await applyOnCloud(e1!, primary)).toBe("applied");
    expect(await applyOnCloud(e2!, primary)).toBe("applied");
    const adopted = await pinRow(userId);
    // The cloud key is E1's + 1 ms: ahead of the node's stepped-back clock.
    const lockAt = now - 60 * MINUTE;
    expect(adopted.pin_generation_at.getTime()).toBeGreaterThan(lockAt);
    const lockedUntilMs = now + 5 * MINUTE;

    // Another node's lock with the same older time stays refused.
    const foreign = lockedEvent(e2!, {
      sequence: e2!.sequence + 1,
      occurredAtMs: lockAt,
      lockedUntilMs,
    });
    expect(await lockOnCloud(foreign, standby)).toBe("not_applicable");
    expect((await pinRow(userId)).locked_until).toBeNull();

    // The node's own later lock (higher sequence) is applied.
    const own = lockedEvent(e2!, {
      sequence: e2!.sequence + 1,
      occurredAtMs: lockAt,
      lockedUntilMs,
    });
    expect(await lockOnCloud(own, primary)).toBe("applied");
    const locked = await pinRow(userId);
    expect(locked.failed_attempts).toBe(MAX_STAFF_PIN_ATTEMPTS);
    expect(locked.locked_until?.getTime()).toBeGreaterThan(now);
    expect(locked.pin_hash).toBe(adopted.pin_hash);
  });
});

describe("legend-kgbw a refused edge set re-exports the cloud pin", () => {
  it("a cloud reset C newer than an edge set E refuses E, re-exports C, and the edge replaces E with C", async () => {
    const userId = await newUser();
    const now = Date.now();
    await asEdge(() => setPin(userId, PIN_E1, new Date(now - 10 * MINUTE)));
    const [event] = await setEvents(userId);
    const edgeMaterial = materialOf(event!);

    // The cloud resets the pin (newer key) and exports it.
    await setPin(userId, PIN_C);
    const cloud = await pinRow(userId);
    expect(cloud.pin_generation_at.getTime()).toBeGreaterThan(
      Date.parse(edgeMaterial.setAt),
    );
    const exported = await pullUntil(userId);
    expect(exported.records.some((row) => row.userId === userId)).toBe(true);

    // E arrives afterwards: refused, but the cloud row is touched.
    expect(await applyOnCloud(event!, primary)).toBe("not_applicable");
    const touched = await pinRow(userId);
    expect(touched.pin_hash).toBe(cloud.pin_hash);
    expect(touched.pin_generation_at.getTime()).toBe(
      cloud.pin_generation_at.getTime(),
    );
    expect(touched.sync_xid).not.toBe(cloud.sync_xid);

    // The next pull from the old watermark sends the cloud pin again.
    const again = await pullUntil(userId, exported.watermark);
    const record = again.records.find((row) => row.userId === userId);
    expect(record?.pinHash).toBe(cloud.pin_hash);

    // The edge still holds E; applying the export replaces it with C.
    await owner.query(
      `UPDATE staff_pins SET pin_hash = $2, pin_salt = $3, pin_generation_at = $4::timestamptz,
              cloud_generation_at = NULL
        WHERE id = $1`,
      [cloud.id, edgeMaterial.pinHash, edgeMaterial.salt, edgeMaterial.setAt],
    );
    expect((await applyStaffPinRecords(edgeContext, [record!])).applied).toBe(
      1,
    );
    const edgeRow = await pinRow(userId);
    expect(edgeRow.pin_hash).toBe(cloud.pin_hash);
    expect(edgeRow.pin_salt).toBe(cloud.pin_salt);
  });
});
