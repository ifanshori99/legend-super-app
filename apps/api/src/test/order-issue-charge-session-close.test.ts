// legend-i83ls (review fix B): what happens to an `open` swap charge when its
// table session ends.
//
// - A waiter's forced close (`waiterConfirmedEmpty`) expires the session's
//   `open` charges in the same transaction: status `expired`, closed_at set,
//   close_reason `session_closed`, closed_by null, the payment link cancelled
//   and an `order_issue.charge_expired` audit row (actor system). A pay-first
//   session that was fully paid is closed as `paid_and_cleaned`, never
//   `voided` just because a charge was open.
// - `deliverIssueChargeEvent` for a session that is already closed opens the
//   charge directly as `expired` (reason `session_closed`): an `open` charge
//   nobody can pay would sit on a dead bill.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  tenantIdSchema,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { EventEnvelope } from "@starter/shared/events";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { deliverIssueChargeEvent } from "../services/order-recovery-charge.ts";
import { deliverSwapKitchenEvent } from "../services/order-recovery-swap-kitchen.ts";
import { createPaymentLink } from "../services/payment.service.ts";
import { PRICES, createWorld, type World } from "./order-recovery-helpers.ts";
import { owner } from "./floor-test-helpers.ts";

let w: World;

beforeAll(async () => {
  w = await createWorld();
}, 120_000);

afterAll(async () => {
  await w.teardown();
});

const DIFFERENCE = 6_000;
const SERVICE = 300;
const PBJT = 630;
const AMOUNT = DIFFERENCE + SERVICE + PBJT;

