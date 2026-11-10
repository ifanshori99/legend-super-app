// legend-i83ls S4: the dearer-swap charge on the open bill and the staff
// waive / expire routes (docs: scratchpad design-B.md).
// Written before the implementation, so it starts red.
//
// - settlementOf (the ORD-10 port and GET /bill): a charge `open` or `paid`
//   adds its amount to the bill total, a `paid` one to what is paid; `waived`,
//   `expired` and `routed_pos` owe nothing here. So closing a session waits for
//   an `open` charge (outstanding = total - paid).
// - GET /bill lists every charge of the session in `charges[]`.
// - POST /api/order-issue-charges/:chargeId/waive|expire (permission
//   `order.recovery.handle` on the charge's outlet, body `{ reason }`): only an
//   `open` charge, once (a repeat is a no-op without a second audit row), the
//   pending link is cancelled, audit `order_issue.charge_waived` /
//   `order_issue.charge_expired`. Neither writes a journal.
//
// The link reference is `oic:<chargeId>` (40 chars): createPaymentLink caps
// `reference` at 40, so the design's `order-issue-charge:<id>` cannot be used.
//
// Assumptions where the design is silent: a decided charge refused with 409;
// a missing charge or one of another outlet answers 404 / 403; the shared
// world does not seed accounting, so no journal row exists to assert on and
// the "no journal" rule is checked through the outbox: no `order_issue.*`
// event is appended.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenantIdSchema, ulidToUuid } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { createPaymentLink } from "../services/payment.service.ts";
import { qrOrderSettlementLookup } from "../services/qr-order.service.ts";
import { agent, originHeader } from "./helpers.ts";
import { createWorld, type World } from "./order-recovery-helpers.ts";
import { owner } from "./floor-test-helpers.ts";

let w: World;

beforeAll(async () => {
  w = await createWorld();
}, 120_000);

afterAll(async () => {
  await w.teardown();
});

const DIFFERENCE = 6_000;
// 6.000 + 5% service (300) + 10% PBJT on (6.000 + 300) = 630 => 6.930.
const SERVICE = 300;
const PBJT = 630;
const AMOUNT = DIFFERENCE + SERVICE + PBJT;

type Status = "open" | "paid" | "routed_pos" | "waived" | "expired";

/** A paid order whose roti failed, plus a charge of `status` on the guest's session. */
async function chargeOf(status: Status = "open", withLink = false) {
  const paid = await w.paidOrder();
  const issueId = (await w.report(paid.roti.id)).body.data.id as string;
  const chargeId = randomUUID();
  let linkId: string | null = null;
  if (withLink) {
    const opened = await createPaymentLink(
      scopedContext(),
      {
        outletId: w.tenant.outletId,
        reference: `oic:${chargeId}`,
        tableLabel: null,
        pax: null,
        subtotalIdr: DIFFERENCE,
        discountIdr: 0,
        serviceChargeIdr: SERVICE,
        taxIdr: PBJT,
        roundingIdr: 0,
        totalIdr: AMOUNT,
        returnPath: null,
      },
      w.supervisor.userId,
    );
    linkId = opened.linkId;
  }
  await owner.query(
    `INSERT INTO order_issue_charges
       (id, tenant_id, outlet_id, order_issue_id, order_id, table_session_id, route, status,
        difference_idr, gross_sales_idr, service_charge_idr, pbjt_idr, amount_idr, payment_link_id, payment_link_token_sealed, paid_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'qr_link', $7, $8, $8, $9, $10, $11, $12, CASE WHEN $12::uuid IS NULL THEN NULL ELSE 'test-sealed' END, $13)`,
    [
      chargeId,
      w.tenant.tenantId,
      w.tenant.outletId,
      issueId,
      ulidToUuid(paid.order.id),
      paid.guest.sessionId,
      status,
      DIFFERENCE,
      SERVICE,
      PBJT,
      AMOUNT,
      linkId,
      status === "paid" ? new Date().toISOString() : null,
    ],
  );
  return { ...paid, issueId, chargeId, linkId };
}

