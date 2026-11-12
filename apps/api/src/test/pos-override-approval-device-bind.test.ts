// A PIN approval is bound to the verified device that created it (bead
// legend-fjwxo, Codex 418 finding 3; PRD v1.7 §3 F6 "Override Supervisor",
// AUTH-06). createPosOverride with `options.deviceId` (supervisor PIN typed on
// that POS) must only be replayed and only be consumed (void / discount / ...)
// from the same device. A replay or a consumption from another device, or from
// a caller that names no device, is refused and leaves the approval unspent.
//
// Assumptions (spec silent): (1) the refusal on consumption is the contract's
// VOID_APPROVAL_REQUIRED (fail closed, same as every other approval mismatch);
// (2) a replay from another device is refused with some error (code not
// pinned); (3) an approval that names a device is not usable by a caller with
// no device. An approval created with no device keeps the old behaviour (not
// covered here: pos-order-approval.test.ts).
//
// Fixtures follow apps/api/src/test/pos-order-approval.test.ts and
// staff-override-device-slot.test.ts (isolated tenant, real services, RLS).

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  userIdSchema,
  type ScopedTenantContext,
  type UserId,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { setStaffPin } from "../services/device-pin.service.ts";
import { voidPosOrder } from "../services/pos-order.service.ts";
import { createPosOverride } from "../services/staff-override.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const PIN = "582914";
const KOPI_IDR = 25_000;

const ids = {
  category: randomUUID(),
  kopi: randomUUID(),
  priceList: randomUUID(),
  cashierRole: randomUUID(),
  supervisorRole: randomUUID(),
};

let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
type Member = { client: ReturnType<typeof agent>; userId: string };
let cashier: Member;
let supervisor: Member;
const deviceIssuedAts = new Map<string, number>();

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

async function member(roleId: string, label: string): Promise<Member> {
  const client = agent(app);
  await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, roleId],
  );
  return { client, userId };
}

/** A registered POS device of the outlet. */
async function newDevice(label: string): Promise<string> {
  const id = randomUUID();
  // Registry floor and token share the API host clock; the database VM can
  // run ahead and make a token signed with Date.now() appear stale.
  const issuedAt = Math.floor(Date.now() / 1000);
  await asOwnerTenant(tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
       VALUES ($1, $2, $3, 'pos', $4, $5)`,
      [id, tenant.tenantId, tenant.outletId, label, new Date(issuedAt * 1000)],
    ),
  );
  deviceIssuedAts.set(id, issuedAt);
  return id;
}

function tenantContext(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

/** A fresh, unpaid order the cashier may void. */
async function openOrder(): Promise<{ orderId: string; status: string }> {
  const created = await cashier.client
    .post(`/api/outlets/${encodeURIComponent(tenant.outletId)}/pos/orders`)
    .set(headers)
    .set(originHeader)
    .send({
      idempotencyKey: randomUUID(),
      channel: "pos",
      serviceType: "takeaway",
      items: [{ menuItemId: ids.kopi, quantity: 1, modifierIds: [] }],
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return {
    orderId: created.body.data.id as string,
    status: created.body.data.status as string,
  };
}

async function orderStatus(orderId: string): Promise<string> {
  const res = await cashier.client
    .get(
      `/api/outlets/${encodeURIComponent(tenant.outletId)}/pos/orders/${orderId}`,
    )
    .set(headers)
    .set(originHeader);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data.status as string;
}

/** The supervisor's PIN typed on `deviceId` (the verified device). */
function approveOnDevice(
  orderId: string,
  deviceId: string | null,
  idempotencyKey: string | null = randomUUID(),
) {
  return createPosOverride(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    cashier.userId,
    {
      outletId: tenant.outletId,
      action: "void",
      valueIdr: 1_000_000,
      reason: "Pelanggan salah pesan",
      objectType: "order",
      objectId: orderId,
      approval: {
        method: "supervisor_pin",
        approverUserId: userIdSchema.parse(supervisor.userId),
        pin: PIN,
      },
    } as Parameters<typeof createPosOverride>[2],
    { idempotencyKey, deviceId },
  );
}

/** Void the order as the cashier acting from `deviceId`. */
function voidFrom(
  deviceId: string | null,
  orderId: string,
  status: string,
  overrideId: string,
) {
  return voidPosOrder(
    tenantContext(tenant.tenantId),
    {
      userId: userIdSchema.parse(cashier.userId) as UserId,
      deviceId,
      expectedVersion: null,
    },
    outletIdSchema.parse(tenant.outletId),
    orderId,
    {
      reason: "customer_cancelled" as const,
      reasonNote: "Pelanggan salah pesan",
      expectedStatus: status,
      idempotencyKey: randomUUID(),
      approvedBy: supervisor.userId,
      overrideId,
    } as never,
  );
}

async function usesOf(overrideId: string): Promise<number> {
  const { rows } = await owner.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM pos_order_approval_uses
     WHERE override_id = $1::uuid`,
    [ulidToUuid(overrideId)],
  );
  return Number(rows[0]?.count);
}

