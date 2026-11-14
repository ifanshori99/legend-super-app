// Edge -> cloud `staff_pin.*` and `pos_override.recorded` applier (bead
// legend-kyie, tier K). The cloud link store receives these events from an edge
// node and applies them instead of parking them 'deferred':
// - staff_pin.set carrying `payload.material` rewrites the cloud PIN row, so a
//   standby takeover / cloud -> edge sync never reverts a PIN set on the edge;
// - staff_pin.locked locks the cloud row (clamped);
// - pos_override.recorded writes one cloud audit row the owner sees.
// Musts: idempotent per event id, ordering (an older PIN never overwrites a
// newer one), tenant / outlet / node isolation, replay of rows already parked.
//
// Names this file assumes from the implementation (spec: brief DESIGN):
// - `registerAccessEdgeApplier()` exported by ../edge/access-applier.ts.
// - `staff_pins.pin_set_at` (timestamptz) and `edge_deferred_events.applied_at`
//   / `apply_outcome` ('applied' | 'not_applicable' | 'refused').
// - `staff_pin.set` payload `material` = { algorithm, salt, pinHash, params,
//   pepperVersion, setAt }; `pos_override.recorded` payload optional `reason`
//   and `reasonCode`.
// - An event the applier skips (v1 set without material, wrong pepperVersion,
//   lock for a user without a PIN row, expired lock) writes nothing and records
//   NO conflict; an invalid event (unknown / banned user, aggregateId not equal
//   to staffPinId, requestedBy == approvedBy) is refused: one
//   `edge_sync_conflicts` row with reason 'applier_refused' and the batch goes on.
// - The cloud audit row of an override has action 'pos_override.recorded',
//   object_type 'pos_override', objectId = overrideId (as ULID or its uuid),
//   actorId = approvedBy, reason = payload reason.
// - A wrong tenant / outlet / node is refused by the applier (throws); through
//   the link a wrong outlet aborts the batch (same as the stock.moved test).
// - Replay is triggered by delivering any live access event of the same tenant
//   and outlet (lazy drain inside the applier).
// Fixtures: two disposable tenants, created by the migration owner and removed
// in afterAll (staff_pins before user).
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
import { STAFF_PIN_HASH_ALGORITHM } from "@starter/shared/access/override";
import { MAX_STAFF_PIN_ATTEMPTS } from "@starter/shared/identity";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  applyStaffPinLocked,
  drainParkedAccessEvents,
  applyStaffPinSet,
  registerAccessEdgeApplier,
} from "../edge/access-applier.ts";
import { setStaffPin } from "../services/device-pin.service.ts";
import { enqueueEdgeEvent } from "../services/edge-queue.service.ts";
import {
  registeredEdgeEventClassifier,
  resetEdgeApplierRegistryForTests,
} from "../edge/applier-registry.ts";
import {
  registerEdgeDeferredFallback,
  registerPosDeferredEdgeApplier,
} from "../edge/deferred-event-applier.ts";
import { createDbLinkStore } from "../edge/db-link-store.ts";
import { edgeEventApplier, type EdgeApplyMeta } from "../edge/ports.ts";
import { registerStockMovedEdgeApplier } from "../edge/stock-moved-applier.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  hashStaffPin,
  verifyStaffPinHash,
} from "../services/device-pin-hash.ts";
import {
  currentStaffPinPepperVersion,
  staffPinPepper,
} from "../services/device-pin-pepper.ts";
import {
  authenticateEdgeCredential,
  registerEdgeNode,
  type AuthenticatedEdgeNode,
} from "../services/edge-node.service.ts";
import {
  applyStaffPinRecords as applyStaffPinRecordsRaw,
  listStaffPinRecordsSince,
  STAFF_PIN_SYNC_LIMIT_DEFAULT,
} from "../services/staff-pin-sync.ts";
import { createBuiltinWorkerTransport } from "../worker/transport.ts";
import {
  resetAccessDrainSweepThrottle,
  sweepParkedAccessEvents,
} from "../worker/access-drain.job.ts";
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
const tenant2Id = randomUUID();
const outletA = randomUUID();
const outletB = randomUUID();
const outlet2 = randomUUID();
let node: AuthenticatedEdgeNode; // tenant 1, outlet A
let nodeB: AuthenticatedEdgeNode; // tenant 1, outlet B
let node2: AuthenticatedEdgeNode; // tenant 2, outlet 2
const createdUsers: string[] = [];

const HOUR = 3_600_000;
const MINUTE = 60_000;

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
     SELECT $1, $2, 'Tenant Akses Edge', plan, 'active', deployment_mode, feature_flags, limits, $3
       FROM tenants WHERE id = $4`,
    [
      tid,
      `akses-edge-${randomBytes(4).toString("hex")}`,
      actor,
      cafeLegendPlatformFixtures.tenant.id,
    ],
  );
  await owner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand')`,
    [brand, tid, `akses-edge-${randomBytes(3).toString("hex")}`],
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
        `AKS-${randomBytes(3).toString("hex").toUpperCase()}`,
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

const staffRoleId = randomUUID();

/**
 * A staff member of tenant 1 (DESIGN: the user must exist in the tenant and
 * not be banned): a user row plus a cashier assignment at outlet A.
 */
async function newUser(banned = false): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email, email_verified, banned) VALUES ($1, 'Staf Akses', $2, true, false)`,
    [id, `akses-${randomBytes(4).toString("hex")}@example.test`],
  );
  createdUsers.push(id);
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 minute', $2)`,
    [tenantId, id, staffRoleId, outletA],
  );
  // 0144 (legend_role_assignment_grantee_guard) refuses a role for a banned
  // account, so a banned staff member is one banned after the assignment.
  if (banned)
    await owner.query(`UPDATE "user" SET banned = true WHERE id = $1`, [id]);
  return id;
}

// ------------------------------------------------------------- PIN material

type Material = {
  algorithm: string;
  salt: string;
  pinHash: string;
  params: { N: number; r: number; p: number; keyLength: 32 };
  pepperVersion: number;
  setAt: string;
};

/** Real hash (HMAC pepper + scrypt, bound to tenant / outlet / user). */
async function pinMaterial(
  userId: string,
  pin: string,
  setAtMs: number,
  options: { tenant?: string; outlet?: string; pepperVersion?: number } = {},
): Promise<Material> {
  const tenant = options.tenant ?? tenantId;
  const outlet = options.outlet ?? outletA;
  const hashed = await hashStaffPin({
    pepper: staffPinPepper(tenant, outlet),
    binding: { tenantId: tenant, outletId: outlet, userId },
    pin,
  });
  return {
    algorithm: STAFF_PIN_HASH_ALGORITHM,
    salt: hashed.salt,
    pinHash: hashed.pinHash,
    params: hashed.params as Material["params"],
    pepperVersion: options.pepperVersion ?? currentStaffPinPepperVersion(),
    setAt: new Date(setAtMs).toISOString(),
  };
}

async function pinVerifies(
  userId: string,
  pin: string,
  stored: { pin_hash: string; pin_salt: string },
): Promise<boolean> {
  return verifyStaffPinHash({
    pepper: staffPinPepper(tenantId, outletA),
    binding: { tenantId, outletId: outletA, userId },
    pin,
    stored: {
      salt: stored.pin_salt,
      pinHash: stored.pin_hash,
      params: { N: 16_384, r: 8, p: 1, keyLength: 32 },
    },
  });
}

type PinRow = {
  id: string;
  pin_hash: string;
  pin_salt: string;
  pepper_version: number;
  failed_attempts: number;
  locked_until: Date | null;
  pin_set_at: Date;
  updated_at: Date;
  set_in_past: boolean;
  lock_secs: number | null;
};

async function pinRows(userId: string, tid = tenantId): Promise<PinRow[]> {
  const { rows } = await owner.query<PinRow>(
    `SELECT id, pin_hash, pin_salt, pepper_version, failed_attempts, locked_until, pin_set_at, updated_at,
            (pin_set_at <= now()) AS set_in_past,
            extract(epoch FROM (locked_until - now()))::float8 AS lock_secs
       FROM staff_pins WHERE tenant_id = $1 AND user_id = $2`,
    [tid, userId],
  );
  return rows;
}

/** Cloud PIN row as the cloud itself has it (owner insert, explicit versions). */
async function seedPin(
  userId: string,
  pin: string,
  options: {
    id?: string;
    setAtMs: number;
    updatedAtMs?: number;
    failedAttempts?: number;
    lockedUntilMs?: number;
  },
): Promise<{ id: string; material: Material }> {
  const id = options.id ?? randomUUID();
  const material = await pinMaterial(userId, pin, options.setAtMs);
  await owner.query(
    `INSERT INTO staff_pins (id, tenant_id, outlet_id, user_id, pin_hash, pin_salt, kdf_n, kdf_r, kdf_p,
        pepper_version, failed_attempts, locked_until, set_by, created_at, updated_at, pin_set_at, pin_generation_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $4, $13, $14, $13, $13)`,
    [
      id,
      tenantId,
      outletA,
      userId,
      material.pinHash,
      material.salt,
      material.params.N,
      material.params.r,
      material.params.p,
      material.pepperVersion,
      options.failedAttempts ?? 0,
      options.lockedUntilMs === undefined
        ? null
        : new Date(options.lockedUntilMs),
      new Date(options.setAtMs),
      new Date(options.updatedAtMs ?? options.setAtMs),
    ],
  );
  return { id, material };
}

// ------------------------------------------------------------------- events

