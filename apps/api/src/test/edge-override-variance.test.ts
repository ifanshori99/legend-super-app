// legend-7iti: the blind-count figures of a `cash_shift_close` override reach
// the cloud audit row when the override was approved on an edge node, and the
// two audit shapes (cloud-made, edge-made) match. Also the cloud guard for the
// edge PIN re-send job (legend-zclb): a `staff_pin.set` carrying the material
// the cloud row already holds must not reset the cloud lock or attempts.
// Real services on the disposable PostgreSQL (RLS on).
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import {
  createPosOverrideSchema,
  posOverrideRecordedEvent,
  STAFF_PIN_HASH_ALGORITHM,
} from "@starter/shared/access/override";
import {
  createUlid,
  outletIdSchema,
  ulidToUuid,
  type ScopedTenantContext,
  type TenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { EventEnvelope } from "@starter/shared/events";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  applyPosOverrideRecorded,
  applyStaffPinSet,
} from "../edge/access-applier.ts";
import type { EdgeApplyMeta } from "../edge/ports.ts";
import { setAuditWriter, type AuditEntry } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { hashStaffPin } from "../services/device-pin-hash.ts";
import {
  currentStaffPinPepperVersion,
  staffPinPepper,
} from "../services/device-pin-pepper.ts";
import { setStaffPin } from "../services/device-pin.service.ts";
import {
  authenticateEdgeCredential,
  registerEdgeNode,
  type AuthenticatedEdgeNode,
} from "../services/edge-node.service.ts";
import { createPosOverride } from "../services/staff-override.service.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

const MINUTE = 60_000;

// ---------------------------------------------------------------------------
// Emitter: the real override service on the seeded cafe tenant.
// ---------------------------------------------------------------------------

const cafeTenantId = cafeLegendPlatformFixtures.tenant.id;
const bandung = cafeLegendAccessFixtures.outletIds.bandung;
const cafeTenant: TenantContext = establishTenantContext({
  tenantId: cafeTenantId,
  brandId: null,
  source: "session",
});
const PIN = "582914";
const audits: AuditEntry[] = [];
const cafeUsers: string[] = [];
// A shift is history (POS-03, no delete): its cashiers stay behind.
const shiftUsers: string[] = [];

async function cafeUser(templateKey: string, bucket = cafeUsers) {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)`,
    [id, `Staf ${templateKey}`, `${id}@example.test`],
  );
  bucket.push(id);
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [cafeTenantId, templateKey],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
    [cafeTenantId, id, rows[0]!.id, bandung],
  );
  return id;
}

/** Open shift with one blind count: counted 70_000 vs expected 100_000. */
async function cashierWithBlindCount() {
  const cashier = await cafeUser("cashier", shiftUsers);
  const shiftId = randomUUID();
  await owner.query(
    `INSERT INTO pos_shifts
       (id, tenant_id, outlet_id, device_id, cashier_id, business_date, status,
        opened_at, opening_float_idr, open_key, open_fingerprint)
     VALUES ($1, $2, $3, $4, $5, current_date, 'open', now(), 100000, $6, $7)`,
    [
      shiftId,
      cafeTenantId,
      bandung,
      randomUUID(),
      cashier,
      randomUUID(),
      "a".repeat(64),
    ],
  );
  const countId = randomUUID();
  await owner.query(
    `INSERT INTO pos_shift_counts
       (id, tenant_id, outlet_id, shift_id, sequence, counts, counts_fingerprint,
        counted_idr, expected_idr, variance_idr, submitted_by, submitted_at,
        idempotency_key, request_fingerprint)
     VALUES ($1, $2, $3, $4, 1, '[]'::jsonb, $5, 70000, 100000, -30000, $6, now(), $7, $5)`,
    [
      countId,
      cafeTenantId,
      bandung,
      shiftId,
      "b".repeat(64),
      cashier,
      randomUUID(),
    ],
  );
  return { cashier, countId };
}

/** Approves a shift close by supervisor PIN; returns the new override id. */
async function approvedShiftClose(edge: boolean): Promise<string> {
  const { cashier, countId } = await cashierWithBlindCount();
  const supervisor = await cafeUser("supervisor");
  await setStaffPin(
    cafeTenant,
    supervisor,
    { outletId: bandung, userId: supervisor },
    { pin: PIN },
  );
  const previous = process.env.EDGE_MODE;
  if (edge) process.env.EDGE_MODE = "true";
  try {
    const { override } = await createPosOverride(
      cafeTenant,
      cashier,
      createPosOverrideSchema.parse({
        outletId: bandung,
        action: "cash_shift_close",
        valueIdr: 0,
        reason: "Hitung kas akhir shift",
        objectType: "pos_shift_count",
        objectId: countId,
        approval: {
          method: "supervisor_pin",
          approverUserId: supervisor,
          pin: PIN,
        },
      }),
      { idempotencyKey: null },
    );
    return override.id;
  } finally {
    if (previous === undefined) delete process.env.EDGE_MODE;
    else process.env.EDGE_MODE = previous;
  }
}

async function recordedPayload(overrideId: string) {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
     WHERE tenant_id = $1 AND aggregate_type = 'pos_override' AND aggregate_id = $2
       AND event->>'name' = 'pos_override.recorded'`,
    [cafeTenantId, ulidToUuid(overrideId)],
  );
  expect(rows).toHaveLength(1);
  return posOverrideRecordedEvent.envelopeSchema.parse(rows[0]!.event).payload;
}

