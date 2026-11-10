// POS cashier switch by PIN (bead legend-aruta). Claim: the switch used to be
// client-only, so POS writes after it were still recorded for the SESSION user
// A, not for cashier B who typed the PIN. Now B's PIN buys a server-side
// "acting cashier" token (POST /api/staff-pins/pos-session) that the device
// sends as X-Acting-Staff on POS calls; shift, order, tender and audit actor
// must then be B. Without a real token the switch cannot be expressed, so test
// 1 is RED until the server binds the switch.
// Device requests = A's session cookie + origin + Host + signed X-Device-Token.
// Fixtures follow pos-order-approval.test.ts (isolated tenant, real app, RLS DB).

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenantIdSchema, ulidToUuid } from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const PIN = "582914";
const WRONG = "907153";
const [category, kopi, priceList, role, device] = [1, 2, 3, 4, 5].map(() =>
  randomUUID(),
) as [string, string, string, string, string];

type Member = { client: ReturnType<typeof agent>; userId: string };
let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
let memberA: Member; // logged-in session on the till
let memberB: Member; // cashier who switches in with a PIN
let memberC: Member; // wrong-PIN test only

async function asOwnerTenant<T>(
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.tenantId],
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

async function member(label: string): Promise<Member> {
  const client = agent(app);
  await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, role],
  );
  return { client, userId };
}

const tenantCtx = () =>
  establishTenantContext({
    tenantId: tenantIdSchema.parse(tenant.tenantId),
    brandId: null,
    source: "session",
  });

const deviceToken = () =>
  signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: tenant.tenantId,
    brandId: null,
    deviceId: device,
  });

/** The device keeps calling with A's session cookie plus the acting-cashier token. */
function posCall(
  path: string,
  body: Record<string, unknown>,
  actingToken: string,
) {
  return memberA.client
    .post(`/api/outlets/${encodeURIComponent(tenant.outletId)}/pos/${path}`)
    .set(headers)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, deviceToken())
    .set("X-Acting-Staff", actingToken)
    .send({ idempotencyKey: randomUUID(), ...body });
}

/** The cashier types a PIN on the device tile; the session user's login asks the server to switch. */
function switchCashier(userId: string, pin: string) {
  return memberA.client
    .post("/api/staff-pins/pos-session")
    .set(headers)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, deviceToken())
    .send({ userId, pin });
}

/** Columns of a row that name a person, as [column, value]. */
function actorColumns(row: Record<string, unknown> | undefined) {
  return Object.entries(row ?? {}).filter(
    ([key, value]) =>
      typeof value === "string" &&
      /(created_by|cashier|actor|opened_by|captured_by)/i.test(key),
  );
}

async function actorsOf(table: string, column: string, value: string) {
  const { rows } = await owner.query<{ row: Record<string, unknown> }>(
    `SELECT to_jsonb(t) AS row FROM ${table} t
     WHERE tenant_id = $1 AND ${column} = $2::uuid`,
    [tenant.tenantId, value],
  );
  return actorColumns(rows[0]?.row);
}

async function count(table: string) {
  const sql = `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`;
  return (await owner.query(sql, [tenant.tenantId])).rows[0].n as number;
}

beforeAll(async () => {
  app = createApp();
  tenant = await createIsolatedTenant(`swch-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  setDeviceOutletResolver(async ({ tenantId, deviceId }) =>
    tenantId === tenant.tenantId && deviceId === device
      ? tenant.outletId
      : null,
  );
  const perms =
    '["order.view","pos.sale.create","pos.payment.accept","shift.cash.operate"]';
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types) VALUES ('${role}', '${tenant.tenantId}', 'POS Kasir Uji', false, NULL, '${perms}', false, '["tenant"]')`,
  );
  memberA = await member("Sesi Kasir A");
  memberB = await member("Kasir B PIN");
  memberC = await member("Kasir C PIN");
  for (const who of [memberB, memberC])
    await setStaffPin(
      tenantCtx(),
      who.userId,
      { outletId: tenant.outletId, userId: who.userId },
      { pin: PIN },
    );
  const { tenantId: t, brandId: b, outletId: o } = tenant;
  const u = memberA.userId;
  // One multi-statement seed (no params): device registry row so verify accepts
  // the token, a priced menu item and a 10% PBJT rule so an order can be priced.
  await asOwnerTenant((client) =>
    client.query(`
      INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at) VALUES ('${device}', '${t}', '${o}', 'pos', 'Kasir PIN', now() - interval '1 minute');
      INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order) VALUES ('${category}', '${t}', '${b}', 'POS Switch', 0);
      INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id) VALUES ('${kopi}', '${t}', '${b}', '${category}', 'Kopi Susu', true, '${randomUUID()}');
      INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from) VALUES ('${priceList}', '${t}', '${o}', 'takeaway', '2026-01-01');
      INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr) VALUES ('${randomUUID()}', '${t}', '${priceList}', '${kopi}', 25000);
      INSERT INTO tax_settings (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode, tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation, version, effective_from, status, published_at, published_by) VALUES ('${randomUUID()}', '${t}', NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL, 'fixed_bp', 1, '2026-01-01', 'published', now(), '${u}');
      INSERT INTO tax_rules (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to, price_includes_tax, include_service_in_base, is_active, version, effective_from, status, published_at, published_by) VALUES ('${randomUUID()}', '${t}', NULL, 'PBJT-POS', 'PBJT 10%', 'pbjt', 1000, NULL, '[]', '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}', false, true, true, 1, '2026-01-01', 'published', now(), '${u}');
    `),
  );
});

