// legend-i83ls (finding 2): an orphan `oic:<chargeId>` payment link.
//
// `ensureChargeLink` opens the charge's link through `createPaymentLink`, which
// commits in its OWN transaction, and only then writes `payment_link_id` on the
// charge in the caller's transaction. If that second step never lands (crash,
// rollback, failed seal) the link row stays and the charge has no link. The
// guest never received the link token, so no intent can exist on it.
//
// The old partial unique index on (tenant_id, reference) for `oic:%` turned
// every later attempt into a 23505 / 500, forever. Expected now: the guest's
// next attempt succeeds, the orphan is cancelled (`cancelPaymentLinkInTx`),
// and at most one active `oic:<chargeId>` link remains.
//
// Assumptions:
// - The orphan is simulated by calling `createPaymentLink` for the charge with
//   the same bill parts as `ensureChargeLink`, and leaving the charge alone.
// - "Active" = `expires_at` null or in the future.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenantIdSchema, type ScopedTenantContext } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { deliverIssueChargeEvent } from "../services/order-recovery-charge.ts";
import { deliverSwapKitchenEvent } from "../services/order-recovery-swap-kitchen.ts";
import { createPaymentLink } from "../services/payment.service.ts";
import { agent, originHeader } from "./helpers.ts";
import {
  PRICES,
  createWorld,
  type Guest,
  type World,
} from "./order-recovery-helpers.ts";
import { owner } from "./floor-test-helpers.ts";

let w: World;

beforeAll(async () => {
  w = await createWorld();
}, 120_000);

afterAll(async () => {
  await w.teardown();
});

const DIFFERENCE = PRICES.kopi - PRICES.roti;

function contextOf(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

async function openCharge() {
  const order = await w.paidOrder();
  const issueId = (await w.report(order.roti.id)).body.data.id as string;
  const approvalId = await w.insertApproval({
    actionType: "price_correction",
    objectType: "order_issue",
    objectId: issueId,
    amountIdr: DIFFERENCE,
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
  const event = (await w.outboxRows("order_issue.resolved", issueId))[0]!.event;
  const context = contextOf(w.tenant.tenantId);
  await withTenant(db, context, async (tx) => {
    await deliverSwapKitchenEvent(context, event, tx);
    await deliverIssueChargeEvent(context, event, tx);
  });
  const { rows } = await owner.query<{
    id: string;
    outlet_id: string;
    gross: string;
    service: string;
    pbjt: string;
    amount: string;
  }>(
    `SELECT id, outlet_id, gross_sales_idr AS gross, service_charge_idr AS service,
            pbjt_idr AS pbjt, amount_idr AS amount
     FROM order_issue_charges WHERE tenant_id = $1 AND order_issue_id = $2`,
    [w.tenant.tenantId, issueId],
  );
  expect(rows).toHaveLength(1);
  return { ...order, issueId, charge: rows[0]! };
}

/** The leftover of a crashed `ensureChargeLink`: link committed, charge untouched. */
async function plantOrphanLink(
  charge: Awaited<ReturnType<typeof openCharge>>["charge"],
) {
  const opened = await createPaymentLink(
    contextOf(w.tenant.tenantId),
    {
      outletId: charge.outlet_id,
      reference: `oic:${charge.id}`,
      tableLabel: null,
      pax: null,
      subtotalIdr: Number(charge.gross),
      discountIdr: 0,
      serviceChargeIdr: Number(charge.service),
      taxIdr: Number(charge.pbjt),
      roundingIdr: 0,
      totalIdr: Number(charge.amount),
      returnPath: null,
    },
    "system:qr-order",
    new Date(),
  );
  return opened.linkId;
}

function guestPay(guest: Guest, chargeId: string) {
  return agent(w.app)
    .post(
      `/api/table-sessions/${guest.sessionId}/issue-charges/${chargeId}/payments`,
    )
    .set("Host", w.tenant.hostname)
    .set("Authorization", `Bearer ${guest.token}`)
    .set(originHeader)
    .send({ method: "qris", idempotencyKey: randomUUID() });
}

async function linksOf(chargeId: string) {
  const { rows } = await owner.query<{ id: string; active: boolean }>(
    `SELECT id, (expires_at IS NULL OR expires_at > now()) AS active
     FROM payment_links WHERE tenant_id = $1 AND reference = $2
     ORDER BY created_at, id`,
    [w.tenant.tenantId, `oic:${chargeId}`],
  );
  return rows;
}

describe("legend-i83ls orphan oic:<chargeId> link", () => {
  it("OL-1 guest pays after an orphan link was left behind: 201, orphan cancelled, one active link", async () => {
    const { guest, charge } = await openCharge();
    const orphanId = await plantOrphanLink(charge);

    const res = await guestPay(guest, charge.id);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const links = await linksOf(charge.id);
    expect(
      links.filter((l) => l.active),
      "active oic links",
    ).toHaveLength(1);
    const orphan = links.find((l) => l.id === orphanId)!;
    expect(orphan.active, "orphan still active").toBe(false);

    const { rows } = await owner.query<{
      payment_link_id: string;
      payment_intent_id: string;
    }>(
      "SELECT payment_link_id, payment_intent_id FROM order_issue_charges WHERE tenant_id = $1 AND id = $2",
      [w.tenant.tenantId, charge.id],
    );
    const activeId = links.find((l) => l.active)!.id;
    expect(rows[0]!.payment_link_id).toBe(activeId);
    expect(rows[0]!.payment_link_id).not.toBe(orphanId);
    const intents = await owner.query<{ id: string; payment_link_id: string }>(
      "SELECT id, payment_link_id FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = ANY($2::uuid[])",
      [w.tenant.tenantId, links.map((l) => l.id)],
    );
    expect(intents.rows).toEqual([
      { id: rows[0]!.payment_intent_id, payment_link_id: activeId },
    ]);
  });

  it("OL-2 two orphan links: both cancelled, guest still gets one working link; a repeat call reuses it", async () => {
    const { guest, charge } = await openCharge();
    // A second orphan cannot exist under the old unique index; only the fixed
    // schema allows it, and the fix must cope with any number.
    const first = await plantOrphanLink(charge);
    const second = await plantOrphanLink(charge);

    const res = await guestPay(guest, charge.id);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const again = await guestPay(guest, charge.id);
    expect([200, 201]).toContain(again.status);
    expect(again.body.data.id).toBe(res.body.data.id);

    const links = await linksOf(charge.id);
    expect(links).toHaveLength(3);
    expect(links.filter((l) => l.active)).toHaveLength(1);
    for (const id of [first, second])
      expect(links.find((l) => l.id === id)!.active).toBe(false);
  });
});
