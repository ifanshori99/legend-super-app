// legend-ngyd7 (978): idempotent replay of parked access events that were
// marked 'refused' only because the audit writer was missing (M1 window,
// runbook worker-audit-writer-m1-window.md section 5).
//
// Planned API (from the brief), asserted here fail-first:
//   replayRefusedAccessEvents(tx, meta, outletId, { eventIds })
//
// Assumptions (the contract does not pin these down):
// - Only an AuditUnavailableError refusal is transient: the drain still marks
//   the row 'refused' but keeps the envelope intact, so it can be replayed.
// - A successful replay sets apply_outcome = 'applied' (and keeps the row).
// - A `staff_pin.set` without material (v1 event) cannot be replayed: it is
//   skipped silently, stays 'refused', and no staff_pins row is created.
// - Replay is scoped to the given outlet AND the given eventIds; events of
//   another outlet or tenant are never touched. Assertions use DB state only,
//   not the return value (its shape is unspecified).
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  drainParkedAccessEvents,
  registerAccessEdgeApplier,
  replayRefusedAccessEvents,
} from "./access-applier.ts";
import { resetEdgeApplierRegistryForTests } from "./applier-registry.ts";
import type { EdgeApplyMeta } from "./ports.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
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
const tenantId = randomUUID();
const tenant2Id = randomUUID();
const outletA = randomUUID();
const outletB = randomUUID();
const outlet2 = randomUUID();
const staffRoleId = randomUUID();
let node: AuthenticatedEdgeNode; // tenant 1, outlet A
let nodeB: AuthenticatedEdgeNode; // tenant 1, outlet B
let node2: AuthenticatedEdgeNode; // tenant 2, outlet 2
const createdUsers: string[] = [];

const OUTLET_A = outletIdSchema.parse(outletA);

const scopeFor = (tid: string, outletIds: string[]): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId: tid, brandId: null, source: "session" }),
    {
      kind: "outlets",
      outletIds: outletIds.map((id) => outletIdSchema.parse(id)),
    },
  );

async function createTenantFixture(tid: string, outlets: string[]) {
  const brand = randomUUID();
  const entity = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Tenant Replay Refused', plan, 'active', deployment_mode, feature_flags, limits, $3
       FROM tenants WHERE id = $4`,
    [
      tid,
      `replay-refused-${randomBytes(4).toString("hex")}`,
      actor,
      cafeLegendPlatformFixtures.tenant.id,
    ],
  );
  await owner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand')`,
    [brand, tid, `replay-refused-${randomBytes(3).toString("hex")}`],
  );
  await owner.query(
    `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Uji', false)`,
    [entity, tid],
  );
  for (const outletId of outlets)
    await owner.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, $5, 'Jl. Uji', '{}', 'active')`,
      [
        outletId,
        tid,
        brand,
        entity,
        `RPR-${randomBytes(3).toString("hex").toUpperCase()}`,
      ],
    );
}

async function registerNode(tid: string, outletId: string, label: string) {
  const registered = await registerEdgeNode(scopeFor(tid, [outletId]), actor, {
    outletId,
    role: "primary",
    label,
  });
  const authenticated = await authenticateEdgeCredential(registered.credential);
  if (!authenticated) throw new Error("Edge node did not authenticate");
  return authenticated;
}

/** A cashier of tenant 1 at outlet A (the override applier checks both users). */
async function newUser(): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email, email_verified, banned) VALUES ($1, 'Staf Replay', $2, true, false)`,
    [id, `replay-${randomBytes(4).toString("hex")}@example.test`],
  );
  createdUsers.push(id);
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 minute', $2)`,
    [tenantId, id, staffRoleId, outletA],
  );
  return id;
}

// ------------------------------------------------------------------- events

