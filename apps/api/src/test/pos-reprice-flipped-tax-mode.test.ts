// legend-376ob (brief 1085, card 4, money): voiding an item or applying a
// discount on an OPEN POS order after the outlet's tax rule flipped between
// inclusive and exclusive must reprice with the order's own pricing mode
// (orders.prices_include_tax), not answer 409 QR_ORDER_PRICING_MODE_MIXED, and
// the total must not move in the wrong direction.
//
// Written from the bead text and brief 974 (an order keeps one pricing mode,
// POS bill fixture of pos-inclusive-bill-974.test.ts), never from
// pos-order-support.ts.
//
// Technique (no tax math is re-derived): for each case two identical orders
// are created BEFORE the flip. The CONTROL order gets the action before the
// flip, so its total is the correct result in the order's own mode. The TARGET
// order gets the same action AFTER the flip and must end with the same total
// and the same stored mode. A reprice in the flipped mode would give a
// different total (lower when exclusive -> inclusive; higher when inclusive ->
// exclusive), so "not lower than correct" is covered by equality.
//
// Assumptions (also reported):
//  - Fixture: Nasi Goreng Rp30.000, PBJT 10%. Inclusive = a published
//    inclusive item rule for the meal (as in the 974 test); the flip updates
//    tax_rules.price_includes_tax (exclusive -> inclusive) or the rule is made
//    exclusive (inclusive -> exclusive).
//  - Item void body: { reason: "wrong_order", reasonNote, approvedBy,
//    overrideId, idempotencyKey } and discount body: { source: "manual",
//    kind: "percent", percentBp, reason: "manager_goodwill", reasonNote,
//    approvedBy, overrideId, idempotencyKey } with a supervisor PIN approval,
//    as in pos-order-approval.test.ts. Success is 200 (void) and 201 (discount).
//  - The outlet flip is the only change; the order's stored mode is read from
//    the `orders` row (the POS DTO does not expose it).
//  - Voiding an item of an open order keeps the order open and priced in its
//    own mode; the item void leaves one of two lines.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { tenantIdSchema, ulidToUuid, userIdSchema } from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import { setStaffPin } from "../services/device-pin.service.ts";
import { createPosOverride } from "../services/staff-override.service.ts";
import { owner } from "./floor-test-helpers.ts";
import { agent, signUp } from "./helpers.ts";
import {
  asCashierTenant,
  cashierFixture,
  type CashierFixture,
} from "./pos-cashier-test-helpers.ts";

const SUPERVISOR_PIN = "582914";
const fixturesToClean: CashierFixture[] = [];

afterAll(async () => {
  for (const fx of fixturesToClean)
    await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      fx.tenant.tenantId,
      randomUUID(),
    ]);
  await owner.end();
});

type Stored = {
  inclusive: boolean;
  status: string;
  subtotalIdr: number;
  discountIdr: number;
  taxIdr: number;
  totalIdr: number;
};

async function stored(fx: CashierFixture, orderId: string): Promise<Stored> {
  const { rows } = await owner.query<Record<string, string | boolean>>(
    `SELECT prices_include_tax, status, subtotal_idr::text, discount_idr::text,
            tax_idr::text, total_idr::text
       FROM orders WHERE tenant_id = $1 AND id = $2`,
    [fx.tenant.tenantId, ulidToUuid(orderId)],
  );
  const row = rows[0];
  if (!row) throw new Error("order row missing");
  return {
    inclusive: row.prices_include_tax as boolean,
    status: row.status as string,
    subtotalIdr: Number(row.subtotal_idr),
    discountIdr: Number(row.discount_idr),
    taxIdr: Number(row.tax_idr),
    totalIdr: Number(row.total_idr),
  };
}

