// 1269 E3b cloud write gate over HTTP, order recovery family (CTO 26 Nov):
// reporting, resolving and the guest choice of a failed item write edge-owned
// rows (the swap line and its KDS ticket), and the dearer-swap charge routes
// move drawer cash. An outlet with an active edge node is refused the whole
// flow with 409 POS_WRITE_ON_EDGE, the gateway refund included (in doubt, no
// money out), and nothing changes. Without an edge, or with the node revoked,
// the request reaches its handler. A caller who cannot see the target (another
// outlet's supervisor) never learns of the edge.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ulidToUuid } from "@starter/shared/core";
import { originHeader } from "./helpers.ts";
import { owner, type Staff } from "./floor-test-helpers.ts";
import {
  createWorld,
  type Guest,
  type World,
} from "./order-recovery-helpers.ts";

let w: World;
let guest: Guest;
let issueId: string;
let freshItemId: string;
const chargeId = randomUUID();
const manualRefundId = randomUUID();

type Route = [name: string, path: () => string];

const charge = (action: string) =>
  `/api/order-issue-charges/${chargeId}/${action}`;
const manualRefund = (action: string) =>
  `/api/order-issue-charge-manual-refunds/${manualRefundId}/${action}`;

/** Staff routes; the guest choice is checked on its own below. */
const routes: Route[] = [
  ["report item", () => `/api/order-items/${freshItemId}/issues`],
  ["resolve issue", () => `/api/order-issues/${issueId}/resolve`],
  ["charge waive", () => charge("waive")],
  ["charge expire", () => charge("expire")],
  ["charge refund", () => charge("refund")],
  ["charge manual refund", () => charge("manual-refund")],
  ["manual refund approve", () => manualRefund("approve")],
  ["manual refund reject", () => manualRefund("reject")],
  ["charge collect at pos", () => charge("collect-at-pos")],
];

function post(route: Route, who: Staff = w.supervisor) {
  return w.staffPost(who, route[1](), {});
}

function choose() {
  return w.as(guest).choose(issueId, { choice: "voucher" });
}

async function addEdge(): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO edge_nodes (id, tenant_id, outlet_id, role, status, label, credential_hash, last_heartbeat_at)
     VALUES ($1, $2, $3, 'primary', 'active', 'Server lokal', $4, now())`,
    [id, w.tenant.tenantId, w.tenant.outletId, "c".repeat(64)],
  );
  return id;
}

async function revoke(id: string): Promise<void> {
  await owner.query(
    "UPDATE edge_nodes SET status = 'revoked', revoked_at = now() WHERE id = $1",
    [id],
  );
}

async function state() {
  const { rows } = await owner.query(
    `SELECT
       (SELECT status FROM order_issues WHERE id::text = $1) AS issue,
       (SELECT status FROM order_issue_charges WHERE id = $2) AS charge,
       (SELECT status FROM order_issue_charge_manual_refunds WHERE id = $3) AS refund,
       (SELECT count(*)::int FROM order_issues WHERE order_item_id = $4) AS fresh_issues`,
    [issueId, chargeId, manualRefundId, ulidToUuid(freshItemId)],
  );
  return rows[0];
}

beforeAll(async () => {
  w = await createWorld();
  const paid = await w.paidOrder();
  guest = paid.guest;
  freshItemId = paid.kopi.id;
  const reported = await w.report(paid.roti.id);
  expect(reported.status, JSON.stringify(reported.body)).toBe(201);
  issueId = reported.body.data.id as string;
  await owner.query(
    `INSERT INTO order_issue_charges
       (id, tenant_id, outlet_id, order_issue_id, order_id, table_session_id, route, status,
        difference_idr, gross_sales_idr, service_charge_idr, pbjt_idr, amount_idr)
     VALUES ($1, $2, $3, $4, $5, $6, 'qr_link', 'open', 6000, 6000, 300, 630, 6930)`,
    [
      chargeId,
      w.tenant.tenantId,
      w.tenant.outletId,
      issueId,
      ulidToUuid(paid.order.id),
      guest.sessionId,
    ],
  );
  await owner.query(
    `INSERT INTO order_issue_charge_manual_refunds
       (id, tenant_id, outlet_id, charge_id, method, amount_idr, reason, reference, status,
        requested_by, requested_at)
     VALUES ($1, $2, $3, $4, 'edc', 6930, 'Tamu komplain', $5, 'requested', $6, now())`,
    [
      manualRefundId,
      w.tenant.tenantId,
      w.tenant.outletId,
      chargeId,
      `EDC-${manualRefundId.slice(0, 8)}`,
      w.supervisor.userId,
    ],
  );
  // The approve, reject and till routes need their own permissions.
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Refund Gerbang', false, NULL, $3, false, '["tenant"]')`,
    [
      roleId,
      w.tenant.tenantId,
      JSON.stringify(["pos.refund.approve", "pos.payment.accept"]),
    ],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [w.tenant.tenantId, w.supervisor.userId, roleId],
  );
}, 180_000);

