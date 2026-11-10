// Edge database instance in the pin ordering (bead legend-o839h, tier K).
// An edge whose database is rebuilt keeps its node id but restarts its
// aggregate sequence at 1. The cloud must therefore treat a set as "same
// origin" (ordered by sequence) only when node id AND edge database instance
// id match; a different instance is ordered by the key (setAt) alone. An old
// edge never sends an instance id (null): its behaviour is the legend-rucdm
// one, unchanged.
//
// Assumptions (the brief is the spec):
// - The instance id reaches the appliers as `meta.edgeInstanceId` and is kept
//   in `staff_pins.generation_edge_instance_id`.
// - A set from another tenant's node whose event names this tenant's staff
//   member is rejected (throws) or not applied; both are accepted, only
//   "applied" and a changed row are failures.
//
// The "rebuilt" edge is simulated by relabelling real edge set events: a new
// event id, an explicit aggregate sequence, an explicit `material.setAt`, and
// the material of another set (so the material differs from the cloud row).
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createUlid,
  outletIdSchema,
  ulidToUuid,
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
  drainParkedAccessEvents,
} from "../edge/access-applier.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { setStaffPin } from "../services/device-pin.service.ts";
import {
  authenticateEdgeCredential,
  registerEdgeNode,
  type AuthenticatedEdgeNode,
} from "../services/edge-node.service.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const actor = randomUUID();
const createdUsers: string[] = [];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const PINS = ["482916", "730418", "915273"] as const;

/** Edge database instances (`edge_nodes.instance_id`) used by the tests. */
const I1 = randomUUID();
const I2 = randomUUID();

type Fx = {
  tenantId: string;
  outletId: string;
  roleId: string;
  tenant: ReturnType<typeof establishTenantContext>;
  scope: ScopedTenantContext;
  node: AuthenticatedEdgeNode;
};

function newFx(): Omit<Fx, "node"> {
  const tenantId = randomUUID();
  const outletId = randomUUID();
  const tenant = establishTenantContext({
    tenantId,
    brandId: null,
    source: "session",
  });
  return {
    tenantId,
    outletId,
    roleId: randomUUID(),
    tenant,
    scope: establishScopedTenantContext(tenant, {
      kind: "outlets",
      outletIds: [outletIdSchema.parse(outletId)],
    }),
  };
}

const base1 = newFx();
const base2 = newFx();
let t1: Fx;
let t2: Fx;

async function seedTenant(fx: Omit<Fx, "node">, label: string): Promise<Fx> {
  const brand = randomUUID();
  const entity = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, $5, plan, 'active', deployment_mode, feature_flags, limits, $3
       FROM tenants WHERE id = $4`,
    [
      fx.tenantId,
      `inst-${randomBytes(4).toString("hex")}`,
      actor,
      cafeLegendPlatformFixtures.tenant.id,
      `Tenant ${label}`,
    ],
  );
  await owner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand')`,
    [brand, fx.tenantId, `inst-${randomBytes(3).toString("hex")}`],
  );
  await owner.query(
    `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Uji', false)`,
    [entity, fx.tenantId],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, $5, 'Jl. Uji', '{}', 'active')`,
    [
      fx.outletId,
      fx.tenantId,
      brand,
      entity,
      `INS-${randomBytes(3).toString("hex").toUpperCase()}`,
    ],
  );
  const role = await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     SELECT $1, $2, name, is_template, template_key, permissions, mfa_required, allowed_scope_types
       FROM roles WHERE tenant_id = $3 AND template_key = 'cashier'`,
    [fx.roleId, fx.tenantId, cafeLegendPlatformFixtures.tenant.id],
  );
  if (role.rowCount !== 1) throw new Error("No cashier role template");
  const registered = await registerEdgeNode(fx.scope, actor, {
    outletId: fx.outletId,
    role: "primary",
    label: `Instance ${label}`,
  });
  const node = await authenticateEdgeCredential(registered.credential);
  if (!node) throw new Error("Edge node did not authenticate");
  return { ...fx, node };
}

