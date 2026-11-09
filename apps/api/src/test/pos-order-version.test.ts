// legend-63l6: optimistic concurrency for POS order writes. Two terminals in
// the same outlet hold the same order at version v. Once terminal A writes,
// terminal B's write that still states v is a stale write and must be
// refused with 412 PRECONDITION_FAILED, leaving the order as A made it.
//
// Contract under test (section C of the brief):
//   - the order response exposes `version` (integer, bumped by every write);
//   - mutating order bodies accept an optional `expectedVersion`;
//   - `If-Match: "v"` is the equivalent header form;
//   - body and header both present but different -> 412;
//   - neither present -> no version check (legacy clients keep working).
//
// Assumptions (the spec text does not pin these down):
//   - The mutation used is a PARTIAL cash tender (Rp5.000 of a Rp55.000
//     sale). It bumps the version but keeps the order status, so B's stale
//     write carries the same `expectedStatus` as A's and only the version can
//     reject it. The test asserts the status really did not change.
//   - Each terminal has its own cashier with an open shift on that device
//     (cash tenders need the acting cashier's open shift on the device).
//   - The tender response carries the updated order as `data.order`.
//
// Real Express app, Better Auth, RBAC and PostgreSQL with RLS in a fresh
// isolated tenant (same setup as pos-order.test.ts).

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
import type { PosReceipt } from "@starter/shared/pos";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { setDeviceOutletResolver } from "../services/device-pin.service.ts";
import {
  setPosReceiptPort,
  type PosReceiptPort,
} from "../services/pos-order-ports.ts";
import { openPosShift } from "../services/pos-shift.service.ts";
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
  deviceB: randomUUID(),
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
let terminalB: Terminal;

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

