// SO-885 card D (legend-adiov): every force release opens one durable
// reconciliation row, staff are alerted, and the open queue is listed by a
// guarded route (no UI yet).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { owner } from "./floor-test-helpers.ts";
import {
  holdFixture,
  resetHoldPorts,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";
import {
  OPENED_ALERT_TITLE,
  notificationCount,
  reconRows,
  releaseKit,
} from "./qris-hold-so885-d-helpers.ts";

vi.setConfig({ testTimeout: 180_000 });

let fx: HoldFixture;
let kit: ReturnType<typeof releaseKit>;
beforeAll(async () => {
  fx = await holdFixture("qris-hold-so885-d-queue");
  kit = releaseKit(fx);
});
afterAll(async () => {
  resetHoldPorts();
  await owner.end();
});

let granted = false;
async function grantReconcile() {
  if (granted) return;
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Rekonsiliasi QRIS Uji', true, 'finance', $3, false, '["tenant"]')`,
    [roleId, fx.tenant.tenantId, JSON.stringify(["payment.reconcile"])],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [fx.tenant.tenantId, fx.staff.userId, roleId],
  );
  granted = true;
}

const listUrl = () =>
  `/api/outlets/${fx.tenant.outletId}/pos/qris/reconciliations`;

describe("SO-885 D-05 every release without provider proof opens a row", () => {
  it.each([
    ["the provider is down", { error: "5xx" as const }],
    ["the provider still says pending", { rawStatus: "01" as const }],
  ])(
    "D-05 %s: one open row, one staff alert, listed by the route",
    async (_label, answer) => {
      const before = await notificationCount(fx, OPENED_ALERT_TITLE);
      const { qr } = await kit.forceRelease(answer);
      const rows = await reconRows(fx, qr.intentId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: "open",
        reason: "force_released",
        attempts: 0,
        resolution: null,
        outlet_id: fx.tenant.outletId,
      });
      expect(rows[0]!.next_check_at.getTime()).toBeLessThan(
        Date.now() + 60 * 60_000,
      );
      expect(await notificationCount(fx, OPENED_ALERT_TITLE)).toBeGreaterThan(
        before,
      );

      // The cashier cannot read the queue; a role with payment.reconcile can.
      if (!granted) expect((await fx.get(listUrl())).status).toBe(403);
      await grantReconcile();
      const listed = await fx.get(listUrl());
      expect(listed.status, JSON.stringify(listed.body)).toBe(200);
      const items = listed.body.data as {
        paymentIntentId: string;
        status: string;
      }[];
      expect(items.map((i) => i.paymentIntentId)).toContain(qr.intentId);
      expect(items.every((i) => i.status === "open")).toBe(true);
    },
  );

  it("D-05 the route needs a session and a valid status filter", async () => {
    await grantReconcile();
    const bad = await fx.get(`${listUrl()}?status=nope`);
    expect(bad.status).toBe(422);
  });
});
