// legend-3k8no: replay of an Idempotency-Key whose stored response predates
// legend-63l6 (order detail WITHOUT `version`). The route must refresh the
// order snapshot from the current row so the body still satisfies the shared
// response schema, the ETag equals the body version, and nothing is repeated.
//
// Real Express app, Better Auth, RBAC and PostgreSQL with RLS in a fresh
// isolated tenant (same setup as pos-order-version.test.ts).

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  idr,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  userIdSchema,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  addPosTender,
  createPosOrder,
  submitPosOrder,
  type PosReceipt,
} from "@starter/shared/pos";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { setDeviceOutletResolver } from "../services/device-pin.service.ts";
import {
  setPosReceiptPort,
  type PosReceiptPort,
} from "../services/pos-order-ports.ts";
import { openPosShift } from "../services/pos-shift.service.ts";
import { registerTestDevice } from "./device-seed.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const KOPI_IDR = 25_000;
const PARTIAL_CASH_IDR = 5_000;

const ids = {
  category: randomUUID(),
  kopi: randomUUID(),
  priceList: randomUUID(),
  cashierRole: randomUUID(),
  deviceA: randomUUID(),
};

type Terminal = {
  client: ReturnType<typeof agent>;
  userId: string;
  deviceId: string;
};

let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
let terminalA: Terminal;

/** Minimal gapless receipt double, as in pos-order.test.ts (port of legend-93a). */
function memoryReceiptPort(): PosReceiptPort {
  const byOrder = new Map<string, PosReceipt>();
  let sequence = 0;
  return {
    async issueForSale(_tx, context, input) {
      const existing = byOrder.get(input.orderId);
      if (existing) return existing;
      sequence += 1;
      const receipt = {
        id: randomUUID(),
        tenantId: context.tenant.tenantId,
        outletId: input.outletId,
        orderId: input.orderId,
        deviceId: input.deviceId ?? ids.deviceA,
        number: `POS1-${String(sequence).padStart(6, "0")}`,
        sequenceNumber: sequence,
        status: "issued",
        issuedAt: input.at.toISOString(),
        voidedAt: null,
        voidReason: null,
        voidedBy: null,
        reprintCount: 0,
      } as unknown as PosReceipt;
      byOrder.set(input.orderId, receipt);
      return receipt;
    },
    async findForOrder(_tx, _context, orderId) {
      return byOrder.get(orderId) ?? null;
    },
    async voidForOrder() {
      return null;
    },
  };
}

async function terminal(deviceId: string, label: string): Promise<Terminal> {
  const client = agent(app);
  await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, ids.cashierRole],
  );
  await openPosShift(
    establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(tenant.tenantId),
        brandId: null,
        source: "session",
      }),
      { kind: "tenant" },
    ),
    { userId: userIdSchema.parse(userId), deviceId },
    outletIdSchema.parse(tenant.outletId),
    { openingFloatIdr: idr(100_000), idempotencyKey: randomUUID() },
  );
  return { client, userId, deviceId };
}

function ordersBase() {
  return `/api/outlets/${encodeURIComponent(tenant.outletId)}/pos/orders`;
}

function deviceToken(deviceId: string) {
  return signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: tenant.tenantId,
    brandId: null,
    deviceId,
  });
}

/** Terminal-scoped calls; every request carries the terminal's device token. */
function on(who: Terminal) {
  const authed = (request: ReturnType<typeof who.client.post>) =>
    request
      .set(headers)
      .set(originHeader)
      .set(DEVICE_TOKEN_HEADER, deviceToken(who.deviceId));
  return {
    create: (idempotencyKey = randomUUID()) =>
      authed(who.client.post(ordersBase())).send({
        idempotencyKey,
        channel: "pos",
        serviceType: "takeaway",
        items: [{ menuItemId: ids.kopi, quantity: 2, modifierIds: [] }],
      }),
    get: (orderId: string) =>
      who.client
        .get(`${ordersBase()}/${orderId}`)
        .set(headers)
        .set(originHeader)
        .set(DEVICE_TOKEN_HEADER, deviceToken(who.deviceId)),
    submit: (orderId: string, expectedStatus: string, idempotencyKey: string) =>
      authed(who.client.post(`${ordersBase()}/${orderId}/submit`)).send({
        idempotencyKey,
        expectedStatus,
      }),
    /** A partial cash tender: bumps the version, keeps the status. */
    partialCash: (
      orderId: string,
      expectedStatus: string,
      idempotencyKey: string,
    ) =>
      authed(who.client.post(`${ordersBase()}/${orderId}/tenders`)).send({
        idempotencyKey,
        method: "cash",
        receivedIdr: PARTIAL_CASH_IDR,
        expectedStatus,
      }),
  };
}

