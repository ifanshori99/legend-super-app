// legend-5zb6g: restoring an archived tenant emits tenant.status_changed on the
// control-plane stream, exactly like suspend and archive do (legend-488 item 4).
// Written from the contract (control-plane-events.test.ts, platform-restore-window.test.ts),
// not from the implementation. Fail-first: today restore writes no control-plane row.
//
// Assumptions:
// - Driven through the real platform API (POST /api/platform/tenants/:id/restore),
//   like platform-restore-window.test.ts, so no service signature is assumed.
// - The restore event reuses the status-change payload shape of suspend/archive:
//   event.name = "tenant.status_changed", payload { from, to }, with
//   from = "archived" and to = the restored status (active | suspended).
// - The row sits on the sentinel stream (tenant_id = CONTROL_PLANE_TENANT_ID,
//   aggregate_type "tenant", aggregate_id = subject tenant, destination
//   CONTROL_PLANE_DESTINATION), never on the subject's own cloud-sync stream.
// - "Same transaction as the audit row" is proven with a throwing audit writer:
//   status, event and sequence must all roll back together.
// - "Replay": a second identical restore request is refused (409, tenant no
//   longer archived) and writes no second event. This file never sweeps the
//   sentinel stream (control-plane-events.test.ts owns that).
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  CONTROL_PLANE_DESTINATION,
  CONTROL_PLANE_TENANT_ID,
} from "@starter/shared/events";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  agent,
  originHeader,
  setRole,
  signUp,
  verifySessionMfa,
} from "./helpers";

const app = createApp();
const seededTenantId = cafeLegendPlatformFixtures.tenant.id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

type Client = ReturnType<typeof agent>;

const REASON = "Pulihkan sesuai permintaan pemilik usaha.";

const limits = {
  maxOutlets: 5,
  maxActiveEmployees: 30,
  maxDevices: 10,
  aiRequestsPerMonth: 100,
  whatsappCostCapIdr: 0,
  aiCostCapIdr: 50_000,
  emailCostCapIdr: 10_000,
};

afterAll(async () => {
  setAuditWriter(coreAuditWriter);
  await owner.end();
});