afterAll(async () => {
  await w.teardown();
});

describe("1269 E3b POS_WRITE_ON_EDGE on the order recovery flow", () => {
  it("an active edge: every recovery write and the guest choice are 409, nothing changes", async () => {
    const before = await state();
    const id = await addEdge();
    try {
      for (const route of routes) {
        const response = await post(route);
        expect(response.status, route[0]).toBe(409);
        expect(response.body.error.code, route[0]).toBe("POS_WRITE_ON_EDGE");
      }
      const chosen = await choose();
      expect(chosen.status).toBe(409);
      expect(chosen.body.error.code).toBe("POS_WRITE_ON_EDGE");
    } finally {
      await revoke(id);
    }
    expect(await state()).toEqual(before);
    expect(before).toMatchObject({
      issue: "open",
      charge: "open",
      refund: "requested",
      fresh_issues: 0,
    });
  });

  it("R1 another outlet's supervisor never learns of the edge: no 409", async () => {
    const id = await addEdge();
    try {
      for (const route of routes) {
        const response = await post(route, w.otherOutletSupervisor);
        expect(response.body.error?.code, route[0]).not.toBe(
          "POS_WRITE_ON_EDGE",
        );
      }
      const anonymous = await w.anonymousGuestChoose(issueId, {
        choice: "voucher",
      });
      expect(anonymous.status).toBe(401);
    } finally {
      await revoke(id);
    }
  });

  it("W1 an apology voucher on an outlet its edge serves: 201, a replay is the same voucher, no edge-owned row changes", async () => {
    const edgeOwned = async () => {
      const tables = [
        "orders",
        "order_items",
        "pos_orders",
        "kitchen_tickets",
        "pos_shifts",
        "cash_movements",
      ];
      const { rows } = await owner.query(
        `SELECT ${tables
          .map(
            (table) =>
              `(SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t::text), ''))
                  FROM ${table} t WHERE t.tenant_id = $1) AS ${table}`,
          )
          .join(", ")},
           (SELECT count(*)::int FROM apology_vouchers WHERE tenant_id = $1) AS vouchers`,
        [w.tenant.tenantId],
      );
      return rows[0] as Record<string, unknown>;
    };
    const id = await addEdge();
    try {
      const before = await edgeOwned();
      // A standalone voucher always needs an approval (legend-1222).
      const post = (key: string, body: Record<string, unknown>) =>
        w.outletSupervisor.client
          .post("/api/apology-vouchers")
          .set(w.headers)
          .set(originHeader)
          .set("Idempotency-Key", key)
          .send(body);
      const body = { valueIdr: 5000, reason: "Pesanan terlambat lama" };
      const asked = await post(randomUUID(), body);
      expect(asked.body.error?.code, JSON.stringify(asked.body)).toBe(
        "APPROVAL_REQUIRED",
      );
      const [requestId] =
        JSON.stringify(asked.body.error).match(
          /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
        ) ?? [];
      await w.approveExisting(requestId!);
      const idempotencyKey = randomUUID();
      const issue = () =>
        post(idempotencyKey, { ...body, approvalRequestId: requestId });
      const first = await issue();
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      const replay = await issue();
      expect([200, 201], JSON.stringify(replay.body)).toContain(replay.status);
      expect(replay.body.data.id).toBe(first.body.data.id);
      expect(replay.body.data.code).toBe(first.body.data.code);
      expect(await edgeOwned()).toEqual({
        ...before,
        vouchers: Number(before.vouchers) + 1,
      });
    } finally {
      await revoke(id);
    }
  });

  it("a revoked edge node leaves the flow to the cloud again", async () => {
    for (const route of routes) {
      const response = await post(route);
      expect(response.body.error?.code, route[0]).not.toBe("POS_WRITE_ON_EDGE");
    }
    const chosen = await choose();
    expect(chosen.body.error?.code).not.toBe("POS_WRITE_ON_EDGE");
  });
});