async function overridesWithKey(key: string): Promise<number> {
  const { rows } = await owner.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM pos_overrides
     WHERE tenant_id = $1 AND idempotency_key = $2`,
    [tenant.tenantId, key],
  );
  return Number(rows[0]?.count);
}

beforeAll(async () => {
  app = createApp();
  tenant = await createIsolatedTenant(`posdb-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  const roles: [string, string, string[]][] = [
    [
      ids.cashierRole,
      "POS Kasir Uji",
      [
        "order.view",
        "pos.sale.create",
        "pos.payment.accept",
        "pos.discount.apply",
        "pos.void.request",
        "pos.refund.request",
      ],
    ],
    [
      ids.supervisorRole,
      "POS Supervisor Uji",
      [
        "order.view",
        "pos.void.approve",
        "pos.refund.approve",
        "pos.discount.approve",
      ],
    ],
  ];
  for (const [id, name, permissions] of roles)
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant"]')`,
      [id, tenant.tenantId, name, JSON.stringify(permissions)],
    );
  cashier = await member(ids.cashierRole, "Bind Kasir");
  supervisor = await member(ids.supervisorRole, "Bind Supervisor");
  await setStaffPin(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    supervisor.userId,
    { outletId: tenant.outletId, userId: supervisor.userId },
    { pin: PIN },
  );
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'POS Device Bind', 0)`,
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
      [randomUUID(), tenant.tenantId, supervisor.userId],
    );
    await client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-POS', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, supervisor.userId],
    );
  });
});

afterAll(async () => {
  // Isolated tenants stay in the disposable database (audit is append-only);
  // give them a valid creator so the platform tenant list still parses them.
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

describe("legend-fjwxo PIN approval is bound to the verified device", () => {
  it("legend-fjwxo an approval made on device A cannot be consumed from device B, and stays unspent for A", async () => {
    const deviceA = await newDevice("Kasir A");
    const deviceB = await newDevice("Kasir B");
    const { orderId, status } = await openOrder();
    const { override } = await approveOnDevice(orderId, deviceA);

    await expect(
      voidFrom(deviceB, orderId, status, override.id),
    ).rejects.toMatchObject({ code: "VOID_APPROVAL_REQUIRED" });
    expect(await orderStatus(orderId)).toBe(status);
    expect(await usesOf(override.id)).toBe(0);

    // The refused try did not burn it: the device that made it still can.
    const voided = await voidFrom(deviceA, orderId, status, override.id);
    expect(voided.status).toBe("voided");
    expect(await usesOf(override.id)).toBe(1);
  });

  it("legend-fjwxo an approval made on a device is refused for a caller that names no device", async () => {
    const deviceA = await newDevice("Kasir A2");
    const { orderId, status } = await openOrder();
    const { override } = await approveOnDevice(orderId, deviceA);

    await expect(
      voidFrom(null, orderId, status, override.id),
    ).rejects.toMatchObject({ code: "VOID_APPROVAL_REQUIRED" });
    expect(await usesOf(override.id)).toBe(0);
    expect((await voidFrom(deviceA, orderId, status, override.id)).status).toBe(
      "voided",
    );
  });

  it("legend-fjwxo replaying the same approval request (same key, same body) from another device is refused; from the same device it returns the stored approval", async () => {
    const deviceA = await newDevice("Kasir A3");
    const deviceB = await newDevice("Kasir B3");
    const { orderId } = await openOrder();
    const key = randomUUID();
    const first = await approveOnDevice(orderId, deviceA, key);
    expect(first.replayed).toBe(false);

    const sameDevice = await approveOnDevice(orderId, deviceA, key);
    expect(sameDevice).toMatchObject({
      replayed: true,
      override: { id: first.override.id },
    });

    const fromB = await approveOnDevice(orderId, deviceB, key).then(
      (result) => ({ result, error: null }),
      (error: unknown) => ({ result: null, error }),
    );
    // Never hands device B the approval id.
    expect(fromB.result, "replay from device B").toBeNull();
    expect(fromB.error).toBeInstanceOf(Error);
    expect(await overridesWithKey(key)).toBe(1);
  });

  it("legend-fjwxo parallel consumption of one approval from devices A, B and C: only A succeeds", async () => {
    const deviceA = await newDevice("Kasir A4");
    const deviceB = await newDevice("Kasir B4");
    const deviceC = await newDevice("Kasir C4");
    const { orderId, status } = await openOrder();
    const { override } = await approveOnDevice(orderId, deviceA);

    const results = await Promise.allSettled([
      voidFrom(deviceB, orderId, status, override.id),
      voidFrom(deviceA, orderId, status, override.id),
      voidFrom(deviceC, orderId, status, override.id),
    ]);
    expect(results.map((r) => r.status)).toEqual([
      "rejected",
      "fulfilled",
      "rejected",
    ]);
    expect(await orderStatus(orderId)).toBe("voided");
    expect(await usesOf(override.id)).toBe(1);
  });

  // The tenant of a request on a brand domain resolves with source "domain",
  // not "device"; creation and consumption must still read the same signed
  // device (one helper for both sides).
  it("legend-fjwxo an approval created over HTTP on a brand domain with device A's token is bound to A: refused for B, spent once by A", async () => {
    const deviceA = await newDevice("Kasir A5");
    const deviceB = await newDevice("Kasir B5");
    const { orderId, status } = await openOrder();
    const issuedAt = deviceIssuedAts.get(deviceA);
    if (issuedAt === undefined)
      throw new Error("Device fixture was not registered");
    const created = await cashier.client
      .post("/api/pos-overrides")
      .set(headers)
      .set(originHeader)
      .set(
        DEVICE_TOKEN_HEADER,
        signDeviceToken({
          version: 1,
          issuedAt,
          tenantId: tenant.tenantId,
          brandId: null,
          deviceId: deviceA,
        }),
      )
      .set("Idempotency-Key", randomUUID())
      .send({
        outletId: tenant.outletId,
        action: "void",
        valueIdr: 1_000_000,
        reason: "Pelanggan salah pesan",
        objectType: "order",
        objectId: orderId,
        approval: {
          method: "supervisor_pin",
          approverUserId: supervisor.userId,
          pin: PIN,
        },
      });
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
    const overrideId = created.body.data.id as string;
    expect(typeof overrideId).toBe("string");

    await expect(
      voidFrom(deviceB, orderId, status, overrideId),
    ).rejects.toMatchObject({ code: "VOID_APPROVAL_REQUIRED" });
    expect(await usesOf(overrideId)).toBe(0);
    expect((await voidFrom(deviceA, orderId, status, overrideId)).status).toBe(
      "voided",
    );
  });
});
