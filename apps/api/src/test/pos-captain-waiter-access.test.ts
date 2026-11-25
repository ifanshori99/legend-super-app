// 1268 W4 review no. 1: a waiter (order.create, no pos.sale.create) takes a
// captain order for a table session and fires its held items, and nothing
// else. Another channel, a cashier's order, payment, void, discount and
// another outlet stay refused. The channel is read from the order row, never
// trusted from the client.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  owner,
  seedTenantOutlets,
  staffOfIsolatedTenant,
} from "./floor-test-helpers.ts";
import { originHeader } from "./helpers.ts";
import {
  cashierFixture,
  type CashierFixture,
} from "./pos-cashier-test-helpers.ts";

let fixture: CashierFixture;
let waiter: Awaited<ReturnType<typeof staffOfIsolatedTenant>>;
let otherOutletId: string;

beforeAll(async () => {
  fixture = await cashierFixture("captain-waiter");
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Waiter uji', false, NULL, $3, false, '["outlet"]')`,
    [
      roleId,
      fixture.tenant.tenantId,
      JSON.stringify([
        "menu.item.view",
        "floor.table.view",
        "floor.table.operate",
        "order.view",
        "order.create",
      ]),
    ],
  );
  waiter = await staffOfIsolatedTenant(fixture.app, fixture.tenant);
  await owner.query(
    `UPDATE role_assignments SET role_id = $3, scope_type = 'outlet', scope_id = $4
      WHERE tenant_id = $1 AND user_id = $2`,
    [fixture.tenant.tenantId, waiter.userId, roleId, fixture.tenant.outletId],
  );
  [otherOutletId] = await seedTenantOutlets(fixture.tenant.tenantId, 1);
});
afterAll(async () => {
  await owner.end();
});

const post = (path: string, body: Record<string, unknown>) =>
  waiter.client.post(path).set(fixture.headers).set(originHeader).send(body);

/** An open-bill table whose session is running (the waiter confirmed it). */
async function openGuest() {
  const guest = await fixture.newGuest("open_bill");
  await owner.query("UPDATE table_sessions SET status = 'open' WHERE id = $1", [
    guest.sessionId,
  ]);
  return guest;
}

const captainBody = (
  sessionId: string,
  extra: Record<string, unknown> = {},
) => ({
  channel: "captain",
  serviceType: "dine_in",
  tableSessionId: sessionId,
  items: [
    fixture.line({ hold: true }),
    fixture.line({
      menuItemId: fixture.ids.coffee,
      modifierIds: [fixture.ids.modifier],
    }),
  ],
  idempotencyKey: randomUUID(),
  ...extra,
});

