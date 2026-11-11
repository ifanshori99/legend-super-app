// POS approvals carry the pos_override id (bead legend-0gy1). A void, void
// item, linked correction or manual discount names the exact `pos_overrides`
// row (ULID) it was approved by; the service loads that row only (no "newest
// unused PIN override" guess), checks it is fresh by the injected clock, single
// use and for this action/object/requester/approver, and stores the override
// id (plus the WS-01 chain id, null for a PIN) on rows, events and audit.
//
// Fixtures follow apps/api/src/test/pos-order.test.ts (isolated tenant, real
// PIN override service, real Express app and RLS database).

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createUlid,
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
import {
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@starter/shared/events";
import { approvalResolvedEvent } from "@starter/shared/identity";
import { createApp } from "../app.ts";
import { handleApprovalResolved } from "../services/staff-override-consumers.ts";
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
const MINUTE = 60_000;

const ids = {
  category: randomUUID(),
  kopi: randomUUID(),
  priceList: randomUUID(),
  cashierRole: randomUUID(),
  supervisorRole: randomUUID(),
};

let app: Express;
let tenant: IsolatedTenant;
let otherTenant: IsolatedTenant;
let headers: { Host: string };
type Member = { client: ReturnType<typeof agent>; userId: string };
let cashier: Member;
let otherCashier: Member;
let supervisor: Member;

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

function pos(who: Member = cashier) {
  const base = `/api/outlets/${encodeURIComponent(tenant.outletId)}/pos/orders`;
  const send = (path: string, body: Record<string, unknown>) =>
    who.client
      .post(`${base}${path}`)
      .set(headers)
      .set(originHeader)
      .send({ idempotencyKey: randomUUID(), ...body });
  return {
    create: (items = 2) =>
      send("", {
        channel: "pos",
        serviceType: "takeaway",
        items: Array.from({ length: items }, () => ({
          menuItemId: ids.kopi,
          quantity: 1,
          modifierIds: [],
        })),
      }),
    get: (orderId: string) =>
      who.client.get(`${base}/${orderId}`).set(headers).set(originHeader),
    voidOrder: (orderId: string, body: Record<string, unknown>) =>
      send(`/${orderId}/void`, body),
    voidItem: (
      orderId: string,
      itemId: string,
      body: Record<string, unknown>,
    ) => send(`/${orderId}/items/${itemId}/void`, body),
    discount: (orderId: string, body: Record<string, unknown>) =>
      send(`/${orderId}/discounts`, body),
  };
}

/** A fresh, unpaid order the cashier may void. */
async function openOrder(items = 2): Promise<{
  orderId: string;
  status: string;
  itemIds: string[];
}> {
  const created = await pos().create(items);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return {
    orderId: created.body.data.id as string,
    status: created.body.data.status as string,
    itemIds: (created.body.data.items as { id: string }[]).map(
      (item) => item.id,
    ),
  };
}

/** The supervisor's own tile + PIN, like production; `now` drives freshness. */
async function pinApproval(input: {
  action: "void" | "discount" | "refund";
  objectType?: "order" | "order_item";
  objectId: string;
  valueIdr?: number;
  approver?: string;
  requester?: Member;
  now?: Date;
}): Promise<{ approvedBy: string; overrideId: string }> {
  const approver = input.approver ?? supervisor.userId;
  const { override } = await createPosOverride(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    (input.requester ?? cashier).userId,
    {
      outletId: tenant.outletId,
      action: input.action,
      valueIdr: input.valueIdr ?? 1_000_000,
      reason: "Pelanggan salah pesan",
      objectType: input.objectType ?? "order",
      objectId: input.objectId,
      approval: {
        method: "supervisor_pin",
        approverUserId: userIdSchema.parse(approver),
        pin: PIN,
      },
    } as Parameters<typeof createPosOverride>[2],
    { idempotencyKey: randomUUID(), now: input.now },
  );
  expect(override.status).toBe("approved");
  return { approvedBy: approver, overrideId: override.id };
}

const voidBody = (_orderId: string, status: string) => ({
  reason: "customer_cancelled",
  reasonNote: "Pelanggan salah pesan",
  expectedStatus: status,
});

async function usesOf(overrideId: string): Promise<number> {
  const { rows } = await owner.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM pos_order_approval_uses
     WHERE override_id = $1::uuid`,
    [ulidToUuid(overrideId)],
  );
  return Number(rows[0]?.count);
}

/**
 * A phone approval as the consumer/poll leaves it (legend-0gy1 round 2): the
 * `pos_overrides` row is approved with `resolvedAt` = when it was processed,
 * the WS-01 `approval_requests` chain carries when each level was decided.
 * `decidedMinutesAgo` is per level (level 1 first), relative to `base`.
 */
async function phoneApproval(input: {
  orderId: string;
  base: Date;
  decidedMinutesAgo: number[];
  processedMinutesAgo: number;
  /** legend-cx3nb: the override row is still pending (the consumer never ran). */
  unsettled?: boolean;
}): Promise<{ approvedBy: string; overrideId: string; chainId: string }> {
  const overrideId = createUlid(input.base.getTime());
  const overrideUuid = ulidToUuid(overrideId);
  const at = (minutes: number) =>
    new Date(input.base.getTime() - minutes * MINUTE).toISOString();
  const levels = input.decidedMinutesAgo.length;
  const chainId = randomUUID();
  await asOwnerTenant(tenant.tenantId, async (client) => {
    for (const [index, ago] of input.decidedMinutesAgo.entries()) {
      await client.query(
        `INSERT INTO approval_requests
           (id, tenant_id, outlet_id, chain_id, source_module, action_type, object_type,
            object_id, payload, requested_by, source, level, required_levels,
            required_steps, status, request_reason, decided_by, decided_at, reason,
            deadline_at, created_at)
         VALUES ($1, $2, $3, $4, 'pos_override', 'void', 'pos_override', $5, '{}', $6,
                 'user', $7, $8, '[]', 'approved', 'Pelanggan salah pesan', $9, $10,
                 'Disetujui', $11, $12)`,
        [
          index === 0 ? chainId : randomUUID(),
          tenant.tenantId,
          tenant.outletId,
          chainId,
          overrideUuid,
          cashier.userId,
          index + 1,
          levels,
          supervisor.userId,
          at(ago),
          new Date(input.base.getTime() + 60 * MINUTE).toISOString(),
          at(60),
        ],
      );
    }
    await client.query(
      `INSERT INTO pos_overrides
         (id, tenant_id, outlet_id, action, method, status, requested_by, approved_by,
          reason, value_idr, object_type, object_id, approval_request_id,
          request_fingerprint, created_at, resolved_at)
       VALUES ($1, $2, $3, 'void', 'supervisor_phone', $11, $4, $5,
               'Pelanggan salah pesan', 1000000, 'order', $6, $7, $8, $9, $10)`,
      [
        overrideUuid,
        tenant.tenantId,
        tenant.outletId,
        cashier.userId,
        input.unsettled ? null : supervisor.userId,
        input.orderId,
        chainId,
        randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
        at(60),
        input.unsettled ? null : at(input.processedMinutesAgo),
        input.unsettled ? "pending" : "approved",
      ],
    );
  });
  return { approvedBy: supervisor.userId, overrideId, chainId };
}

async function voidWith(
  orderId: string,
  status: string,
  approval: { approvedBy: string; overrideId: string },
  now: Date,
) {
  return voidPosOrder(
    tenantContext(tenant.tenantId),
    {
      userId: userIdSchema.parse(cashier.userId) as UserId,
      deviceId: null,
      expectedVersion: null,
    },
    outletIdSchema.parse(tenant.outletId),
    orderId,
    {
      reason: "customer_cancelled" as const,
      reasonNote: "Pelanggan salah pesan",
      expectedStatus: status,
      idempotencyKey: randomUUID(),
      ...approval,
    } as never,
    now,
  );
}

beforeAll(async () => {
  app = createApp();
  tenant = await createIsolatedTenant(`posap-${randomUUID().slice(0, 6)}`);
  otherTenant = await createIsolatedTenant(`posao-${randomUUID().slice(0, 6)}`);
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
  cashier = await member(ids.cashierRole, "Approval Kasir");
  otherCashier = await member(ids.cashierRole, "Approval Kasir Lain");
  supervisor = await member(ids.supervisorRole, "Approval Supervisor");
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
       VALUES ($1, $2, $3, 'POS Approval', 0)`,
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
    // PBJT 10% on F&B, menu prices exclude tax, no service charge rule.
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
  for (const row of [tenant, otherTenant])
    await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      row.tenantId,
      randomUUID(),
    ]);
  await owner.end();
});