function overrideEvent(input: {
  requestedBy: string;
  approvedBy: string;
  tenant?: string;
  outlet?: string;
}): EventEnvelope {
  const overrideId = createUlid(Date.now());
  return {
    id: createUlid(Date.now()),
    tenantId: (input.tenant ?? tenantId) as EventEnvelope["tenantId"],
    outletId: (input.outlet ?? outletA) as EventEnvelope["outletId"],
    name: "pos_override.recorded",
    version: 1,
    aggregateType: "pos_override",
    aggregateId: overrideId,
    sequence: 1,
    occurredAt: new Date().toISOString(),
    actor: { type: "user", id: input.approvedBy },
    deviceId: null,
    idempotencyKey: `pos_override.recorded:${overrideId}:${randomBytes(4).toString("hex")}`,
    payloadSchemaRef: "pos_override.recorded.v1",
    payload: {
      overrideId,
      action: "void",
      method: "supervisor_pin",
      requestedBy: input.requestedBy,
      approvedBy: input.approvedBy,
      valueIdr: 45_000,
      objectType: "order",
      objectId: randomUUID(),
      approvalRequestId: null,
      reason: "Salah input menu",
      reasonCode: "wrong_item",
    },
  } as EventEnvelope;
}

/** v1 `staff_pin.set`: no `material` in the payload. */
function pinSetWithoutMaterial(userId: string): EventEnvelope {
  const staffPinId = randomUUID();
  return {
    id: createUlid(Date.now()),
    tenantId: tenantId as EventEnvelope["tenantId"],
    outletId: outletA as EventEnvelope["outletId"],
    name: "staff_pin.set",
    version: 1,
    aggregateType: "staff_pin",
    aggregateId: staffPinId,
    sequence: 1,
    occurredAt: new Date().toISOString(),
    actor: { type: "user", id: userId },
    deviceId: null,
    idempotencyKey: `staff_pin.set:${staffPinId}:${randomBytes(4).toString("hex")}`,
    payloadSchemaRef: "staff_pin.set.v1",
    payload: { staffPinId, userId, setBy: userId, self: true },
  } as EventEnvelope;
}

// --------------------------------------------------------------- helpers/SQL

const meta = (): EdgeApplyMeta => ({
  edgeNodeId: node.scope.edgeNodeId,
  direction: "edge_to_cloud",
  kind: "transaction_event",
  context: node.context,
});

const drain = () =>
  withTenant(db, node.context, (tx) =>
    drainParkedAccessEvents(tx, meta(), OUTLET_A),
  );

const replay = (eventIds: string[], acknowledgeUnmarked?: boolean) =>
  withTenant(db, node.context, (tx) =>
    replayRefusedAccessEvents(tx, meta(), OUTLET_A, {
      eventIds,
      acknowledgeUnmarked,
    }),
  );

type ParkedRow = {
  applied_at: Date | null;
  apply_outcome: string | null;
  overrideId: string | null;
  refusal: string | null;
};

async function parkedRow(eventId: string, tid = tenantId) {
  const { rows } = await owner.query<ParkedRow>(
    `SELECT applied_at, apply_outcome, envelope->'payload'->>'overrideId' AS "overrideId",
           envelope->>'refusal' AS refusal
       FROM edge_deferred_events WHERE tenant_id = $1 AND event_id = $2::uuid`,
    [tid, ulidToUuid(eventId)],
  );
  return rows[0] ?? null;
}

async function seedParked(
  event: EventEnvelope,
  where: { tenant: string; outlet: string; edgeNodeId: string },
) {
  await owner.query(
    `INSERT INTO edge_deferred_events (tenant_id, outlet_id, edge_node_id, event_id, aggregate_type, aggregate_id,
        aggregate_sequence, event_name, envelope, parked_reason)
     VALUES ($1, $2, $3, $4::uuid, $5, $6, $7, $8, $9::jsonb, 'deferred')`,
    [
      where.tenant,
      where.outlet,
      where.edgeNodeId,
      ulidToUuid(event.id),
      event.aggregateType,
      event.aggregateId,
      event.sequence,
      event.name,
      JSON.stringify(event),
    ],
  );
}

/**
 * A row already marked refused (owner update), as a past drain left it.
 * `marked` adds the audit-unavailable marker a drain writes; unmarked is a
 * legacy m1-window row or a real refusal.
 */
async function markRefused(eventId: string, tid = tenantId, marked = true) {
  await owner.query(
    `UPDATE edge_deferred_events
        SET applied_at = now(), apply_outcome = 'refused',
            envelope = CASE WHEN $3::boolean
              THEN envelope || '{"refusal":"audit_unavailable"}'::jsonb
              ELSE envelope END
      WHERE tenant_id = $1 AND event_id = $2::uuid`,
    [tid, ulidToUuid(eventId), marked],
  );
}

