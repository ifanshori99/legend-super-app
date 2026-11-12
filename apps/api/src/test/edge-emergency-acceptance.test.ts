// FAC-08: a registered panic device at this edge can raise an incident even
// when the cloud link is down. Scope comes from the device/node, not the body.
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { Pool, type PoolClient } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outletIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  cafeLegendPlatformFixtures,
  DEVICE_TOKEN_HEADER,
} from "@starter/shared/platform";
import { createApp } from "../app.ts";
import {
  getEdgeRuntimeState,
  setEdgeRuntimeStateForTests,
} from "../edge/runtime.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { attachEmergencyRealtime } from "../edge/emergency-realtime.ts";
import { retryEmergencyIncidents } from "../services/edge-emergency.service.ts";
import { respondFacilityIncident } from "../services/facility-incidents.service.ts";
import { staffWithRole } from "./floor-test-helpers.ts";

const { tenant, outlets } = cafeLegendPlatformFixtures;
const [outlet, otherOutlet] = outlets;
const pool = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const app = createApp({ edgeMode: true });
const previousRuntime = getEdgeRuntimeState();
let incidentId: string;
const edgeNodeId = randomUUID();
const facilityId = randomUUID();
const areaId = randomUUID();
const unitId = randomUUID();
const panicId = randomUUID();
const foreignId = randomUUID();
const issuedAt = Math.floor(Date.now() / 1000);
const token = (deviceId: string) =>
  signDeviceToken({
    version: 1,
    tenantId: tenant.id,
    brandId: null,
    deviceId,
    issuedAt,
  });

async function scoped<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.id],
    );
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  const context = establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenant.id,
      brandId: null,
      source: "device",
    }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outlet.id)] },
  );
  setEdgeRuntimeStateForTests({
    edgeMode: true,
    identity: {
      context,
      scope: {
        tenantId: tenant.id,
        outletId: outletIdSchema.parse(outlet.id),
        edgeNodeId,
      },
    },
    link: { cloudLink: "disconnected", refused: false, lastConnectedAt: null },
  });
  await scoped(async (client) => {
    await client.query(
      "INSERT INTO edge_nodes (id,tenant_id,outlet_id,role,label,credential_hash) VALUES ($1,$2,$3,'primary','Emergency test',$4)",
      [edgeNodeId, tenant.id, outlet.id, "a".repeat(64)],
    );
    await client.query(
      "INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at) VALUES ($1,$2,$3,'panic_button','Panic A',$4),($5,$2,$6,'panic_button','Panic B',$4)",
      [
        panicId,
        tenant.id,
        outlet.id,
        new Date(issuedAt * 1000),
        foreignId,
        otherOutlet.id,
      ],
    );
    await client.query(
      "INSERT INTO facilities (id,tenant_id,outlet_id,name,type,session_minutes,cleaning_minutes,arrival_grace_minutes,operating_hours,overtime_policy,cancellation_policy) VALUES ($1,$2,$3,'Emergency test','shower',20,10,10,$4,$5,$6)",
      [
        facilityId,
        tenant.id,
        outlet.id,
        JSON.stringify([
          {
            daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
            opensAt: "00:00",
            closesAt: "23:59",
          },
        ]),
        JSON.stringify({
          graceMinutes: 5,
          blockMinutes: 15,
          feePerBlockIdr: 5000,
        }),
        JSON.stringify({
          freeCancelMinutesBefore: 30,
          lateCancelResolution: "no_refund",
          lateCancelFeeIdr: 0,
          noShowResolution: "no_refund",
        }),
      ],
    );
    await client.query(
      "INSERT INTO facility_areas (id,tenant_id,outlet_id,facility_id,name,sort_order) VALUES ($1,$2,$3,$4,'Area',0)",
      [areaId, tenant.id, outlet.id, facilityId],
    );
    await client.query(
      "INSERT INTO facility_units (id,tenant_id,outlet_id,facility_id,area_id,code,status,panic_device_id) VALUES ($1,$2,$3,$4,$5,'P1','available',$6)",
      [unitId, tenant.id, outlet.id, facilityId, areaId, panicId],
    );
  });
});