async function newUser(fx: Fx): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email, email_verified, banned) VALUES ($1, 'Staf Instance', $2, true, false)`,
    [id, `inst-${randomBytes(4).toString("hex")}@example.test`],
  );
  createdUsers.push(id);
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 day', $2)`,
    [fx.tenantId, id, fx.roleId, fx.outletId],
  );
  return id;
}

type PinRow = {
  id: string;
  pin_hash: string;
  pin_generation_at: Date;
  generation_edge_node_id: string | null;
  generation_edge_instance_id: string | null;
  generation_edge_sequence: string | null;
  failed_attempts: number;
  locked_until: Date | null;
};

async function pinRow(fx: Fx, userId: string): Promise<PinRow> {
  const { rows } = await owner.query<PinRow>(
    `SELECT id, pin_hash, pin_generation_at, generation_edge_node_id,
            generation_edge_instance_id,
            generation_edge_sequence::text AS generation_edge_sequence,
            failed_attempts, locked_until
       FROM staff_pins WHERE tenant_id = $1 AND user_id = $2`,
    [fx.tenantId, userId],
  );
  return rows[0]!;
}

type SetMaterial = { pinHash: string; salt: string; setAt: string };
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

const setPin = (fx: Fx, userId: string, pin: string, now: Date) =>
  setStaffPin(
    fx.tenant,
    userId,
    { outletId: fx.outletId, userId },
    { pin },
    { now },
  );