async function auditCount(overrideId: string, tid = tenantId) {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_logs
      WHERE tenant_id = $1 AND event->>'action' = 'pos_override.recorded'
        AND lower(event->>'objectId') IN ($2, $3)`,
    [tid, overrideId.toLowerCase(), ulidToUuid(overrideId).toLowerCase()],
  );
  return rows[0]!.n;
}

async function pinRowCount(userId: string) {
  const { rows } = await owner.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM staff_pins WHERE tenant_id = $1 AND user_id = $2",
    [tenantId, userId],
  );
  return rows[0]!.n;
}

// ------------------------------------------------------------------- set up

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  // registerEdgeNode records an audit row and throws AuditUnavailableError
  // without a writer. Install it for setup; test 1 detaches it for its drain.
  setAuditWriter(coreAuditWriter);
  await createTenantFixture(tenantId, [outletA, outletB]);
  await createTenantFixture(tenant2Id, [outlet2]);
  const role = await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     SELECT $1, $2, name, is_template, template_key, permissions, mfa_required, allowed_scope_types
       FROM roles WHERE tenant_id = $3 AND template_key = 'cashier'`,
    [staffRoleId, tenantId, cafeLegendPlatformFixtures.tenant.id],
  );
  if (role.rowCount !== 1) throw new Error("No cashier role template");
  node = await registerNode(tenantId, outletA, "Replay A");
  nodeB = await registerNode(tenantId, outletB, "Replay B");
  node2 = await registerNode(tenant2Id, outlet2, "Replay 2");
});

beforeEach(() => {
  resetEdgeApplierRegistryForTests();
  registerAccessEdgeApplier();
  setAuditWriter(coreAuditWriter);
});

afterAll(async () => {
  resetEdgeApplierRegistryForTests();
  setAuditWriter(null);
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const table of [
      "edge_deferred_events",
      "delivery_attempts",
      "notifications",
      "notification_outbox",
      "domain_event_outbox",
      "edge_link_slots",
      "edge_inbound_events",
      "edge_received_events",
      "edge_sync_conflicts",
      "edge_outbound_queue",
      "sync_cursors",
      "edge_nodes",
      "audit_logs",
      "pos_acting_staff",
      "devices",
      "staff_pins",
      "role_assignments",
      "roles",
      "outlets",
      "legal_entities",
      "brands",
    ])
      for (const tid of [tenantId, tenant2Id])
        await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tid]);
    for (const tid of [tenantId, tenant2Id])
      await client.query("DELETE FROM tenants WHERE id = $1", [tid]);
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

// -------------------------------------------------------------------- tests

const where = () => ({
  tenant: tenantId,
  outlet: outletA,
  edgeNodeId: node.scope.edgeNodeId,
});

