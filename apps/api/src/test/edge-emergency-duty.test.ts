// FAC-08 duty = active published shift OR latest valid local clock-in.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outletIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import {
  getEdgeRuntimeState,
  setEdgeRuntimeStateForTests,
} from "../edge/runtime.ts";
import { isEmergencyOnDuty } from "../services/edge-emergency.service.ts";
import { agent, signUp } from "./helpers.ts";

const { tenant, outlets } = cafeLegendPlatformFixtures;
const [outlet, other] = outlets;
const pool = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const saved = getEdgeRuntimeState();
const employee = randomUUID();
const shift = randomUUID();
let userId: string;
async function scoped<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(
      "SELECT set_config('app.tenant_id',$1,true),set_config('app.outlet_ids','*',true)",
      [tenant.id],
    );
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (error) {
    await c.query("ROLLBACK");
    throw error;
  } finally {
    c.release();
  }
}
beforeAll(async () => {
  const client = agent(createApp());
  await signUp(client, "Emergency Duty");
  userId = (await client.get("/api/auth/get-session")).body.user.id;
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
      "INSERT INTO employees (id,tenant_id,user_id,employee_no,full_name,home_outlet_id,employment_type,join_date,status) VALUES ($1,$2,$3,$4,'Duty test',$5,'pkwtt','2025-01-01','active')",
      [
        employee,
        tenant.id,
        userId,
        `ET-${employee.slice(0, 8).toUpperCase()}`,
        outlet.id,
      ],
    );
  });
});
afterAll(async () => {
  await scoped(async (c) => {
    await c.query(
      "DELETE FROM attendance_logs WHERE tenant_id=$1 AND employee_id=$2",
      [tenant.id, employee],
    );
    await c.query(
      "DELETE FROM shift_assignments WHERE tenant_id=$1 AND employee_id=$2",
      [tenant.id, employee],
    );
    await c.query("DELETE FROM employees WHERE tenant_id=$1 AND id=$2", [
      tenant.id,
      employee,
    ]);
  });
  await pool.query('DELETE FROM "user" WHERE id=$1', [userId]);
  setEdgeRuntimeStateForTests(saved);
  await pool.end();
});
describe("on-duty union scoped to edge outlet", () => {
  it("accepts published current shift without clock-in and rejects other outlet and tenant", async () => {
    const now = Date.now();
    await scoped((c) =>
      c.query(
        "INSERT INTO shift_assignments (id,tenant_id,outlet_id,employee_id,business_date,segments,status,source,published_by,published_at,created_by) VALUES ($1,$2,$3,$4,CURRENT_DATE,$5,'published','user',$6,now(),$6)",
        [
          shift,
          tenant.id,
          outlet.id,
          employee,
          JSON.stringify([
            {
              startsAt: new Date(now - 60000).toISOString(),
              endsAt: new Date(now + 600000).toISOString(),
            },
          ]),
          userId,
        ],
      ),
    );
    expect(await isEmergencyOnDuty(userId, tenant.id, outlet.id)).toBe(true);
    expect(await isEmergencyOnDuty(userId, tenant.id, other.id)).toBe(false);
    expect(await isEmergencyOnDuty(userId, randomUUID(), outlet.id)).toBe(
      false,
    );
  });
  it("accepts local clock-in without a schedule and rejects after clock-out", async () => {
    await scoped(async (c) => {
      await c.query(
        "DELETE FROM shift_assignments WHERE tenant_id=$1 AND id=$2",
        [tenant.id, shift],
      );
      await c.query(
        "INSERT INTO attendance_logs (id,tenant_id,outlet_id,employee_id,type,method,occurred_at,validity,business_date,client_event_id,offline) VALUES ($1,$2,$3,$4,'in','rotating_qr',now()-interval '1 minute','valid',CURRENT_DATE,$5,true)",
        [randomUUID(), tenant.id, outlet.id, employee, randomUUID()],
      );
    });
    expect(await isEmergencyOnDuty(userId, tenant.id, outlet.id)).toBe(true);
    await scoped((c) =>
      c.query(
        "INSERT INTO attendance_logs (id,tenant_id,outlet_id,employee_id,type,method,occurred_at,validity,business_date,client_event_id,offline) VALUES ($1,$2,$3,$4,'out','rotating_qr',now()-interval '1 second','valid',CURRENT_DATE,$5,true)",
        [randomUUID(), tenant.id, outlet.id, employee, randomUUID()],
      ),
    );
    expect(await isEmergencyOnDuty(userId, tenant.id, outlet.id)).toBe(false);
  });
});