const auditOf = (overrideId: string) =>
  audits.find(
    (row) =>
      row.action === "pos_override.recorded" && row.objectId === overrideId,
  );

// ---------------------------------------------------------------------------
// Cloud apply + PIN guard: an own tenant with one registered edge node.
// ---------------------------------------------------------------------------

const actor = randomUUID();
const tenantId = randomUUID();
const outletA = randomUUID();
const staffRoleId = randomUUID();
const createdUsers: string[] = [];
let node: AuthenticatedEdgeNode;

async function createTenantFixture() {
  const brand = randomUUID();
  const entity = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Tenant Varians Edge', plan, 'active', deployment_mode, feature_flags, limits, $3
       FROM tenants WHERE id = $4`,
    [
      tenantId,
      `varians-edge-${randomBytes(4).toString("hex")}`,
      actor,
      cafeTenantId,
    ],
  );
  await owner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand')`,
    [brand, tenantId, `varians-${randomBytes(3).toString("hex")}`],
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
      `VAR-${randomBytes(3).toString("hex").toUpperCase()}`,
    ],
  );
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     SELECT $1, $2, name, is_template, template_key, permissions, mfa_required, allowed_scope_types
       FROM roles WHERE tenant_id = $3 AND template_key = 'cashier'`,
    [staffRoleId, tenantId, cafeTenantId],
  );
}

async function newUser(): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, 'Staf Varians', $2, true)`,
    [id, `varians-${randomBytes(4).toString("hex")}@example.test`],
  );
  createdUsers.push(id);
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 minute', $2)`,
    [tenantId, id, staffRoleId, outletA],
  );
  return id;
}

const scope: ScopedTenantContext = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "session" }),
  { kind: "outlets", outletIds: [outletIdSchema.parse(outletA)] },
);

const meta = (): EdgeApplyMeta => ({
  edgeNodeId: node.scope.edgeNodeId,
  direction: "edge_to_cloud",
  kind: "transaction_event",
  context: node.context,
});

function envelope(
  name: string,
  aggregateType: string,
  aggregateId: string,
  actorId: string,
  payload: Record<string, unknown>,
): EventEnvelope {
  return {
    id: createUlid(Date.now()),
    tenantId: tenantId as EventEnvelope["tenantId"],
    outletId: outletA as EventEnvelope["outletId"],
    name,
    version: 1,
    aggregateType,
    aggregateId,
    sequence: 1,
    occurredAt: new Date().toISOString(),
    actor: { type: "user", id: actorId } as EventEnvelope["actor"],
    deviceId: null,
    idempotencyKey: `${name}:${aggregateId}:${randomBytes(4).toString("hex")}`,
    payloadSchemaRef: `${name}.v1`,
    payload: payload as EventEnvelope["payload"],
  };
}

