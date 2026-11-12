// legend-dysef G5: a staff draft is not payable until submitted, and a
// closed QR session cannot be reopened by submitting a previously saved draft.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ulidToUuid } from "@starter/shared/core";
import { setQrOrderDepositCreditLookup } from "../services/qr-order-ports.ts";
import { qrOrderSettlementLookup } from "../services/qr-order.service.ts";
import { setTableSessionSettlementLookup } from "../services/table-session.service.ts";
import { owner } from "./floor-test-helpers.ts";
import {
  asCashierTenant,
  cashierFixture,
  type CashierFixture,
} from "./pos-cashier-test-helpers.ts";

let fixture: CashierFixture;
beforeAll(async () => {
  fixture = await cashierFixture("closed-captain-draft");
  setTableSessionSettlementLookup(qrOrderSettlementLookup);
});
afterEach(() => {
  setQrOrderDepositCreditLookup(null);
});
afterAll(async () => {
  setTableSessionSettlementLookup(null);
  await owner.end();
});

async function createDraft(sessionId: string) {
  const created = await fixture.create({
    channel: "captain",
    serviceType: "dine_in",
    tableSessionId: sessionId,
    items: [fixture.line()],
    holdItems: true,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect(created.body.data.status).toBe("draft");
  return created.body.data as {
    id: string;
    status: string;
    totalIdr: number;
    depositAppliedIdr: number;
  };
}

async function submit(orderId: string) {
  return fixture.post(`${fixture.base}/${orderId}/submit`, {
    expectedStatus: "draft",
    idempotencyKey: randomUUID(),
  });
}

async function capturedCash(orderId: string, amountIdr: number) {
  await asCashierTenant(fixture.tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO pos_order_tenders
       (tenant_id, outlet_id, order_id, method, provider, amount_idr,
        received_idr, change_idr, status, requested_at, resolved_at, captured_by)
     VALUES ($1, $2, $3, 'cash', 'manual', $4, $4, 0, 'captured', now(), now(), $5)`,
      [
        fixture.tenant.tenantId,
        fixture.tenant.outletId,
        ulidToUuid(orderId),
        amountIdr,
        fixture.staff.userId,
      ],
    ),
  );
}

async function snapshot(sessionId: string, orderId: string) {
  const { rows } = await owner.query<{
    event_count: number;
    deposit_idr: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM order_events WHERE tenant_id = $1 AND order_id = $3) AS event_count,
       (SELECT coalesce(sum(deposit_applied_idr), 0)::int FROM orders WHERE tenant_id = $1 AND table_session_id = $2) AS deposit_idr`,
    [fixture.tenant.tenantId, sessionId, ulidToUuid(orderId)],
  );
  return rows[0]!;
}

describe("legend-dysef captain draft bound to a live QR session", () => {
  it.each(["empty", "paid"] as const)(
    "G5-SESSION-01 rejects an old draft after closing an %s session without new events, fire or DP",
    async (mode) => {
      const creditIdr = 20_000;
      setQrOrderDepositCreditLookup(async () => creditIdr);
      const guest = await fixture.newGuest();
      if (mode === "paid") {
        const active = await createDraft(guest.sessionId);
        const submitted = await submit(active.id);
        expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
        const due =
          submitted.body.data.totalIdr - submitted.body.data.depositAppliedIdr;
        expect(due).toBeGreaterThan(0);
        await capturedCash(active.id, due);
      }
      const draft = await createDraft(guest.sessionId);
      const before = await snapshot(guest.sessionId, draft.id);
      expect(before.deposit_idr).toBeLessThanOrEqual(creditIdr);
      const closed = await fixture.post(
        `/api/table-sessions/${guest.sessionId}/close`,
        { tableCleaned: true },
      );
      expect(closed.status, JSON.stringify(closed.body)).toBe(200);
      expect(closed.body.data.status).toBe("closed");
      expect((await fixture.guestGet(guest, "")).status).toBe(401);
      const refused = await submit(draft.id);
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      const found = await fixture.get(`${fixture.base}/${draft.id}`);
      expect(found.status, JSON.stringify(found.body)).toBe(200);
      expect(found.body.data).toMatchObject({
        status: "draft",
        submittedAt: null,
        firedAt: null,
        totalIdr: draft.totalIdr,
        depositAppliedIdr: draft.depositAppliedIdr,
      });
      expect(
        found.body.data.items.every(
          (item: { fireStatus: string }) => item.fireStatus === "held",
        ),
      ).toBe(true);
      expect(await snapshot(guest.sessionId, draft.id)).toEqual(before);
    },
  );

  it("G5-SESSION-02 concurrent submit and close cannot both succeed on the same unpaid session", async () => {
    const guest = await fixture.newGuest();
    const draft = await createDraft(guest.sessionId);
    const [submitted, closed] = await Promise.all([
      submit(draft.id).then((response) => response),
      fixture
        .post(`/api/table-sessions/${guest.sessionId}/close`, {
          tableCleaned: true,
        })
        .then((response) => response),
    ]);
    expect(
      [submitted.status, closed.status].sort(),
      JSON.stringify({ submitted: submitted.body, closed: closed.body }),
    ).toEqual([200, 409]);
    const found = await fixture.get(`${fixture.base}/${draft.id}`);
    expect(found.status).toBe(200);
    if (closed.status === 200) {
      expect(found.body.data.status).toBe("draft");
      expect((await fixture.guestGet(guest, "")).status).toBe(401);
    } else {
      expect(found.body.data.status).toBe("awaiting_payment");
      const bill = await fixture.guestGet(guest, "/bill");
      expect(bill.status, JSON.stringify(bill.body)).toBe(200);
      expect(bill.body.data.totals.outstandingIdr).toBe(draft.totalIdr);
    }
  });
});
