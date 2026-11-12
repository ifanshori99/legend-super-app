// legend-dysef G7, approved captain UI: a request_bill must be acknowledged
// before resolving it. This uses the existing guest and staff HTTP contracts.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agent } from "./helpers.ts";
import { owner } from "./floor-test-helpers.ts";
import {
  cashierFixture,
  type CashierFixture,
} from "./pos-cashier-test-helpers.ts";

let fixture: CashierFixture;
beforeAll(async () => {
  fixture = await cashierFixture("bill-ack");
});
afterAll(async () => {
  await owner.end();
});

describe("legend-dysef captain bill request acknowledgement", () => {
  it("G7 refuses pending bill resolution without changing the request or session, then resolves after acknowledgement", async () => {
    const guest = await fixture.newGuest();
    const created = await agent(fixture.app)
      .post(`/api/table-sessions/${guest.sessionId}/service-requests`)
      .set(fixture.headers)
      .set("Authorization", `Bearer ${guest.token}`)
      .send({ type: "request_bill", idempotencyKey: randomUUID() });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const request = created.body.data;
    const refused = await fixture.post(
      `/api/service-requests/${request.id}/resolve`,
      {},
    );
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error.code).toBe("CALL_NOT_ACKNOWLEDGED");
    const inbox = await fixture.get(
      `/api/outlets/${fixture.tenant.outletId}/service-requests?status=pending`,
    );
    expect(inbox.status).toBe(200);
    expect(
      inbox.body.data.find((item: { id: string }) => item.id === request.id),
    ).toMatchObject({
      status: "pending",
      acknowledgedAt: null,
      resolvedAt: null,
    });
    const accepted = await fixture.post(
      `/api/service-requests/${request.id}/acknowledge`,
      {},
    );
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body.data.status).toBe("acknowledged");
    const resolved = await fixture.post(
      `/api/service-requests/${request.id}/resolve`,
      {},
    );
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    expect(resolved.body.data).toMatchObject({
      status: "resolved",
      assignedTo: fixture.staff.userId,
    });
    expect(resolved.body.data.acknowledgedAt).not.toBeNull();
  });

  it("G7 adds a safe table label to paginated calls and preserves reason codes and ordinary direct resolution", async () => {
    const guest = await fixture.newGuest();
    const created = await agent(fixture.app)
      .post(`/api/table-sessions/${guest.sessionId}/service-requests`)
      .set(fixture.headers)
      .set("Authorization", `Bearer ${guest.token}`)
      .send({
        type: "call_waiter",
        reason: "utensils",
        idempotencyKey: randomUUID(),
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const inbox = await fixture.get(
      `/api/outlets/${fixture.tenant.outletId}/service-requests?limit=1`,
    );
    expect(inbox.status, JSON.stringify(inbox.body)).toBe(200);
    expect(inbox.body.data).toHaveLength(1);
    expect(inbox.body.data[0]).toMatchObject({
      id: created.body.data.id,
      tableLabel: guest.table.code,
      status: "pending",
      reason: "utensils",
    });
    const resolved = await fixture.post(
      `/api/service-requests/${created.body.data.id}/resolve`,
      {},
    );
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    expect(resolved.body.data).toMatchObject({
      status: "resolved",
      reason: "utensils",
      tableLabel: guest.table.code,
    });
  });
});
