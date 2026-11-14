// KDS ticket header (bead legend-rutl; PRD v1.7 §3 F12 KDS per station): a
// ticket detail carries the table label and channel of its order, so the
// station screen shows "meja + kode pesanan + kanal" without a second call.
// The table code comes from the order's table session; the channel is the
// order's menu channel (own dine-in or takeaway, or a delivery platform).
//
// Real Express app, Better Auth, RBAC and PostgreSQL with RLS (disposable
// server from `pnpm test`) in fresh isolated tenants. Rows are written as the
// database owner: the header only reads the order.

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ulidToUuid, uuidToUlid } from "@starter/shared/core";
import {
  kitchenStationSnapshotSchema,
  kitchenTicketDetailSchema,
} from "@starter/shared/kitchen";
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
  station: randomUUID(),
  category: randomUUID(),
  menuItem: randomUUID(),
  zone: randomUUID(),
  table: randomUUID(),
  session: randomUUID(),
};

type Member = { client: ReturnType<typeof agent>; userId: string };

let app: Express;
let tenant: IsolatedTenant;
let tenantB: IsolatedTenant;
let headers: { Host: string };
let headersB: { Host: string };
let cook: Member;
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

type Seeded = { ticketId: string };

/** One order (channel, service type, optional table session) with one ticket and one line. */
async function seedTicket(
  channel: string,
  serviceType: string,
  tableSessionId: string | null,
): Promise<Seeded> {
  const orderId = randomUUID();
  const ticketId = randomUUID();
  const orderItemId = randomUUID();
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, table_session_id, payment_mode,
         subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
         status, business_date, placed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pay_first', 20000, 0, 0, 0, 0, 20000,
               'sent', '2026-11-01', now())`,
      [
        orderId,
        tenant.tenantId,
        tenant.outletId,
        `HDR-${randomUUID().slice(0, 8)}`,
        channel,
        serviceType,
        tableSessionId,
      ],
    );
    await client.query(
      `INSERT INTO order_items (id, tenant_id, outlet_id, order_id, menu_item_id, name, quantity,
         unit_price_idr, modifiers_total_idr, line_total_idr, modifiers, fire_status, status, reserved_business_date)
       VALUES ($1, $2, $3, $4, $5, 'Kopi Susu', 1, 20000, 0, 20000, '[]', 'fired', 'queued', '2026-11-01')`,
      [orderItemId, tenant.tenantId, tenant.outletId, orderId, ids.menuItem],
    );
    await client.query(
      `INSERT INTO kitchen_tickets (id, tenant_id, outlet_id, order_id, station_id, fire_batch_id, business_date, ticket_no, status, priority, fired_at)
       VALUES ($1, $2, $3, $4, $5, $6, '2026-11-01', (SELECT coalesce(max(m.ticket_no), 0) + 1 FROM kitchen_tickets m WHERE m.tenant_id = $2::uuid AND m.outlet_id = $3::uuid AND m.business_date = '2026-11-01'), 'new', 0, now())`,
      [
        ticketId,
        tenant.tenantId,
        tenant.outletId,
        orderId,
        ids.station,
        randomUUID(),
      ],
    );
    await client.query(
      `INSERT INTO kitchen_ticket_items (id, tenant_id, outlet_id, ticket_id, order_id, order_item_id, menu_item_id,
         name, quantity, modifiers, status, fired_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'Kopi Susu', 1, '{}', 'queued', now())`,
      [
        randomUUID(),
        tenant.tenantId,
        tenant.outletId,
        ticketId,
        orderId,
        orderItemId,
        ids.menuItem,
      ],
    );
  });
  return { ticketId: uuidToUlid(ticketId) };
}

const base = () => `/api/outlets/${tenant.outletId}/kitchen`;

function ticketOf(who: Member, ticketId: string, host = headers) {
  return who.client
    .get(`${base()}/tickets/${ticketId}`)
    .set(host)
    .set(originHeader);
}

beforeAll(async () => {
  app = createApp();
  tenant = await createIsolatedTenant(`kdshdr-${randomUUID().slice(0, 6)}`);
  tenantB = await createIsolatedTenant(`kdshdrb-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  headersB = { Host: tenantB.hostname };

  await insertRole(
    tenant.tenantId,
    ids.kdsRole,
    "KDS Header Uji",
    ["kds.ticket.process"],
    ["tenant", "outlet", "station"],
  );
  await insertRole(
    tenantB.tenantId,
    ids.kdsRoleB,
    "KDS Header Tenant B",
    ["kds.ticket.process"],
    ["tenant"],
  );
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO stations (id, tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'Bar H', 'beverage_bar')`,
      [ids.station, tenant.tenantId, tenant.outletId],
    );
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Header Uji', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    await client.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id, station_id, station_type)
       VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5, $6, 'beverage_bar')`,
      [
        ids.menuItem,
        tenant.tenantId,
        tenant.brandId,
        ids.category,
        randomUUID(),
        ids.station,
      ],
    );
    await client.query(
      `INSERT INTO floor_zones (id, tenant_id, outlet_id, name, payment_mode, hours)
       VALUES ($1, $2, $3, 'Zona Header', 'pay_first', '[]')`,
      [ids.zone, tenant.tenantId, tenant.outletId],
    );
    await client.query(
      `INSERT INTO tables (id, tenant_id, outlet_id, zone_id, code, capacity, type, layout, status)
       VALUES ($1, $2, $3, $4, 'T-07', 4, 'regular',
               '{"x":10,"y":10,"width":60,"height":60,"rotation":0,"shape":"rect"}', 'occupied')`,
      [ids.table, tenant.tenantId, tenant.outletId, ids.zone],
    );
    await client.query(
      `INSERT INTO table_sessions (id, tenant_id, outlet_id, table_id, pax, payment_mode, status,
         session_token_hash, session_token_sealed)
       VALUES ($1, $2, $3, $4, 2, 'pay_first', 'open', $5, 'sealed')`,
      [
        ids.session,
        tenant.tenantId,
        tenant.outletId,
        ids.table,
        randomUUID().replaceAll("-", "").padEnd(64, "0"),
      ],
    );
  });

  cook = await member(
    tenant,
    ids.kdsRole,
    { type: "tenant", id: null },
    "Hdr Koki",
  );
  tenantBCook = await member(
    tenantB,
    ids.kdsRoleB,
    { type: "tenant", id: null },
    "Hdr Tenant B",
  );
});