function contextOf(): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(w.tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

/** A paid order whose roti failed, plus an `open` charge with a payment link. */
async function openChargeWithLink() {
  const paid = await w.paidOrder();
  const issueId = (await w.report(paid.roti.id)).body.data.id as string;
  const chargeId = randomUUID();
  const opened = await createPaymentLink(
    contextOf(),
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
  await owner.query(
    `INSERT INTO order_issue_charges
       (id, tenant_id, outlet_id, order_issue_id, order_id, table_session_id, route, status,
        difference_idr, gross_sales_idr, service_charge_idr, pbjt_idr, amount_idr, payment_link_id, payment_link_token_sealed)
     VALUES ($1, $2, $3, $4, $5, $6, 'qr_link', 'open', $7, $7, $8, $9, $10, $11, 'test-sealed')`,
    [
      chargeId,
      w.tenant.tenantId,
      w.tenant.outletId,
      issueId,
      ulidToUuid(paid.order.id),
      paid.guest.sessionId,
      DIFFERENCE,
      SERVICE,
      PBJT,
      AMOUNT,
      opened.linkId,
    ],
  );
  return { ...paid, issueId, chargeId, linkId: opened.linkId };
}

const closeSession = (sessionId: string, body: Record<string, unknown>) =>
  w.staffPost(w.floorStaff, `/api/table-sessions/${sessionId}/close`, body);

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

async function chargeOfIssue(issueId: string) {
  const { rows } = await owner.query<{
    status: string;
    route: string;
    closed_at: Date | null;
    closed_by: string | null;
    close_reason: string | null;
  }>(
    "SELECT status, route, closed_at, closed_by, close_reason FROM order_issue_charges WHERE tenant_id = $1 AND order_issue_id = $2",
    [w.tenant.tenantId, issueId],
  );
  return rows;
}

async function sessionRow(sessionId: string) {
  const { rows } = await owner.query<{
    status: string;
    closed_reason: string | null;
  }>(
    "SELECT status, closed_reason FROM table_sessions WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, sessionId],
  );
  return rows[0]!;
}

async function auditRows(action: string, issueId: string) {
  const { rows } = await owner.query<{ actor_type: string | null }>(
    `SELECT event->>'actorType' AS actor_type FROM audit_logs
     WHERE tenant_id = $1 AND event->>'action' = $2 AND event->>'objectId' = $3`,
    [w.tenant.tenantId, action, issueId],
  );
  return rows;
}

describe("forced close of a session with an open charge", () => {
  it("expires the charge, cancels its link and audits it", async () => {
    const { guest, chargeId, linkId, issueId } = await openChargeWithLink();
    const res = await closeSession(guest.sessionId, {
      tableCleaned: false,
      waiterConfirmedEmpty: true,
    });
    expect(res.status).toBe(200);

    const row = await chargeRow(chargeId);
    expect(row.status).toBe("expired");
    expect(row.closed_at).not.toBeNull();
    expect(row.closed_by).toBeNull();
    expect(row.close_reason).toBe("session_closed");

    const { rows } = await owner.query<{ expires_at: Date | null }>(
      "SELECT expires_at FROM payment_links WHERE tenant_id = $1 AND id = $2",
      [w.tenant.tenantId, linkId],
    );
    expect(rows[0]!.expires_at!.getTime()).toBeLessThanOrEqual(Date.now());

    const audits = await auditRows("order_issue.charge_expired", issueId);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actor_type).toBe("system");
  });

  it("does not record a fully paid pay-first session as voided", async () => {
    const { guest } = await openChargeWithLink();
    const res = await closeSession(guest.sessionId, {
      tableCleaned: true,
      waiterConfirmedEmpty: true,
    });
    expect(res.status).toBe(200);
    expect(await sessionRow(guest.sessionId)).toEqual({
      status: "closed",
      closed_reason: "paid_and_cleaned",
    });
  });

  it("a normal close still waits for an open charge", async () => {
    const { guest, chargeId } = await openChargeWithLink();
    const res = await closeSession(guest.sessionId, {
      tableCleaned: true,
      waiterConfirmedEmpty: false,
    });
    expect(res.status).toBe(409);
    expect((await chargeRow(chargeId)).status).toBe("open");
  });
});

describe("swap charge event on a session that is already closed", () => {
  async function swapped() {
    const order = await w.paidOrder();
    const issueId = (await w.report(order.roti.id)).body.data.id as string;
    const approvalId = await w.insertApproval({
      actionType: "price_correction",
      objectType: "order_issue",
      objectId: issueId,
      amountIdr: PRICES.kopi - PRICES.roti,
      status: "approved",
      requestedBy: w.floorStaff.userId,
    });
    const resolved = await w.staffPost(
      w.supervisor,
      `/api/order-issues/${issueId}/resolve`,
      {
        resolution: "swap",
        replacementItemId: w.ids.kopi,
        approvalRequestId: approvalId,
      },
    );
    expect(resolved.status).toBe(200);
    const rows = await w.outboxRows("order_issue.resolved", issueId);
    expect(rows).toHaveLength(1);
    return { ...order, issueId, event: rows[0]!.event as EventEnvelope };
  }

  async function deliver(event: EventEnvelope) {
    const context = contextOf();
    return withTenant(db, context, async (tx) => {
      await deliverSwapKitchenEvent(context, event, tx);
      await deliverIssueChargeEvent(context, event, tx);
    });
  }

  it("opens the charge as expired, not open", async () => {
    const { guest, issueId, event } = await swapped();
    const closed = await closeSession(guest.sessionId, {
      tableCleaned: true,
      waiterConfirmedEmpty: false,
    });
    expect(closed.status).toBe(200);

    await deliver(event);
    const rows = await chargeOfIssue(issueId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "expired",
      route: "qr_link",
      closed_by: null,
      close_reason: "session_closed",
    });
    expect(rows[0]!.closed_at).not.toBeNull();
    expect(await auditRows("order_issue.charge_expired", issueId)).toHaveLength(
      1,
    );
    expect(await auditRows("order_issue.charge_opened", issueId)).toHaveLength(
      0,
    );

    // A replayed event changes nothing.
    await deliver(event);
    expect(await chargeOfIssue(issueId)).toHaveLength(1);
    expect(await auditRows("order_issue.charge_expired", issueId)).toHaveLength(
      1,
    );
  });

  it("an active session still gets an open charge", async () => {
    const { issueId, event } = await swapped();
    await deliver(event);
    const rows = await chargeOfIssue(issueId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("open");
  });
});