/** This staff member's `staff_pin.set` events, oldest first. */
async function setEvents(fx: Fx, userId: string): Promise<EventEnvelope[]> {
  const { rows } = await owner.query<{ event: EventEnvelope }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND aggregate_type = 'staff_pin'
        AND event->>'name' = 'staff_pin.set' AND event->'payload'->>'userId' = $2
      ORDER BY sequence`,
    [fx.tenantId, userId],
  );
  return rows.map((row) => row.event);
}

/**
 * A staff member whose cloud row is an old cloud pin (3 hours old, no edge
 * provenance), plus three edge set events with three different materials.
 */
async function staffWithSets(fx: Fx) {
  const userId = await newUser(fx);
  const now = Date.now();
  for (const [index, pin] of PINS.entries())
    await asEdge(() =>
      setPin(fx, userId, pin, new Date(now - (30 - index) * MINUTE)),
    );
  const events = await setEvents(fx, userId);
  const [s1, s2, s3] = events;
  if (!s1 || !s2 || !s3) throw new Error("Expected three set events");
  const row = await pinRow(fx, userId);
  await owner.query(
    `UPDATE staff_pins SET pin_hash = $2, pin_generation_at = $3,
            generation_edge_node_id = NULL, generation_edge_sequence = NULL,
            generation_edge_instance_id = NULL,
            failed_attempts = 0, locked_until = NULL
      WHERE id = $1`,
    [row.id, "0".repeat(64), new Date(now - 3 * HOUR)],
  );
  return { userId, now, s1, s2, s3 };
}

/**
 * A set as an edge with its own sequence counter would send it: the staff
 * member and aggregate of `shape`, the material of `materialFrom`, an
 * explicit sequence and an explicit key (`setAt`).
 */
function relabel(
  shape: EventEnvelope,
  materialFrom: EventEnvelope,
  input: { sequence: number; setAtMs: number },
): EventEnvelope {
  return {
    ...shape,
    id: createUlid(Date.now()) as EventEnvelope["id"],
    sequence: input.sequence,
    occurredAt: new Date(input.setAtMs).toISOString(),
    payload: {
      ...(shape.payload as object),
      material: {
        ...materialOf(materialFrom),
        setAt: new Date(input.setAtMs).toISOString(),
      },
    } as EventEnvelope["payload"],
  };
}

/** A `staff_pin.locked` of the same aggregate (set and lock share one sequence). */
function lockedEvent(
  shape: EventEnvelope,
  input: { sequence: number; occurredAtMs: number; lockedUntilMs: number },
): EventEnvelope {
  const payload = shape.payload as { staffPinId: string; userId: string };
  return {
    ...shape,
    id: createUlid(Date.now()) as EventEnvelope["id"],
    name: "staff_pin.locked",
    sequence: input.sequence,
    occurredAt: new Date(input.occurredAtMs).toISOString(),
    idempotencyKey: `staff_pin.locked:${shape.aggregateId}:${input.sequence}`,
    payloadSchemaRef: "staff_pin.locked.v1",
    payload: {
      staffPinId: payload.staffPinId,
      userId: payload.userId,
      lockedUntil: new Date(input.lockedUntilMs).toISOString(),
    } as EventEnvelope["payload"],
  };
}

/**
 * `instanceId` undefined: the meta of an old edge (the field is absent).
 * null: the field present but unknown.
 */
function metaOf(
  node: AuthenticatedEdgeNode,
  instanceId: string | null | undefined,
) {
  return {
    edgeNodeId: node.scope.edgeNodeId,
    ...(instanceId === undefined ? {} : { edgeInstanceId: instanceId }),
    direction: "edge_to_cloud" as const,
    kind: "transaction_event" as const,
    context: node.context,
  };
}

function applySet(
  node: AuthenticatedEdgeNode,
  instanceId: string | null | undefined,
  event: EventEnvelope,
) {
  return withTenant(db, node.context, (tx) =>
    applyStaffPinSet(tx, event, metaOf(node, instanceId)),
  );
}

function applyLock(
  node: AuthenticatedEdgeNode,
  instanceId: string | null | undefined,
  event: EventEnvelope,
) {
  return withTenant(db, node.context, (tx) =>
    applyStaffPinLocked(tx, event, metaOf(node, instanceId)),
  );
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter({ record: async () => {} });
  t1 = await seedTenant(base1, "Instance A");
  t2 = await seedTenant(base2, "Instance B");
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
    for (const tenantId of [base1.tenantId, base2.tenantId]) {
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
    }
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

describe("legend-o839h the edge database instance joins the node in the pin ordering", () => {
  it("1 rebuilt database (same node, new instance): a set with sequence 1 and a newer key is applied, and the new instance then orders by sequence", async () => {
    const { userId, now, s1, s2, s3 } = await staffWithSets(t1);
    const node = t1.node;

    // I1 adopted a set at sequence 50.
    const first = relabel(s1, s1, { sequence: 50, setAtMs: now - 10 * MINUTE });
    expect(await applySet(node, I1, first)).toBe("applied");
    const adopted = await pinRow(t1, userId);
    expect(adopted.generation_edge_node_id).toBe(node.scope.edgeNodeId);
    expect(adopted.generation_edge_instance_id).toBe(I1);
    expect(adopted.generation_edge_sequence).toBe("50");

    // The edge database is rebuilt: same node id, new instance, sequence 1,
    // newer key, other material.
    const rebuilt = relabel(s2, s2, { sequence: 1, setAtMs: now - 5 * MINUTE });
    expect(await applySet(node, I2, rebuilt)).toBe("applied");
    const afterRebuild = await pinRow(t1, userId);
    expect(afterRebuild.pin_hash).toBe(materialOf(s2).pinHash);
    expect(afterRebuild.generation_edge_node_id).toBe(node.scope.edgeNodeId);
    expect(afterRebuild.generation_edge_instance_id).toBe(I2);
    expect(afterRebuild.generation_edge_sequence).toBe("1");

    // Same-origin sequence rule for the new instance: sequence 2 with a
    // stepped-back (older) key is adopted.
    const later = relabel(s3, s3, { sequence: 2, setAtMs: now - 60 * MINUTE });
    expect(await applySet(node, I2, later)).toBe("applied");
    const afterLater = await pinRow(t1, userId);
    expect(afterLater.pin_hash).toBe(materialOf(s3).pinHash);
    expect(afterLater.generation_edge_instance_id).toBe(I2);
    expect(afterLater.generation_edge_sequence).toBe("2");
    // The cloud key never moves back.
    expect(afterLater.pin_generation_at.getTime()).toBeGreaterThanOrEqual(
      afterRebuild.pin_generation_at.getTime(),
    );

    // The old instance is now a different origin: a high sequence with an
    // older key does not win over the I2 generation.
    const stale = relabel(s1, s1, { sequence: 99, setAtMs: now - 90 * MINUTE });
    expect(await applySet(node, I1, stale)).toBe("not_applicable");
    const afterStale = await pinRow(t1, userId);
    expect(afterStale.pin_hash).toBe(materialOf(s3).pinHash);
    expect(afterStale.generation_edge_instance_id).toBe(I2);
    expect(afterStale.generation_edge_sequence).toBe("2");
  });

  it("1b row adopted before instances existed (null instance): the rebuilt database's set with sequence 1 and a newer key is applied without the runbook", async () => {
    const { userId, now, s1, s2 } = await staffWithSets(t1);
    const node = t1.node;

    // Adopted from this node before the edge reported an instance.
    const first = relabel(s1, s1, { sequence: 50, setAtMs: now - 10 * MINUTE });
    expect(await applySet(node, undefined, first)).toBe("applied");

    // The edge database is rebuilt and the edge now reports its instance.
    const rebuilt = relabel(s2, s2, { sequence: 1, setAtMs: now - 5 * MINUTE });
    expect(await applySet(node, I2, rebuilt)).toBe("applied");
    expect((await pinRow(t1, userId)).pin_hash).toBe(materialOf(s2).pinHash);
  });

  it("2 same instance: a lower or equal sequence with a newer key is refused and the row is unchanged; a higher sequence is still adopted", async () => {
    const { userId, now, s1, s2, s3 } = await staffWithSets(t1);
    const node = t1.node;

    const first = relabel(s1, s1, { sequence: 50, setAtMs: now - 10 * MINUTE });
    expect(await applySet(node, I1, first)).toBe("applied");
    const before = await pinRow(t1, userId);

    const equal = relabel(s2, s2, { sequence: 50, setAtMs: now - 2 * MINUTE });
    expect(await applySet(node, I1, equal)).toBe("not_applicable");
    const lower = relabel(s3, s3, { sequence: 10, setAtMs: now - 1 * MINUTE });
    expect(await applySet(node, I1, lower)).toBe("not_applicable");

    const after = await pinRow(t1, userId);
    expect(after.pin_hash).toBe(before.pin_hash);
    expect(after.pin_generation_at.getTime()).toBe(
      before.pin_generation_at.getTime(),
    );
    expect(after.generation_edge_instance_id).toBe(I1);
    expect(after.generation_edge_sequence).toBe("50");

    // Control: the same instance with a higher sequence and an older key
    // still wins (legend-rucdm).
    const next = relabel(s2, s2, { sequence: 51, setAtMs: now - 70 * MINUTE });
    expect(await applySet(node, I1, next)).toBe("applied");
    const adopted = await pinRow(t1, userId);
    expect(adopted.pin_hash).toBe(materialOf(s2).pinHash);
    expect(adopted.generation_edge_sequence).toBe("51");
  });

  it("3 old edge without an instance (absent, then null): later sequence wins with an older key, lower sequence with a newer key is refused, the row instance stays null", async () => {
    const { userId, now, s1, s2, s3 } = await staffWithSets(t1);
    const node = t1.node;

    // edgeInstanceId absent from the meta, as an old edge sends it.
    const first = relabel(s1, s1, { sequence: 5, setAtMs: now - 10 * MINUTE });
    expect(await applySet(node, undefined, first)).toBe("applied");
    const adopted = await pinRow(t1, userId);
    expect(adopted.generation_edge_node_id).toBe(node.scope.edgeNodeId);
    expect(adopted.generation_edge_instance_id).toBeNull();
    expect(adopted.generation_edge_sequence).toBe("5");

    // Later sequence, older key (clock stepped back): adopted.
    const later = relabel(s2, s2, { sequence: 6, setAtMs: now - 70 * MINUTE });
    expect(await applySet(node, undefined, later)).toBe("applied");
    const afterLater = await pinRow(t1, userId);
    expect(afterLater.pin_hash).toBe(materialOf(s2).pinHash);
    expect(afterLater.generation_edge_instance_id).toBeNull();
    expect(afterLater.generation_edge_sequence).toBe("6");

    // Lower sequence, newer key: refused (R2).
    const lower = relabel(s3, s3, { sequence: 2, setAtMs: now - 1 * MINUTE });
    expect(await applySet(node, undefined, lower)).toBe("not_applicable");
    // The explicit null (field present, unknown) behaves the same.
    expect(await applySet(node, null, lower)).toBe("not_applicable");
    const afterLower = await pinRow(t1, userId);
    expect(afterLower.pin_hash).toBe(materialOf(s2).pinHash);
    expect(afterLower.generation_edge_instance_id).toBeNull();
    expect(afterLower.generation_edge_sequence).toBe("6");

    // And a null-instance set with a higher sequence still wins.
    const higher = relabel(s3, s3, { sequence: 7, setAtMs: now - 80 * MINUTE });
    expect(await applySet(node, null, higher)).toBe("applied");
    const afterHigher = await pinRow(t1, userId);
    expect(afterHigher.pin_hash).toBe(materialOf(s3).pinHash);
    expect(afterHigher.generation_edge_instance_id).toBeNull();
  });

  it("4a lock: another instance's lock with a higher sequence but an older time is refused; the same instance's lock is applied", async () => {
    const { userId, now, s1 } = await staffWithSets(t1);
    const node = t1.node;
    const first = relabel(s1, s1, { sequence: 50, setAtMs: now - 10 * MINUTE });
    expect(await applySet(node, I1, first)).toBe("applied");

    const lockAtMs = now - 60 * MINUTE; // older than the generation key
    const lockedUntilMs = now + 5 * MINUTE;

    // I2 (rebuilt database): sequence 51 is higher than the stored 50 but
    // not comparable, and the time is older than the key: refused.
    const foreignHigher = lockedEvent(s1, {
      sequence: 51,
      occurredAtMs: lockAtMs,
      lockedUntilMs,
    });
    expect(await applyLock(node, I2, foreignHigher)).toBe("not_applicable");
    const foreignLower = lockedEvent(s1, {
      sequence: 3,
      occurredAtMs: lockAtMs,
      lockedUntilMs,
    });
    expect(await applyLock(node, I2, foreignLower)).toBe("not_applicable");
    const untouched = await pinRow(t1, userId);
    expect(untouched.locked_until).toBeNull();
    expect(untouched.failed_attempts).toBe(0);

    // The instance that gave the generation: higher sequence is applied.
    expect(await applyLock(node, I1, foreignHigher)).toBe("applied");
    const locked = await pinRow(t1, userId);
    expect(locked.failed_attempts).toBe(MAX_STAFF_PIN_ATTEMPTS);
    expect(locked.locked_until?.getTime()).toBeGreaterThan(now);
  });

  it("4b lock after an adoption by sequence in the rebuilt instance: the new instance's later lock is applied, the old instance's is refused", async () => {
    const { userId, now, s1, s2, s3 } = await staffWithSets(t1);
    const node = t1.node;

    expect(
      await applySet(
        node,
        I1,
        relabel(s1, s1, { sequence: 50, setAtMs: now - 10 * MINUTE }),
      ),
    ).toBe("applied");
    expect(
      await applySet(
        node,
        I2,
        relabel(s2, s2, { sequence: 1, setAtMs: now - 5 * MINUTE }),
      ),
    ).toBe("applied");
    // Adopted by sequence with a stepped-back key: the cloud key stays ahead
    // of the edge clock.
    expect(
      await applySet(
        node,
        I2,
        relabel(s3, s3, { sequence: 2, setAtMs: now - 120 * MINUTE }),
      ),
    ).toBe("applied");
    const adopted = await pinRow(t1, userId);
    expect(adopted.generation_edge_instance_id).toBe(I2);
    const lockAtMs = now - 60 * MINUTE;
    expect(adopted.pin_generation_at.getTime()).toBeGreaterThan(lockAtMs);
    const lockedUntilMs = now + 5 * MINUTE;

    // The old instance I1 is not the origin any more: refused whatever its
    // sequence.
    const oldInstance = lockedEvent(s3, {
      sequence: 99,
      occurredAtMs: lockAtMs,
      lockedUntilMs,
    });
    expect(await applyLock(node, I1, oldInstance)).toBe("not_applicable");
    expect((await pinRow(t1, userId)).locked_until).toBeNull();

    // I2's own later lock (sequence 3 > 2) is applied despite the older time.
    const own = lockedEvent(s3, {
      sequence: 3,
      occurredAtMs: lockAtMs,
      lockedUntilMs,
    });
    expect(await applyLock(node, I2, own)).toBe("applied");
    const locked = await pinRow(t1, userId);
    expect(locked.failed_attempts).toBe(MAX_STAFF_PIN_ATTEMPTS);
    expect(locked.locked_until?.getTime()).toBeGreaterThan(now);
    expect(locked.pin_hash).toBe(adopted.pin_hash);
  });

  it("6 unknown instance (parked drain, conflict replay) against a row holding an instance: the node-only rule, as before instances existed", async () => {
    const { userId, now, s1, s2, s3 } = await staffWithSets(t1);
    const node = t1.node;
    // Adopted by sequence with a stepped-back key: the cloud key is ahead of
    // the node's clock.
    expect(
      await applySet(
        node,
        I1,
        relabel(s1, s1, { sequence: 10, setAtMs: now - 10 * MINUTE }),
      ),
    ).toBe("applied");
    expect(
      await applySet(
        node,
        I1,
        relabel(s2, s2, { sequence: 11, setAtMs: now - 120 * MINUTE }),
      ),
    ).toBe("applied");
    const adopted = await pinRow(t1, userId);
    expect(adopted.generation_edge_instance_id).toBe(I1);

    // An older set of the node (lower sequence, newer key) replayed without
    // its instance is refused (R2), as before.
    const older = relabel(s3, s3, { sequence: 9, setAtMs: now - 1 * MINUTE });
    expect(await applySet(node, undefined, older)).toBe("not_applicable");
    expect(await applySet(node, null, older)).toBe("not_applicable");
    expect((await pinRow(t1, userId)).pin_hash).toBe(adopted.pin_hash);

    // The node's later lock replayed without its instance is applied (F1),
    // although its time is older than the cloud key.
    const lock = lockedEvent(s2, {
      sequence: 12,
      occurredAtMs: now - 60 * MINUTE,
      lockedUntilMs: now + 5 * MINUTE,
    });
    expect(await applyLock(node, undefined, lock)).toBe("applied");
    const locked = await pinRow(t1, userId);
    expect(locked.failed_attempts).toBe(MAX_STAFF_PIN_ATTEMPTS);
    expect(locked.pin_hash).toBe(adopted.pin_hash);

    // A later set of the node replayed without its instance is adopted by
    // sequence and keeps the stored instance (review K re-review): the node's
    // next live events, with I1, still order by sequence.
    const replayed = relabel(s3, s3, {
      sequence: 13,
      setAtMs: now - 100 * MINUTE,
    });
    expect(await applySet(node, undefined, replayed)).toBe("applied");
    const afterReplay = await pinRow(t1, userId);
    expect(afterReplay.pin_hash).toBe(materialOf(s3).pinHash);
    expect(afterReplay.generation_edge_instance_id).toBe(I1);
    expect(afterReplay.generation_edge_sequence).toBe("13");
    const liveLock = lockedEvent(s3, {
      sequence: 14,
      occurredAtMs: now - 90 * MINUTE,
      lockedUntilMs: now + 6 * MINUTE,
    });
    await owner.query(
      `UPDATE staff_pins SET failed_attempts = 0, locked_until = NULL WHERE id = $1`,
      [afterReplay.id],
    );
    expect(await applyLock(node, I1, liveLock)).toBe("applied");
    const liveSet = relabel(s2, s2, {
      sequence: 15,
      setAtMs: now - 80 * MINUTE,
    });
    expect(await applySet(node, I1, liveSet)).toBe("applied");
    expect((await pinRow(t1, userId)).pin_hash).toBe(materialOf(s2).pinHash);
  });

  it("5 cross tenant: another tenant's node with the same instance id never changes this tenant's row", async () => {
    const one = await staffWithSets(t1);
    const nodeOne = t1.node;
    expect(
      await applySet(
        nodeOne,
        I1,
        relabel(one.s1, one.s1, {
          sequence: 50,
          setAtMs: one.now - 10 * MINUTE,
        }),
      ),
    ).toBe("applied");
    const before = await pinRow(t1, one.userId);

    // The second tenant adopts its own staff member's set with the same
    // instance id.
    const two = await staffWithSets(t2);
    expect(
      await applySet(
        t2.node,
        I1,
        relabel(two.s1, two.s1, {
          sequence: 50,
          setAtMs: two.now - 10 * MINUTE,
        }),
      ),
    ).toBe("applied");
    const rowTwo = await pinRow(t2, two.userId);
    expect(rowTwo.generation_edge_node_id).toBe(t2.node.scope.edgeNodeId);
    expect(rowTwo.generation_edge_instance_id).toBe(I1);

    // Tenant 2's node sends an event naming tenant 1's staff member (newer
    // key, higher sequence, same instance): never applied.
    const outcome = await applySet(
      t2.node,
      I1,
      relabel(one.s2, one.s2, { sequence: 60, setAtMs: one.now - 1 * MINUTE }),
    ).catch(() => "rejected" as const);
    expect(outcome).not.toBe("applied");

    const after = await pinRow(t1, one.userId);
    expect(after.pin_hash).toBe(before.pin_hash);
    expect(after.pin_generation_at.getTime()).toBe(
      before.pin_generation_at.getTime(),
    );
    expect(after.generation_edge_node_id).toBe(nodeOne.scope.edgeNodeId);
    expect(after.generation_edge_instance_id).toBe(I1);
    expect(after.generation_edge_sequence).toBe("50");

    // Tenant 2's own row is unaffected by tenant 1's later work either.
    const rowTwoAfter = await pinRow(t2, two.userId);
    expect(rowTwoAfter.pin_hash).toBe(rowTwo.pin_hash);
    expect(rowTwoAfter.generation_edge_sequence).toBe("50");
  });

  it("7 parked drain never borrows the live link's instance: a standby's parked set is adopted with its node and a null instance", async () => {
    const { userId, now, s1 } = await staffWithSets(t1);

    // A standby node of the same outlet, besides the primary (the live link).
    const registered = await registerEdgeNode(t1.scope, actor, {
      outletId: t1.outletId,
      role: "standby",
      label: "Instance standby",
    });
    const standby = await authenticateEdgeCredential(registered.credential);
    if (!standby) throw new Error("Standby node did not authenticate");
    const standbyId = standby.scope.edgeNodeId;
    expect(standbyId).not.toBe(t1.node.scope.edgeNodeId);

    // A `staff_pin.set` with material parked by the standby (owner INSERT, as
    // seedParked in edge-access-applier.test.ts).
    const parked = relabel(s1, s1, {
      sequence: 20,
      setAtMs: now - 10 * MINUTE,
    });
    await owner.query(
      `INSERT INTO edge_deferred_events (tenant_id, outlet_id, edge_node_id, event_id, aggregate_type, aggregate_id,
          aggregate_sequence, event_name, envelope, parked_reason)
       VALUES ($1, $2, $3, $4::uuid, $5, $6, $7, $8, $9::jsonb, 'deferred')`,
      [
        t1.tenantId,
        t1.outletId,
        standbyId,
        ulidToUuid(parked.id),
        parked.aggregateType,
        parked.aggregateId,
        parked.sequence,
        parked.name,
        JSON.stringify(parked),
      ],
    );

    // The drain runs on the primary's live link, which carries instance I1.
    const drained = await withTenant(db, t1.node.context, (tx) =>
      drainParkedAccessEvents(
        tx,
        metaOf(t1.node, I1),
        outletIdSchema.parse(t1.outletId),
      ),
    );
    expect(drained).toBe(1);

    const marked = await owner.query<{ applied_at: Date | null }>(
      "SELECT applied_at FROM edge_deferred_events WHERE tenant_id = $1 AND event_id = $2::uuid",
      [t1.tenantId, ulidToUuid(parked.id)],
    );
    expect(marked.rows[0]?.applied_at).not.toBeNull();

    // Adopted under the standby's node; the live link's instance (I1) is never
    // borrowed, because the parked row's own instance was never recorded.
    const row = await pinRow(t1, userId);
    expect(row.pin_hash).toBe(materialOf(parked).pinHash);
    expect(row.generation_edge_node_id).toBe(standbyId);
    expect(row.generation_edge_instance_id).toBeNull();
    expect(row.generation_edge_sequence).toBe("20");
  });
});