function envelope(input: {
  tenant?: string;
  outlet?: string;
  name: string;
  aggregateType: string;
  aggregateId: string;
  occurredAtMs?: number;
  actorId?: string | null;
  payload: Record<string, unknown>;
}): EventEnvelope {
  const occurredAtMs = input.occurredAtMs ?? Date.now();
  const actorId = input.actorId ?? null;
  return {
    id: createUlid(Date.now()),
    tenantId: (input.tenant ?? tenantId) as EventEnvelope["tenantId"],
    outletId: (input.outlet ?? outletA) as EventEnvelope["outletId"],
    name: input.name,
    version: 1,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    sequence: 1,
    occurredAt: new Date(occurredAtMs).toISOString(),
    actor: (actorId === null
      ? { type: "system" }
      : { type: "user", id: actorId }) as EventEnvelope["actor"],
    deviceId: null,
    idempotencyKey: `${input.name}:${input.aggregateId}:${randomBytes(4).toString("hex")}`,
    payloadSchemaRef: `${input.name}.v1`,
    payload: input.payload as EventEnvelope["payload"],
  };
}

/** A fresh staffPinId per event: one aggregate stream per event (sequence 1). */
function pinSetEvent(input: {
  userId: string;
  material?: Material;
  staffPinId?: string;
  aggregateId?: string;
  tenant?: string;
  outlet?: string;
}): EventEnvelope {
  const staffPinId = input.staffPinId ?? randomUUID();
  return envelope({
    tenant: input.tenant,
    outlet: input.outlet,
    name: "staff_pin.set",
    aggregateType: "staff_pin",
    aggregateId: input.aggregateId ?? staffPinId,
    actorId: input.userId,
    payload: {
      staffPinId,
      userId: input.userId,
      setBy: input.userId,
      self: true,
      ...(input.material ? { material: input.material } : {}),
    },
  });
}

function pinLockedEvent(input: {
  userId: string;
  lockedUntilMs: number;
  occurredAtMs?: number;
}): EventEnvelope {
  const staffPinId = randomUUID();
  return envelope({
    name: "staff_pin.locked",
    aggregateType: "staff_pin",
    aggregateId: staffPinId,
    occurredAtMs: input.occurredAtMs,
    payload: {
      staffPinId,
      userId: input.userId,
      lockedUntil: new Date(input.lockedUntilMs).toISOString(),
    },
  });
}

function overrideEvent(input: {
  requestedBy: string;
  approvedBy: string;
  overrideId?: string;
  tenant?: string;
  outlet?: string;
  reason?: string;
  reasonCode?: string;
}): EventEnvelope {
  const overrideId = input.overrideId ?? createUlid(Date.now());
  return envelope({
    tenant: input.tenant,
    outlet: input.outlet,
    name: "pos_override.recorded",
    aggregateType: "pos_override",
    aggregateId: overrideId,
    actorId: input.approvedBy,
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
      reason: input.reason ?? "Salah input menu",
      reasonCode: input.reasonCode ?? "wrong_item",
    },
  });
}

// --------------------------------------------------------------- link + SQL

function store(n = node) {
  return createDbLinkStore({
    database: db,
    context: n.context,
    node: n.scope,
    outboundDirection: "cloud_to_edge",
  });
}

async function deliver(events: EventEnvelope[], n = node) {
  const link = store(n);
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

const meta = (
  context: ScopedTenantContext = node.context,
  edgeNodeId: string = node.scope.edgeNodeId,
): EdgeApplyMeta => ({
  edgeNodeId,
  direction: "edge_to_cloud",
  kind: "transaction_event",
  context,
});

function applyDirect(event: EventEnvelope, m: EdgeApplyMeta = meta()) {
  return withTenant(db, m.context, (tx) =>
    edgeEventApplier("edge_to_cloud").apply(tx, event, m),
  );
}

async function count(query: string, params: unknown[]) {
  const { rows } = await owner.query<{ n: number }>(query, params);
  return rows[0]!.n;
}

const conflictsOf = (eventId: string) =>
  count(
    "SELECT count(*)::int AS n FROM edge_sync_conflicts WHERE tenant_id = $1 AND event_id = $2::uuid AND reason = 'applier_refused'",
    [tenantId, ulidToUuid(eventId)],
  );
const parkedOf = (eventId: string) =>
  count(
    "SELECT count(*)::int AS n FROM edge_deferred_events WHERE tenant_id = $1 AND event_id = $2::uuid",
    [tenantId, ulidToUuid(eventId)],
  );
const cloudToEdgeQueue = () =>
  count(
    "SELECT count(*)::int AS n FROM edge_outbound_queue WHERE tenant_id = $1 AND direction = 'cloud_to_edge'",
    [tenantId],
  );
const outboxTotal = (tid = tenantId) =>
  count(
    "SELECT count(*)::int AS n FROM domain_event_outbox WHERE tenant_id = $1",
    [tid],
  );

type AuditRow = {
  outlet_id: string | null;
  event: {
    action: string;
    objectType: string;
    objectId: string;
    actorId: string | null;
    reason: string | null;
    maskedChanges: { after: Record<string, unknown> };
  };
};

/** Override audit rows by overrideId (stored as the ULID or its uuid). */
async function overrideAudit(overrideId: string, tid = tenantId) {
  const { rows } = await owner.query<AuditRow>(
    `SELECT outlet_id, event FROM audit_logs
      WHERE tenant_id = $1 AND event->>'action' = 'pos_override.recorded'
        AND lower(event->>'objectId') IN ($2, $3)`,
    [tid, overrideId.toLowerCase(), ulidToUuid(overrideId).toLowerCase()],
  );
  return rows;
}

type ParkedRow = {
  applied_at: Date | null;
  apply_outcome: string | null;
  parked_reason: string;
};

async function parkedRow(eventId: string, tid = tenantId) {
  const { rows } = await owner.query<ParkedRow>(
    "SELECT applied_at, apply_outcome, parked_reason FROM edge_deferred_events WHERE tenant_id = $1 AND event_id = $2::uuid",
    [tid, ulidToUuid(eventId)],
  );
  return rows[0] ?? null;
}

/** An event parked before the applier existed (owner insert, as the old applier did). */
async function seedParked(
  event: EventEnvelope,
  parkedReason: "deferred" | "unclassified",
  where: { tenant: string; outlet: string; edgeNodeId: string },
) {
  await owner.query(
    `INSERT INTO edge_deferred_events (tenant_id, outlet_id, edge_node_id, event_id, aggregate_type, aggregate_id,
        aggregate_sequence, event_name, envelope, parked_reason)
     VALUES ($1, $2, $3, $4::uuid, $5, $6, $7, $8, $9::jsonb, $10)`,
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
      parkedReason,
    ],
  );
}

// ------------------------------------------------------------------- set up

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
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
  node = await registerNode(tenantId, outletA, "Utama Akses A");
  nodeB = await registerNode(tenantId, outletB, "Utama Akses B");
  node2 = await registerNode(tenant2Id, outlet2, "Utama Akses 2");
});