function shiftCloseEvent(
  requestedBy: string,
  approvedBy: string,
  withVariance: boolean,
): EventEnvelope {
  const overrideId = createUlid(Date.now());
  return envelope(
    "pos_override.recorded",
    "pos_override",
    overrideId,
    approvedBy,
    {
      overrideId,
      action: "cash_shift_close",
      method: "supervisor_pin",
      requestedBy,
      approvedBy,
      // Blind count: the edge never sends the value itself.
      valueIdr: null,
      objectType: "pos_shift_count",
      objectId: randomUUID(),
      approvalRequestId: null,
      reason: "Hitung kas akhir shift",
      ...(withVariance
        ? {
            shiftCloseVariance: {
              expectedIdr: 100_000,
              countedIdr: 70_000,
              varianceIdr: -30_000,
            },
          }
        : {}),
    },
  );
}

async function cloudAuditAfter(overrideId: string) {
  const { rows } = await owner.query<{
    event: { maskedChanges: { after: Record<string, unknown> } };
  }>(
    `SELECT event FROM audit_logs
      WHERE tenant_id = $1 AND event->>'action' = 'pos_override.recorded'
        AND lower(event->>'objectId') IN ($2, $3)`,
    [tenantId, overrideId.toLowerCase(), ulidToUuid(overrideId).toLowerCase()],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!.event.maskedChanges.after;
}

async function pinMaterial(userId: string, pin: string, setAtMs: number) {
  const hashed = await hashStaffPin({
    pepper: staffPinPepper(tenantId, outletA),
    binding: { tenantId, outletId: outletA, userId },
    pin,
  });
  return {
    algorithm: STAFF_PIN_HASH_ALGORITHM,
    salt: hashed.salt,
    pinHash: hashed.pinHash,
    params: hashed.params,
    pepperVersion: currentStaffPinPepperVersion(),
    setAt: new Date(setAtMs).toISOString(),
  };
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter({
    record: async (entry, scope) => {
      audits.push(entry);
      await coreAuditWriter.record(entry, scope);
    },
  });
  await createTenantFixture();
  const registered = await registerEdgeNode(scope, actor, {
    outletId: outletA,
    role: "primary",
    label: "Utama Varians",
  });
  const authenticated = await authenticateEdgeCredential(registered.credential);
  if (!authenticated) throw new Error("Edge node did not authenticate");
  node = authenticated;
});

afterEach(() => {
  audits.length = 0;
});

afterAll(async () => {
  setAuditWriter(null);
  await owner.query(
    `DELETE FROM pos_overrides WHERE tenant_id = $1 AND requested_by = ANY($2::text[])`,
    [cafeTenantId, [...cafeUsers, ...shiftUsers]],
  );
  await owner.query(
    `DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])`,
    [cafeTenantId, [...cafeUsers, ...shiftUsers]],
  );
  // staff_pins reference the user: delete the pins first (FK 23503 otherwise).
  await owner.query(`DELETE FROM staff_pins WHERE user_id = ANY($1::text[])`, [
    cafeUsers,
  ]);
  await owner.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [
    cafeUsers,
  ]);
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const table of [
      "edge_sync_conflicts",
      "edge_nodes",
      "audit_logs",
      "staff_pins",
      "role_assignments",
      "roles",
      "outlets",
      "legal_entities",
      "brands",
    ])
      await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [
        tenantId,
      ]);
    await client.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
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