describe("POS approval carries the override id (legend-0gy1)", () => {
  it("a PIN approval by overrideId voids the order and stores the override id on the row, event and audit", async () => {
    const { orderId, status } = await openOrder();
    const approval = await pinApproval({ action: "void", objectId: orderId });
    const voided = await pos().voidOrder(orderId, {
      ...voidBody(orderId, status),
      ...approval,
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(voided.body.data).toMatchObject({
      status: "voided",
      voidApprovedBy: supervisor.userId,
      voidOverrideId: approval.overrideId,
      // A PIN has no WS-01 chain: the id is never taken from client input.
      voidApprovalRequestId: null,
    });
    const row = await owner.query<{ override_id: string | null }>(
      `SELECT void_override_id AS override_id FROM pos_orders
       WHERE tenant_id = $1 AND order_id = $2::uuid`,
      [tenant.tenantId, ulidToUuid(orderId)],
    );
    expect(row.rows[0]?.override_id).toBe(ulidToUuid(approval.overrideId));
    const event = await owner.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM order_events
       WHERE tenant_id = $1 AND order_id = $2::uuid AND type = 'order.voided'`,
      [tenant.tenantId, ulidToUuid(orderId)],
    );
    expect(event.rows[0]?.payload).toMatchObject({
      overrideId: approval.overrideId,
      approvalRequestId: null,
    });
    const audit = await asOwnerTenant(tenant.tenantId, (client) =>
      client.query<{ event: unknown }>(
        `SELECT event FROM audit_logs
         WHERE tenant_id = $1 AND event->>'action' = 'pos_order.voided'`,
        [tenant.tenantId],
      ),
    );
    expect(
      audit.rows.some((row) =>
        JSON.stringify(row.event).includes(approval.overrideId),
      ),
    ).toBe(true);
    expect(await usesOf(approval.overrideId)).toBe(1);
  });

  it("an item void and a manual discount store the override id too", async () => {
    const { orderId, itemIds } = await openOrder(2);
    const itemId = itemIds[0] as string;
    const itemApproval = await pinApproval({
      action: "void",
      objectType: "order_item",
      objectId: itemId,
    });
    const item = await pos().voidItem(orderId, itemId, {
      reason: "wrong_order",
      reasonNote: "Salah pesan item",
      ...itemApproval,
    });
    expect(item.status, JSON.stringify(item.body)).toBe(200);
    const voidedItem = (
      item.body.data.items as { id: string; voidOverrideId: string | null }[]
    ).find((row) => row.id === itemId);
    expect(voidedItem?.voidOverrideId).toBe(itemApproval.overrideId);

    const discountApproval = await pinApproval({
      action: "discount",
      objectId: orderId,
    });
    const discounted = await pos().discount(orderId, {
      source: "manual",
      kind: "percent",
      percentBp: 1_000,
      reason: "manager_goodwill",
      reasonNote: "Keluhan pelanggan",
      ...discountApproval,
    });
    expect(discounted.status, JSON.stringify(discounted.body)).toBe(201);
    const stored = await owner.query<{
      override_id: string;
      approval_request_id: string | null;
    }>(
      `SELECT override_id, approval_request_id FROM pos_order_discounts
       WHERE tenant_id = $1 AND order_id = $2::uuid`,
      [tenant.tenantId, ulidToUuid(orderId)],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.override_id).toBe(
      ulidToUuid(discountApproval.overrideId),
    );
    expect(stored.rows[0]?.approval_request_id).toBeNull();
  });

  it("an override is single use: a second action with it is refused", async () => {
    const first = await openOrder();
    const approval = await pinApproval({
      action: "void",
      objectId: first.orderId,
    });
    const ok = await pos().voidOrder(first.orderId, {
      ...voidBody(first.orderId, first.status),
      ...approval,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    // Same override on another order: wrong object, and already consumed.
    const second = await openOrder();
    const reused = await pos().voidOrder(second.orderId, {
      ...voidBody(second.orderId, second.status),
      ...approval,
    });
    expect(reused.status).toBeGreaterThanOrEqual(400);
    expect(reused.body.error?.code ?? reused.body.code).toMatch(
      /APPROVAL_REQUIRED/,
    );
    expect((await pos().get(second.orderId)).body.data.status).not.toBe(
      "voided",
    );
    expect(await usesOf(approval.overrideId)).toBe(1);
  });

  it("an approval older than 15 minutes by the injected clock is refused, a fresh one passes", async () => {
    const { orderId, status } = await openOrder();
    const approvedAt = new Date();
    const approval = await pinApproval({
      action: "void",
      objectId: orderId,
      now: approvedAt,
    });
    const caller = {
      userId: userIdSchema.parse(cashier.userId) as UserId,
      deviceId: null,
      expectedVersion: null,
    };
    const input = {
      reason: "customer_cancelled" as const,
      reasonNote: "Pelanggan salah pesan",
      expectedStatus: status,
      idempotencyKey: randomUUID(),
      ...approval,
    };
    const call = (now: Date) =>
      voidPosOrder(
        tenantContext(tenant.tenantId),
        caller,
        outletIdSchema.parse(tenant.outletId),
        orderId,
        { ...input, idempotencyKey: randomUUID() } as never,
        now,
      );
    await expect(
      call(new Date(approvedAt.getTime() + 16 * MINUTE)),
    ).rejects.toMatchObject({ code: "VOID_APPROVAL_REQUIRED" });
    // The refusal consumed nothing, so the same override still works in time.
    expect(await usesOf(approval.overrideId)).toBe(0);
    const fresh = await call(new Date(approvedAt.getTime() + 14 * MINUTE));
    expect(fresh.status).toBe("voided");
  });

  it("a phone approval is as old as the supervisor's decision, not as its processing (legend-0gy1)", async () => {
    const base = new Date();
    // Decided 20 min ago, but the poll/consumer only settled the override
    // 1 min ago: resolvedAt looks fresh, the decision is not.
    const stale = await openOrder();
    const lateApproval = await phoneApproval({
      orderId: stale.orderId,
      base,
      decidedMinutesAgo: [20],
      processedMinutesAgo: 1,
    });
    await expect(
      voidWith(stale.orderId, stale.status, lateApproval, base),
    ).rejects.toMatchObject({ code: "VOID_APPROVAL_REQUIRED" });
    expect(await usesOf(lateApproval.overrideId)).toBe(0);

    // Decided 5 min ago: accepted.
    const fresh = await openOrder();
    const recent = await phoneApproval({
      orderId: fresh.orderId,
      base,
      decidedMinutesAgo: [5],
      processedMinutesAgo: 1,
    });
    const voided = await voidWith(fresh.orderId, fresh.status, recent, base);
    expect(voided.status).toBe("voided");
    expect(await usesOf(recent.overrideId)).toBe(1);
  });

  // legend-cx3nb (d): a dead approval.resolved event replayed late settles the
  // override NOW (resolvedAt fresh), but the 15-minute window of a phone
  // approval counts from the supervisor's decision on the chain (decidedAt).
  // Assumptions: the chain and the still-pending override are inserted directly
  // (like phoneApproval), the replayed event is a well-formed "approved"
  // envelope for that chain, the worker context is tenant-wide from a job.
  it("legend-cx3nb AUTH-06 (d) a late replay of the approval event does not make the approval fresh: void is refused after 15 minutes from the decision, 0 uses", async () => {
    const base = new Date();
    const order = await openOrder();
    const { chainId, ...approval } = await phoneApproval({
      orderId: order.orderId,
      base,
      decidedMinutesAgo: [20],
      processedMinutesAgo: 0,
      unsettled: true,
    });
    const replayed = approvalResolvedEvent.envelopeSchema.parse({
      id: createUlid(),
      tenantId: tenant.tenantId,
      outletId: tenant.outletId,
      name: approvalResolvedEvent.name,
      version: approvalResolvedEvent.version,
      aggregateType: approvalResolvedEvent.entry.aggregateType,
      aggregateId: chainId,
      sequence: 1,
      occurredAt: new Date(base.getTime() - 20 * MINUTE).toISOString(),
      actor: { type: "user", id: supervisor.userId },
      deviceId: null,
      idempotencyKey: `cx3nb-late:${chainId}`,
      payloadSchemaRef: approvalResolvedEvent.payloadSchemaRef,
      payload: {
        chainId,
        requestId: chainId,
        sourceModule: "pos_override",
        actionType: "void",
        objectType: "pos_override",
        objectId: approval.overrideId,
        source: "user",
        outcome: "approved",
        level: 1,
        requiredLevels: 1,
        requestedBy: cashier.userId,
        decidedBy: supervisor.userId,
        amountIdr: 1_000_000,
      },
    }) as EventEnvelope;
    eventEnvelopeSchema.parse(replayed);
    await handleApprovalResolved(
      establishScopedTenantContext(
        establishTenantContext({
          tenantId: tenantIdSchema.parse(tenant.tenantId),
          brandId: null,
          source: "job",
        }),
        { kind: "tenant" },
      ),
      replayed,
    );
    const settled = await owner.query<{ status: string; resolved_at: Date }>(
      `SELECT status, resolved_at FROM pos_overrides WHERE id = $1::uuid`,
      [ulidToUuid(approval.overrideId)],
    );
    // The replay did approve it just now: resolvedAt is fresh, the decision is not.
    expect(settled.rows[0]?.status).toBe("approved");
    expect(settled.rows[0]?.resolved_at).not.toBeNull();

    await expect(
      voidWith(order.orderId, order.status, approval, new Date()),
    ).rejects.toMatchObject({ code: "VOID_APPROVAL_REQUIRED" });
    expect(await usesOf(approval.overrideId)).toBe(0);
  });

  it("a multi-level phone approval is as old as its last level's decision", async () => {
    const base = new Date();
    const order = await openOrder();
    // Level 1 decided 20 min ago, the last level 3 min ago: fresh.
    const approval = await phoneApproval({
      orderId: order.orderId,
      base,
      decidedMinutesAgo: [20, 3],
      processedMinutesAgo: 1,
    });
    const voided = await voidWith(order.orderId, order.status, approval, base);
    expect(voided.status).toBe("voided");
  });

  it("an override for another action, object, requester or approver is refused", async () => {
    const { orderId, status } = await openOrder();
    const other = await openOrder();
    const attempt = (
      overrideId: string,
      approvedBy = supervisor.userId,
      who = cashier,
    ) =>
      pos(who).voidOrder(orderId, {
        ...voidBody(orderId, status),
        approvedBy,
        overrideId,
      });
    const expectRefused = (res: Awaited<ReturnType<typeof attempt>>) => {
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.body.error?.code ?? res.body.code).toMatch(
        /APPROVAL_REQUIRED/,
      );
    };

    // Wrong action (a refund override cannot void).
    const refund = await pinApproval({ action: "refund", objectId: orderId });
    expectRefused(await attempt(refund.overrideId));
    // Wrong object (an override for another order).
    const forOther = await pinApproval({
      action: "void",
      objectId: other.orderId,
    });
    expectRefused(await attempt(forOther.overrideId));
    // Wrong requester (approval was requested by another cashier).
    const byOther = await pinApproval({
      action: "void",
      objectId: orderId,
      requester: otherCashier,
    });
    expectRefused(await attempt(byOther.overrideId));
    // Wrong approver (the body names someone who did not approve).
    const right = await pinApproval({ action: "void", objectId: orderId });
    expectRefused(await attempt(right.overrideId, otherCashier.userId));
    // AUTH-06: the requester never approves their own void.
    expectRefused(await attempt(right.overrideId, cashier.userId));
    // A value below the order total does not cover it.
    const small = await pinApproval({
      action: "void",
      objectId: orderId,
      valueIdr: 1,
    });
    expectRefused(await attempt(small.overrideId));
    // An id that is no override at all.
    expectRefused(await attempt(createUlid()));
    expect((await pos().get(orderId)).body.data.status).not.toBe("voided");
    for (const row of [refund, forOther, byOther, right, small])
      expect(await usesOf(row.overrideId)).toBe(0);
    // The untouched right approval still works afterwards.
    const ok = await attempt(right.overrideId);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it("another tenant's override is refused and stays unused (TEN-01)", async () => {
    const { orderId, status } = await openOrder();
    const foreignId = createUlid();
    await asOwnerTenant(otherTenant.tenantId, (client) =>
      client.query(
        `INSERT INTO pos_overrides
           (id, tenant_id, outlet_id, action, method, status, requested_by,
            approved_by, reason, value_idr, object_type, object_id,
            request_fingerprint, resolved_at)
         VALUES ($1::uuid, $2, $3, 'void', 'supervisor_pin', 'approved', $4,
                 $5, 'Uji lintas tenant', 1000000, 'order', $6, $7, now())`,
        [
          ulidToUuid(foreignId),
          otherTenant.tenantId,
          otherTenant.outletId,
          cashier.userId,
          supervisor.userId,
          orderId,
          "f".repeat(64),
        ],
      ),
    );
    const refused = await pos().voidOrder(orderId, {
      ...voidBody(orderId, status),
      approvedBy: supervisor.userId,
      overrideId: foreignId,
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.body.error?.code ?? refused.body.code).toMatch(
      /APPROVAL_REQUIRED/,
    );
    expect((await pos().get(orderId)).body.data.status).not.toBe("voided");
    expect(await usesOf(foreignId)).toBe(0);
  });

  it("two concurrent voids with one override succeed exactly once", async () => {
    const { orderId, status } = await openOrder();
    const approval = await pinApproval({ action: "void", objectId: orderId });
    const results = await Promise.all(
      [0, 1].map(() =>
        pos().voidOrder(orderId, {
          ...voidBody(orderId, status),
          ...approval,
        }),
      ),
    );
    const succeeded = results.filter((res) => res.status === 200);
    expect(
      succeeded,
      JSON.stringify(results.map((res) => [res.status, res.body])),
    ).toHaveLength(1);
    expect(results.filter((res) => res.status >= 400)).toHaveLength(1);
    expect(await usesOf(approval.overrideId)).toBe(1);
    expect((await pos().get(orderId)).body.data.status).toBe("voided");
  });
});
