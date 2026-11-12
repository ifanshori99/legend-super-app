// legend-dysef G3/G4, approved POS order UI: held lines remain billed while
// only the selected lines wait for the kitchen. Prices come from the server.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPosOrder } from "@starter/shared/pos";
import { owner } from "./floor-test-helpers.ts";
import {
  cashierFixture,
  type CashierFixture,
} from "./pos-cashier-test-helpers.ts";

let fixture: CashierFixture;
beforeAll(async () => {
  fixture = await cashierFixture("line-hold");
});
afterAll(async () => {
  await owner.end();
});

describe("legend-dysef POS per-line hold", () => {
  it("G3 contract accepts hold independently on each line", () => {
    const parsed = createPosOrder.body.safeParse({
      channel: "pos",
      serviceType: "takeaway",
      items: [fixture.line({ hold: true }), fixture.line({ hold: false })],
      idempotencyKey: randomUUID(),
    });
    expect(parsed.success, parsed.success ? "" : parsed.error.message).toBe(
      true,
    );
  });

  it("G3/G4 holds one course, bills every line and fires only the selected server item", async () => {
    const created = await fixture.create({
      items: [
        fixture.line({
          menuItemId: fixture.ids.coffee,
          modifierIds: [fixture.ids.modifier],
          hold: false,
          course: "drink",
        }),
        fixture.line({
          hold: true,
          course: "main",
          note: "Nanti setelah minuman",
        }),
      ],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const order = created.body.data;
    expect(order.subtotalIdr).toBe(60_000);
    const submitted = await fixture.post(`${fixture.base}/${order.id}/submit`, {
      expectedStatus: order.status,
      idempotencyKey: randomUUID(),
    });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    const items = submitted.body.data.items as {
      id: string;
      menuItemId: string;
      fireStatus: string;
    }[];
    const coffee = items.find(
      (item) => item.menuItemId === fixture.ids.coffee,
    )!;
    const meal = items.find((item) => item.menuItemId === fixture.ids.meal)!;
    expect(coffee.fireStatus).toBe("fired");
    expect(meal.fireStatus).toBe("held");
    expect(submitted.body.data.totalIdr).toBe(order.totalIdr);
    const body = {
      itemIds: [meal.id],
      expectedStatus: submitted.body.data.status,
      idempotencyKey: randomUUID(),
    };
    const fired = await fixture.post(`${fixture.base}/${order.id}/fire`, body);
    expect(fired.status, JSON.stringify(fired.body)).toBe(200);
    expect(
      fired.body.data.items.every(
        (item: { fireStatus: string }) => item.fireStatus === "fired",
      ),
    ).toBe(true);
    expect(fired.body.data.totalIdr).toBe(order.totalIdr);
    const replay = await fixture.post(`${fixture.base}/${order.id}/fire`, body);
    expect(replay.status).toBe(200);
    expect(replay.body.data.totalIdr).toBe(order.totalIdr);
  });

  it("G3 preserves legacy whole-order hold and lets an explicit false release one line", async () => {
    const created = await fixture.create({
      holdItems: true,
      items: [
        fixture.line({ course: "main" }),
        fixture.line({
          menuItemId: fixture.ids.coffee,
          modifierIds: [fixture.ids.modifier],
          hold: false,
          course: "drink",
        }),
      ],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const submitted = await fixture.post(
      `${fixture.base}/${created.body.data.id}/submit`,
      {
        expectedStatus: created.body.data.status,
        idempotencyKey: randomUUID(),
      },
    );
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    expect(submitted.body.data.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          menuItemId: fixture.ids.meal,
          fireStatus: "held",
        }),
        expect.objectContaining({
          menuItemId: fixture.ids.coffee,
          fireStatus: "fired",
        }),
      ]),
    );
    expect(submitted.body.data.totalIdr).toBe(created.body.data.totalIdr);
  });
});