beforeEach(() => {
  resetEdgeApplierRegistryForTests();
  // Registration order of registerEdgeLink (runtime.ts).
  registerStockMovedEdgeApplier();
  registerPosDeferredEdgeApplier();
  registerAccessEdgeApplier();
  registerEdgeDeferredFallback();
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
      "pos_acting_staff", // before "user" and "devices"
      "devices",
      "staff_pins", // before "user"
      "role_assignments", // before "user"
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

// ---------------------------------------------------------------- PIN set

describe("legend-kyie staff_pin.set from an edge", () => {
  // Seeds a live acting-cashier token of the staff member at outlet A on a
  // fresh device (the token a PIN adoption must end).
  async function seedActingToken(userId: string): Promise<string> {
    const deviceId = randomUUID();
    await owner.query(
      `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
       VALUES ($1, $2, $3, 'pos', 'Kasir edge', now() - interval '1 minute')`,
      [deviceId, tenantId, outletA],
    );
    const id = randomUUID();
    await owner.query(
      `INSERT INTO pos_acting_staff
         (id, tenant_id, outlet_id, device_id, staff_user_id, session_user_id,
          session_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $5, $6, $7, now() + interval '1 hour')`,
      [
        id,
        tenantId,
        outletA,
        deviceId,
        userId,
        randomUUID(),
        randomUUID().replaceAll("-", "").padEnd(64, "0"),
      ],
    );
    return id;
  }

  async function actingTokenState(id: string) {
    const { rows } = await owner.query<{
      revoked: boolean;
      reason: string | null;
    }>(
      "SELECT revoked_at IS NOT NULL AS revoked, revoke_reason AS reason FROM pos_acting_staff WHERE id = $1",
      [id],
    );
    return rows[0]!;
  }

  it("revokes the live acting-cashier tokens when a newer edge set is adopted (update), and not on the same material", async () => {
    const userId = await newUser();
    await seedPin(userId, "135790", { setAtMs: Date.now() - 3 * HOUR });
    const tokenId = await seedActingToken(userId);
    const material = await pinMaterial(userId, "246801", Date.now() - HOUR);

    await deliver([pinSetEvent({ userId, material })]);
    expect(await actingTokenState(tokenId)).toEqual({
      revoked: true,
      reason: "pin_reset",
    });

    // Same material again (a re-send): not an adoption, a new token lives on.
    const liveId = await seedActingToken(userId);
    await deliver([pinSetEvent({ userId, material })]);
    expect(await actingTokenState(liveId)).toEqual({
      revoked: false,
      reason: null,
    });
  });

  it("revokes the live acting-cashier tokens when an edge set inserts the cloud row", async () => {
    const userId = await newUser();
    const tokenId = await seedActingToken(userId);
    const material = await pinMaterial(userId, "482916", Date.now() - MINUTE);

    await deliver([pinSetEvent({ userId, material })]);

    expect(await pinRows(userId)).toHaveLength(1);
    expect(await actingTokenState(tokenId)).toEqual({
      revoked: true,
      reason: "pin_reset",
    });
  });

  it("keeps the tokens when an older edge set is refused", async () => {
    const userId = await newUser();
    await seedPin(userId, "135790", { setAtMs: Date.now() - HOUR });
    const tokenId = await seedActingToken(userId);
    const older = await pinMaterial(userId, "246801", Date.now() - 2 * HOUR);

    await deliver([pinSetEvent({ userId, material: older })]);

    expect(await actingTokenState(tokenId)).toEqual({
      revoked: false,
      reason: null,
    });
  });

  it("inserts the cloud row when none exists, keeps it out of the parked inbox and queues nothing", async () => {
    const userId = await newUser();
    const setAtMs = Date.now() - MINUTE;
    const material = await pinMaterial(userId, "482916", setAtMs);
    const event = pinSetEvent({ userId, material });
    const outboxBefore = await outboxTotal();
    const queueBefore = await cloudToEdgeQueue();
    const link = store();
    const cursorBefore = await link.lastReceivedInbound();

    await deliver([event]);

    expect(await link.lastReceivedInbound()).toBe(cursorBefore + 1);
    const rows = await pinRows(userId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe(event.payload.staffPinId);
    expect(row.pin_hash).toBe(material.pinHash);
    expect(row.pin_salt).toBe(material.salt);
    expect(row.pepper_version).toBe(currentStaffPinPepperVersion());
    expect(row.failed_attempts).toBe(0);
    expect(row.locked_until).toBeNull();
    expect(row.pin_set_at.toISOString()).toBe(material.setAt);
    // The edge's PIN works on the cloud row, another one does not.
    expect(await pinVerifies(userId, "482916", row)).toBe(true);
    expect(await pinVerifies(userId, "482917", row)).toBe(false);
    // Applied, not parked; no conflict; nothing echoed back or queued.
    expect(await parkedOf(event.id)).toBe(0);
    expect(await conflictsOf(event.id)).toBe(0);
    expect(await outboxTotal()).toBe(outboxBefore);
    expect(await cloudToEdgeQueue()).toBe(queueBefore);
    expect(registeredEdgeEventClassifier(event)).toBe("transaction_event");
  });

  it("replaces the hash when the edge set is newer and keeps the cloud row id", async () => {
    const userId = await newUser();
    const cloud = await seedPin(userId, "135790", {
      setAtMs: Date.now() - 3 * HOUR,
      failedAttempts: 3,
      lockedUntilMs: Date.now() + 10 * MINUTE,
    });
    const material = await pinMaterial(userId, "246801", Date.now() - HOUR);
    const event = pinSetEvent({ userId, material }); // staffPinId != cloud.id

    await deliver([event]);

    const rows = await pinRows(userId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe(cloud.id);
    expect(row.id).not.toBe(event.payload.staffPinId);
    expect(row.pin_hash).toBe(material.pinHash);
    expect(row.pin_set_at.toISOString()).toBe(material.setAt);
    expect(await pinVerifies(userId, "246801", row)).toBe(true);
    expect(await pinVerifies(userId, "135790", row)).toBe(false);
    // A set clears the counter and the lock, like a normal set.
    expect(row.failed_attempts).toBe(0);
    expect(row.locked_until).toBeNull();
  });

  it("leaves the cloud row alone when it is newer or equally new (tie: cloud stays)", async () => {
    const newerUser = await newUser();
    const tieUser = await newUser();
    const tieAtMs = Date.now() - HOUR;
    const newer = await seedPin(newerUser, "135790", {
      setAtMs: Date.now() - HOUR,
    });
    const tie = await seedPin(tieUser, "135790", { setAtMs: tieAtMs });
    const older = await pinMaterial(newerUser, "246801", Date.now() - 2 * HOUR);
    const equal = await pinMaterial(tieUser, "246801", tieAtMs);
    const events = [
      pinSetEvent({ userId: newerUser, material: older }),
      pinSetEvent({ userId: tieUser, material: equal }),
    ];

    await deliver(events);

    for (const [userId, seeded] of [
      [newerUser, newer],
      [tieUser, tie],
    ] as const) {
      const [row] = await pinRows(userId);
      expect(row!.id).toBe(seeded.id);
      expect(row!.pin_hash).toBe(seeded.material.pinHash);
      expect(row!.pin_set_at.toISOString()).toBe(seeded.material.setAt);
    }
    for (const event of events) expect(await conflictsOf(event.id)).toBe(0);
  });

  it("the edge set wins although a cloud PIN attempt bumped updated_at later", async () => {
    const userId = await newUser();
    await seedPin(userId, "135790", {
      setAtMs: Date.now() - 3 * HOUR,
      updatedAtMs: Date.now() - 10 * MINUTE, // a failed attempt
      failedAttempts: 2,
    });
    const material = await pinMaterial(userId, "246801", Date.now() - HOUR);

    await deliver([pinSetEvent({ userId, material })]);

    const [row] = await pinRows(userId);
    expect(row!.pin_hash).toBe(material.pinHash);
    expect(row!.failed_attempts).toBe(0);
  });

  it("clamps a setAt in the future to the cloud clock", async () => {
    const userId = await newUser();
    // The clamp is LEAST(setAt, now()) on the database clock, so every time
    // here comes from the database clock, never the host clock: a host/VM
    // clock drift under load made the old Date.now() bounds flake.
    const {
      rows: [{ db_now: dbBefore }],
    } = await owner.query<{ db_now: Date }>("SELECT now() AS db_now");
    // Inside the 5 min skew window (round 3 R1 refuses anything further).
    const futureAtMs = dbBefore.getTime() + 3 * MINUTE;
    const future = await pinMaterial(userId, "482916", futureAtMs);

    await deliver([pinSetEvent({ userId, material: future })]);

    const [row] = await pinRows(userId);
    expect(row!.pin_hash).toBe(future.pinHash);
    expect(row!.set_in_past).toBe(true);
    expect(row!.pin_set_at.getTime()).toBeLessThan(futureAtMs);
    expect(row!.pin_set_at.getTime()).toBeGreaterThanOrEqual(
      dbBefore.getTime() - 1_000,
    );

    // The clamp keeps a skewed edge clock from freezing the PIN: an honest
    // earlier set no longer wins over it.
    const honest = await pinMaterial(
      userId,
      "246801",
      dbBefore.getTime() - HOUR,
    );
    await deliver([pinSetEvent({ userId, material: honest })]);
    const [after] = await pinRows(userId);
    expect(after!.pin_hash).toBe(future.pinHash);
  });

  it("a replay of the same event changes nothing (link redelivery and a direct second apply)", async () => {
    const userId = await newUser();
    const material = await pinMaterial(userId, "482916", Date.now() - MINUTE);
    const event = pinSetEvent({ userId, material });
    await deliver([event]);
    const [first] = await pinRows(userId);

    await deliver([event]);
    await applyDirect(event);

    const rows = await pinRows(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(first);
    expect(await conflictsOf(event.id)).toBe(0);
  });

  it("writes nothing for a v1 payload without material or for another pepper version, and records no conflict", async () => {
    const withRowUser = await newUser();
    const noRowUser = await newUser();
    const wrongPepperUser = await newUser();
    const seeded = await seedPin(withRowUser, "135790", {
      setAtMs: Date.now() - 3 * HOUR,
    });
    const v1 = pinSetEvent({ userId: withRowUser });
    const v1NoRow = pinSetEvent({ userId: noRowUser });
    const wrongPepper = pinSetEvent({
      userId: wrongPepperUser,
      material: await pinMaterial(
        wrongPepperUser,
        "482916",
        Date.now() - HOUR,
        {
          pepperVersion: currentStaffPinPepperVersion() + 1,
        },
      ),
    });
    const link = store();
    const cursorBefore = await link.lastReceivedInbound();

    await deliver([v1, v1NoRow, wrongPepper]);

    expect(await link.lastReceivedInbound()).toBe(cursorBefore + 3);
    const [row] = await pinRows(withRowUser);
    expect(row!.pin_hash).toBe(seeded.material.pinHash);
    expect(await pinRows(noRowUser)).toHaveLength(0);
    expect(await pinRows(wrongPepperUser)).toHaveLength(0);
    for (const event of [v1, v1NoRow, wrongPepper])
      expect(await conflictsOf(event.id)).toBe(0);
  });

  it("refuses an unknown user, a banned user and an aggregate that is not the pin: one conflict each, no row, the batch goes on", async () => {
    const unknownUser = randomUUID();
    const bannedUser = await newUser(true);
    const mismatchUser = await newUser();
    const goodUser = await newUser();
    const refused = [
      pinSetEvent({
        userId: unknownUser,
        material: await pinMaterial(unknownUser, "482916", Date.now() - HOUR),
      }),
      pinSetEvent({
        userId: bannedUser,
        material: await pinMaterial(bannedUser, "482916", Date.now() - HOUR),
      }),
      pinSetEvent({
        userId: mismatchUser,
        aggregateId: randomUUID(),
        material: await pinMaterial(mismatchUser, "482916", Date.now() - HOUR),
      }),
    ];
    const good = pinSetEvent({
      userId: goodUser,
      material: await pinMaterial(goodUser, "482916", Date.now() - HOUR),
    });
    const link = store();
    const cursorBefore = await link.lastReceivedInbound();

    await deliver([...refused, good]);

    expect(await link.lastReceivedInbound()).toBe(cursorBefore + 4);
    for (const event of refused) {
      expect(await conflictsOf(event.id), event.id).toBe(1);
      const { rows } = await owner.query<{ t: string }>(
        "SELECT to_jsonb(c)::text AS t FROM edge_sync_conflicts c WHERE tenant_id = $1 AND event_id = $2::uuid",
        [tenantId, ulidToUuid(event.id)],
      );
      const material = (event.payload as { material: Material }).material;
      // The stored conflict event never carries the PIN material.
      for (const row of rows) {
        expect(row.t).not.toContain(material.pinHash);
        expect(row.t).not.toContain(material.salt);
        expect(row.t).not.toContain('"material"');
      }
      expect(await parkedOf(event.id)).toBe(0);
    }
    expect(await pinRows(unknownUser)).toHaveLength(0);
    expect(await pinRows(bannedUser)).toHaveLength(0);
    expect(await pinRows(mismatchUser)).toHaveLength(0);
    expect(await pinRows(goodUser)).toHaveLength(1);
  });
});

describe("legend-kyie scope: tenant, outlet and node", () => {
  it("refuses an event of another tenant", async () => {
    const userId = await newUser();
    const event = pinSetEvent({
      userId,
      tenant: tenant2Id,
      outlet: outlet2,
      material: await pinMaterial(userId, "482916", Date.now() - HOUR, {
        tenant: tenant2Id,
        outlet: outlet2,
      }),
    });
    await expect(applyDirect(event)).rejects.toThrow();
    expect(await pinRows(userId, tenant2Id)).toHaveLength(0);
    expect(await pinRows(userId)).toHaveLength(0);
  });

  it("refuses an event of an outlet outside the node scope, also with a tenant-wide context", async () => {
    const userId = await newUser();
    const override = overrideEvent({
      requestedBy: userId,
      approvedBy: await newUser(),
      outlet: outletB,
    });
    const event = pinSetEvent({
      userId,
      outlet: outletB,
      material: await pinMaterial(userId, "482916", Date.now() - HOUR, {
        outlet: outletB,
      }),
    });
    for (const refused of [event, override]) {
      await expect(applyDirect(refused)).rejects.toThrow();
      const tenantWide = establishScopedTenantContext(
        establishTenantContext({ tenantId, brandId: null, source: "session" }),
        { kind: "tenant" },
      );
      await expect(applyDirect(refused, meta(tenantWide))).rejects.toThrow();
    }
    // The link refuses it before any applier runs.
    await expect(deliver([event])).rejects.toThrow();
    expect(await pinRows(userId)).toHaveLength(0);
    expect(
      await overrideAudit(override.payload.overrideId as string),
    ).toHaveLength(0);
  });

  it("refuses an event whose outlet is not the edge node's outlet", async () => {
    const userId = await newUser();
    // Right tenant, outlet A in scope, but the meta names the node of outlet B.
    const event = pinSetEvent({
      userId,
      material: await pinMaterial(userId, "482916", Date.now() - HOUR),
    });
    await expect(
      applyDirect(event, meta(node.context, nodeB.scope.edgeNodeId)),
    ).rejects.toThrow();
    expect(await pinRows(userId)).toHaveLength(0);
  });

  it("applies only inside the node's own outlet: the same user keeps separate PIN rows per outlet", async () => {
    const userId = await newUser();
    const otherOutlet = await seedPinInOutlet(userId, outletB);
    const material = await pinMaterial(userId, "482916", Date.now() - HOUR);

    await deliver([pinSetEvent({ userId, material })]);

    const rows = await pinRows(userId);
    expect(rows).toHaveLength(2);
    const untouched = await owner.query<{ pin_hash: string }>(
      "SELECT pin_hash FROM staff_pins WHERE tenant_id = $1 AND outlet_id = $2 AND user_id = $3",
      [tenantId, outletB, userId],
    );
    expect(untouched.rows[0]!.pin_hash).toBe(otherOutlet.pinHash);
    const own = await owner.query<{ pin_hash: string }>(
      "SELECT pin_hash FROM staff_pins WHERE tenant_id = $1 AND outlet_id = $2 AND user_id = $3",
      [tenantId, outletA, userId],
    );
    expect(own.rows[0]!.pin_hash).toBe(material.pinHash);
  });
});

async function seedPinInOutlet(userId: string, outletId: string) {
  const material = await pinMaterial(userId, "135790", Date.now() - 3 * HOUR, {
    outlet: outletId,
  });
  await owner.query(
    `INSERT INTO staff_pins (tenant_id, outlet_id, user_id, pin_hash, pin_salt, kdf_n, kdf_r, kdf_p,
        pepper_version, set_by, created_at, updated_at, pin_set_at, pin_generation_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $3, $10, $10, $10, $10)`,
    [
      tenantId,
      outletId,
      userId,
      material.pinHash,
      material.salt,
      material.params.N,
      material.params.r,
      material.params.p,
      material.pepperVersion,
      new Date(Date.now() - 3 * HOUR),
    ],
  );
  return material;
}

// --------------------------------------------------------------- PIN locked

describe("legend-kyie staff_pin.locked from an edge", () => {
  it("applies a newer, still active lock", async () => {
    const userId = await newUser();
    await seedPin(userId, "135790", { setAtMs: Date.now() - HOUR });
    const lockedUntilMs = Date.now() + 10 * MINUTE;

    await deliver([
      pinLockedEvent({
        userId,
        lockedUntilMs,
        occurredAtMs: Date.now() - MINUTE,
      }),
    ]);

    const [row] = await pinRows(userId);
    expect(row!.failed_attempts).toBe(MAX_STAFF_PIN_ATTEMPTS);
    expect(row!.locked_until!.toISOString()).toBe(
      new Date(lockedUntilMs).toISOString(),
    );
  });

  it("ignores an expired lock and a lock older than the cloud PIN", async () => {
    const expiredUser = await newUser();
    const oldUser = await newUser();
    await seedPin(expiredUser, "135790", { setAtMs: Date.now() - HOUR });
    await seedPin(oldUser, "135790", { setAtMs: Date.now() - MINUTE });
    const expired = pinLockedEvent({
      userId: expiredUser,
      lockedUntilMs: Date.now() - MINUTE,
    });
    // Recorded on the edge before the cloud's newer PIN: it locked the old PIN.
    const older = pinLockedEvent({
      userId: oldUser,
      lockedUntilMs: Date.now() + 10 * MINUTE,
      occurredAtMs: Date.now() - HOUR,
    });

    await deliver([expired, older]);

    for (const userId of [expiredUser, oldUser]) {
      const [row] = await pinRows(userId);
      expect(row!.failed_attempts).toBe(0);
      expect(row!.locked_until).toBeNull();
    }
    expect(await conflictsOf(expired.id)).toBe(0);
    expect(await conflictsOf(older.id)).toBe(0);
  });

  it("clamps lockedUntil to the standard lock time and never shortens a longer cloud lock", async () => {
    const farUser = await newUser();
    const longerUser = await newUser();
    await seedPin(farUser, "135790", { setAtMs: Date.now() - HOUR });
    const longerMs = Date.now() + 14 * MINUTE;
    await seedPin(longerUser, "135790", {
      setAtMs: Date.now() - HOUR,
      failedAttempts: MAX_STAFF_PIN_ATTEMPTS,
      lockedUntilMs: longerMs,
    });

    await deliver([
      pinLockedEvent({
        userId: farUser,
        lockedUntilMs: Date.now() + 7 * 24 * HOUR,
        occurredAtMs: Date.now() - MINUTE,
      }),
      pinLockedEvent({
        userId: longerUser,
        lockedUntilMs: Date.now() + 5 * MINUTE,
        occurredAtMs: Date.now() - MINUTE,
      }),
    ]);

    const [far] = await pinRows(farUser);
    expect(far!.failed_attempts).toBe(MAX_STAFF_PIN_ATTEMPTS);
    // STAFF_PIN_LOCK_MINUTES = 15 (identity/limits.ts).
    expect(far!.lock_secs!).toBeGreaterThan(14 * 60);
    expect(far!.lock_secs!).toBeLessThanOrEqual(15 * 60 + 5);
    const [longer] = await pinRows(longerUser);
    expect(longer!.locked_until!.toISOString()).toBe(
      new Date(longerMs).toISOString(),
    );
  });

  it("writes nothing for a user without a cloud PIN row and records no conflict", async () => {
    const userId = await newUser();
    const event = pinLockedEvent({
      userId,
      lockedUntilMs: Date.now() + 10 * MINUTE,
    });
    const link = store();
    const cursorBefore = await link.lastReceivedInbound();

    await deliver([event]);

    expect(await link.lastReceivedInbound()).toBe(cursorBefore + 1);
    expect(await pinRows(userId)).toHaveLength(0);
    expect(await conflictsOf(event.id)).toBe(0);
  });
});

// ----------------------------------------------------------------- override

describe("legend-kyie pos_override.recorded from an edge", () => {
  it("writes exactly one cloud audit row, also after a redelivery", async () => {
    const requester = await newUser();
    const approver = await newUser();
    const event = overrideEvent({
      requestedBy: requester,
      approvedBy: approver,
      reason: "Pelanggan membatalkan pesanan",
      reasonCode: "customer_cancel",
    });
    const overrideId = event.payload.overrideId as string;
    const queueBefore = await cloudToEdgeQueue();

    await deliver([event]);
    await deliver([event]);

    const rows = await overrideAudit(overrideId);
    expect(rows).toHaveLength(1);
    const audit = rows[0]!;
    expect(audit.outlet_id).toBe(outletA);
    expect(audit.event.objectType).toBe("pos_override");
    expect(audit.event.actorId).toBe(approver);
    expect(audit.event.reason).toBe("Pelanggan membatalkan pesanan");
    expect(audit.event.maskedChanges.after).toMatchObject({
      action: "void",
      method: "supervisor_pin",
      requestedBy: requester,
      approvedBy: approver,
      valueIdr: 45_000,
      reasonCode: "customer_cancel",
      objectType: "order",
    });
    expect(await parkedOf(event.id)).toBe(0);
    expect(await conflictsOf(event.id)).toBe(0);
    expect(await cloudToEdgeQueue()).toBe(queueBefore);
  });

  it("refuses an override approved by its own requester: a conflict and no audit row", async () => {
    const same = await newUser();
    const refused = overrideEvent({ requestedBy: same, approvedBy: same });
    const good = overrideEvent({
      requestedBy: await newUser(),
      approvedBy: await newUser(),
    });
    const link = store();
    const cursorBefore = await link.lastReceivedInbound();

    await deliver([refused, good]);

    expect(await link.lastReceivedInbound()).toBe(cursorBefore + 2);
    expect(await conflictsOf(refused.id)).toBe(1);
    expect(
      await overrideAudit(refused.payload.overrideId as string),
    ).toHaveLength(0);
    // The next event of the batch is still applied.
    expect(await overrideAudit(good.payload.overrideId as string)).toHaveLength(
      1,
    );
  });
});

// ------------------------------------------------------------------- replay

describe("legend-kyie replay of rows parked before the applier existed", () => {
  it("applies parked 'deferred' and 'unclassified' rows once, with an outcome, and leaves other tenants and outlets alone", async () => {
    const where = {
      tenant: tenantId,
      outlet: outletA,
      edgeNodeId: node.scope.edgeNodeId,
    };
    const requester = await newUser();
    const approver = await newUser();
    const lockedUser = await newUser();
    const v1User = await newUser();
    await seedPin(lockedUser, "135790", { setAtMs: Date.now() - HOUR });

    const deferredOverride = overrideEvent({
      requestedBy: requester,
      approvedBy: approver,
    });
    const unclassifiedOverride = overrideEvent({
      requestedBy: requester,
      approvedBy: approver,
    });
    const invalidOverride = overrideEvent({
      requestedBy: approver,
      approvedBy: approver,
    });
    const parkedLock = pinLockedEvent({
      userId: lockedUser,
      lockedUntilMs: Date.now() + 10 * MINUTE,
      occurredAtMs: Date.now() - MINUTE,
    });
    const parkedV1Set = pinSetEvent({ userId: v1User }); // no material
    await seedParked(deferredOverride, "deferred", where);
    await seedParked(unclassifiedOverride, "unclassified", where);
    await seedParked(invalidOverride, "deferred", where);
    await seedParked(parkedLock, "deferred", where);
    await seedParked(parkedV1Set, "deferred", where);

    // Other outlet of the same tenant and another tenant: must stay parked.
    const otherOutletOverride = overrideEvent({
      requestedBy: requester,
      approvedBy: approver,
      outlet: outletB,
    });
    const otherTenantOverride = overrideEvent({
      requestedBy: requester,
      approvedBy: approver,
      tenant: tenant2Id,
      outlet: outlet2,
    });
    await seedParked(otherOutletOverride, "deferred", {
      tenant: tenantId,
      outlet: outletB,
      edgeNodeId: nodeB.scope.edgeNodeId,
    });
    await seedParked(otherTenantOverride, "deferred", {
      tenant: tenant2Id,
      outlet: outlet2,
      edgeNodeId: node2.scope.edgeNodeId,
    });

    // Before any live event the rows are parked and nothing is applied.
    expect((await parkedRow(deferredOverride.id))!.applied_at).toBeNull();

    // A live access event of the node triggers the replay.
    const liveUser = await newUser();
    await deliver([
      pinSetEvent({
        userId: liveUser,
        material: await pinMaterial(liveUser, "482916", Date.now() - HOUR),
      }),
    ]);

    expect(await pinRows(liveUser)).toHaveLength(1);
    const outcomes = new Map<string, ParkedRow>();
    for (const [name, event, outcome] of [
      ["deferred override", deferredOverride, "applied"],
      ["unclassified override", unclassifiedOverride, "applied"],
      ["invalid override", invalidOverride, "refused"],
      ["lock", parkedLock, "applied"],
      ["v1 set", parkedV1Set, "not_applicable"],
    ] as const) {
      const row = await parkedRow(event.id);
      expect(row, name).not.toBeNull(); // rows are kept, not deleted
      expect(row!.apply_outcome, name).toBe(outcome);
      expect(row!.applied_at, name).not.toBeNull();
      outcomes.set(event.id, row!);
    }
    for (const event of [deferredOverride, unclassifiedOverride])
      expect(
        await overrideAudit(event.payload.overrideId as string),
      ).toHaveLength(1);
    expect(
      await overrideAudit(invalidOverride.payload.overrideId as string),
    ).toHaveLength(0);
    const [locked] = await pinRows(lockedUser);
    expect(locked!.failed_attempts).toBe(MAX_STAFF_PIN_ATTEMPTS);
    expect(await pinRows(v1User)).toHaveLength(0);

    // Other outlet / tenant: untouched, still parked, no audit row.
    expect((await parkedRow(otherOutletOverride.id))!.applied_at).toBeNull();
    expect(
      (await parkedRow(otherTenantOverride.id, tenant2Id))!.applied_at,
    ).toBeNull();
    expect(
      await overrideAudit(otherOutletOverride.payload.overrideId as string),
    ).toHaveLength(0);
    expect(
      await overrideAudit(
        otherTenantOverride.payload.overrideId as string,
        tenant2Id,
      ),
    ).toHaveLength(0);

    // A second live event: no duplicates, outcomes and timestamps unchanged.
    const secondUser = await newUser();
    await deliver([
      pinSetEvent({
        userId: secondUser,
        material: await pinMaterial(secondUser, "482916", Date.now() - HOUR),
      }),
    ]);
    for (const event of [deferredOverride, unclassifiedOverride])
      expect(
        await overrideAudit(event.payload.overrideId as string),
      ).toHaveLength(1);
    for (const [eventId, before] of outcomes) {
      const after = await parkedRow(eventId);
      expect(after!.apply_outcome).toBe(before.apply_outcome);
      expect(after!.applied_at!.toISOString()).toBe(
        before.applied_at!.toISOString(),
      );
    }
    expect((await parkedRow(otherOutletOverride.id))!.applied_at).toBeNull();
  });

  it("a parked row that cannot be applied does not stop the live event", async () => {
    const where = {
      tenant: tenantId,
      outlet: outletA,
      edgeNodeId: node.scope.edgeNodeId,
    };
    // Parked pin set of a user that does not exist: refused during the replay.
    const ghost = randomUUID();
    const parked = pinSetEvent({
      userId: ghost,
      material: await pinMaterial(ghost, "482916", Date.now() - HOUR),
    });
    await seedParked(parked, "deferred", where);
    const liveUser = await newUser();
    const live = pinSetEvent({
      userId: liveUser,
      material: await pinMaterial(liveUser, "482916", Date.now() - HOUR),
    });
    const link = store();
    const cursorBefore = await link.lastReceivedInbound();

    await deliver([live]);

    expect(await link.lastReceivedInbound()).toBe(cursorBefore + 1);
    expect(await pinRows(liveUser)).toHaveLength(1);
    expect(await pinRows(ghost)).toHaveLength(0);
    expect((await parkedRow(parked.id))!.applied_at).not.toBeNull();
  });
});

// --------------------------------------------------------------- round trip

describe("legend-kyie round trip with the cloud -> edge PIN sync", () => {
  it("an applied PIN is in listStaffPinRecordsSince; applying it on the originating edge keeps its hash and writes no outbox row", async () => {
    const userId = await newUser();
    const material = await pinMaterial(userId, "482916", Date.now() - HOUR);
    await deliver([pinSetEvent({ userId, material })]);

    const page = await listStaffPinRecordsSince(
      {
        tenantId: tenantId as never,
        outletId: outletA as never,
        edgeNodeId: node.scope.edgeNodeId,
      },
      { limit: STAFF_PIN_SYNC_LIMIT_DEFAULT },
    );
    const record = page.data.find((r) => r.userId === userId);
    expect(record).toBeDefined();
    expect(record!.pinHash).toBe(material.pinHash);
    expect(record!.salt).toBe(material.salt);
    expect(record!.pepperVersion).toBe(material.pepperVersion);
    expect(record!.failedAttempts).toBe(0);
    expect(record!.lockedUntil).toBeNull();

    // The edge applies what the cloud sends back: same hash, nothing reverts,
    // and no event is emitted (it would echo to the cloud).
    const [before] = await pinRows(userId);
    const outboxBefore = await outboxTotal();
    const queueBefore = await cloudToEdgeQueue();
    await applyStaffPinRecords(node.context, [record]);
    const [after] = await pinRows(userId);
    expect(after!.pin_hash).toBe(material.pinHash);
    expect(after!.pin_hash).toBe(before!.pin_hash);
    expect(await pinVerifies(userId, "482916", after!)).toBe(true);
    expect(await outboxTotal()).toBe(outboxBefore);
    expect(await cloudToEdgeQueue()).toBe(queueBefore);
  });

  it("an older cloud record cannot revert an applied edge PIN", async () => {
    const userId = await newUser();
    const stale = await pinMaterial(userId, "135790", Date.now() - 5 * HOUR);
    const fresh = await pinMaterial(userId, "482916", Date.now() - HOUR);
    await deliver([pinSetEvent({ userId, material: fresh })]);
    const [applied] = await pinRows(userId);

    await applyStaffPinRecords(node.context, [
      {
        id: applied!.id,
        tenantId,
        outletId: outletA,
        userId,
        algorithm: stale.algorithm,
        salt: stale.salt,
        pinHash: stale.pinHash,
        params: stale.params,
        pepperVersion: stale.pepperVersion,
        failedAttempts: 0,
        lockedUntil: null,
        updatedAt: stale.setAt,
        pinGenerationAt: stale.setAt,
      },
    ]);

    const [after] = await pinRows(userId);
    expect(after!.pin_hash).toBe(fresh.pinHash);
  });
});

// ------------------------------------------------- material is edge -> cloud

describe("legend-kyie PIN material stays edge -> cloud", () => {
  it("never reaches a device queue, the cloud outbox, the parked inbox or a conflict row", async () => {
    const userId = await newUser();
    const ghost = randomUUID();
    const material = await pinMaterial(userId, "482916", Date.now() - HOUR);
    const ghostMaterial = await pinMaterial(ghost, "482916", Date.now() - HOUR);
    const applied = pinSetEvent({ userId, material });
    const refused = pinSetEvent({ userId: ghost, material: ghostMaterial });
    const queueBefore = await cloudToEdgeQueue();

    await deliver([applied, refused]);

    // The cloud worker transport (EDGE_MODE off) must not queue it either.
    const transport = createBuiltinWorkerTransport({
      database: db,
      env: { EDGE_MODE: "false" },
    });
    await withTenant(db, node.context, (tx) =>
      transport.deliverEvent(node.context, applied, "key", tx, {
        destination: "cloud-sync",
        direction: null,
        peerId: null,
      }),
    ).catch(() => undefined);

    expect(await cloudToEdgeQueue()).toBe(queueBefore);
    for (const secret of [
      material.pinHash,
      material.salt,
      ghostMaterial.pinHash,
      ghostMaterial.salt,
    ])
      for (const table of [
        "edge_outbound_queue",
        "domain_event_outbox",
        "edge_deferred_events",
        "edge_sync_conflicts",
      ]) {
        expect(
          await count(
            `SELECT count(*)::int AS n FROM ${table} t WHERE tenant_id = $1 AND to_jsonb(t)::text LIKE $2`,
            [tenantId, `%${secret}%`],
          ),
          table,
        ).toBe(0);
      }
  });

  it("registering the access applier twice keeps one dispatcher", () => {
    registerAccessEdgeApplier();
    const dispatcher = edgeEventApplier("edge_to_cloud");
    registerAccessEdgeApplier();
    expect(edgeEventApplier("edge_to_cloud")).toBe(dispatcher);
  });
});

// ------------------------------------------------- review K fixes (round 1)

const gapConflictsOf = (eventId: string) =>
  count(
    "SELECT count(*)::int AS n FROM edge_sync_conflicts WHERE tenant_id = $1 AND event_id = $2::uuid AND reason = 'sequence_gap'",
    [tenantId, ulidToUuid(eventId)],
  );

describe("legend-kyie review K round 1", () => {
  it("F1 a refused staff_pin.set does not turn the next set of the same PIN into a sequence gap", async () => {
    // A user without any role in the tenant: the first set is refused.
    const userId = randomUUID();
    await owner.query(
      `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, 'Staf Baru', $2, true)`,
      [userId, `akses-${randomBytes(4).toString("hex")}@example.test`],
    );
    createdUsers.push(userId);
    const staffPinId = randomUUID();
    const refused = pinSetEvent({
      userId,
      staffPinId,
      material: await pinMaterial(userId, "135790", Date.now() - 2 * HOUR),
    });
    await deliver([refused]);
    expect(await conflictsOf(refused.id)).toBe(1);
    expect(await pinRows(userId)).toHaveLength(0);

    // The staff member joins the outlet; the edge's next set (sequence 2).
    await owner.query(
      `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 minute', $2)`,
      [tenantId, userId, staffRoleId, outletA],
    );
    const material = await pinMaterial(userId, "482916", Date.now() - HOUR);
    const next = {
      ...pinSetEvent({ userId, staffPinId, material }),
      sequence: 2,
    };
    await deliver([next]);

    expect(await gapConflictsOf(next.id)).toBe(0);
    expect(await conflictsOf(next.id)).toBe(0);
    const [row] = await pinRows(userId);
    expect(row!.pin_hash).toBe(material.pinHash);
  });

  it("F1 a node that has received nothing of an aggregate applies its sequence 5 (standby takeover)", async () => {
    const userId = await newUser();
    const material = await pinMaterial(userId, "482916", Date.now() - HOUR);
    const event = { ...pinSetEvent({ userId, material }), sequence: 5 };
    await deliver([event]);

    expect(await gapConflictsOf(event.id)).toBe(0);
    const [row] = await pinRows(userId);
    expect(row!.pin_hash).toBe(material.pinHash);
  });

  it("F2 a newer cloud record of the same PIN never clears the edge's lock or counter", async () => {
    const userId = await newUser();
    const lockedUntilMs = Date.now() + 10 * MINUTE;
    // This database plays the edge: a locked row of the current generation.
    const { id, material } = await seedPin(userId, "482916", {
      setAtMs: Date.now() - 2 * HOUR,
      updatedAtMs: Date.now() - HOUR,
      failedAttempts: MAX_STAFF_PIN_ATTEMPTS,
      lockedUntilMs,
    });

    // The cloud adopted that PIN and sends it back with a cleared counter.
    await applyStaffPinRecords(node.context, [
      {
        id,
        tenantId,
        outletId: outletA,
        userId,
        algorithm: material.algorithm,
        salt: material.salt,
        pinHash: material.pinHash,
        params: material.params,
        pepperVersion: material.pepperVersion,
        failedAttempts: 0,
        lockedUntil: null,
        updatedAt: new Date(Date.now() - MINUTE).toISOString(),
        pinGenerationAt: material.setAt,
      },
    ]);

    const [row] = await pinRows(userId);
    expect(row!.failed_attempts).toBe(MAX_STAFF_PIN_ATTEMPTS);
    expect(row!.locked_until?.getTime()).toBe(lockedUntilMs);
  });
});

describe("legend-kyie Codex 160 round 2", () => {
  it("C1 an edge clock 5 s ahead: sets A then B in one batch leave B's hash on the cloud", async () => {
    const userId = await newUser();
    const staffPinId = randomUUID();
    const aheadMs = Date.now() + 5_000;
    const a = await pinMaterial(userId, "482916", aheadMs);
    const b = await pinMaterial(userId, "246801", aheadMs + 1_000);
    const setA = pinSetEvent({ userId, material: a, staffPinId });
    const setB = {
      ...pinSetEvent({ userId, material: b, staffPinId }),
      sequence: 2,
    };

    await deliver([setA, setB]);

    const [row] = await pinRows(userId);
    expect(row!.pin_hash).toBe(b.pinHash);
    expect(await pinVerifies(userId, "246801", row!)).toBe(true);
    // The clamped time stays on pin_set_at; the raw edge time orders.
    expect(row!.set_in_past).toBe(true);
    const { rows } = await owner.query<{ generation: Date }>(
      "SELECT pin_generation_at AS generation FROM staff_pins WHERE tenant_id = $1 AND user_id = $2",
      [tenantId, userId],
    );
    expect(rows[0]!.generation.toISOString()).toBe(b.setAt);
    for (const event of [setA, setB])
      expect(await conflictsOf(event.id)).toBe(0);
  });

  it("C1 two future-dated sets in separate batches: the latest wins, an older one never comes back", async () => {
    const userId = await newUser();
    const first = await pinMaterial(userId, "482916", Date.now() + 2 * MINUTE);
    const second = await pinMaterial(userId, "246801", Date.now() + 3 * MINUTE);
    // One edge pin row is one aggregate stream: its sets carry rising
    // sequences (appendDevicePinEvent). The cloud refuses a set of the node
    // that gave the generation at a lower or equal sequence (review K R2), so
    // separate streams at sequence 1 would no longer model a real edge.
    const staffPinId = randomUUID();

    await deliver([pinSetEvent({ userId, material: first, staffPinId })]);
    await deliver([
      { ...pinSetEvent({ userId, material: second, staffPinId }), sequence: 2 },
    ]);
    const [row] = await pinRows(userId);
    expect(row!.pin_hash).toBe(second.pinHash);

    // A redelivered copy of the first set (new event id) does not revert it.
    await deliver([pinSetEvent({ userId, material: first, staffPinId })]);
    const [after] = await pinRows(userId);
    expect(after!.pin_hash).toBe(second.pinHash);
  });

  it("C2 a failed edge queue write of a staff_pin.set with material never quotes the hash or salt", async () => {
    const userId = await newUser();
    const material = await pinMaterial(userId, "482916", Date.now() - MINUTE);
    const event = pinSetEvent({ userId, material });
    const fn = `kyie_c2_guard_${randomBytes(4).toString("hex")}`;
    // The trigger quotes the whole row (event included) in its error, the
    // worst case for a driver error's message.
    await owner.query(
      `CREATE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.tenant_id = '${tenantId}'::uuid THEN
           RAISE EXCEPTION 'c2 sentinel %', NEW.event::text;
         END IF;
         RETURN NEW;
       END $$`,
    );
    await owner.query(
      `CREATE TRIGGER ${fn} BEFORE INSERT ON edge_outbound_queue FOR EACH ROW EXECUTE FUNCTION public.${fn}()`,
    );
    let thrown: unknown;
    try {
      await withTenant(db, node.context, (tx) =>
        enqueueEdgeEvent(tx, node.context, {
          edgeNodeId: node.scope.edgeNodeId,
          direction: "edge_to_cloud",
          kind: "transaction_event",
          event,
        }),
      );
    } catch (error) {
      thrown = error;
    } finally {
      await owner.query(`DROP TRIGGER ${fn} ON edge_outbound_queue`);
      await owner.query(`DROP FUNCTION public.${fn}()`);
    }

    expect(thrown).toBeInstanceOf(Error);
    const error = thrown as Error;
    expect(error.message).toBe("Edge queue write failed");
    expect(error.cause).toBeUndefined();
    const exposed = [
      error.message,
      String(error.stack),
      JSON.stringify(error),
      JSON.stringify(
        Object.getOwnPropertyNames(error).map((key) => [
          key,
          (error as unknown as Record<string, unknown>)[key],
        ]),
      ),
    ].join("\n");
    for (const secret of [material.pinHash, material.salt, "c2 sentinel"])
      expect(exposed).not.toContain(secret);
  });
});

describe("legend-kyie review K round 3", () => {
  it("R1 a set stamped 1 h ahead is refused as a conflict; a later normal set is applied", async () => {
    const userId = await newUser();
    const staffPinId = randomUUID();
    const ahead = await pinMaterial(userId, "482916", Date.now() + HOUR);
    const normal = await pinMaterial(userId, "246801", Date.now() - MINUTE);
    const refused = pinSetEvent({ userId, material: ahead, staffPinId });
    const next = {
      ...pinSetEvent({ userId, material: normal, staffPinId }),
      sequence: 2,
    };

    await deliver([refused]);
    expect(await conflictsOf(refused.id)).toBe(1);
    expect(await pinRows(userId)).toHaveLength(0);

    await deliver([next]);
    expect(await conflictsOf(next.id)).toBe(0);
    const [row] = await pinRows(userId);
    expect(row!.pin_hash).toBe(normal.pinHash);
  });

  it("R1 a lock between the clamped pin_set_at and the generation (edge clock +5 s) is ignored", async () => {
    const userId = await newUser();
    const material = await pinMaterial(userId, "482916", Date.now() + 5_000);
    await deliver([pinSetEvent({ userId, material })]);
    const lock = pinLockedEvent({
      userId,
      lockedUntilMs: Date.now() + 10 * MINUTE,
      occurredAtMs: Date.now() + 2_000,
    });

    await deliver([lock]);

    const [row] = await pinRows(userId);
    expect(row!.pin_hash).toBe(material.pinHash);
    expect(row!.failed_attempts).toBe(0);
    expect(row!.locked_until).toBeNull();
    expect(await conflictsOf(lock.id)).toBe(0);
  });

  it("R1 a lock that occurred more than 5 min ahead of the cloud clock is not applicable", async () => {
    const userId = await newUser();
    await seedPin(userId, "135790", { setAtMs: Date.now() - HOUR });
    const lock = pinLockedEvent({
      userId,
      lockedUntilMs: Date.now() + 15 * MINUTE,
      occurredAtMs: Date.now() + 10 * MINUTE,
    });

    expect(
      await withTenant(db, node.context, (tx) =>
        applyStaffPinLocked(tx, lock, meta()),
      ),
    ).toBe("not_applicable");
    await deliver([lock]);
    expect(await conflictsOf(lock.id)).toBe(0);
    const [row] = await pinRows(userId);
    expect(row!.failed_attempts).toBe(0);
    expect(row!.locked_until).toBeNull();
  });
});

describe("legend-kyie review K round 3 re-review", () => {
  it("R2 an edge key left 1 h ahead recovers once the edge clock is fixed: the next edge set is applied on the cloud", async () => {
    const userId = await newUser();
    // This database plays the edge: its row carries a key from a clock that
    // ran 1 h ahead (the cloud refused that set).
    const { id } = await seedPin(userId, "135790", {
      setAtMs: Date.now() - HOUR,
    });
    await owner.query(
      "UPDATE staff_pins SET pin_generation_at = now() + interval '1 hour' WHERE id = $1",
      [id],
    );

    const previous = process.env.EDGE_MODE;
    process.env.EDGE_MODE = "true";
    try {
      await setStaffPin(
        establishTenantContext({ tenantId, brandId: null, source: "session" }),
        userId,
        { outletId: outletA, userId },
        { pin: "482916" },
      );
    } finally {
      if (previous === undefined) delete process.env.EDGE_MODE;
      else process.env.EDGE_MODE = previous;
    }
    const { rows } = await owner.query<{ event: EventEnvelope }>(
      `SELECT event FROM domain_event_outbox
        WHERE tenant_id = $1 AND aggregate_type = 'staff_pin' AND event->>'name' = 'staff_pin.set'
          AND event->'payload'->>'userId' = $2
        ORDER BY sequence DESC, id DESC LIMIT 1`,
      [tenantId, userId],
    );
    const event = rows[0]!.event;
    const material = (event.payload as { material: Material }).material;
    // Compared on the database clock (the one the edge stamps with).
    const { rows: bound } = await owner.query<{ ok: boolean }>(
      "SELECT $1::timestamptz <= now() + interval '5 minutes 1 millisecond' AS ok",
      [material.setAt],
    );
    expect(bound[0]!.ok).toBe(true);

    // The cloud still has the older pin of this staff member.
    await owner.query(
      "UPDATE staff_pins SET pin_hash = $2, pin_generation_at = now() - interval '1 hour' WHERE id = $1",
      [id, "0".repeat(64)],
    );
    await deliver([event]);

    expect(await conflictsOf(event.id)).toBe(0);
    const [row] = await pinRows(userId);
    expect(row!.pin_hash).toBe(material.pinHash);
    expect(await pinVerifies(userId, "482916", row!)).toBe(true);
  });
});

// ----------------------------------------------------- sweep of parked rows

// legend-0q3r: rows parked before the applier existed were only replayed when a
// live access event of the same outlet arrived. A worker sweep replays them for
// outlets that never send another one. All sweeps below pass `force: true` so
// the per-tenant throttle never makes a test depend on timing.
describe("legend-0q3r sweep of parked access rows", () => {
  const tenantWide = (tid: string): ScopedTenantContext =>
    establishScopedTenantContext(
      establishTenantContext({
        tenantId: tid,
        brandId: null,
        source: "session",
      }),
      { kind: "tenant" },
    );
  const sweep = (
    options: {
      batchLimit?: number;
      maxBatches?: number;
      outletLimit?: number;
    } = {},
    tid = tenantId,
  ) => sweepParkedAccessEvents(tenantWide(tid), { ...options, force: true });

  const whereA = () => ({
    tenant: tenantId,
    outlet: outletA,
    edgeNodeId: node.scope.edgeNodeId,
  });
  const whereB = () => ({
    tenant: tenantId,
    outlet: outletB,
    edgeNodeId: nodeB.scope.edgeNodeId,
  });
  const appliedCount = async (events: EventEnvelope[]) => {
    let applied = 0;
    for (const event of events)
      if ((await parkedRow(event.id))!.applied_at !== null) applied += 1;
    return applied;
  };

  beforeEach(async () => {
    resetAccessDrainSweepThrottle();
    // Assumption: earlier tests may leave pending access rows (for example the
    // other-outlet rows of the replay test). Retire them with the owner so each
    // test here counts only its own rows; they are not part of what is asserted.
    await owner.query(
      `UPDATE edge_deferred_events
          SET applied_at = now(), apply_outcome = 'not_applicable'
        WHERE tenant_id = ANY($1::uuid[]) AND applied_at IS NULL`,
      [[tenantId, tenant2Id]],
    );
  });

  it("applies a parked override and lock of an outlet that never sends a live event, once", async () => {
    const requester = await newUser();
    const approver = await newUser();
    const lockedUser = await newUser();
    await seedPin(lockedUser, "135790", { setAtMs: Date.now() - HOUR });
    const override = overrideEvent({
      requestedBy: requester,
      approvedBy: approver,
    });
    const lock = pinLockedEvent({
      userId: lockedUser,
      lockedUntilMs: Date.now() + 10 * MINUTE,
      occurredAtMs: Date.now() - MINUTE,
    });
    await seedParked(override, "deferred", whereA());
    await seedParked(lock, "deferred", whereA());

    // No live event arrives: the rows stay parked and nothing is applied.
    expect((await parkedRow(override.id))!.applied_at).toBeNull();
    expect((await parkedRow(lock.id))!.applied_at).toBeNull();
    expect(
      await overrideAudit(override.payload.overrideId as string),
    ).toHaveLength(0);

    const result = await sweep();

    expect(result).not.toBeNull();
    expect(result!.failedOutlets).toBe(0);
    const appliedOverride = await parkedRow(override.id);
    expect(appliedOverride!.apply_outcome).toBe("applied");
    expect(appliedOverride!.applied_at).not.toBeNull();
    expect((await parkedRow(lock.id))!.apply_outcome).toBe("applied");
    const audit = await overrideAudit(override.payload.overrideId as string);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.outlet_id).toBe(outletA);
    const [locked] = await pinRows(lockedUser);
    expect(locked!.failed_attempts).toBe(MAX_STAFF_PIN_ATTEMPTS);

    // A second sweep changes nothing: same timestamp, still one audit row.
    await sweep();
    const again = await parkedRow(override.id);
    expect(again!.apply_outcome).toBe("applied");
    expect(again!.applied_at!.toISOString()).toBe(
      appliedOverride!.applied_at!.toISOString(),
    );
    expect(
      await overrideAudit(override.payload.overrideId as string),
    ).toHaveLength(1);
  });

  it("drains no more than batchLimit x maxBatches rows per call and finishes the rest over further sweeps", async () => {
    const requester = await newUser();
    const approver = await newUser();
    const events: EventEnvelope[] = [];
    for (let i = 0; i < 5; i += 1) {
      const event = overrideEvent({
        requestedBy: requester,
        approvedBy: approver,
      });
      await seedParked(event, "deferred", whereA());
      events.push(event);
    }

    const first = await sweep({ batchLimit: 2, maxBatches: 1 });
    expect(first!.drained).toBeLessThanOrEqual(2);
    expect(await appliedCount(events)).toBe(2);

    await sweep({ batchLimit: 2, maxBatches: 1 });
    expect(await appliedCount(events)).toBe(4);

    await sweep({ batchLimit: 2, maxBatches: 1 });
    expect(await appliedCount(events)).toBe(5);

    for (const event of events)
      expect(
        await overrideAudit(event.payload.overrideId as string),
      ).toHaveLength(1);
  });

  it("applies every row exactly once when sweeps and lazy drains run in parallel", async () => {
    const requester = await newUser();
    const approver = await newUser();
    const events: EventEnvelope[] = [];
    for (let i = 0; i < 12; i += 1) {
      const event = overrideEvent({
        requestedBy: requester,
        approvedBy: approver,
      });
      await seedParked(event, "deferred", whereA());
      events.push(event);
    }

    await Promise.all([
      sweep(),
      sweep(),
      sweep(),
      withTenant(db, node.context, (tx) =>
        drainParkedAccessEvents(tx, meta(), outletIdSchema.parse(outletA)),
      ),
      withTenant(db, node.context, (tx) =>
        drainParkedAccessEvents(tx, meta(), outletIdSchema.parse(outletA)),
      ),
      withTenant(db, node.context, (tx) =>
        drainParkedAccessEvents(tx, meta(), outletIdSchema.parse(outletA)),
      ),
    ]);

    expect(await appliedCount(events)).toBe(12);
    for (const event of events) {
      expect((await parkedRow(event.id))!.apply_outcome).toBe("applied");
      expect(
        await overrideAudit(event.payload.overrideId as string),
      ).toHaveLength(1);
    }
  });

  it("stays inside the tenant and the outlet, and a refused row does not block the others", async () => {
    const requester = await newUser();
    const approver = await newUser();
    // Refused (requester == approver) is seeded first so it is the oldest row.
    const refused = overrideEvent({
      requestedBy: approver,
      approvedBy: approver,
    });
    const goodA = overrideEvent({
      requestedBy: requester,
      approvedBy: approver,
    });
    const goodB = overrideEvent({
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
    await seedParked(refused, "deferred", whereA());
    await seedParked(goodA, "deferred", whereA());
    await seedParked(goodB, "deferred", whereB());
    await seedParked(otherTenant, "deferred", {
      tenant: tenant2Id,
      outlet: outlet2,
      edgeNodeId: node2.scope.edgeNodeId,
    });

    const result = await sweep();

    expect(result).not.toBeNull();
    expect(result!.failedOutlets).toBe(0);
    // The refused row is marked refused, writes no audit row, and the good
    // row of the same outlet is still applied.
    const refusedRow = await parkedRow(refused.id);
    expect(refusedRow!.apply_outcome).toBe("refused");
    expect(refusedRow!.applied_at).not.toBeNull();
    expect(
      await overrideAudit(refused.payload.overrideId as string),
    ).toHaveLength(0);
    expect((await parkedRow(goodA.id))!.apply_outcome).toBe("applied");
    const auditA = await overrideAudit(goodA.payload.overrideId as string);
    expect(auditA).toHaveLength(1);
    expect(auditA[0]!.outlet_id).toBe(outletA);

    // The row of the other outlet is applied to its own outlet only.
    expect((await parkedRow(goodB.id))!.apply_outcome).toBe("applied");
    const auditB = await overrideAudit(goodB.payload.overrideId as string);
    expect(auditB).toHaveLength(1);
    expect(auditB[0]!.outlet_id).toBe(outletB);

    // The sweep of tenant 1 never touches tenant 2.
    expect((await parkedRow(otherTenant.id, tenant2Id))!.applied_at).toBeNull();
    expect(
      await overrideAudit(otherTenant.payload.overrideId as string, tenant2Id),
    ).toHaveLength(0);
  });
});

describe("legend-lhffb staff_pin.locked of the node that gave the generation", () => {
  /** A lock of the pin's aggregate stream at a chosen sequence. */
  function streamLock(input: {
    userId: string;
    staffPinId: string;
    sequence: number;
    occurredAtMs: number;
    lockedUntilMs: number;
  }): EventEnvelope {
    return {
      ...envelope({
        name: "staff_pin.locked",
        aggregateType: "staff_pin",
        aggregateId: input.staffPinId,
        occurredAtMs: input.occurredAtMs,
        payload: {
          staffPinId: input.staffPinId,
          userId: input.userId,
          lockedUntil: new Date(input.lockedUntilMs).toISOString(),
        },
      }),
      sequence: input.sequence,
    };
  }

  const applyLock = (event: EventEnvelope, m: EdgeApplyMeta = meta()) =>
    withTenant(db, m.context, (tx) => applyStaffPinLocked(tx, event, m));
  const applySet = (event: EventEnvelope) =>
    withTenant(db, node.context, (tx) => applyStaffPinSet(tx, event, meta()));

  /** Set seq 1, then a reset seq 4 whose key is older (edge clock stepped back). */
  async function setThenReset(userId: string) {
    const staffPinId = randomUUID();
    const first = await pinMaterial(userId, "482916", Date.now() - HOUR);
    const reset = await pinMaterial(userId, "246801", Date.now() - 2 * HOUR);
    expect(
      await applySet(pinSetEvent({ userId, material: first, staffPinId })),
    ).toBe("applied");
    expect(
      await applySet({
        ...pinSetEvent({ userId, material: reset, staffPinId }),
        sequence: 4,
      }),
    ).toBe("applied");
    return staffPinId;
  }

  it("a backlog lock with a lower sequence than the reset is not applicable, although its timestamp is newer than the generation key", async () => {
    const userId = await newUser();
    const staffPinId = await setThenReset(userId);
    const [before] = await pinRows(userId);

    const lock = streamLock({
      userId,
      staffPinId,
      sequence: 2,
      occurredAtMs: Date.now() - 10 * MINUTE,
      lockedUntilMs: Date.now() + 10 * MINUTE,
    });

    expect(await applyLock(lock)).toBe("not_applicable");
    const [after] = await pinRows(userId);
    expect(after!.failed_attempts).toBe(before!.failed_attempts);
    expect(after!.locked_until).toBeNull();
  });

  it("a lock of the same node with a higher sequence still applies", async () => {
    const userId = await newUser();
    const staffPinId = await setThenReset(userId);

    const lockedUntilMs = Date.now() + 10 * MINUTE;
    expect(
      await applyLock(
        streamLock({
          userId,
          staffPinId,
          sequence: 5,
          occurredAtMs: Date.now() - 10 * MINUTE,
          lockedUntilMs,
        }),
      ),
    ).toBe("applied");
    const [row] = await pinRows(userId);
    expect(row!.failed_attempts).toBe(MAX_STAFF_PIN_ATTEMPTS);
    expect(row!.locked_until!.getTime()).toBe(lockedUntilMs);
  });

  it("a lock of another node with a newer timestamp still applies", async () => {
    const userId = await newUser();
    const staffPinId = await setThenReset(userId);
    // A standby of the same outlet: another node, same outlet scope.
    const registered = await registerEdgeNode(
      scopeFor(tenantId, [outletA]),
      actor,
      { outletId: outletA, role: "standby", label: "Siaga Akses A lock" },
    );
    const other = await authenticateEdgeCredential(registered.credential);
    if (!other) throw new Error("Edge node did not authenticate");

    const lockedUntilMs = Date.now() + 10 * MINUTE;
    expect(
      await applyLock(
        streamLock({
          userId,
          staffPinId,
          sequence: 2,
          occurredAtMs: Date.now() - 10 * MINUTE,
          lockedUntilMs,
        }),
        meta(other.context, other.scope.edgeNodeId),
      ),
    ).toBe("applied");
    const [row] = await pinRows(userId);
    expect(row!.failed_attempts).toBe(MAX_STAFF_PIN_ATTEMPTS);
  });
});