describe("legend-7iti edge override audit carries the blind-count variance", () => {
  it("an edge shift close event carries shiftCloseVariance, valueIdr stays null; the cloud audit has the same shape", async () => {
    const overrideId = await approvedShiftClose(true);
    const payload = await recordedPayload(overrideId);
    expect(payload.valueIdr).toBeNull();
    expect(payload.shiftCloseVariance).toEqual({
      expectedIdr: 100_000,
      countedIdr: 70_000,
      varianceIdr: -30_000,
    });
    // The edge's own audit already has one shape with the cloud-made one.
    expect(auditOf(overrideId)?.after).toMatchObject({
      action: "cash_shift_close",
      valueIdr: 30_000,
      expectedIdr: 100_000,
      countedIdr: 70_000,
      varianceIdr: -30_000,
    });
  });

  it("the cloud's own shift close keeps the variance out of its event but in its audit", async () => {
    const overrideId = await approvedShiftClose(false);
    expect((await recordedPayload(overrideId)).shiftCloseVariance).toBe(
      undefined,
    );
    expect(auditOf(overrideId)?.after).toMatchObject({
      valueIdr: 30_000,
      expectedIdr: 100_000,
      countedIdr: 70_000,
      varianceIdr: -30_000,
    });
  });

  it("the cloud audit row of an edge shift close has expected, counted, variance and valueIdr = |variance|", async () => {
    const event = shiftCloseEvent(await newUser(), await newUser(), true);
    const overrideId = event.payload.overrideId as string;

    const outcome = await withTenant(db, node.context, (tx) =>
      applyPosOverrideRecorded(tx, event, meta()),
    );

    expect(outcome).toBe("applied");
    expect(await cloudAuditAfter(overrideId)).toMatchObject({
      action: "cash_shift_close",
      valueIdr: 30_000,
      expectedIdr: 100_000,
      countedIdr: 70_000,
      varianceIdr: -30_000,
    });
  });

  it("an old event without shiftCloseVariance still writes valueIdr null", async () => {
    const event = shiftCloseEvent(await newUser(), await newUser(), false);
    const overrideId = event.payload.overrideId as string;

    await withTenant(db, node.context, (tx) =>
      applyPosOverrideRecorded(tx, event, meta()),
    );

    const after = await cloudAuditAfter(overrideId);
    expect(after.valueIdr).toBeNull();
    expect(after).not.toHaveProperty("varianceIdr");
  });
});

describe("legend-zclb cloud guard: identical pin material is a no-op", () => {
  it("a staff_pin.set with the material the cloud row holds leaves its lock and attempts intact", async () => {
    const userId = await newUser();
    const generationMs = Date.now() - 10 * MINUTE;
    const material = await pinMaterial(userId, "482916", generationMs);
    const rowId = randomUUID();
    await owner.query(
      `INSERT INTO staff_pins (id, tenant_id, outlet_id, user_id, pin_hash, pin_salt, kdf_n, kdf_r, kdf_p,
          pepper_version, failed_attempts, locked_until, set_by, created_at, updated_at, pin_set_at, pin_generation_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 5, now() + interval '10 minutes', $4, $11, $11, $11, $11)`,
      [
        rowId,
        tenantId,
        outletA,
        userId,
        material.pinHash,
        material.salt,
        material.params.N,
        material.params.r,
        material.params.p,
        material.pepperVersion,
        new Date(generationMs),
      ],
    );
    // A re-sent set: same material, a newer setAt (the old event's moment).
    const event = envelope("staff_pin.set", "staff_pin", rowId, userId, {
      staffPinId: rowId,
      userId,
      setBy: userId,
      self: true,
      material: {
        ...material,
        setAt: new Date(generationMs + MINUTE).toISOString(),
      },
    });

    const outcome = await withTenant(db, node.context, (tx) =>
      applyStaffPinSet(tx, event, meta()),
    );

    expect(outcome).toBe("not_applicable");
    const { rows } = await owner.query<{
      failed_attempts: number;
      locked: boolean;
      pin_hash: string;
    }>(
      `SELECT failed_attempts, (locked_until > now()) AS locked, pin_hash
         FROM staff_pins WHERE id = $1`,
      [rowId],
    );
    expect(rows[0]).toMatchObject({
      failed_attempts: 5,
      locked: true,
      pin_hash: material.pinHash,
    });
  });
});