afterAll(async () => {
  setEdgeRuntimeStateForTests(previousRuntime);
  await scoped(async (client) => {
    // Test teardown simulates acknowledgement before retention removes rows.
    await client.query(
      "UPDATE edge_outbound_queue SET status='acked', acked_at=now() WHERE tenant_id=$1 AND edge_node_id=$2 AND status='pending'",
      [tenant.id, edgeNodeId],
    );
    await client.query(
      "DELETE FROM edge_outbound_queue WHERE tenant_id=$1 AND edge_node_id=$2",
      [tenant.id, edgeNodeId],
    );
    await client.query(
      "DELETE FROM sync_cursors WHERE tenant_id=$1 AND edge_node_id=$2",
      [tenant.id, edgeNodeId],
    );
    await client.query(
      "UPDATE edge_nodes SET status='revoked', revoked_at=now() WHERE tenant_id=$1 AND id=$2",
      [tenant.id, edgeNodeId],
    );
    await client.query(
      "DELETE FROM edge_emergency_deliveries WHERE tenant_id=$1 AND incident_id=$2",
      [tenant.id, incidentId],
    );
    await client.query(
      "DELETE FROM facility_incidents WHERE tenant_id=$1 AND unit_id=$2",
      [tenant.id, unitId],
    );
    await client.query(
      "DELETE FROM facility_units WHERE tenant_id=$1 AND id=$2",
      [tenant.id, unitId],
    );
    await client.query(
      "DELETE FROM facility_areas WHERE tenant_id=$1 AND id=$2",
      [tenant.id, areaId],
    );
    await client.query("DELETE FROM facilities WHERE tenant_id=$1 AND id=$2", [
      tenant.id,
      facilityId,
    ]);
    await client.query(
      "DELETE FROM devices WHERE tenant_id=$1 AND id=ANY($2::uuid[])",
      [tenant.id, [panicId, foreignId]],
    );
  });
  await pool.end();
});

describe("FAC-08 panic device ingest on disconnected edge", () => {
  it("records the incident for the device's unit while offline", async () => {
    const start = Date.now();
    const response = await request(app)
      .post("/api/edge/emergencies")
      .set(DEVICE_TOKEN_HEADER, token(panicId))
      .send({});
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    incidentId = response.body.data.id as string;
    expect(Date.now() - start).toBeLessThanOrEqual(5000);
    const rows = await scoped((client) =>
      client.query(
        "SELECT tenant_id,outlet_id,unit_id,type,triggered_at FROM facility_incidents WHERE id=$1",
        [response.body.data.id],
      ),
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      tenant_id: tenant.id,
      outlet_id: outlet.id,
      unit_id: unitId,
      type: "panic",
    });
  });

  it("retries an unresolved incident when staff reconnects and records a response for cloud sync", async () => {
    // No recipient yet: retry must preserve the incident for a later delivery.
    await retryEmergencyIncidents();
    const pending = await scoped((client) =>
      client.query(
        "SELECT responded_at FROM facility_incidents WHERE tenant_id=$1 AND id=$2",
        [tenant.id, incidentId],
      ),
    );
    expect(pending.rows).toHaveLength(1);
    expect(pending.rows[0].responded_at).toBeNull();
    const server = createServer();
    const realtime = attachEmergencyRealtime(server, {
      trustedOrigins: ["http://outlet.test"],
      resolveConnection: async () => ({
        userId: "staff",
        tenantId: tenant.id,
        outletId: outlet.id,
      }),
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const socket = new WebSocket(
      `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/edge/emergency/realtime`,
      { origin: "http://outlet.test" },
    );
    try {
      await once(socket, "open");
      const message = once(socket, "message");
      await retryEmergencyIncidents();
      const [bytes] = await message;
      expect(JSON.parse(String(bytes))).toMatchObject({
        type: "emergency",
        incidentId,
        unitId,
      });
    } finally {
      socket.terminate();
      realtime.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    const staff = await staffWithRole(createApp(), { template: "owner" });
    const context = establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenant.id,
        brandId: null,
        source: "session",
      }),
      { kind: "outlets", outletIds: [outletIdSchema.parse(outlet.id)] },
    );
    const respondedAt = new Date();
    await respondFacilityIncident(
      context,
      staff.userId,
      incidentId,
      { resolution: "Dibantu" },
      respondedAt,
    );
    const rows = await scoped((client) =>
      client.query(
        "SELECT responded_by,responded_at FROM facility_incidents WHERE tenant_id=$1 AND id=$2",
        [tenant.id, incidentId],
      ),
    );
    expect(rows.rows[0].responded_by).toBe(staff.userId);
    expect(new Date(rows.rows[0].responded_at).toISOString()).toBe(
      respondedAt.toISOString(),
    );
    const queued = await scoped((client) =>
      client.query(
        "SELECT event FROM edge_outbound_queue WHERE tenant_id=$1 AND edge_node_id=$2 AND event->>'aggregateId'=$3 ORDER BY link_seq",
        [tenant.id, edgeNodeId, incidentId],
      ),
    );
    expect(queued.rows.map((row) => row.event.name)).toEqual([
      "facility_incident.raised",
      "facility_incident.responded",
    ]);
    expect(queued.rows.map((row) => row.event.sequence)).toEqual([1, 2]);
  });

  it("rejects a device registered to another outlet", async () => {
    const response = await request(app)
      .post("/api/edge/emergencies")
      .set(DEVICE_TOKEN_HEADER, token(foreignId))
      .send({});
    expect([401, 403]).toContain(response.status);
  });
});