async function adminClient() {
  const client = agent(app);
  const email = await signUp(client, "Platform Admin");
  await setRole(email, "admin");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    "INSERT INTO platform_admins (user_id) VALUES ($1) ON CONFLICT DO NOTHING",
    [userId],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     SELECT $1, $2, id, 'tenant', now() - interval '1 minute', $2 FROM roles
     WHERE tenant_id = $1 AND template_key = 'owner'`,
    [seededTenantId, userId],
  );
  await verifySessionMfa(email);
  return client;
}

async function createTenant(client: Client): Promise<string> {
  const created = await client
    .post("/api/platform/tenants")
    .set(originHeader)
    .send({
      slug: `pulih-${randomBytes(4).toString("hex")}`,
      name: "Uji Event Pemulihan",
      plan: "lengkap",
      deploymentMode: "shared",
      featureFlags: { modules: ["pos", "qr_order"], integrationProviders: [] },
      limits,
      firstAdmin: {
        name: "Admin Pertama",
        whatsapp: "6281234567890",
        email: null,
      },
    });
  expect(created.status).toBe(201);
  return created.body.data.id as string;
}

async function setStatus(
  client: Client,
  tenantId: string,
  status: "suspended" | "archived",
) {
  const res = await client
    .post(`/api/platform/tenants/${tenantId}/status`)
    .set(originHeader)
    .send({ status, reason: "Perubahan status untuk uji event." });
  expect(res.status).toBe(200);
}

async function archivedTenant(
  client: Client,
  from: "active" | "suspended",
): Promise<string> {
  const id = await createTenant(client);
  if (from === "suspended") await setStatus(client, id, "suspended");
  await setStatus(client, id, "archived");
  return id;
}

function restore(client: Client, tenantId: string) {
  return client
    .post(`/api/platform/tenants/${tenantId}/restore`)
    .set(originHeader)
    .send({ reason: REASON });
}

type ControlRow = {
  destination: string;
  sequence: string;
  event: { name: string; payload: Record<string, unknown> };
};

async function controlRows(tenantId: string): Promise<ControlRow[]> {
  const { rows } = await owner.query<ControlRow>(
    `SELECT destination, sequence, event FROM domain_event_outbox
      WHERE tenant_id = $1 AND aggregate_type = 'tenant' AND aggregate_id = $2
      ORDER BY destination, sequence`,
    [CONTROL_PLANE_TENANT_ID, tenantId],
  );
  return rows;
}

const restoreRows = (rows: ControlRow[]) =>
  rows.filter((row) => row.event.payload.from === "archived");

async function subjectStreamNames(tenantId: string): Promise<string[]> {
  const { rows } = await owner.query<{ name: string }>(
    `SELECT event->>'name' AS name FROM domain_event_outbox
      WHERE tenant_id = $1 AND aggregate_type = 'tenant' ORDER BY sequence`,
    [tenantId],
  );
  return rows.map((row) => row.name);
}

async function tenantStatus(tenantId: string): Promise<string> {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM tenants WHERE id = $1",
    [tenantId],
  );
  return rows[0]!.status;
}

async function restoreAuditCount(tenantId: string): Promise<number> {
  const { rows } = await owner.query<{ total: string }>(
    `SELECT count(*) AS total FROM audit_logs
      WHERE tenant_id = $1 AND event->>'action' = 'tenant.restored'`,
    [tenantId],
  );
  return Number(rows[0]!.total);
}

describe("restoreTenant emits tenant.status_changed (legend-5zb6g)", () => {
  it("restoring an archived active tenant writes exactly one control-plane row, archived -> active, next in sequence", async () => {
    const client = await adminClient();
    const id = await archivedTenant(client, "active");
    const before = await controlRows(id);
    expect(restoreRows(before)).toHaveLength(0);

    const restored = await restore(client, id);
    expect(restored.status).toBe(200);

    const after = await controlRows(id);
    const restoreEvents = restoreRows(after);
    expect(restoreEvents).toHaveLength(1);
    expect(after).toHaveLength(before.length + 1);
    expect(restoreEvents[0]).toMatchObject({
      destination: CONTROL_PLANE_DESTINATION,
      sequence: String(before.length + 1),
    });
    expect(restoreEvents[0]!.event.name).toBe("tenant.status_changed");
    expect(restoreEvents[0]!.event.payload).toMatchObject({
      from: "archived",
      to: "active",
    });
    // The event travels on the sentinel stream only.
    expect(await subjectStreamNames(id)).toEqual(["tenant.created"]);
    // Same unit of work as the audit row.
    expect(await restoreAuditCount(id)).toBe(1);
  });

  it("restoring an archived suspended tenant reports the restored status (suspended), not active", async () => {
    const client = await adminClient();
    const id = await archivedTenant(client, "suspended");

    expect((await restore(client, id)).status).toBe(200);

    const events = restoreRows(await controlRows(id));
    expect(events).toHaveLength(1);
    expect(events[0]!.event.name).toBe("tenant.status_changed");
    expect(events[0]!.event.payload).toMatchObject({
      from: "archived",
      to: "suspended",
    });
  });

  it("a failure in the audit write rolls back status, audit and event together, and leaves no sequence gap", async () => {
    const client = await adminClient();
    const id = await archivedTenant(client, "active");
    const before = await controlRows(id);

    setAuditWriter({
      record: async () => {
        throw new Error("audit down");
      },
    });
    try {
      const failed = await restore(client, id);
      expect(failed.status).not.toBe(200);
    } finally {
      setAuditWriter(coreAuditWriter);
    }

    expect(await tenantStatus(id)).toBe("archived");
    expect(await restoreAuditCount(id)).toBe(0);
    expect(await controlRows(id)).toEqual(before);

    // The retry succeeds and takes the very next sequence number.
    expect((await restore(client, id)).status).toBe(200);
    const events = restoreRows(await controlRows(id));
    expect(events).toHaveLength(1);
    expect(events[0]!.sequence).toBe(String(before.length + 1));
  });

  it("refused restores emit nothing: expired window, legacy row, not archived", async () => {
    const client = await adminClient();

    const expired = await archivedTenant(client, "active");
    await owner.query(
      "UPDATE tenants SET archived_at = now() - interval '31 days' WHERE id = $1",
      [expired],
    );
    const expiredBefore = await controlRows(expired);
    expect((await restore(client, expired)).status).toBe(409);
    expect(await controlRows(expired)).toEqual(expiredBefore);

    const legacy = await archivedTenant(client, "active");
    await owner.query(
      "UPDATE tenants SET archived_at = NULL, status_before_archive = NULL WHERE id = $1",
      [legacy],
    );
    const legacyBefore = await controlRows(legacy);
    expect((await restore(client, legacy)).status).toBe(409);
    expect(await controlRows(legacy)).toEqual(legacyBefore);

    const active = await createTenant(client);
    const activeBefore = await controlRows(active);
    expect((await restore(client, active)).status).toBe(409);
    expect(await controlRows(active)).toEqual(activeBefore);

    for (const id of [expired, legacy, active])
      expect(restoreRows(await controlRows(id))).toHaveLength(0);
  });

  it("replaying the same restore is refused and does not duplicate the event", async () => {
    const client = await adminClient();
    const id = await archivedTenant(client, "active");

    expect((await restore(client, id)).status).toBe(200);
    const once = await controlRows(id);
    expect(restoreRows(once)).toHaveLength(1);

    const replay = await restore(client, id);
    expect(replay.status).toBe(409);
    expect(await controlRows(id)).toEqual(once);
    expect(await restoreAuditCount(id)).toBe(1);
  });
});