async function count(table: string, orderId: string): Promise<number> {
  const { rows } = await owner.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${table}
     WHERE tenant_id = $1 AND order_id = $2::uuid`,
    [tenant.tenantId, ulidToUuid(orderId)],
  );
  return Number(rows[0]?.count);
}

/** Rewrites the stored answer into its pre-legend-63l6 shape: no `version`. */
async function stripStoredVersion(key: string) {
  const { rowCount } = await owner.query(
    `UPDATE pos_order_idempotency
        SET response = (response - 'version') #- '{order,version}'
      WHERE tenant_id = $1 AND outlet_id = $2 AND key = $3`,
    [tenant.tenantId, tenant.outletId, key],
  );
  expect(rowCount).toBe(1);
  const { rows } = await owner.query<{ response: Record<string, unknown> }>(
    `SELECT response FROM pos_order_idempotency
      WHERE tenant_id = $1 AND outlet_id = $2 AND key = $3`,
    [tenant.tenantId, tenant.outletId, key],
  );
  const stored = rows[0]?.response ?? {};
  const holder = (stored.order ?? stored) as Record<string, unknown>;
  expect("version" in holder).toBe(false);
}

beforeAll(async () => {
  app = createApp();
  setPosReceiptPort(memoryReceiptPort());
  tenant = await createIsolatedTenant(`poslegacy-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  setDeviceOutletResolver(async ({ tenantId, deviceId }) =>
    tenantId === tenant.tenantId && deviceId === ids.deviceA
      ? tenant.outletId
      : null,
  );
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'POS Kasir Replay', false, NULL, $3, false, '["tenant"]')`,
    [
      ids.cashierRole,
      tenant.tenantId,
      JSON.stringify([
        "order.view",
        "pos.sale.create",
        "pos.payment.accept",
        "pos.discount.apply",
        "shift.cash.operate",
      ]),
    ],
  );
  await registerTestDevice(owner, {
    tenantId: tenant.tenantId,
    outletId: tenant.outletId,
    deviceId: ids.deviceA,
  });
  terminalA = await terminal(ids.deviceA, "POS Kasir Replay");

  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.tenantId],
    );
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'POS Uji', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    await client.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5)`,
      [ids.kopi, tenant.tenantId, tenant.brandId, ids.category, randomUUID()],
    );
    await client.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'takeaway', '2026-01-01')`,
      [ids.priceList, tenant.tenantId, tenant.outletId],
    );
    await client.query(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), tenant.tenantId, ids.priceList, ids.kopi, KOPI_IDR],
    );
    await client.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, terminalA.userId],
    );
    await client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-POS', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, terminalA.userId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

afterAll(async () => {
  setPosReceiptPort(null);
  setDeviceOutletResolver(null);
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

describe("POS order legacy idempotency replay (legend-3k8no)", () => {
  it("create replay without a stored version is refreshed from the current order", async () => {
    const key = randomUUID();
    const created = await on(terminalA).create(key);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const orderId = created.body.data.id as string;
    const status = created.body.data.status as string;

    await stripStoredVersion(key);
    // A later write moves the order past the version the replay would show.
    const key2 = randomUUID();
    const submitted =
      status === "draft"
        ? await on(terminalA).submit(orderId, "draft", key2)
        : await on(terminalA).partialCash(orderId, status, key2);
    expect(submitted.status, JSON.stringify(submitted.body)).toBeLessThan(300);
    const current = await on(terminalA).get(orderId);
    expect(current.status).toBe(200);
    const currentVersion = current.body.data.version as number;
    const eventsBefore = await count("order_events", orderId);

    const replay = await on(terminalA).create(key);
    expect(replay.status, JSON.stringify(replay.body)).toBe(201);
    const parsed = createPosOrder.response.parse(replay.body);
    expect(parsed.data.id).toBe(orderId);
    expect(parsed.data.version).toBe(currentVersion);
    expect(replay.headers.etag).toBe(`"${currentVersion}"`);
    expect(await count("order_events", orderId)).toBe(eventsBefore);
  });

  it("submit replay without a stored version is refreshed and not repeated", async () => {
    const created = await on(terminalA).create();
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const orderId = created.body.data.id as string;
    expect(created.body.data.status).toBe("draft");

    const key = randomUUID();
    const first = await on(terminalA).submit(orderId, "draft", key);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    await stripStoredVersion(key);
    const eventsBefore = await count("order_events", orderId);

    const replay = await on(terminalA).submit(orderId, "draft", key);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    const parsed = submitPosOrder.response.parse(replay.body);
    expect(parsed.data.version).toBe(
      Number(replay.headers.etag.replace(/"/g, "")),
    );
    const current = await on(terminalA).get(orderId);
    expect(parsed.data.version).toBe(current.body.data.version);
    expect(await count("order_events", orderId)).toBe(eventsBefore);
  });

  it("tender replay without order.version is refreshed to the current version and the tender is not repeated", async () => {
    const created = await on(terminalA).create();
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const orderId = created.body.data.id as string;
    let status = created.body.data.status as string;
    if (status === "draft") {
      const submitted = await on(terminalA).submit(
        orderId,
        "draft",
        randomUUID(),
      );
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
      status = submitted.body.data.status as string;
    }

    const key = randomUUID();
    const first = await on(terminalA).partialCash(orderId, status, key);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    await stripStoredVersion(key);
    // A second tender moves the order past the stored snapshot.
    const second = await on(terminalA).partialCash(
      orderId,
      status,
      randomUUID(),
    );
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    const current = await on(terminalA).get(orderId);
    const currentVersion = current.body.data.version as number;
    expect(currentVersion).toBeGreaterThan(first.body.data.order.version);
    expect(await count("pos_order_tenders", orderId)).toBe(2);
    const eventsBefore = await count("order_events", orderId);

    const replay = await on(terminalA).partialCash(orderId, status, key);
    expect(replay.status, JSON.stringify(replay.body)).toBe(201);
    const parsed = addPosTender.response.parse(replay.body);
    expect(parsed.data.order.version).toBe(
      Number(replay.headers.etag.replace(/"/g, "")),
    );
    expect(parsed.data.order.version).toBe(currentVersion);
    expect(parsed.data.tender.id).toBe(first.body.data.tender.id);
    expect(await count("pos_order_tenders", orderId)).toBe(2);
    expect(await count("order_events", orderId)).toBe(eventsBefore);
  });
});