afterAll(async () => {
  setDeviceOutletResolver(null);
  const sql = "UPDATE tenants SET created_by = $2 WHERE id = $1";
  await owner.query(sql, [tenant.tenantId, randomUUID()]);
  await owner.end();
});

describe("POS cashier switch by PIN (legend-aruta)", () => {
  it("after B verifies a PIN on the device, shift, order and tender are recorded for B, not for session user A", async () => {
    const switched = await switchCashier(memberB.userId, PIN);
    expect(switched.status, JSON.stringify(switched.body)).toBe(201);
    const acting = switched.body.data.token as string;

    const shift = await posCall("shifts", { openingFloatIdr: 100_000 }, acting);
    expect(shift.status, JSON.stringify(shift.body)).toBe(201);
    const created = await posCall(
      "orders",
      {
        channel: "pos",
        serviceType: "takeaway",
        items: [{ menuItemId: kopi, quantity: 1, modifierIds: [] }],
      },
      acting,
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const orderId = created.body.data.id as string;
    let status = created.body.data.status as string;
    if (status === "draft") {
      const submitted = await posCall(
        `orders/${orderId}/submit`,
        { expectedStatus: status },
        acting,
      );
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
      status = submitted.body.data.status as string;
    }
    const paid = await posCall(
      `orders/${orderId}/tenders`,
      { method: "cash", receivedIdr: 100_000, expectedStatus: status },
      acting,
    );
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);

    const orderUuid = ulidToUuid(orderId);
    const recorded = {
      shift: await actorsOf("pos_shifts", "id", shift.body.data.id),
      order: await actorsOf("orders", "id", orderUuid),
      tender: await actorsOf("pos_order_tenders", "order_id", orderUuid),
      audit: await asOwnerTenant(async (client) => {
        const { rows } = await client.query<{ event: Record<string, unknown> }>(
          `SELECT event FROM audit_logs
           WHERE tenant_id = $1 AND event::text LIKE $2`,
          [tenant.tenantId, `%${shift.body.data.id}%`],
        );
        return rows.flatMap((row) =>
          actorColumns(row.event).filter(([key]) => key === "actorId"),
        );
      }),
    };
    const message = `switched cashier B=${memberB.userId}, session user A=${memberA.userId}; recorded actors: ${JSON.stringify(recorded)}`;
    // Guard against a vacuous pass: the shift owner column must be readable.
    expect(recorded.shift.length, message).toBeGreaterThan(0);
    for (const [name, columns] of Object.entries(recorded))
      expect(columns, `${name} actor must be B. ${message}`).toEqual(
        columns.map(([key]) => [key, memberB.userId]),
      );
  });

  it("a wrong PIN is refused and changes nothing: same session user, no shift, no order", async () => {
    const shiftsBefore = await count("pos_shifts");
    const ordersBefore = await count("orders");
    const wrong = await switchCashier(memberC.userId, WRONG);
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe("PIN_INVALID");
    const session = await memberA.client.get("/api/auth/get-session");
    expect(session.body.user.id).toBe(memberA.userId);
    expect(await count("pos_shifts")).toBe(shiftsBefore);
    expect(await count("orders")).toBe(ordersBefore);
  });
});
