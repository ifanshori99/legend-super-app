import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Pool, type PoolClient } from "pg";
import WebSocket from "ws";
import { afterAll, beforeAll, expect, it } from "vitest";
import { outletIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { attachEmergencyRealtime } from "../edge/emergency-realtime.ts";
import {
  getEdgeRuntimeState,
  setEdgeRuntimeStateForTests,
} from "../edge/runtime.ts";
import { retryEmergencyIncidents } from "../services/edge-emergency.service.ts";

const { tenant, outlets } = cafeLegendPlatformFixtures;
const outlet = outlets[0];
const pool = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const saved = getEdgeRuntimeState();
const facility = randomUUID(),
  area = randomUUID(),
  unit = randomUUID(),
  incident = randomUUID();
async function scoped<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(
      "SELECT set_config('app.tenant_id',$1,true),set_config('app.outlet_ids','*',true)",
      [tenant.id],
    );
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
async function delivered() {
  return (
    await scoped((c) =>
      c.query(
        "SELECT delivered_at FROM edge_emergency_deliveries WHERE tenant_id=$1 AND incident_id=$2",
        [tenant.id, incident],
      ),
    )
  ).rows[0]?.delivered_at;
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
        edgeNodeId: randomUUID(),
      },
    },
    link: { cloudLink: "disconnected", refused: false, lastConnectedAt: null },
  });
  await scoped(async (c) => {
    await c.query(
      "INSERT INTO facilities (id,tenant_id,outlet_id,name,type,session_minutes,cleaning_minutes,arrival_grace_minutes,operating_hours,overtime_policy,cancellation_policy) VALUES ($1,$2,$3,'Delivery test','shower',20,10,10,$4,$5,$6)",
      [
        facility,
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
    await c.query(
      "INSERT INTO facility_areas (id,tenant_id,outlet_id,facility_id,name) VALUES ($1,$2,$3,$4,'Area')",
      [area, tenant.id, outlet.id, facility],
    );
    await c.query(
      "INSERT INTO facility_units (id,tenant_id,outlet_id,facility_id,area_id,code,status) VALUES ($1,$2,$3,$4,$5,'T1','available')",
      [unit, tenant.id, outlet.id, facility, area],
    );
    await c.query(
      "INSERT INTO facility_incidents (id,tenant_id,outlet_id,facility_id,unit_id,type,triggered_at,offline) VALUES ($1,$2,$3,$4,$5,'panic',now(),true)",
      [incident, tenant.id, outlet.id, facility, unit],
    );
    await c.query(
      "INSERT INTO edge_emergency_deliveries (tenant_id,outlet_id,incident_id) VALUES ($1,$2,$3)",
      [tenant.id, outlet.id, incident],
    );
  });
});
afterAll(async () => {
  setEdgeRuntimeStateForTests(saved);
  await scoped(async (c) => {
    await c.query(
      "DELETE FROM edge_emergency_deliveries WHERE tenant_id=$1 AND incident_id=$2",
      [tenant.id, incident],
    );
    await c.query(
      "DELETE FROM facility_incidents WHERE tenant_id=$1 AND id=$2",
      [tenant.id, incident],
    );
    await c.query("DELETE FROM facility_units WHERE tenant_id=$1 AND id=$2", [
      tenant.id,
      unit,
    ]);
    await c.query("DELETE FROM facility_areas WHERE tenant_id=$1 AND id=$2", [
      tenant.id,
      area,
    ]);
    await c.query("DELETE FROM facilities WHERE tenant_id=$1 AND id=$2", [
      tenant.id,
      facility,
    ]);
  });
  await pool.end();
});
it("keeps delivery pending without a recipient and sends to staff arriving separately", async () => {
  await retryEmergencyIncidents();
  expect(await delivered()).toBeNull();
  const server = createServer();
  const transport = attachEmergencyRealtime(server, {
    trustedOrigins: ["http://outlet.test"],
    resolveConnection: async (req) => ({
      userId: String(req.headers["x-staff"]),
      tenantId: tenant.id,
      outletId: outlet.id,
    }),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/edge/emergency/realtime`;
  const first = new WebSocket(url, {
    origin: "http://outlet.test",
    headers: { "x-staff": "first" },
  });
  let second: WebSocket | undefined;
  try {
    await once(first, "open");
    const firstMessage = once(first, "message");
    await retryEmergencyIncidents();
    await firstMessage;
    const firstDelivery = await delivered();
    expect(firstDelivery).not.toBeNull();
    second = new WebSocket(url, {
      origin: "http://outlet.test",
      headers: { "x-staff": "supervisor" },
    });
    await once(second, "open");
    const secondMessage = once(second, "message");
    await retryEmergencyIncidents();
    expect(JSON.parse(String((await secondMessage)[0]))).toMatchObject({
      type: "emergency",
      incidentId: incident,
      unitId: unit,
    });
    expect((await delivered()).getTime()).toBe(firstDelivery.getTime());
  } finally {
    first.terminate();
    second?.terminate();
    transport.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("serializes a delivery insert against a concurrent move to another outlet", async () => {
  const otherOutlet = outlets[1];
  const otherFacility = randomUUID();
  const movingIncident = randomUUID();
  await scoped(async (c) => {
    await c.query(
      "INSERT INTO facilities (id,tenant_id,outlet_id,name,type,session_minutes,cleaning_minutes,arrival_grace_minutes,operating_hours,overtime_policy,cancellation_policy) SELECT $1,tenant_id,$2,'Other outlet',type,session_minutes,cleaning_minutes,arrival_grace_minutes,operating_hours,overtime_policy,cancellation_policy FROM facilities WHERE tenant_id=$3 AND id=$4",
      [otherFacility, otherOutlet.id, tenant.id, facility],
    );
    await c.query(
      "INSERT INTO facility_incidents (id,tenant_id,outlet_id,facility_id,type,triggered_at) VALUES ($1,$2,$3,$4,'panic',now())",
      [movingIncident, tenant.id, outlet.id, facility],
    );
  });
  const a = await pool.connect();
  const b = await pool.connect();
  try {
    await a.query("BEGIN");
    await b.query("BEGIN");
    for (const client of [a, b])
      await client.query(
        "SELECT set_config('app.tenant_id',$1,true),set_config('app.outlet_ids','*',true)",
        [tenant.id],
      );
    await a.query(
      "INSERT INTO edge_emergency_deliveries (tenant_id,outlet_id,incident_id) VALUES ($1,$2,$3)",
      [tenant.id, outlet.id, movingIncident],
    );
    const moving = b
      .query(
        "UPDATE facility_incidents SET outlet_id=$1,facility_id=$2 WHERE tenant_id=$3 AND id=$4",
        [otherOutlet.id, otherFacility, tenant.id, movingIncident],
      )
      .then(
        () => "moved",
        () => "rejected",
      );
    await a.query("COMMIT");
    expect(await moving).toBe("rejected");
    await b.query("ROLLBACK");
    await a.query("BEGIN");
    await a.query(
      "SELECT set_config('app.tenant_id',$1,true),set_config('app.outlet_ids','*',true)",
      [tenant.id],
    );
    const current = await a.query(
      "SELECT outlet_id FROM facility_incidents WHERE tenant_id=$1 AND id=$2",
      [tenant.id, movingIncident],
    );
    expect(current.rows[0].outlet_id).toBe(outlet.id);
    await a.query(
      "DELETE FROM edge_emergency_deliveries WHERE tenant_id=$1 AND incident_id=$2",
      [tenant.id, movingIncident],
    );
    await a.query("COMMIT");
    await a.query("BEGIN");
    await b.query("BEGIN");
    for (const client of [a, b])
      await client.query(
        "SELECT set_config('app.tenant_id',$1,true),set_config('app.outlet_ids','*',true)",
        [tenant.id],
      );
    await a.query(
      "UPDATE facility_incidents SET outlet_id=$1,facility_id=$2 WHERE tenant_id=$3 AND id=$4",
      [otherOutlet.id, otherFacility, tenant.id, movingIncident],
    );
    const inserted = b
      .query(
        "INSERT INTO edge_emergency_deliveries (tenant_id,outlet_id,incident_id) VALUES ($1,$2,$3)",
        [tenant.id, outlet.id, movingIncident],
      )
      .then(
        () => "inserted",
        () => "rejected",
      );
    await a.query("COMMIT");
    expect(await inserted).toBe("rejected");
    await b.query("ROLLBACK");
  } finally {
    await a.query("ROLLBACK").catch(() => {});
    await b.query("ROLLBACK").catch(() => {});
    a.release();
    b.release();
    await scoped(async (c) => {
      await c.query(
        "DELETE FROM edge_emergency_deliveries WHERE tenant_id=$1 AND incident_id=$2",
        [tenant.id, movingIncident],
      );
      await c.query(
        "DELETE FROM facility_incidents WHERE tenant_id=$1 AND id=$2",
        [tenant.id, movingIncident],
      );
      await c.query("DELETE FROM facilities WHERE tenant_id=$1 AND id=$2", [
        tenant.id,
        otherFacility,
      ]);
    });
  }
});

it("hides delivery state across tenant and outlet RLS scopes", async () => {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL ROLE legend_app");
    await c.query(
      "SELECT set_config('app.tenant_id',$1,true),set_config('app.outlet_ids',$2,true)",
      [tenant.id, JSON.stringify([outlets[1].id])],
    );
    expect(
      (
        await c.query(
          "SELECT incident_id FROM edge_emergency_deliveries WHERE incident_id=$1",
          [incident],
        )
      ).rows,
    ).toHaveLength(0);
    await c.query(
      "SELECT set_config('app.tenant_id',$1,true),set_config('app.outlet_ids',$2,true)",
      [randomUUID(), JSON.stringify([outlet.id])],
    );
    expect(
      (
        await c.query(
          "SELECT incident_id FROM edge_emergency_deliveries WHERE incident_id=$1",
          [incident],
        )
      ).rows,
    ).toHaveLength(0);
  } finally {
    await c.query("ROLLBACK");
    c.release();
  }
});
