import { once } from "node:events";
import { WebSocketServer } from "ws";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { outletIdSchema } from "@starter/shared/core";
import { reportEdgeAuditRetentionStatus } from "../edge/runtime.ts";
import { decodeFrame } from "../edge/protocol.ts";
import { createEdgeLinkClient } from "../edge/link-client.ts";
import type { LinkStore } from "../edge/link-peer.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const tenantId = randomUUID();
const outletId = randomUUID();
const edgeNodeId = randomUUID();
const supervisorUserId = randomUUID();
const ownerUserId = randomUUID();
const context = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "session" }),
  { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
);

async function notificationRows() {
  const { rows } = await owner.query<{ user_id: string; title: string }>(
    "SELECT user_id, title FROM notifications WHERE tenant_id = $1",
    [tenantId],
  );
  return rows;
}

async function addUser(
  userId: string,
  name: string,
  templateKey: "supervisor" | "owner",
  scope: { type: "outlet" | "tenant"; id: string | null },
) {
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)`,
    [userId, name, `ecs-${randomBytes(4).toString("hex")}@example.test`],
  );
  const role = await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     SELECT $1, $2, name, is_template, template_key, permissions, mfa_required, allowed_scope_types
       FROM roles WHERE tenant_id = $3 AND template_key = $4`,
    [roleId, tenantId, cafeLegendPlatformFixtures.tenant.id, templateKey],
  );
  if (role.rowCount !== 1) throw new Error(`No ${templateKey} role template`);
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [tenantId, userId, roleId, scope.type, scope.id],
  );
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  const brand = randomUUID();
  const entity = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Tenant Edge Retention', plan, 'active', deployment_mode, feature_flags, limits, $3
       FROM tenants WHERE id = $4`,
    [
      tenantId,
      `retention-owner-538-${randomBytes(4).toString("hex")}`,
      randomUUID(),
      cafeLegendPlatformFixtures.tenant.id,
    ],
  );
  await owner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand')`,
    [brand, tenantId, `retention-owner-538-${randomBytes(3).toString("hex")}`],
  );
  await owner.query(
    `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Uji', false)`,
    [entity, tenantId],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours, status)
     VALUES ($1, $2, $3, $4, 'ECS-01', 'ECS-01', 'Jl. Uji', '{}', 'active')`,
    [outletId, tenantId, brand, entity],
  );
  await addUser(supervisorUserId, "Supervisor Retention", "supervisor", {
    type: "outlet",
    id: outletId,
  });
  await addUser(ownerUserId, "Owner Retention", "owner", {
    type: "tenant",
    id: null,
  });
});

afterAll(async () => {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const table of [
      "delivery_attempts",
      "notifications",
      "notification_outbox",
      "domain_event_outbox",
      "audit_logs",
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
      [supervisorUserId, ownerUserId],
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

describe("G5b missing edge maintenance login reaches the cloud owner", () => {
  const today = new Date("2026-11-12T23:59:59.999Z");
  const tomorrow = new Date("2026-11-13T00:00:00.000Z");
  const identity = { context, scope: { tenantId, outletId, edgeNodeId } };

  it("accepts maintenance status in strict heartbeat frames and preserves older edges", () => {
    const base = {
      type: "heartbeat",
      version: "1.0.0",
      occurredAt: new Date().toISOString(),
    };
    expect(decodeFrame(JSON.stringify(base))).toMatchObject({
      type: "heartbeat",
    });
    expect(
      decodeFrame(JSON.stringify({ ...base, auditRetentionDisabled: true })),
    ).toMatchObject({ auditRetentionDisabled: true });
    expect(
      decodeFrame(JSON.stringify({ ...base, auditRetentionDisabled: false })),
    ).toMatchObject({ auditRetentionDisabled: false });
    expect(
      decodeFrame(JSON.stringify({ ...base, auditRetentionDisabled: "true" })),
    ).toBeNull();
  });

  it("reports missing maintenance login in heartbeat and omits the field once restored", async () => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await once(server, "listening");
    const address = server.address();
    if (typeof address === "string" || address === null)
      throw new Error("Expected local WebSocket address");
    const frames: unknown[] = [];
    server.on("connection", (socket) =>
      socket.on("message", (raw) => {
        frames.push(decodeFrame(raw.toString()));
      }),
    );
    const store: LinkStore = {
      outboundHead: async () => 0,
      lastAckedOutbound: async () => 0,
      readOutbound: async () => [],
      ackOutbound: async () => undefined,
      lastReceivedInbound: async () => 0,
      applyInbound: async () => undefined,
    };
    let disabled = true;
    const client = createEdgeLinkClient({
      url: `ws://127.0.0.1:${address.port}/api/edge-link`,
      credential: "test-heartbeat-retention-credential",
      scope: identity.scope,
      store,
      version: "test538",
      heartbeatIntervalMs: 10,
      auditRetentionDisabled: () => disabled,
    });
    try {
      await vi.waitFor(() =>
        expect(frames).toContainEqual(
          expect.objectContaining({
            type: "heartbeat",
            auditRetentionDisabled: true,
          }),
        ),
      );
      const restoredAfter = frames.length;
      disabled = false;
      await vi.waitFor(() => {
        const restored = frames
          .slice(restoredAfter)
          .find(
            (frame) =>
              typeof frame === "object" &&
              frame !== null &&
              "type" in frame &&
              frame.type === "heartbeat",
          );
        expect(restored).toBeDefined();
        expect(restored).not.toHaveProperty("auditRetentionDisabled");
      });
    } finally {
      await client.stop();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("delivers to supervisor and owner once per node and UTC day even across repeated status changes", async () => {
    await reportEdgeAuditRetentionStatus(identity, true, today);
    let notifications = await notificationRows();
    expect(notifications.map((row) => row.user_id).sort()).toEqual(
      [supervisorUserId, ownerUserId].sort(),
    );
    expect(notifications.every((row) => row.title.length > 0)).toBe(true);
    await Promise.all([
      reportEdgeAuditRetentionStatus(identity, true, today),
      reportEdgeAuditRetentionStatus(identity, true, today),
    ]);
    expect(await notificationRows()).toHaveLength(2);
    await reportEdgeAuditRetentionStatus(identity, false, today);
    expect(await notificationRows()).toHaveLength(2);
    await reportEdgeAuditRetentionStatus(identity, true, today);
    expect(await notificationRows()).toHaveLength(2);
    await reportEdgeAuditRetentionStatus(identity, true, tomorrow);
    notifications = await notificationRows();
    expect(notifications).toHaveLength(4);
    expect(
      notifications.filter((row) => row.user_id === ownerUserId),
    ).toHaveLength(2);
    expect(
      notifications.filter((row) => row.user_id === supervisorUserId),
    ).toHaveLength(2);
  });
});
