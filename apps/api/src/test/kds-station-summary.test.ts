// KDS station summary (bead legend-tsp5; PRD v1.7 §3 F12 KDS): one light GET
// returns the open-ticket count of every station the caller may see, so the
// tablet's station switch does not poll every station board.
//
// Real Express app, Better Auth, RBAC and PostgreSQL with RLS (disposable
// server from `pnpm test`) in fresh isolated tenants. Tickets are written as
// the database owner: the summary only counts rows, so no POS flow is needed.

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stationSummarySchema } from "@starter/shared/kitchen";
import { createApp } from "../app.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const ids = {
  kdsRole: randomUUID(),
  kdsRoleB: randomUUID(),
  noKdsRole: randomUUID(),
  outletB: randomUUID(),
  // outlet A
  barA: randomUUID(),
  kitchenA: randomUUID(),
  idleA: randomUUID(),
  // outlet B
  barB: randomUUID(),
  // other tenant
  stationX: randomUUID(),
};

type Member = { client: ReturnType<typeof agent>; userId: string };

let app: Express;
let tenant: IsolatedTenant;
let tenantB: IsolatedTenant;
let headers: { Host: string };
let headersB: { Host: string };
let cook: Member; // tenant scope
let barista: Member; // station bar A only
let outletBStaff: Member; // outlet B only
let noKds: Member;
let tenantBCook: Member;

async function asOwnerTenant<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function member(
  forTenant: IsolatedTenant,
  roleId: string,
  scope: { type: "tenant" | "outlet" | "station"; id: string | null },
  label: string,
): Promise<Member> {
  const client = agent(app);
  await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [forTenant.tenantId, userId, roleId, scope.type, scope.id],
  );
  return { client, userId };
}