describe("legend-ngyd7 replay of access events refused while the audit writer was missing", () => {
  it("keeps the envelope when the drain is refused for AuditUnavailableError, then replays it once and never twice", async () => {
    const requester = await newUser();
    const approver = await newUser();
    const event = overrideEvent({
      requestedBy: requester,
      approvedBy: approver,
    });
    await seedParked(event, where());

    // M1 window: no audit writer registered -> drain refuses the row.
    setAuditWriter(null);
    await drain();
    const refused = await parkedRow(event.id);
    expect(refused!.apply_outcome).toBe("refused");
    // Transient refusal: the envelope must NOT be redacted.
    expect(refused!.overrideId).toBe(event.payload.overrideId);
    expect(refused!.refusal).toBe("audit_unavailable");
    expect(await auditCount(event.payload.overrideId as string)).toBe(0);

    // Audit writer is back: replay applies it exactly once.
    setAuditWriter(coreAuditWriter);
    await replay([event.id]);
    const applied = await parkedRow(event.id);
    expect(applied!.apply_outcome).toBe("applied");
    expect(applied!.applied_at).not.toBeNull();
    expect(applied!.refusal).toBeNull();
    expect(await auditCount(event.payload.overrideId as string)).toBe(1);

    // Second replay: idempotent, nothing applied again, row unchanged.
    await replay([event.id]);
    const again = await parkedRow(event.id);
    expect(again!.apply_outcome).toBe("applied");
    expect(again!.applied_at!.toISOString()).toBe(
      applied!.applied_at!.toISOString(),
    );
    expect(await auditCount(event.payload.overrideId as string)).toBe(1);
  });

  it("does not touch an event that was already applied", async () => {
    const requester = await newUser();
    const approver = await newUser();
    const event = overrideEvent({
      requestedBy: requester,
      approvedBy: approver,
    });
    await seedParked(event, where());
    await drain(); // writer present: applied normally
    const before = await parkedRow(event.id);
    expect(before!.apply_outcome).toBe("applied");
    expect(await auditCount(event.payload.overrideId as string)).toBe(1);

    await replay([event.id]);

    const after = await parkedRow(event.id);
    expect(after!.apply_outcome).toBe("applied");
    expect(after!.applied_at!.toISOString()).toBe(
      before!.applied_at!.toISOString(),
    );
    expect(await auditCount(event.payload.overrideId as string)).toBe(1);
  });

  it("skips a refused row without the marker, and replays it only with acknowledgeUnmarked", async () => {
    const requester = await newUser();
    const approver = await newUser();
    const event = overrideEvent({
      requestedBy: requester,
      approvedBy: approver,
    });
    await seedParked(event, where());
    await markRefused(event.id, tenantId, false); // legacy row, no marker

    await replay([event.id]);
    const skipped = await parkedRow(event.id);
    expect(skipped!.apply_outcome).toBe("refused");
    expect(skipped!.refusal).toBeNull();
    expect(await auditCount(event.payload.overrideId as string)).toBe(0);

    await replay([event.id], true);
    const applied = await parkedRow(event.id);
    expect(applied!.apply_outcome).toBe("applied");
    expect(await auditCount(event.payload.overrideId as string)).toBe(1);
  });

  it("skips a refused staff_pin.set that has no material", async () => {
    const userId = await newUser();
    const event = pinSetWithoutMaterial(userId);
    await seedParked(event, where());
    await markRefused(event.id);

    await expect(replay([event.id])).resolves.not.toThrow();

    const row = await parkedRow(event.id);
    expect(row!.apply_outcome).toBe("refused"); // skipped, not applied
    expect(await pinRowCount(userId)).toBe(0);
  });

  it("only replays the requested eventIds of its own outlet", async () => {
    const requester = await newUser();
    const approver = await newUser();
    const wanted = overrideEvent({
      requestedBy: requester,
      approvedBy: approver,
    });
    const notRequested = overrideEvent({
      requestedBy: requester,
      approvedBy: approver,
    });
    const otherOutlet = overrideEvent({
      requestedBy: requester,
      approvedBy: approver,
      outlet: outletB,
    });
    const otherTenant = overrideEvent({
      requestedBy: requester,
      approvedBy: approver,
      tenant: tenant2Id,
      outlet: outlet2,
    });
    await seedParked(wanted, where());
    await seedParked(notRequested, where());
    await seedParked(otherOutlet, {
      tenant: tenantId,
      outlet: outletB,
      edgeNodeId: nodeB.scope.edgeNodeId,
    });
    await seedParked(otherTenant, {
      tenant: tenant2Id,
      outlet: outlet2,
      edgeNodeId: node2.scope.edgeNodeId,
    });
    await markRefused(wanted.id);
    await markRefused(notRequested.id);
    await markRefused(otherOutlet.id);
    await markRefused(otherTenant.id, tenant2Id);

    // The other outlet / tenant ids are passed on purpose: still untouched.
    await replay([wanted.id, otherOutlet.id, otherTenant.id]);

    expect((await parkedRow(wanted.id))!.apply_outcome).toBe("applied");
    expect(await auditCount(wanted.payload.overrideId as string)).toBe(1);
    // Refused outlet-A event that was not requested stays refused.
    expect((await parkedRow(notRequested.id))!.apply_outcome).toBe("refused");
    expect(await auditCount(notRequested.payload.overrideId as string)).toBe(0);
    // Other outlet of the same tenant and another tenant: untouched.
    expect((await parkedRow(otherOutlet.id))!.apply_outcome).toBe("refused");
    expect(await auditCount(otherOutlet.payload.overrideId as string)).toBe(0);
    expect((await parkedRow(otherTenant.id, tenant2Id))!.apply_outcome).toBe(
      "refused",
    );
    expect(
      await auditCount(otherTenant.payload.overrideId as string, tenant2Id),
    ).toBe(0);
  });
});