/** Terminal-scoped calls; every request carries that terminal's device token. */
function on(who: Terminal) {
  const authed = (request: ReturnType<typeof who.client.post>) =>
    request
      .set(headers)
      .set(originHeader)
      .set(DEVICE_TOKEN_HEADER, deviceToken(who.deviceId));
  return {
    create: () =>
      authed(who.client.post(ordersBase())).send({
        idempotencyKey: randomUUID(),
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
    submit: (orderId: string, expectedStatus: string) =>
      authed(who.client.post(`${ordersBase()}/${orderId}/submit`)).send({
        idempotencyKey: randomUUID(),
        expectedStatus,
      }),
    /** A write that bumps the version but keeps the status. */
    partialCash: (
      orderId: string,
      expectedStatus: string,
      extra: {
        expectedVersion?: number;
        ifMatch?: string;
        idempotencyKey?: string;
      } = {},
    ) => {
      const request = authed(
        who.client.post(`${ordersBase()}/${orderId}/tenders`),
      );
      if (extra.ifMatch !== undefined) request.set("If-Match", extra.ifMatch);
      return request.send({
        idempotencyKey: extra.idempotencyKey ?? randomUUID(),
        method: "cash",
        receivedIdr: PARTIAL_CASH_IDR,
        expectedStatus,
        ...(extra.expectedVersion === undefined
          ? {}
          : { expectedVersion: extra.expectedVersion }),
      });
    },
  };
}

/** A fresh order that both terminals have read: status s, version v. */
async function sharedOrder(): Promise<{
  orderId: string;
  status: string;
  version: number;
  totalIdr: number;
}> {
  const created = await on(terminalA).create();
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const orderId = created.body.data.id as string;
  if (created.body.data.status === "draft") {
    const submitted = await on(terminalA).submit(orderId, "draft");
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
  }
  // Both terminals open the order and see the same state.
  const seenByA = await on(terminalA).get(orderId);
  const seenByB = await on(terminalB).get(orderId);
  expect(seenByA.status).toBe(200);
  expect(seenByB.status).toBe(200);
  expect(typeof seenByA.body.data.version).toBe("number");
  expect(seenByB.body.data.version).toBe(seenByA.body.data.version);
  expect(seenByB.body.data.status).toBe(seenByA.body.data.status);
  return {
    orderId,
    status: seenByA.body.data.status as string,
    version: seenByA.body.data.version as number,
    totalIdr: seenByA.body.data.totalIdr as number,
  };
}

async function tenderCount(orderId: string): Promise<number> {
  const { rows } = await owner.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM pos_order_tenders
     WHERE tenant_id = $1 AND order_id = $2::uuid`,
    [tenant.tenantId, ulidToUuid(orderId)],
  );
  return Number(rows[0]?.count);
}

/** Order, version and tender count are exactly as before B's refused write. */
async function expectUntouched(
  orderId: string,
  expected: { version: number; status: string; tenders: number },
) {
  const read = await on(terminalA).get(orderId);
  expect(read.status).toBe(200);
  expect(read.body.data.version).toBe(expected.version);
  expect(read.body.data.status).toBe(expected.status);
  expect(await tenderCount(orderId)).toBe(expected.tenders);
}

beforeAll(async () => {
  app = createApp();
  setPosReceiptPort(memoryReceiptPort());
  tenant = await createIsolatedTenant(`posver-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  setDeviceOutletResolver(async ({ tenantId, deviceId }) =>
    tenantId === tenant.tenantId &&
    (deviceId === ids.deviceA || deviceId === ids.deviceB)
      ? tenant.outletId
      : null,
  );
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'POS Kasir Versi', false, NULL, $3, false, '["tenant"]')`,
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
  terminalA = await terminal(ids.deviceA, "POS Kasir A");
  terminalB = await terminal(ids.deviceB, "POS Kasir B");

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

describe("POS order expectedVersion (legend-63l6)", () => {
  it("an order read exposes its integer version", async () => {
    const { version } = await sharedOrder();
    expect(Number.isInteger(version)).toBe(true);
    expect(version).toBeGreaterThanOrEqual(0);
  });

  it("(1) terminal A writes with the version it read: accepted, version goes up", async () => {
    const { orderId, status, version } = await sharedOrder();
    const written = await on(terminalA).partialCash(orderId, status, {
      expectedVersion: version,
    });
    expect(written.status, JSON.stringify(written.body)).toBe(201);
    expect(written.body.data.order.status).toBe(status);
    expect(written.body.data.order.version).toBeGreaterThan(version);
  });

  it("(2) terminal B's write with the same status and the stale body version is refused 412 and changes nothing", async () => {
    const { orderId, status, version } = await sharedOrder();
    const first = await on(terminalA).partialCash(orderId, status, {
      expectedVersion: version,
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    // Precondition of the scenario: only the version differs for B.
    expect(first.body.data.order.status).toBe(status);
    const afterA = first.body.data.order.version as number;

    const stale = await on(terminalB).partialCash(orderId, status, {
      expectedVersion: version,
    });
    expect(stale.status, JSON.stringify(stale.body)).toBe(412);
    expect(stale.body.error?.code ?? stale.body.code).toBe(
      "PRECONDITION_FAILED",
    );
    await expectUntouched(orderId, { version: afterA, status, tenders: 1 });
  });

  it("(3) the same stale write through If-Match is refused 412 and changes nothing", async () => {
    const { orderId, status, version } = await sharedOrder();
    const first = await on(terminalA).partialCash(orderId, status, {
      ifMatch: `"${version}"`,
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.data.order.status).toBe(status);
    const afterA = first.body.data.order.version as number;
    expect(afterA).toBeGreaterThan(version);

    const stale = await on(terminalB).partialCash(orderId, status, {
      ifMatch: `"${version}"`,
    });
    expect(stale.status, JSON.stringify(stale.body)).toBe(412);
    expect(stale.body.error?.code ?? stale.body.code).toBe(
      "PRECONDITION_FAILED",
    );
    await expectUntouched(orderId, { version: afterA, status, tenders: 1 });
  });

  it("(4) a legacy client with neither expectedVersion nor If-Match still succeeds, even after another terminal wrote", async () => {
    const { orderId, status } = await sharedOrder();
    const first = await on(terminalA).partialCash(orderId, status);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.data.order.status).toBe(status);
    const second = await on(terminalB).partialCash(orderId, status);
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(await tenderCount(orderId)).toBe(2);
  });

  it("(5) a body expectedVersion that disagrees with If-Match is refused 412 and changes nothing", async () => {
    const { orderId, status, version } = await sharedOrder();
    // The order is still at `version`, so only the disagreement can refuse it.
    const conflicting = await on(terminalA).partialCash(orderId, status, {
      expectedVersion: version,
      ifMatch: `"${version + 1}"`,
    });
    expect(conflicting.status, JSON.stringify(conflicting.body)).toBe(412);
    expect(conflicting.body.error?.code ?? conflicting.body.code).toBe(
      "PRECONDITION_FAILED",
    );
    await expectUntouched(orderId, { version, status, tenders: 0 });
  });

  it("(5b) body and If-Match that agree are accepted", async () => {
    const { orderId, status, version } = await sharedOrder();
    const agreed = await on(terminalA).partialCash(orderId, status, {
      expectedVersion: version,
      ifMatch: `"${version}"`,
    });
    expect(agreed.status, JSON.stringify(agreed.body)).toBe(201);
  });

  // Assumption: a retry with the same idempotency key is a replay of the
  // stored answer. The replay must not re-check the precondition against the
  // now-bumped version, and must not depend on how the client states it
  // (If-Match on the first call, body expectedVersion on the retry).
  it("(6) a retry with the same idempotency key replays the stored answer, even when the version is stated differently", async () => {
    const { orderId, status, version } = await sharedOrder();
    const idempotencyKey = randomUUID();
    const first = await on(terminalA).partialCash(orderId, status, {
      ifMatch: `"${version}"`,
      idempotencyKey,
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const afterFirst = first.body.data.order.version as number;
    expect(afterFirst).toBeGreaterThan(version);

    // Same key, same stale version, now in the body and without the header.
    const retry = await on(terminalA).partialCash(orderId, status, {
      expectedVersion: version,
      idempotencyKey,
    });
    expect(retry.status, JSON.stringify(retry.body)).toBe(first.status);
    expect(retry.status).not.toBe(409);
    expect(retry.status).not.toBe(412);
    expect(retry.body.data.order.id).toBe(first.body.data.order.id);
    expect(retry.body.data.order.version).toBe(afterFirst);
    expect(retry.body.data.tender?.id).toBe(first.body.data.tender?.id);
    // The retry created nothing and bumped nothing.
    await expectUntouched(orderId, { version: afterFirst, status, tenders: 1 });
  });
});
