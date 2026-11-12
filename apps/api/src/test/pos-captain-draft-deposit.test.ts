// legend-dysef G5-DP: reservation credit belongs to payable orders. Drafts
// cannot reserve credit that the real bill and cashier then disagree about.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ulidToUuid } from "@starter/shared/core";
import { setQrOrderDepositCreditLookup } from "../services/qr-order-ports.ts";
import { owner } from "./floor-test-helpers.ts";
import { asCashierTenant } from "./pos-cashier-test-helpers.ts";
import {
  captainPaymentFixture,
  resetCaptainPaymentPorts,
  type CaptainPaymentFixture,
} from "./pos-captain-payment-test-helpers.ts";

let fixture: CaptainPaymentFixture;
beforeAll(async () => {
  fixture = await captainPaymentFixture("draft-dp");
});
afterEach(() => {
  setQrOrderDepositCreditLookup(null);
});
afterAll(async () => {
  resetCaptainPaymentPorts();
  await owner.end();
});

async function payableDeposit(sessionId: string) {
  const { rows } = await owner.query<{ amount: number }>(
    "SELECT coalesce(sum(deposit_applied_idr),0)::int AS amount FROM orders WHERE tenant_id=$1 AND table_session_id=$2 AND status NOT IN ('draft','voided')",
    [fixture.tenant.tenantId, sessionId],
  );
  return rows[0]!.amount;
}

describe("legend-dysef draft DP allocation agrees with the payable bill", () => {
  it.each(["cash", "qris"] as const)(
    "G5-DP-01 draft A leaves one DP for submitted B and the real %s amount equals the guest remainder",
    async (method) => {
      setQrOrderDepositCreditLookup(async () => 20_000);
      const guest = await fixture.newGuest();
      const parked = await fixture.createDraft(guest.sessionId);
      expect(parked.depositAppliedIdr).toBe(0);
      const selected = await fixture.createDraft(guest.sessionId);
      expect(selected.depositAppliedIdr).toBe(0);
      const submitted = await fixture.submit(selected.id);
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
      expect(submitted.body.data.depositAppliedIdr).toBe(20_000);
      const due = submitted.body.data.totalIdr - 20_000;
      const bill = await fixture.guestGet(guest, "/bill");
      expect(bill.status, JSON.stringify(bill.body)).toBe(200);
      expect(bill.body.data.totals).toMatchObject({
        totalIdr: submitted.body.data.totalIdr,
        paidIdr: 20_000,
        outstandingIdr: due,
      });
      const paid = await fixture.tender(
        selected.id,
        submitted.body.data.status,
        method,
        due,
      );
      expect(paid.status, JSON.stringify(paid.body)).toBe(201);
      expect(paid.body.data.tender.amountIdr).toBe(due);
      if (method === "cash") {
        expect(paid.body.data.tender.changeIdr).toBe(0);
        expect(paid.body.data.remainingIdr).toBe(0);
        const settled = await fixture.guestGet(guest, "/bill");
        expect(settled.body.data.totals).toMatchObject({
          paidIdr: submitted.body.data.totalIdr,
          outstandingIdr: 0,
        });
      } else {
        expect(fixture.gateway.requests.at(-1)?.amountIdr).toBe(due);
        expect(paid.body.data.tender.status).toBe("authorized");
        expect(paid.body.data.remainingIdr).toBe(due);
      }
      expect(await payableDeposit(guest.sessionId)).toBe(20_000);
      const unchanged = await fixture.get(`${fixture.base}/${parked.id}`);
      expect(unchanged.body.data).toMatchObject({
        status: "draft",
        depositAppliedIdr: 0,
      });
    },
  );

  it("G5-DP-02 repricing an unsubmitted draft cannot allocate session credit", async () => {
    setQrOrderDepositCreditLookup(async () => 20_000);
    const guest = await fixture.newGuest();
    const draft = await fixture.createDraft(guest.sessionId);
    const discounted = await fixture.post(
      `${fixture.base}/${draft.id}/discounts`,
      {
        source: "manual",
        kind: "percent",
        percentBp: 100,
        reason: "manager_goodwill",
        reasonNote: "Diskon kecil uji",
        idempotencyKey: randomUUID(),
      },
    );
    expect(
      discounted.status,
      JSON.stringify(discounted.body),
    ).toBeGreaterThanOrEqual(200);
    expect(discounted.status, JSON.stringify(discounted.body)).toBeLessThan(
      300,
    );
    expect(discounted.body.data.totalIdr).toBeLessThan(draft.totalIdr);
    expect(discounted.body.data.status).toBe("draft");
    expect(discounted.body.data.depositAppliedIdr).toBe(0);
    expect(await payableDeposit(guest.sessionId)).toBe(0);
  });

  it("G5-DP-03 legacy draft allocations are ignored and reassigned only when each order becomes payable", async () => {
    setQrOrderDepositCreditLookup(async () => 20_000);
    const guest = await fixture.newGuest();
    const stale = await fixture.createDraft(guest.sessionId);
    await asCashierTenant(fixture.tenant.tenantId, (client) =>
      client.query(
        "UPDATE orders SET deposit_applied_idr=20000 WHERE tenant_id=$1 AND id=$2",
        [fixture.tenant.tenantId, ulidToUuid(stale.id)],
      ),
    );
    const selected = await fixture.createDraft(guest.sessionId);
    const submitted = await fixture.submit(selected.id);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    expect(submitted.body.data.depositAppliedIdr).toBe(20_000);
    expect(await payableDeposit(guest.sessionId)).toBe(20_000);
    const resumed = await fixture.submit(stale.id);
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    expect(resumed.body.data.depositAppliedIdr).toBe(0);
    expect(await payableDeposit(guest.sessionId)).toBe(20_000);
  });

  it("G5-DP-04 concurrent payable orders consume one credit despite a legacy unsubmitted allocation", async () => {
    setQrOrderDepositCreditLookup(async () => 20_000);
    const guest = await fixture.newGuest();
    const stale = await fixture.createDraft(guest.sessionId);
    await asCashierTenant(fixture.tenant.tenantId, (client) =>
      client.query(
        "UPDATE orders SET deposit_applied_idr=20000 WHERE tenant_id=$1 AND id=$2",
        [fixture.tenant.tenantId, ulidToUuid(stale.id)],
      ),
    );
    const first = await fixture.createDraft(guest.sessionId);
    const second = await fixture.createDraft(guest.sessionId);
    const results = await Promise.all([
      fixture.submit(first.id).then((response) => response),
      fixture.submit(second.id).then((response) => response),
    ]);
    for (const result of results)
      expect(result.status, JSON.stringify(result.body)).toBe(200);
    const applied = results.reduce(
      (sum, result) => sum + result.body.data.depositAppliedIdr,
      0,
    );
    expect(applied).toBe(20_000);
    expect(await payableDeposit(guest.sessionId)).toBe(20_000);
    const gross = results.reduce(
      (sum, result) => sum + result.body.data.totalIdr,
      0,
    );
    const bill = await fixture.guestGet(guest, "/bill");
    expect(bill.status, JSON.stringify(bill.body)).toBe(200);
    expect(bill.body.data.totals).toMatchObject({
      totalIdr: gross,
      paidIdr: 20_000,
      outstandingIdr: gross - 20_000,
    });
  });
});