describe("waiter captain order access", () => {
  it("creates, submits and fires a captain order for a table session", async () => {
    const guest = await openGuest();
    const created = await post(fixture.base, captainBody(guest.sessionId));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const order = created.body.data as { id: string; status: string };
    const submitted = await post(`${fixture.base}/${order.id}/submit`, {
      expectedStatus: order.status,
      idempotencyKey: randomUUID(),
    });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    const held = (
      submitted.body.data.items as { id: string; fireStatus: string }[]
    ).filter((item) => item.fireStatus === "held");
    expect(held).toHaveLength(1);
    const fired = await post(`${fixture.base}/${order.id}/fire`, {
      itemIds: [held[0]!.id],
      expectedStatus: submitted.body.data.status,
      idempotencyKey: randomUUID(),
    });
    expect(fired.status, JSON.stringify(fired.body)).toBe(200);
  });

  it("refuses every other channel", async () => {
    const guest = await openGuest();
    const takeaway = await post(fixture.base, {
      channel: "pos",
      serviceType: "takeaway",
      items: [fixture.line()],
      idempotencyKey: randomUUID(),
    });
    expect(takeaway.status, JSON.stringify(takeaway.body)).toBe(403);
    const dineIn = await post(
      fixture.base,
      captainBody(guest.sessionId, { channel: "pos" }),
    );
    expect(dineIn.status, JSON.stringify(dineIn.body)).toBe(403);
    const ojol = await post(fixture.base, {
      channel: "gofood",
      serviceType: "delivery",
      externalRef: "GF-1",
      items: [fixture.line()],
      idempotencyKey: randomUUID(),
    });
    expect(ojol.status, JSON.stringify(ojol.body)).toBe(403);
  });

  it("cannot submit, fire or complete a cashier's order", async () => {
    const made = await fixture.create();
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const id = made.body.data.id as string;
    const submit = await post(`${fixture.base}/${id}/submit`, {
      expectedStatus: "draft",
      idempotencyKey: randomUUID(),
    });
    expect(submit.status, JSON.stringify(submit.body)).toBe(403);
    // The cashier submits it; the waiter still cannot fire or complete it.
    const cashierSubmit = await fixture.post(`${fixture.base}/${id}/submit`, {
      expectedStatus: "draft",
      idempotencyKey: randomUUID(),
    });
    expect(cashierSubmit.status, JSON.stringify(cashierSubmit.body)).toBe(200);
    const fire = await post(`${fixture.base}/${id}/fire`, {
      course: "main",
      expectedStatus: "awaiting_payment",
      idempotencyKey: randomUUID(),
    });
    expect(fire.status, JSON.stringify(fire.body)).toBe(403);
    const complete = await post(`${fixture.base}/${id}/complete`, {
      expectedStatus: "awaiting_payment",
      idempotencyKey: randomUUID(),
    });
    expect(complete.status, JSON.stringify(complete.body)).toBe(403);
  });

  it("cannot pay, void or discount", async () => {
    const guest = await openGuest();
    const created = await post(fixture.base, captainBody(guest.sessionId));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.data.id as string;
    const tender = await post(`${fixture.base}/${id}/tenders`, {
      method: "cash",
      amountIdr: 1000,
      receivedIdr: 1000,
      idempotencyKey: randomUUID(),
    });
    expect(tender.status, JSON.stringify(tender.body)).toBe(403);
    const voided = await post(`${fixture.base}/${id}/void`, {
      reason: "customer_changed_mind",
      reasonNote: "uji akses",
      expectedStatus: "draft",
      idempotencyKey: randomUUID(),
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(403);
    const discount = await post(`${fixture.base}/${id}/discounts`, {
      source: "manual",
      kind: "percent",
      percentBp: 1_000,
      reason: "manager_goodwill",
      reasonNote: "Uji akses",
      expectedStatus: "draft",
      idempotencyKey: randomUUID(),
    });
    expect(discount.status, JSON.stringify(discount.body)).toBe(403);
  });

  it("is refused at another outlet", async () => {
    const guest = await openGuest();
    const response = await post(
      `/api/outlets/${otherOutletId}/pos/orders`,
      captainBody(guest.sessionId),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(403);
  });

  it("leaves the cashier as it was", async () => {
    const takeaway = await fixture.create();
    expect(takeaway.status, JSON.stringify(takeaway.body)).toBe(201);
    const guest = await fixture.newGuest();
    const captain = await fixture.post(
      fixture.base,
      captainBody(guest.sessionId),
    );
    expect(captain.status, JSON.stringify(captain.body)).toBe(201);
  });

  it("cannot attach a customer profile (points go to another account)", async () => {
    const guest = await openGuest();
    const response = await post(
      fixture.base,
      captainBody(guest.sessionId, { customerProfileId: randomUUID() }),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(403);
  });

  it("cannot fire another channel's order by item ids", async () => {
    const made = await fixture.create();
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const id = made.body.data.id as string;
    const submitted = await fixture.post(`${fixture.base}/${id}/submit`, {
      expectedStatus: "draft",
      idempotencyKey: randomUUID(),
    });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    const itemId = submitted.body.data.items[0].id as string;
    const fire = await post(`${fixture.base}/${id}/fire`, {
      itemIds: [itemId],
      expectedStatus: submitted.body.data.status,
      idempotencyKey: randomUUID(),
    });
    expect(fire.status, JSON.stringify(fire.body)).toBe(403);
  });

  it("cannot submit or fire an order of another outlet through its own outlet", async () => {
    const made = await fixture.create();
    const id = made.body.data.id as string;
    const other = `/api/outlets/${otherOutletId}/pos/orders/${id}`;
    const submit = await post(`${other}/submit`, {
      expectedStatus: "draft",
      idempotencyKey: randomUUID(),
    });
    expect(submit.status, JSON.stringify(submit.body)).toBe(403);
    const fire = await post(`${other}/fire`, {
      course: "main",
      expectedStatus: "draft",
      idempotencyKey: randomUUID(),
    });
    expect(fire.status, JSON.stringify(fire.body)).toBe(403);
  });
});

// CTO decision (PRD D10): pay first means the kitchen starts after payment, so
// a captain-only caller never creates, submits or fires on a pay_first session.
describe("waiter on a pay_first table", () => {
  it("is held back at create, submit and fire with its own code", async () => {
    const guest = await fixture.newGuest("pay_first");
    const created = await post(fixture.base, captainBody(guest.sessionId));
    expect(created.status, JSON.stringify(created.body)).toBe(409);
    expect(created.body.error.code).toBe("CAPTAIN_PAY_FIRST");
    // The cashier may still take the order; the waiter cannot move it on.
    const byCashier = await fixture.post(
      fixture.base,
      captainBody(guest.sessionId),
    );
    expect(byCashier.status, JSON.stringify(byCashier.body)).toBe(201);
    const id = byCashier.body.data.id as string;
    const submit = await post(`${fixture.base}/${id}/submit`, {
      expectedStatus: "draft",
      idempotencyKey: randomUUID(),
    });
    expect(submit.status, JSON.stringify(submit.body)).toBe(409);
    expect(submit.body.error.code).toBe("CAPTAIN_PAY_FIRST");
    const fire = await post(`${fixture.base}/${id}/fire`, {
      course: "main",
      expectedStatus: "draft",
      idempotencyKey: randomUUID(),
    });
    expect(fire.status, JSON.stringify(fire.body)).toBe(409);
    expect(fire.body.error.code).toBe("CAPTAIN_PAY_FIRST");
  });
});

describe("waiter on an open bill over its limit", () => {
  it("is refused with 409, not 500, and the cashier is not limited", async () => {
    await owner.query(
      `INSERT INTO outlet_open_bill_policies
         (tenant_id, outlet_id, max_bill_value_idr, inactivity_minutes, bill_request_slo_seconds)
       VALUES ($1, $2, 100000, 45, 180)
       ON CONFLICT (tenant_id, outlet_id) DO UPDATE SET max_bill_value_idr = 100000`,
      [fixture.tenant.tenantId, fixture.tenant.outletId],
    );
    try {
      const guest = await openGuest();
      const big = captainBody(guest.sessionId, {
        items: [fixture.line({ quantity: 5 })],
      });
      const created = await post(fixture.base, big);
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const submit = await post(
        `${fixture.base}/${created.body.data.id}/submit`,
        {
          expectedStatus: created.body.data.status,
          idempotencyKey: randomUUID(),
        },
      );
      expect(submit.status, JSON.stringify(submit.body)).toBe(409);
      expect(submit.body.error.code).toBe("QR_ORDER_OPEN_BILL_LIMIT");
      // Not limited for a user who can sell.
      const cashier = await fixture.post(fixture.base, {
        ...big,
        idempotencyKey: randomUUID(),
      });
      expect(cashier.status, JSON.stringify(cashier.body)).toBe(201);
      const cashierSubmit = await fixture.post(
        `${fixture.base}/${cashier.body.data.id}/submit`,
        {
          expectedStatus: cashier.body.data.status,
          idempotencyKey: randomUUID(),
        },
      );
      expect(cashierSubmit.status, JSON.stringify(cashierSubmit.body)).toBe(
        200,
      );
    } finally {
      await owner.query(
        "DELETE FROM outlet_open_bill_policies WHERE tenant_id = $1 AND outlet_id = $2",
        [fixture.tenant.tenantId, fixture.tenant.outletId],
      );
    }
  });
});