async function insertRole(
  tenantId: string,
  id: string,
  name: string,
  permissions: string[],
  scopes: string[],
) {
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4, false, $5)`,
    [id, tenantId, name, JSON.stringify(permissions), JSON.stringify(scopes)],
  );
}

/** One order plus one ticket per given status on a station. */
async function seedTickets(
  forTenant: IsolatedTenant,
  outletId: string,
  stationId: string,
  statuses: string[],
) {
  await asOwnerTenant(forTenant.tenantId, async (client) => {
    for (const status of statuses) {
      const orderId = randomUUID();
      await client.query(
        `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
           subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
           status, business_date, placed_at)
         VALUES ($1, $2, $3, $4, 'pos', 'takeaway', 'pay_first', 20000, 0, 0, 0, 0, 20000,
                 'sent', '2026-11-01', now())`,
        [
          orderId,
          forTenant.tenantId,
          outletId,
          `SUM-${randomUUID().slice(0, 8)}`,
        ],
      );
      await client.query(
        `INSERT INTO kitchen_tickets
           (id, tenant_id, outlet_id, order_id, station_id, fire_batch_id, business_date, ticket_no,
            status, priority, fired_at, started_at, done_at, cancelled_at)
         VALUES ($1, $2, $3, $4, $5, $6, '2026-11-01', (SELECT coalesce(max(m.ticket_no), 0) + 1 FROM kitchen_tickets m WHERE m.tenant_id = $2::uuid AND m.outlet_id = $3::uuid AND m.business_date = '2026-11-01'), $7::text, 0, now(),
                 CASE WHEN $7::text = 'new' THEN NULL ELSE now() END,
                 CASE WHEN $7::text IN ('done', 'recalled') THEN now() ELSE NULL END,
                 CASE WHEN $7::text = 'cancelled' THEN now() ELSE NULL END)`,
        [
          randomUUID(),
          forTenant.tenantId,
          outletId,
          orderId,
          stationId,
          randomUUID(),
          status,
        ],
      );
    }
  });
}

function summary(
  who: Member,
  outletId: string,
  host: { Host: string } = headers,
) {
  return who.client
    .get(`/api/outlets/${outletId}/kitchen/station-summary`)
    .set(host)
    .set(originHeader);
}

const countsOf = (body: {
  data: { stations: { stationId: string; openTickets: number }[] };
}) =>
  Object.fromEntries(
    body.data.stations.map((row) => [row.stationId, row.openTickets]),
  );

beforeAll(async () => {
  app = createApp();
  tenant = await createIsolatedTenant(`kdssum-${randomUUID().slice(0, 6)}`);
  tenantB = await createIsolatedTenant(`kdssumb-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  headersB = { Host: tenantB.hostname };

  await insertRole(
    tenant.tenantId,
    ids.kdsRole,
    "KDS Ringkasan Uji",
    ["kds.ticket.process"],
    ["tenant", "outlet", "station"],
  );
  await insertRole(
    tenant.tenantId,
    ids.noKdsRole,
    "Tanpa KDS Uji",
    ["order.view"],
    ["tenant"],
  );
  await insertRole(
    tenantB.tenantId,
    ids.kdsRoleB,
    "KDS Ringkasan Tenant B",
    ["kds.ticket.process"],
    ["tenant"],
  );

  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet Ringkasan B', 'Jl. Uji 2', timezone, opening_hours, 'active'
       FROM outlets WHERE tenant_id = $3 AND id = $4`,
      [
        ids.outletB,
        `SB-${randomUUID().slice(0, 6)}`.toUpperCase(),
        tenant.tenantId,
        tenant.outletId,
      ],
    );
    const stations: [string, string, string, string][] = [
      [ids.barA, tenant.outletId, "Bar A", "beverage_bar"],
      [ids.kitchenA, tenant.outletId, "Dapur A", "hot_kitchen"],
      [ids.idleA, tenant.outletId, "Pastry A", "pastry"],
      [ids.barB, ids.outletB, "Bar B", "beverage_bar"],
    ];
    for (const [id, outletId, name, type] of stations)
      await client.query(
        `INSERT INTO stations (id, tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, $4, $5)`,
        [id, tenant.tenantId, outletId, name, type],
      );
  });
  await asOwnerTenant(tenantB.tenantId, async (client) => {
    await client.query(
      `INSERT INTO stations (id, tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'Bar X', 'beverage_bar')`,
      [ids.stationX, tenantB.tenantId, tenantB.outletId],
    );
  });

  cook = await member(
    tenant,
    ids.kdsRole,
    { type: "tenant", id: null },
    "Sum Koki",
  );
  barista = await member(
    tenant,
    ids.kdsRole,
    { type: "station", id: ids.barA },
    "Sum Barista",
  );
  outletBStaff = await member(
    tenant,
    ids.kdsRole,
    { type: "outlet", id: ids.outletB },
    "Sum Outlet B",
  );
  noKds = await member(
    tenant,
    ids.noKdsRole,
    { type: "tenant", id: null },
    "Sum Tanpa KDS",
  );
  tenantBCook = await member(
    tenantB,
    ids.kdsRoleB,
    { type: "tenant", id: null },
    "Sum Tenant B",
  );

  // Open: new, in progress, recalled. Not open: done, cancelled.
  await seedTickets(tenant, tenant.outletId, ids.barA, [
    "new",
    "in_progress",
    "done",
    "cancelled",
  ]);
  await seedTickets(tenant, tenant.outletId, ids.kitchenA, ["recalled"]);
  await seedTickets(tenant, ids.outletB, ids.barB, ["new", "new", "new"]);
  await seedTickets(tenantB, tenantB.outletId, ids.stationX, ["new", "new"]);
});

afterAll(async () => {
  // Isolated tenants stay in the disposable database; give them a valid
  // creator so the platform tenant list parses (as kds.test.ts does).
  for (const t of [tenant, tenantB])
    await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      t.tenantId,
      randomUUID(),
    ]);
  await owner.end();
});

describe("legend-tsp5 KDS station summary", () => {
  it("counts new, in-progress and recalled tickets per station; done and cancelled do not count; an idle station shows 0", async () => {
    const response = await summary(cook, tenant.outletId);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const parsed = stationSummarySchema.parse(response.body.data);
    expect(parsed.outletId).toBe(tenant.outletId);
    expect(parsed.tenantId).toBe(tenant.tenantId);
    expect(countsOf(response.body)).toEqual({
      [ids.barA]: 2,
      [ids.kitchenA]: 1,
      [ids.idleA]: 0,
    });
  });

  it("a station-scoped cook gets only their own station", async () => {
    const response = await summary(barista, tenant.outletId);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(countsOf(response.body)).toEqual({ [ids.barA]: 2 });
  });

  it("TEN-03 staff of outlet B get 403 for outlet A and only outlet B's own counts for outlet B", async () => {
    expect((await summary(outletBStaff, tenant.outletId)).status).toBe(403);
    const own = await summary(outletBStaff, ids.outletB);
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(countsOf(own.body)).toEqual({ [ids.barB]: 3 });
  });

  it("TEN-03 a tenant-scope cook reading outlet B sees outlet B's stations only, never outlet A's", async () => {
    const response = await summary(cook, ids.outletB);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(countsOf(response.body)).toEqual({ [ids.barB]: 3 });
  });

  it("TEN-01 another tenant's cook cannot read this tenant's counts and sees only their own", async () => {
    for (const host of [headersB, headers]) {
      const crossed = await summary(tenantBCook, tenant.outletId, host);
      expect([401, 403, 404], String(host.Host)).toContain(crossed.status);
    }
    const own = await summary(tenantBCook, tenantB.outletId, headersB);
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(countsOf(own.body)).toEqual({ [ids.stationX]: 2 });
  });

  it("staff without kds.ticket.process get 403, anonymous callers 401", async () => {
    expect((await summary(noKds, tenant.outletId)).status).toBe(403);
    const anonymous = await agent(app)
      .get(`/api/outlets/${tenant.outletId}/kitchen/station-summary`)
      .set(headers)
      .set(originHeader);
    expect(anonymous.status).toBe(401);
  });

  it("a ticket that finishes leaves the count on the next read", async () => {
    await asOwnerTenant(tenant.tenantId, (client) =>
      client.query(
        `UPDATE kitchen_tickets SET status = 'done', started_at = now(), done_at = now()
         WHERE station_id = $1 AND status = 'recalled'`,
        [ids.kitchenA],
      ),
    );
    const response = await summary(cook, tenant.outletId);
    expect(countsOf(response.body)[ids.kitchenA]).toBe(0);
  });
});