afterAll(async () => {
  for (const t of [tenant, tenantB])
    await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      t.tenantId,
      randomUUID(),
    ]);
  await owner.end();
});

describe("legend-rutl KDS ticket header", () => {
  it("a dine-in order on a table shows the table code and the dine_in channel", async () => {
    const { ticketId } = await seedTicket("qr", "dine_in", ids.session);
    const response = await ticketOf(cook, ticketId);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const detail = kitchenTicketDetailSchema.parse(response.body.data);
    expect(detail.tableLabel).toBe("T-07");
    expect(detail.channel).toBe("dine_in");
  });

  it("a counter takeaway has no table and the takeaway channel", async () => {
    const { ticketId } = await seedTicket("pos", "takeaway", null);
    const response = await ticketOf(cook, ticketId);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const detail = kitchenTicketDetailSchema.parse(response.body.data);
    expect(detail.tableLabel).toBeNull();
    expect(detail.channel).toBe("takeaway");
  });

  it("a delivery platform order keeps its platform as the channel", async () => {
    const { ticketId } = await seedTicket("gofood", "delivery", null);
    const response = await ticketOf(cook, ticketId);
    expect(kitchenTicketDetailSchema.parse(response.body.data).channel).toBe(
      "gofood",
    );
  });

  it("the station snapshot carries the same header on every ticket", async () => {
    const response = await cook.client
      .get(`${base()}/stations/${ids.station}/tickets`)
      .set(headers)
      .set(originHeader);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const snapshot = kitchenStationSnapshotSchema.parse(response.body.data);
    expect(snapshot.tickets.map((t) => t.channel).sort()).toEqual([
      "dine_in",
      "gofood",
      "takeaway",
    ]);
    expect(snapshot.tickets.map((t) => t.tableLabel).sort()).toEqual([
      "T-07",
      null,
      null,
    ]);
  });

  it("TEN-01 another tenant's cook cannot read the ticket, so the table label does not leak", async () => {
    const { ticketId } = await seedTicket("qr", "dine_in", ids.session);
    for (const host of [headersB, headers]) {
      const response = await ticketOf(tenantBCook, ticketId, host);
      expect([401, 403, 404]).toContain(response.status);
      expect(JSON.stringify(response.body)).not.toContain("T-07");
    }
    expect(ulidToUuid(ticketId)).toHaveLength(36);
  });
});