function scopedContext() {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(w.tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

/** GET /bill with the guest's session credential. */
function billOf(guest: { token: string; sessionId: string }) {
  return agent(w.app)
    .get(`/api/table-sessions/${guest.sessionId}/bill`)
    .set("Host", w.tenant.hostname)
    .set("Authorization", `Bearer ${guest.token}`)
    .set(originHeader);
}

async function settlement(sessionId: string) {
  const context = scopedContext();
  return withTenant(db, context, (tx) =>
    qrOrderSettlementLookup({
      tx,
      tenantId: context.tenant.tenantId,
      sessionId,
    }),
  );
}

async function chargeRow(chargeId: string) {
  const { rows } = await owner.query<{
    status: string;
    closed_at: Date | null;
    closed_by: string | null;
    close_reason: string | null;
  }>(
    "SELECT status, closed_at, closed_by, close_reason FROM order_issue_charges WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, chargeId],
  );
  return rows[0]!;
}

async function auditCount(action: string, chargeId: string) {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*) AS n FROM audit_logs
     WHERE tenant_id = $1 AND event->>'action' = $2 AND event->>'objectId' = $3`,
    [w.tenant.tenantId, action, chargeId],
  );
  return Number(rows[0]!.n);
}

const waive = (chargeId: string, body: Record<string, unknown> = {}) =>
  w.staffPost(w.supervisor, `/api/order-issue-charges/${chargeId}/waive`, {
    reason: "Tamu komplain, selisih dibebaskan",
    ...body,
  });
const expire = (chargeId: string, body: Record<string, unknown> = {}) =>
  w.staffPost(w.supervisor, `/api/order-issue-charges/${chargeId}/expire`, {
    reason: "Tamu pulang sebelum bayar",
    ...body,
  });

describe("settlement of a session with a swap charge", () => {
  it("an open charge raises the total, not the paid amount", async () => {
    const paid = await w.paidOrder();
    const before = await settlement(paid.guest.sessionId);
    const issueId = (await w.report(paid.roti.id)).body.data.id as string;
    await owner.query(
      `INSERT INTO order_issue_charges
         (tenant_id, outlet_id, order_issue_id, order_id, table_session_id, route, status,
          difference_idr, gross_sales_idr, service_charge_idr, pbjt_idr, amount_idr)
       VALUES ($1, $2, $3, $4, $5, 'qr_link', 'open', $6, $6, $7, $8, $9)`,
      [
        w.tenant.tenantId,
        w.tenant.outletId,
        issueId,
        ulidToUuid(paid.order.id),
        paid.guest.sessionId,
        DIFFERENCE,
        SERVICE,
        PBJT,
        AMOUNT,
      ],
    );
    const after = await settlement(paid.guest.sessionId);
    expect(after.billTotalIdr - before.billTotalIdr).toBe(AMOUNT);
    expect(after.paidIdr - before.paidIdr).toBe(0);
  });

  it("a paid charge raises total and paid together", async () => {
    const paid = await w.paidOrder();
    const before = await settlement(paid.guest.sessionId);
    const issueId = (await w.report(paid.roti.id)).body.data.id as string;
    await owner.query(
      `INSERT INTO order_issue_charges
         (tenant_id, outlet_id, order_issue_id, order_id, table_session_id, route, status,
          difference_idr, gross_sales_idr, service_charge_idr, pbjt_idr, amount_idr, paid_at)
       VALUES ($1, $2, $3, $4, $5, 'qr_link', 'paid', $6, $6, $7, $8, $9, now())`,
      [
        w.tenant.tenantId,
        w.tenant.outletId,
        issueId,
        ulidToUuid(paid.order.id),
        paid.guest.sessionId,
        DIFFERENCE,
        SERVICE,
        PBJT,
        AMOUNT,
      ],
    );
    const after = await settlement(paid.guest.sessionId);
    expect(after.billTotalIdr - before.billTotalIdr).toBe(AMOUNT);
    expect(after.paidIdr - before.paidIdr).toBe(AMOUNT);
  });

  it.each(["waived", "expired", "routed_pos"] as const)(
    "a %s charge owes nothing on the bill",
    async (status) => {
      const paid = await w.paidOrder();
      const before = await settlement(paid.guest.sessionId);
      const issueId = (await w.report(paid.roti.id)).body.data.id as string;
      await owner.query(
        `INSERT INTO order_issue_charges
           (tenant_id, outlet_id, order_issue_id, order_id, table_session_id, route, status,
            difference_idr, gross_sales_idr, service_charge_idr, pbjt_idr, amount_idr,
            closed_at, closed_by, close_reason)
         VALUES ($1, $2, $3, $4, $5, $10, $11, $6, $6, $7, $8, $9, $12, $13, $14)`,
        [
          w.tenant.tenantId,
          w.tenant.outletId,
          issueId,
          ulidToUuid(paid.order.id),
          paid.guest.sessionId,
          DIFFERENCE,
          SERVICE,
          PBJT,
          AMOUNT,
          status === "routed_pos" ? "pos" : "qr_link",
          status,
          status === "routed_pos" ? null : new Date().toISOString(),
          status === "waived" ? w.supervisor.userId : null,
          status === "waived" ? "Uji" : null,
        ],
      );
      expect(await settlement(paid.guest.sessionId)).toEqual(before);
    },
  );

  it("GET /bill lists the charges and counts the open one in the totals", async () => {
    const { guest, chargeId } = await chargeOf("open");
    const base = await settlement(guest.sessionId);
    const bill = await billOf(guest);
    expect(bill.status).toBe(200);
    expect(bill.body.data.totals.totalIdr).toBe(base.billTotalIdr);
    expect(bill.body.data.totals.paidIdr).toBe(base.paidIdr);
    expect(bill.body.data.totals.outstandingIdr).toBe(
      Math.max(0, base.billTotalIdr - base.paidIdr),
    );
    expect(bill.body.data.charges).toHaveLength(1);
    expect(bill.body.data.charges[0]).toMatchObject({
      id: chargeId,
      status: "open",
      differenceIdr: DIFFERENCE,
      serviceChargeIdr: SERVICE,
      pbjtIdr: PBJT,
      amountIdr: AMOUNT,
    });
  });

  it("GET /bill of a session without a charge has an empty charges list", async () => {
    const paid = await w.paidOrder();
    const bill = await billOf(paid.guest);
    expect(bill.status).toBe(200);
    expect(bill.body.data.charges).toEqual([]);
  });
});

describe("staff waive and expire", () => {
  it("waives an open charge: reason, actor, audit, settlement back", async () => {
    const { guest, chargeId } = await chargeOf("open");
    const open = await settlement(guest.sessionId);
    const res = await waive(chargeId);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: chargeId, status: "waived" });
    const row = await chargeRow(chargeId);
    expect(row.status).toBe("waived");
    expect(row.closed_at).not.toBeNull();
    expect(row.closed_by).toBe(w.supervisor.userId);
    expect(row.close_reason).toBe("Tamu komplain, selisih dibebaskan");
    expect(await auditCount("order_issue.charge_waived", chargeId)).toBe(1);
    expect((await settlement(guest.sessionId)).billTotalIdr).toBe(
      open.billTotalIdr - AMOUNT,
    );
  });

  it("expires an open charge with its own audit action", async () => {
    const { chargeId } = await chargeOf("open");
    const res = await expire(chargeId);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: chargeId, status: "expired" });
    expect((await chargeRow(chargeId)).status).toBe("expired");
    expect(await auditCount("order_issue.charge_expired", chargeId)).toBe(1);
    expect(await auditCount("order_issue.charge_waived", chargeId)).toBe(0);
  });

  it("repeating the same action is a no-op without a second audit row", async () => {
    const { chargeId } = await chargeOf("open");
    expect((await waive(chargeId)).status).toBe(200);
    const again = await waive(chargeId, { reason: "Alasan lain lagi" });
    expect(again.status).toBe(200);
    expect(again.body.data.status).toBe("waived");
    expect((await chargeRow(chargeId)).close_reason).toBe(
      "Tamu komplain, selisih dibebaskan",
    );
    expect(await auditCount("order_issue.charge_waived", chargeId)).toBe(1);
  });

  it("refuses a decided charge of the other kind and a paid one", async () => {
    const waived = await chargeOf("open");
    expect((await waive(waived.chargeId)).status).toBe(200);
    expect((await expire(waived.chargeId)).status).toBe(409);
    expect((await chargeRow(waived.chargeId)).status).toBe("waived");

    const paid = await chargeOf("paid");
    expect((await waive(paid.chargeId)).status).toBe(409);
    expect((await expire(paid.chargeId)).status).toBe(409);
    expect((await chargeRow(paid.chargeId)).status).toBe("paid");
  });

  it("closes the pending payment link so the guest cannot pay a waived charge", async () => {
    const { chargeId, linkId } = await chargeOf("open", true);
    expect((await waive(chargeId)).status).toBe(200);
    const { rows } = await owner.query<{ expires_at: Date | null }>(
      "SELECT expires_at FROM payment_links WHERE tenant_id = $1 AND id = $2",
      [w.tenant.tenantId, linkId],
    );
    expect(rows[0]!.expires_at!.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("needs order.recovery.handle, in the charge's outlet", async () => {
    const { chargeId } = await chargeOf("open");
    const path = `/api/order-issue-charges/${chargeId}/waive`;
    const body = { reason: "Tamu komplain, selisih dibebaskan" };
    expect((await w.staffPost(w.floorStaff, path, body)).status).toBe(403);
    // Outlet RLS hides the row from another outlet's scope: 404, not 403.
    expect([403, 404]).toContain(
      (await w.staffPost(w.otherOutletSupervisor, path, body)).status,
    );
    expect((await chargeRow(chargeId)).status).toBe("open");
    expect((await w.staffPost(w.outletSupervisor, path, body)).status).toBe(
      200,
    );
  });

  it("validates the reason and the id", async () => {
    const { chargeId } = await chargeOf("open");
    expect([400, 422]).toContain(
      (await waive(chargeId, { reason: "" })).status,
    );
    expect([400, 422]).toContain(
      (await waive(chargeId, { reason: "ok ok", extra: 1 })).status,
    );
    expect((await chargeRow(chargeId)).status).toBe("open");
    expect((await waive(randomUUID())).status).toBe(404);
  });

  it("an unauthenticated caller is refused", async () => {
    const { chargeId } = await chargeOf("open");
    const res = await agent(w.app)
      .post(`/api/order-issue-charges/${chargeId}/waive`)
      .set("Host", w.tenant.hostname)
      .set(originHeader)
      .send({ reason: "Tamu komplain, selisih dibebaskan" });
    expect(res.status).toBe(401);
  });
});
