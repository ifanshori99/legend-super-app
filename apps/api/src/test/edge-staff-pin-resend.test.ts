// legend-zclb: one-shot edge job re-sending pin sets that predate
// `payload.material`. This database plays the edge (the job and the outbox)
// and, through `applyStaffPinSet`, the cloud that receives the new event.
// An outbox event written without EDGE_MODE has no material: exactly the
// shape of an old edge event.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { outletIdSchema, type ScopedTenantContext } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { EventEnvelope } from "@starter/shared/events";
import { sql } from "drizzle-orm";
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

// legend-gauz3: lets one test park the resend job between its reads and its
// append, only for the append that carries `pausePinHash` as material. Every
// other call passes straight through.
const appendGate = vi.hoisted(() => ({
  pausePinHash: null as string | null,
  onPaused: null as ((pid: number) => void) | null,
  release: null as Promise<void> | null,
}));

vi.mock("../services/device-pin-support.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../services/device-pin-support.ts")>();
  return {
    ...actual,
    appendDevicePinEvent: async (
      ...args: Parameters<typeof actual.appendDevicePinEvent>
    ) => {
      const [tx, , , input] = args;
      const material = (input.payload as { material?: { pinHash?: string } })
        .material;
      if (
        appendGate.pausePinHash !== null &&
        material?.pinHash === appendGate.pausePinHash
      ) {
        const { rows } = await tx.execute<{ pid: number }>(
          sql`select pg_backend_pid() as pid`,
        );
        appendGate.onPaused?.(Number(rows[0]!.pid));
        await appendGate.release;
      }
      return actual.appendDevicePinEvent(...args);
    },
  };
});

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

  it("caps material.setAt at the job's now when the old event is stamped in the future", async () => {
    const userId = await newUser();
    const now = new Date();
    await setPinWithoutMaterial(
      userId,
      "913574",
      new Date(now.getTime() + 5 * HOUR),
    );
    const [old] = await setEvents(userId);
    expect(Date.parse(old!.occurredAt)).toBeGreaterThan(now.getTime());

    const result = await resendMateriallessStaffPinSets(tenant, outletA, {
      now,
    });
    expect(result.resent).toBe(1);

    const sent = (await setEvents(userId))[1]!;
    expect(materialOf(sent)!.setAt).toBe(now.toISOString());
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

  // legend-gauz3: a reset that commits between the job's read and its append
  // must not be followed by the old material at a higher sequence (the cloud
  // would re-activate the old pin).
  it("never emits the old material after a reset that commits while the job is between its read and its append", async () => {
    const userId = await newUser();
    await setPinWithoutMaterial(userId, "318642", new Date(Date.now() - HOUR));
    const rowA = await pinRow(userId);

    let pausedPid: (pid: number) => void = () => undefined;
    const paused = new Promise<number>((resolve) => (pausedPid = resolve));
    let releaseJob: () => void = () => undefined;
    appendGate.pausePinHash = rowA.pin_hash;
    appendGate.onPaused = pausedPid;
    appendGate.release = new Promise<void>((resolve) => (releaseJob = resolve));

    const job = resendMateriallessStaffPinSets(tenant, outletA);
    const jobPid = await Promise.race([
      paused,
      job.then(() => {
        throw new Error("The job finished without reaching its append");
      }),
    ]);

    // The reset to B runs while the job is parked. With the row lock held
    // by the job it must wait; without it, it commits right away.
    process.env.EDGE_MODE = "true";
    let resetDone = false;
    const reset = setStaffPin(
      tenant,
      userId,
      { outletId: outletA, userId },
      { pin: "975310" },
    ).finally(() => {
      resetDone = true;
    });
    for (let attempt = 0; attempt < 400 && !resetDone; attempt++) {
      const { rowCount } = await owner.query(
        `SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))`,
        [jobPid],
      );
      if (rowCount) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    try {
      releaseJob();
      await Promise.all([job, reset]);
    } finally {
      delete process.env.EDGE_MODE;
      appendGate.pausePinHash = null;
      appendGate.onPaused = null;
      appendGate.release = null;
    }

    const rowB = await pinRow(userId);
    expect(rowB.pin_hash).not.toBe(rowA.pin_hash);
    const events = await setEvents(userId);
    const last = events[events.length - 1]!;
    expect(materialOf(last)?.pinHash).toBe(rowB.pin_hash);
    // Whatever order they ran in, no event after B's carries A's material.
    const indexOfB = events.findIndex(
      (event) => materialOf(event)?.pinHash === rowB.pin_hash,
    );
    expect(
      events
        .slice(indexOfB + 1)
        .some((event) => materialOf(event)?.pinHash === rowA.pin_hash),
    ).toBe(false);
  });
});