async function addInclusiveMealRule(fx: CashierFixture): Promise<void> {
  await asCashierTenant(fx.tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, $3, 'PB1 10% nett', 'pbjt', 1000, NULL, '[]', $4,
               true, true, true, 1, '2026-01-01', 'published', now(), $5)`,
      [
        randomUUID(),
        fx.tenant.tenantId,
        `PBJT-NETT-${randomUUID().slice(0, 6)}`.toUpperCase(),
        JSON.stringify({
          itemClasses: [],
          categoryIds: [],
          itemIds: [fx.ids.meal],
        }),
        fx.staff.userId,
      ],
    ),
  );
}

type World = {
  fx: CashierFixture;
  supervisorUserId: string;
  /** Flip the outlet's tax rule to the other mode. */
  flip: () => Promise<void>;
  /** A new open order of two separate meal lines in the current mode. */
  openOrder: () => Promise<{ orderId: string; itemIds: string[] }>;
  approval: (input: {
    objectType: "order" | "order_item";
    objectId: string;
    valueIdr: number;
  }) => Promise<{ approvedBy: string; overrideId: string }>;
};

/** `startInclusive`: orders start inclusive and the flip makes the outlet
 * exclusive; otherwise the reverse. */
async function world(label: string, startInclusive: boolean): Promise<World> {
  const fx = await cashierFixture(label);
  fixturesToClean.push(fx);
  await owner.query(
    "UPDATE roles SET permissions = permissions || $2::jsonb WHERE id = $1",
    [
      fx.tenant.roleId,
      JSON.stringify(["pos.void.request", "pos.discount.apply"]),
    ],
  );
  const client = agent(fx.app);
  await signUp(client, "Supervisor Reprice Uji");
  const session = await client.get("/api/auth/get-session");
  const supervisorUserId = session.body.user.id as string;
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Supervisor Reprice Uji', false, NULL, $3, false, '["tenant"]')`,
    [
      roleId,
      fx.tenant.tenantId,
      JSON.stringify([
        "order.view",
        "pos.void.approve",
        "pos.discount.approve",
      ]),
    ],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [fx.tenant.tenantId, supervisorUserId, roleId],
  );
  const context = establishTenantContext({
    tenantId: tenantIdSchema.parse(fx.tenant.tenantId),
    brandId: null,
    source: "session",
  });
  await setStaffPin(
    context,
    supervisorUserId,
    { outletId: fx.tenant.outletId, userId: supervisorUserId },
    { pin: SUPERVISOR_PIN },
  );

  if (startInclusive) await addInclusiveMealRule(fx);

  return {
    fx,
    supervisorUserId,
    flip: async () => {
      if (startInclusive) {
        await owner.query(
          "UPDATE tax_rules SET price_includes_tax = false WHERE tenant_id = $1",
          [fx.tenant.tenantId],
        );
      } else {
        await addInclusiveMealRule(fx);
      }
    },
    openOrder: async () => {
      const created = await fx.post(fx.base, {
        channel: "pos",
        serviceType: "takeaway",
        items: [fx.line(), fx.line()],
        idempotencyKey: randomUUID(),
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      return {
        orderId: created.body.data.id as string,
        itemIds: (created.body.data.items as { id: string }[]).map(
          (item) => item.id,
        ),
      };
    },
    approval: async (input) => {
      const { override } = await createPosOverride(
        context,
        fx.staff.userId,
        {
          outletId: fx.tenant.outletId,
          action: input.objectType === "order_item" ? "void" : "discount",
          valueIdr: input.valueIdr,
          reason: "Pelanggan salah pesan",
          objectType: input.objectType,
          objectId: input.objectId,
          approval: {
            method: "supervisor_pin",
            approverUserId: userIdSchema.parse(supervisorUserId),
            pin: SUPERVISOR_PIN,
          },
        } as Parameters<typeof createPosOverride>[2],
        { idempotencyKey: randomUUID() },
      );
      expect(override.status).toBe("approved");
      return { approvedBy: supervisorUserId, overrideId: override.id };
    },
  };
}

async function voidFirstItem(
  w: World,
  order: { orderId: string; itemIds: string[] },
) {
  const itemId = order.itemIds[0] as string;
  const approval = await w.approval({
    objectType: "order_item",
    objectId: itemId,
    valueIdr: 30_000,
  });
  return w.fx.post(`${w.fx.base}/${order.orderId}/items/${itemId}/void`, {
    reason: "wrong_order",
    reasonNote: "Salah pesan item",
    idempotencyKey: randomUUID(),
    ...approval,
  });
}

async function discountTenPercent(
  w: World,
  order: { orderId: string; itemIds: string[] },
) {
  const approval = await w.approval({
    objectType: "order",
    objectId: order.orderId,
    valueIdr: 10_000,
  });
  return w.fx.post(`${w.fx.base}/${order.orderId}/discounts`, {
    source: "manual",
    kind: "percent",
    percentBp: 1_000,
    reason: "manager_goodwill",
    reasonNote: "Keluhan pelanggan",
    idempotencyKey: randomUUID(),
    ...approval,
  });
}

describe("legend-376ob: reprice with the order's own pricing mode after the outlet flipped", () => {
  for (const startInclusive of [false, true]) {
    const mode = startInclusive
      ? "inclusive order, outlet now exclusive"
      : "exclusive order, outlet now inclusive";

    it(`376ob-void-${startInclusive ? "inc" : "exc"} void item: ${mode}: no 409, own mode kept, total equals the unflipped result`, async () => {
      const w = await world(
        `reprice-void-${startInclusive ? "inc" : "exc"}`,
        startInclusive,
      );
      const control = await w.openOrder();
      const target = await w.openOrder();
      expect((await stored(w.fx, target.orderId)).inclusive).toBe(
        startInclusive,
      );

      const controlVoid = await voidFirstItem(w, control);
      expect(controlVoid.status, JSON.stringify(controlVoid.body)).toBe(200);
      const expected = await stored(w.fx, control.orderId);
      expect(expected.inclusive).toBe(startInclusive);

      await w.flip();
      const before = await stored(w.fx, target.orderId);
      const voided = await voidFirstItem(w, target);
      expect(
        voided.status,
        `item void after the flip must not be refused: ${JSON.stringify(voided.body)}`,
      ).toBe(200);
      expect(JSON.stringify(voided.body)).not.toContain(
        "QR_ORDER_PRICING_MODE_MIXED",
      );

      const after = await stored(w.fx, target.orderId);
      expect(after.inclusive, "the order keeps its own pricing mode").toBe(
        startInclusive,
      );
      expect(after.status).toBe(before.status);
      expect(after.subtotalIdr).toBe(expected.subtotalIdr);
      expect(after.taxIdr).toBe(expected.taxIdr);
      // Never lower than the correct total (the outlet is never short-paid).
      expect(after.totalIdr).toBeGreaterThanOrEqual(expected.totalIdr);
      expect(after.totalIdr).toBe(expected.totalIdr);
      // One of two lines went away: the total fell, it did not jump.
      expect(after.totalIdr).toBeLessThan(before.totalIdr);
    });

    it(`376ob-discount-${startInclusive ? "inc" : "exc"} manual discount: ${mode}: no 409, own mode kept, total equals the unflipped result`, async () => {
      const w = await world(
        `reprice-disc-${startInclusive ? "inc" : "exc"}`,
        startInclusive,
      );
      const control = await w.openOrder();
      const target = await w.openOrder();

      const controlDiscount = await discountTenPercent(w, control);
      expect(controlDiscount.status, JSON.stringify(controlDiscount.body)).toBe(
        201,
      );
      const expected = await stored(w.fx, control.orderId);
      expect(expected.inclusive).toBe(startInclusive);
      expect(expected.discountIdr).toBeGreaterThan(0);

      await w.flip();
      const before = await stored(w.fx, target.orderId);
      const discounted = await discountTenPercent(w, target);
      expect(
        discounted.status,
        `discount after the flip must not be refused: ${JSON.stringify(discounted.body)}`,
      ).toBe(201);
      expect(JSON.stringify(discounted.body)).not.toContain(
        "QR_ORDER_PRICING_MODE_MIXED",
      );

      const after = await stored(w.fx, target.orderId);
      expect(after.inclusive, "the order keeps its own pricing mode").toBe(
        startInclusive,
      );
      expect(after.discountIdr).toBe(expected.discountIdr);
      expect(after.taxIdr).toBe(expected.taxIdr);
      expect(after.totalIdr).toBeGreaterThanOrEqual(expected.totalIdr);
      expect(after.totalIdr).toBe(expected.totalIdr);
      expect(after.totalIdr).toBeLessThan(before.totalIdr);
    });
  }
});
