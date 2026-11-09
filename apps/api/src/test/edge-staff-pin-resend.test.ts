// legend-zclb: one-shot edge job re-sending pin sets that predate
// `payload.material`. This database plays the edge (the job and the outbox)
// and, through `applyStaffPinSet`, the cloud that receives the new event.
// An outbox event written without EDGE_MODE has no material: exactly the
// shape of an old edge event.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { outletIdSchema, type ScopedTenantContext } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { EventEnvelope } from "@starter/shared/events";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { applyStaffPinSet } from "../edge/access-applier.ts";
import { resendMateriallessStaffPinSets } from "../edge/staff-pin-resend.ts";
import type { EdgeApplyMeta } from "../edge/ports.ts";
import { setStaffPin } from "../services/device-pin.service.ts";
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
const outletA = randomUUID();
const staffRoleId = randomUUID();
const createdUsers: string[] = [];
let node: AuthenticatedEdgeNode;

const HOUR = 3_600_000;
const tenant = establishTenantContext({
  tenantId,
  brandId: null,
  source: "session",
});

const scopeFor = (outletIds: string[]): ScopedTenantContext =>
  establishScopedTenantContext(tenant, {
    kind: "outlets",
    outletIds: outletIds.map((id) => outletIdSchema.parse(id)),
  });

async function newUser(): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email, email_verified, banned) VALUES ($1, 'Staf Kirim Ulang', $2, true, false)`,
    [id, `resend-${randomBytes(4).toString("hex")}@example.test`],
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
  failed_attempts: number;
  locked_until: Date | null;
};

async function pinRow(userId: string): Promise<PinRow> {
  const { rows } = await owner.query<PinRow>(
    `SELECT id, pin_hash, pin_salt, failed_attempts, locked_until
       FROM staff_pins WHERE tenant_id = $1 AND user_id = $2`,
    [tenantId, userId],
  );
  return rows[0]!;
}

type SetMaterial = { pinHash: string; salt: string; setAt: string };

async function setEvents(userId: string) {
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
  (event.payload as { material?: SetMaterial }).material;

/** The cloud's applier, fed one event of this node (the edge -> cloud path). */
function applyOnCloud(event: EventEnvelope) {
  const meta: EdgeApplyMeta = {
    edgeNodeId: node.scope.edgeNodeId,
    direction: "edge_to_cloud",
    kind: "transaction_event",
    context: node.context,
  };
  return withTenant(db, node.context, (tx) =>
    applyStaffPinSet(tx, event, meta),
  );
}

/** A pin set without EDGE_MODE: no `material`, like an event from before it. */
async function setPinWithoutMaterial(userId: string, pin: string, now: Date) {
  await setStaffPin(
    tenant,
    userId,
    { outletId: outletA, userId },
    { pin },
    { now },
  );
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  const brand = randomUUID();
  const entity = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Tenant Kirim Ulang', plan, 'active', deployment_mode, feature_flags, limits, $3
       FROM tenants WHERE id = $4`,
    [
      tenantId,
      `resend-${randomBytes(4).toString("hex")}`,
      actor,
      cafeLegendPlatformFixtures.tenant.id,
    ],
  );
  await owner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand')`,
    [brand, tenantId, `resend-${randomBytes(3).toString("hex")}`],
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
      `RSD-${randomBytes(3).toString("hex").toUpperCase()}`,
    ],
  );
  const role = await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     SELECT $1, $2, name, is_template, template_key, permissions, mfa_required, allowed_scope_types
       FROM roles WHERE tenant_id = $3 AND template_key = 'cashier'`,
    [staffRoleId, tenantId, cafeLegendPlatformFixtures.tenant.id],
  );
  if (role.rowCount !== 1) throw new Error("No cashier role template");
  const registered = await registerEdgeNode(scopeFor([outletA]), actor, {
    outletId: outletA,
    role: "primary",
    label: "Utama Kirim Ulang",
  });
  const authenticated = await authenticateEdgeCredential(registered.credential);
  if (!authenticated) throw new Error("Edge node did not authenticate");
  node = authenticated;
});

beforeEach(() => {
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

describe("legend-zclb edge job re-sending pre-material pin sets", () => {
  it("re-sends the row's material at the old set moment, the cloud adopts it, and a second run emits nothing", async () => {
    const userId = await newUser();
    const setAt = new Date(Date.now() - 2 * HOUR);
    await setPinWithoutMaterial(userId, "482916", setAt);
    const edgeRow = await pinRow(userId);
    const [old] = await setEvents(userId);
    expect(materialOf(old!)).toBeUndefined();
    // A backfill moved the generation key to "now": the job must not use it.
    await owner.query(
      "UPDATE staff_pins SET pin_generation_at = now() WHERE id = $1",
      [edgeRow.id],
    );

    const first = await resendMateriallessStaffPinSets(tenant, outletA);
    expect(first.resent).toBe(1);

    const events = await setEvents(userId);
    expect(events).toHaveLength(2);
    const sent = events[1]!;
    const material = materialOf(sent)!;
    expect(material.pinHash).toBe(edgeRow.pin_hash);
    expect(material.salt).toBe(edgeRow.pin_salt);
    expect(material.setAt).toBe(old!.occurredAt);
    expect(sent.payload).toMatchObject({
      staffPinId: edgeRow.id,
      userId,
      setBy: userId,
      self: true,
    });

    // The cloud still holds an older pin of this staff member.
    await owner.query(
      `UPDATE staff_pins SET pin_hash = $2, pin_generation_at = $3 WHERE id = $1`,
      [edgeRow.id, "0".repeat(64), new Date(setAt.getTime() - HOUR)],
    );
    expect(await applyOnCloud(sent)).toBe("applied");
    expect((await pinRow(userId)).pin_hash).toBe(edgeRow.pin_hash);

    const second = await resendMateriallessStaffPinSets(tenant, outletA);
    expect(second.resent).toBe(0);
    expect(await setEvents(userId)).toHaveLength(2);
  });

  it("emits nothing for a pin whose latest set event already carries material, or that has no local set event", async () => {
    const withMaterial = await newUser();
    process.env.EDGE_MODE = "true";
    await setStaffPin(
      tenant,
      withMaterial,
      { outletId: outletA, userId: withMaterial },
      { pin: "135790" },
    );
    delete process.env.EDGE_MODE;
    // A pin that came from the cloud: a row, but no local set event.
    const mirrored = await newUser();
    await setPinWithoutMaterial(mirrored, "246813", new Date());
    await owner.query(
      `DELETE FROM domain_event_outbox WHERE tenant_id = $1 AND aggregate_type = 'staff_pin'
          AND event->'payload'->>'userId' = $2`,
      [tenantId, mirrored],
    );
    const before = (await setEvents(withMaterial)).length;

    await resendMateriallessStaffPinSets(tenant, outletA);

    expect(await setEvents(withMaterial)).toHaveLength(before);
    expect(await setEvents(mirrored)).toHaveLength(0);
  });

  it("skips a row of another pepper version", async () => {
    const userId = await newUser();
    await setPinWithoutMaterial(userId, "579135", new Date());
    await owner.query(
      "UPDATE staff_pins SET pepper_version = 2 WHERE tenant_id = $1 AND user_id = $2",
      [tenantId, userId],
    );

    await resendMateriallessStaffPinSets(tenant, outletA);

    expect(await setEvents(userId)).toHaveLength(1);
  });
});
