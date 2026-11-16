// legend-5wn1e: staff release of a virtual account code the provider never
// answered final for. Since SO-896 a pending/expired/failed VA code stays "live"
// (blocks every replacement code) until the provider says it is final. If the
// provider never does, the bill is locked forever. Like the QRIS force release
// (founder Q93) a supervisor may release it, on the most restrictive terms.
//
// Contract used (brief legend-5wn1e, written from the brief, not the code):
// - POST /api/outlets/:outletId/pos/orders/:orderId/va/release, guard
//   pos.payment.accept, body { paymentIntentId, approvedBy, overrideId,
//   idempotencyKey, reason } (reason trimmed, 3..300).
// - Supervisor override (action "void", object = the order, value >= intent
//   amount, requester != approver, one use) is the step-up.
// - Eligible: VA intent of the order, provider_ref set, provider_final_at null,
//   status pending/expired/failed, now >= expires_at + 30 min, no existing
//   release. Otherwise 409 VA_RELEASE_NOT_ELIGIBLE.
// - Provider answers paid and it is applied to the bill: 409 PAID_VA_RELEASE.
//   Open parked funds on the intent: 409 FUNDS_UNRESOLVED.
// - Release writes a row in payment_va_releases (status open, resolved by the
//   worker) and an audit_logs row with action payment_va_code.force_released.
// - A released code no longer blocks a replacement; it is NOT final
//   (provider_final_at stays null) until the provider answers.
// - Money paid on a released code is ALWAYS parked as unallocated funds
//   (once per provider transaction), the confirmation fails with BILL_CLOSED,
//   the bill is never settled by it, open funds block a replacement with
//   409 FUNDS_UNRESOLVED.
// - Worker: worker/payment-va-release-recon.job.ts exports
//   runPaymentVaReleaseReconJob(context, now, { force }), same shape as the
//   QRIS one.
//
// Assumptions: 403 is the answer for a role without pos.payment.accept (the
// permission is read per request); validation failures are 422; an order's
// payment progress is read from payment_links.paid_idr.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/va-staff-release-5wn1e.test.ts" heavy pnpm test
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ulidToUuid,
  uuidToUlid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { consumeApproval } from "../services/pos-order-support.ts";
import { setPaymentGateway } from "../services/payment-gateway.ts";
import {
  confirmPayment,
  holdGatewayAmountMismatch,
  pollPendingGatewayIntents,
} from "../services/payment.service.ts";
import { owner } from "./floor-test-helpers.ts";
import {
  holdFixture,
  resetHoldPorts,
  tryImport,
  unallocatedFunds,
  type HoldFixture,
  type ManagerApproval,
  type ProviderAnswer,
} from "./pos-qris-hold-test-helpers.ts";
import {
  evidenceRows,
  hoursAfter,
  outboxCountOf,
  releaseKit,
} from "./qris-hold-so885-d-helpers.ts";
import { enableVaBank } from "./qris-hold-so879-va-gateway.ts";

vi.setConfig({ testTimeout: 180_000 });

const RELEASE_AFTER_MIN = 30;
const REASON = "Bank tidak menjawab status VA lebih dari sehari";
const AUDIT_ACTION = "payment_va_code.force_released";

let fx: HoldFixture;
let kit: ReturnType<typeof releaseKit>;
beforeAll(async () => {
  fx = await holdFixture("va-staff-release-5wn1e");
  enableVaBank(fx.gateway);
  setPaymentGateway(fx.gateway);
  kit = releaseKit(fx);
});
afterAll(async () => {
  resetHoldPorts();
  await owner.end();
});

type Guest = Awaited<ReturnType<HoldFixture["newGuest"]>>;
type Opened = Awaited<ReturnType<typeof openCode>>;

// ----------------------------------------------------------------- fixtures

function idForms(id: string): string[] {
  const forms = [id];
  for (const convert of [ulidToUuid, uuidToUlid]) {
    try {
      forms.push(String(convert(id as never)));
    } catch {
      /* not that form */
    }
  }
  return forms;
}

function replace(guest: Guest, orderId: string, method: "qris" | "va") {
  return fx.guestPost(guest, "/payments", {
    target: { kind: "order", orderId },
    method,
    ...(method === "va" ? { bankCode: "bmri" } : {}),
    idempotencyKey: randomUUID(),
  });
}

/** A guest order with one code of `method` issued (201). */
async function openCode(method: "va" | "qris" = "va") {
  const guest = await fx.newGuest();
  const order = await fx.qrOrder(guest);
  const res = await replace(guest, order.id, method);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const intentId = res.body.data.id as string;
  const { rows } = await owner.query<{
    amount: number;
    provider_ref: string;
    payment_link_id: string;
  }>(
    `SELECT amount_idr::int AS amount, provider_ref,
            payment_link_id::text AS payment_link_id
       FROM payment_intents WHERE tenant_id=$1 AND id=$2`,
    [fx.tenant.tenantId, intentId],
  );
  return {
    guest,
    order,
    intentId,
    amount: rows[0]!.amount,
    providerRef: rows[0]!.provider_ref,
    linkId: rows[0]!.payment_link_id,
  };
}

/** Expiry `minutes` in the past (status untouched unless given). */
async function lapse(
  code: Opened,
  minutes: number,
  status?: "pending" | "expired" | "failed",
) {
  await owner.query(
    `UPDATE payment_intents
        SET expires_at = now() - $3::int * interval '1 minute',
            status = coalesce($4, status)
      WHERE tenant_id=$1 AND id=$2`,
    [fx.tenant.tenantId, code.intentId, minutes, status ?? null],
  );
}

const releaseUrl = (orderId: string) => `${fx.base}/${orderId}/va/release`;

function postVaRelease(
  code: Opened,
  approval: ManagerApproval,
  extra: Record<string, unknown> = {},
) {
  return fx.post(releaseUrl(code.order.id), {
    paymentIntentId: code.intentId,
    ...approval,
    idempotencyKey: randomUUID(),
    reason: REASON,
    ...extra,
  });
}

const approvalFor = (code: Opened, order: { id: string } = code.order) =>
  kit.managerApproval(order.id, code.amount);

/** Release with a fresh valid approval; expects 200. */
async function releaseOk(code: Opened, provider: ProviderAnswer) {
  fx.gateway.script(code.intentId, provider);
  await lapse(code, RELEASE_AFTER_MIN + 1);
  const approval = await approvalFor(code);
  const res = await postVaRelease(code, approval);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { approval, res };
}

async function releaseRows(intentId?: string) {
  const { rows } = await owner.query<{
    id: string;
    payment_intent_id: string;
    order_id: string;
    outlet_id: string;
    reason: string;
    released_by: string;
    approved_by: string;
    override_id: string;
    status: string;
    attempts: number;
    next_check_at: Date;
    last_provider_status: string | null;
    resolved_at: Date | null;
    resolution: string | null;
  }>(
    `SELECT id::text AS id, payment_intent_id::text AS payment_intent_id,
            order_id::text AS order_id, outlet_id::text AS outlet_id, reason,
            released_by::text AS released_by, approved_by::text AS approved_by,
            override_id::text AS override_id, status, attempts, next_check_at,
            last_provider_status, resolved_at, resolution
       FROM payment_va_releases
      WHERE tenant_id=$1 AND ($2::uuid IS NULL OR payment_intent_id=$2::uuid)
      ORDER BY created_at, id`,
    [fx.tenant.tenantId, intentId ?? null],
  );
  return rows;
}

async function auditRows(code: Opened) {
  const { rows } = await owner.query<{ event: Record<string, unknown> }>(
    `SELECT event FROM audit_logs
      WHERE tenant_id=$1 AND event->>'action'=$2 AND event::text LIKE $3`,
    [fx.tenant.tenantId, AUDIT_ACTION, `%${code.intentId}%`],
  );
  return rows;
}

async function auditCountForOrder(code: Opened) {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_logs
      WHERE tenant_id=$1 AND event->>'action'=$2
        AND (event::text LIKE ANY($3::text[]))`,
    [
      fx.tenant.tenantId,
      AUDIT_ACTION,
      [code.intentId, ...idForms(code.order.id)].map((x) => `%${x}%`),
    ],
  );
  return rows[0]!.n;
}

async function intentRow(intentId: string) {
  const { rows } = await owner.query<{
    status: string;
    provider_final_at: Date | null;
  }>(
    "SELECT status, provider_final_at FROM payment_intents WHERE tenant_id=$1 AND id=$2",
    [fx.tenant.tenantId, intentId],
  );
  return rows[0]!;
}

async function paidIdr(linkId: string) {
  const { rows } = await owner.query<{ paid: number }>(
    "SELECT paid_idr::int AS paid FROM payment_links WHERE tenant_id=$1 AND id=$2",
    [fx.tenant.tenantId, linkId],
  );
  return rows[0]!.paid;
}

async function resolveFunds(intentId: string) {
  await owner.query(
    `UPDATE payment_unallocated_funds
        SET resolution='refund', resolved_by='test', resolved_at=now()
      WHERE tenant_id=$1 AND payment_intent_id=$2 AND resolved_at IS NULL`,
    [fx.tenant.tenantId, intentId],
  );
}

/** A verified webhook "paid" for a VA intent. */
function webhookPaid(
  intentId: string,
  amountIdr: number,
  providerRef: string,
  now: Date = new Date(),
) {
  return confirmPayment(
    fx.context,
    intentId,
    {
      source: "verified_webhook",
      method: "va",
      amountIdr,
      providerRef,
      at: now.toISOString(),
    },
    { type: "system" },
    now,
  ).then(
    () => null,
    (error: unknown) => error,
  );
}

async function runVaRecon(now: Date, options: { force?: boolean } = {}) {
  const job = await tryImport<{
    runPaymentVaReleaseReconJob?: (
      context: ScopedTenantContext,
      now?: Date,
      options?: { force?: boolean },
    ) => Promise<unknown>;
  }>("../worker/payment-va-release-recon.job.ts", "VA release recon job");
  if (typeof job.runPaymentVaReleaseReconJob !== "function")
    throw new Error(
      "worker/payment-va-release-recon.job.ts must export runPaymentVaReleaseReconJob(context, now, { force })",
    );
  return job.runPaymentVaReleaseReconJob(fx.context, now, {
    force: options.force ?? true,
  });
}

function expectError(
  res: Awaited<ReturnType<HoldFixture["post"]>>,
  status: number,
  code?: string,
) {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  if (code) expect(res.body.error.code).toBe(code);
}

async function expectNothingReleased(code: Opened) {
  expect(await releaseRows(code.intentId)).toEqual([]);
  expect(await auditRows(code)).toEqual([]);
  expect((await intentRow(code.intentId)).provider_final_at).toBeNull();
}

async function expectParkedOnce(code: Opened) {
  const funds = await unallocatedFunds(fx, code.intentId);
  expect(funds).toHaveLength(1);
  expect(funds[0]!.amountIdr).toBe(code.amount);
  expect(await evidenceRows(fx, code.intentId)).toHaveLength(1);
  expect(
    await outboxCountOf(fx, "payment.funds_unallocated", code.intentId),
  ).toBe(1);
  expect(await paidIdr(code.linkId), "the bill is not paid by it").toBe(0);
}

// -------------------------------------------------------------------- tests

describe("legend-5wn1e refusals", () => {
  it("legend-5wn1e without pos.payment.accept the release is refused (403) and nothing changes", async () => {
    const code = await openCode();
    fx.gateway.script(code.intentId, { rawStatus: "01" });
    await lapse(code, RELEASE_AFTER_MIN + 1);
    const approval = await approvalFor(code);
    await owner.query(
      "UPDATE roles SET permissions = permissions - 'pos.payment.accept' WHERE id = $1",
      [fx.tenant.roleId],
    );
    try {
      expectError(await postVaRelease(code, approval), 403);
    } finally {
      await owner.query(
        "UPDATE roles SET permissions = permissions || '[\"pos.payment.accept\"]'::jsonb WHERE id = $1",
        [fx.tenant.roleId],
      );
    }
    await expectNothingReleased(code);
    // The same approval still works for the permitted cashier: it was not used.
    expect((await postVaRelease(code, approval)).status).toBe(200);
  });

  it("legend-5wn1e without a valid supervisor override the release is refused with VOID_APPROVAL_REQUIRED", async () => {
    const code = await openCode();
    const other = await openCode();
    fx.gateway.script(code.intentId, { rawStatus: "01" });
    await lapse(code, RELEASE_AFTER_MIN + 1);

    // An approval granted for ANOTHER order is not an approval for this one.
    const wrongObject = await approvalFor(other);
    const refused = await postVaRelease(code, wrongObject);
    expect(refused.status, JSON.stringify(refused.body)).toBeGreaterThanOrEqual(
      400,
    );
    expect(refused.status).toBeLessThan(500);
    expect(refused.body.error.code).toBe("VOID_APPROVAL_REQUIRED");

    // An approval for too small a value is refused too.
    const tooSmall = await kit.managerApproval(code.order.id, code.amount - 1);
    expectError(
      await postVaRelease(code, tooSmall),
      refused.status,
      "VOID_APPROVAL_REQUIRED",
    );
    await expectNothingReleased(code);
  });

  it("legend-5wn1e a missing, blank or too short reason is refused (422)", async () => {
    const code = await openCode();
    fx.gateway.script(code.intentId, { rawStatus: "01" });
    await lapse(code, RELEASE_AFTER_MIN + 1);
    const approval = await approvalFor(code);

    const base = {
      paymentIntentId: code.intentId,
      ...approval,
      idempotencyKey: randomUUID(),
    };
    expectError(await fx.post(releaseUrl(code.order.id), base), 422);
    for (const reason of ["", "   ", "  ab  ", "x".repeat(301)])
      expectError(
        await fx.post(releaseUrl(code.order.id), { ...base, reason }),
        422,
      );
    await expectNothingReleased(code);
    // The approval was never consumed by the refused calls.
    expect((await postVaRelease(code, approval)).status).toBe(200);
  });

  it("legend-5wn1e before expires_at + 30 min the release is refused (409), the code keeps blocking", async () => {
    const code = await openCode();
    fx.gateway.script(code.intentId, { error: "5xx" });

    // Still inside the lifetime of the code.
    expectError(
      await postVaRelease(code, await approvalFor(code)),
      409,
      "VA_RELEASE_NOT_ELIGIBLE",
    );
    // 29 minutes after expiry: one minute short.
    await lapse(code, RELEASE_AFTER_MIN - 1);
    expectError(
      await postVaRelease(code, await approvalFor(code)),
      409,
      "VA_RELEASE_NOT_ELIGIBLE",
    );
    await expectNothingReleased(code);
    expect((await replace(code.guest, code.order.id, "va")).status).toBe(409);
  });

  it("legend-5wn1e the reason is counted in characters, not UTF-16 units: 300 emoji pass, 301 or 2 do not", async () => {
    const code = await openCode();
    fx.gateway.script(code.intentId, { rawStatus: "01" });
    await lapse(code, RELEASE_AFTER_MIN + 1);
    const approval = await approvalFor(code);
    for (const reason of ["\u{1F600}".repeat(2), "\u{1F600}".repeat(301)])
      expectError(await postVaRelease(code, approval, { reason }), 422);
    await expectNothingReleased(code);
    const reason = "\u{1F600}".repeat(300);
    const res = await postVaRelease(code, approval, { reason });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.reason).toBe(reason);
  });

  it("legend-5wn1e a foreign intent id is a 404 before any provider read", async () => {
    const mine = await openCode();
    const theirs = await openCode();
    fx.gateway.script(theirs.intentId, { error: "5xx" });
    await lapse(theirs, RELEASE_AFTER_MIN + 1);
    const before = fx.gateway.requests.length;
    const crossed = await fx.post(releaseUrl(mine.order.id), {
      paymentIntentId: theirs.intentId,
      ...(await approvalFor(mine)),
      idempotencyKey: randomUUID(),
      reason: REASON,
    });
    expectError(crossed, 404);
    expect(fx.gateway.requests.length).toBe(before);
    expect(await releaseRows(theirs.intentId)).toEqual([]);
  });

  it("legend-5wn1e not eligible: a code the provider already declared final, a QRIS code, another order's code, an unknown code", async () => {
    const final = await openCode();
    fx.gateway.script(final.intentId, { error: "5xx" });
    await lapse(final, RELEASE_AFTER_MIN + 1, "expired");
    await owner.query(
      "UPDATE payment_intents SET provider_final_at = now() WHERE tenant_id=$1 AND id=$2",
      [fx.tenant.tenantId, final.intentId],
    );
    expectError(
      await postVaRelease(final, await approvalFor(final)),
      409,
      "VA_RELEASE_NOT_ELIGIBLE",
    );
    expect(await releaseRows(final.intentId)).toEqual([]);

    const qris = await openCode("qris");
    fx.gateway.script(qris.intentId, { error: "5xx" });
    await lapse(qris, RELEASE_AFTER_MIN + 1);
    expectError(
      await postVaRelease(qris, await approvalFor(qris)),
      409,
      "VA_RELEASE_NOT_ELIGIBLE",
    );
    expect(await releaseRows(qris.intentId)).toEqual([]);

    // The intent belongs to another order of the outlet.
    const mine = await openCode();
    const theirs = await openCode();
    fx.gateway.script(theirs.intentId, { error: "5xx" });
    await lapse(theirs, RELEASE_AFTER_MIN + 1);
    const crossed = await fx.post(releaseUrl(mine.order.id), {
      paymentIntentId: theirs.intentId,
      ...(await approvalFor(mine)),
      idempotencyKey: randomUUID(),
      reason: REASON,
    });
    expect([404, 409], JSON.stringify(crossed.body)).toContain(crossed.status);
    expect(await releaseRows(theirs.intentId)).toEqual([]);

    const unknown = await fx.post(releaseUrl(mine.order.id), {
      paymentIntentId: randomUUID(),
      ...(await approvalFor(mine)),
      idempotencyKey: randomUUID(),
      reason: REASON,
    });
    expect([404, 409], JSON.stringify(unknown.body)).toContain(unknown.status);
  });

  it("legend-5wn1e the provider answers paid and it is applied to the bill -> 409 PAID_VA_RELEASE, not released", async () => {
    const code = await openCode();
    fx.gateway.script(code.intentId, { status: "paid" });
    await lapse(code, RELEASE_AFTER_MIN + 1);
    expectError(
      await postVaRelease(code, await approvalFor(code)),
      409,
      "PAID_VA_RELEASE",
    );
    await expectNothingReleased(code);
    // The money belongs to the bill: it was applied once, nothing is parked.
    expect(await unallocatedFunds(fx, code.intentId)).toEqual([]);
    expect(await paidIdr(code.linkId)).toBeLessThanOrEqual(code.amount);
  });

  it("legend-5wn1e open parked funds on the code block the release", async () => {
    const code = await openCode();
    await holdGatewayAmountMismatch(
      fx.context,
      code.intentId,
      {
        providerRef: `${code.providerRef}-paid-${randomUUID().slice(0, 8)}`,
        paidAmountIdr: 10_000,
        source: "webhook",
      },
      new Date(),
    );
    expect(await unallocatedFunds(fx, code.intentId)).toHaveLength(1);
    fx.gateway.script(code.intentId, { rawStatus: "01" });
    await lapse(code, RELEASE_AFTER_MIN + 1);
    expectError(await postVaRelease(code, await approvalFor(code)), 409);
    expect(await releaseRows(code.intentId)).toEqual([]);
    expect(await auditRows(code)).toEqual([]);
  });
});

describe("legend-5wn1e release needs a readable provider answer (912 P1-1)", () => {
  it.each<{ label: string; answer: ProviderAnswer }>([
    { label: "provider 5xx", answer: { error: "5xx" } },
    { label: "provider timeout", answer: { error: "timeout" } },
    {
      label: "answer about another reference",
      answer: { otherReference: true },
    },
  ])(
    "legend-5wn1e $label: 409 VA_RELEASE_PROVIDER_UNREAD, nothing released, the approval is not spent",
    async ({ answer }) => {
      const code = await openCode();
      fx.gateway.script(code.intentId, answer);
      await lapse(code, RELEASE_AFTER_MIN + 1);
      const approval = await approvalFor(code);
      expectError(
        await postVaRelease(code, approval),
        409,
        "VA_RELEASE_PROVIDER_UNREAD",
      );
      await expectNothingReleased(code);
      expect((await replace(code.guest, code.order.id, "va")).status).toBe(409);

      // The provider answers again: the same approval releases the code.
      fx.gateway.script(code.intentId, { rawStatus: "01" });
      expect((await postVaRelease(code, approval)).status).toBe(200);
    },
  );
});

describe("legend-5wn1e release without provider proof", () => {
  it.each<{
    label: string;
    status: "pending" | "expired" | "failed";
    answer: ProviderAnswer;
  }>([
    {
      label: "pending, provider status pending",
      status: "pending",
      answer: { status: "pending" },
    },
    {
      label: "pending, provider pending",
      status: "pending",
      answer: { rawStatus: "01" },
    },
    {
      label: "expired, provider status pending",
      status: "expired",
      answer: { status: "pending" },
    },
    {
      label: "failed, provider pending",
      status: "failed",
      answer: { rawStatus: "01" },
    },
  ])(
    "legend-5wn1e $label: released, one open release row, one audit row, not final",
    async ({ status, answer }) => {
      const code = await openCode();
      fx.gateway.script(code.intentId, answer);
      await lapse(code, RELEASE_AFTER_MIN + 1, status);
      expect((await replace(code.guest, code.order.id, "va")).status).toBe(409);

      const approval = await approvalFor(code);
      const res = await postVaRelease(code, approval);
      expect(res.status, JSON.stringify(res.body)).toBe(200);

      const rows = await releaseRows(code.intentId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: "open",
        reason: REASON,
        attempts: 0,
        outlet_id: fx.tenant.outletId,
        resolved_at: null,
        resolution: null,
      });
      expect(idForms(fx.staff.userId)).toContain(rows[0]!.released_by);
      expect(idForms(approval.approvedBy)).toContain(rows[0]!.approved_by);
      expect(idForms(approval.overrideId)).toContain(rows[0]!.override_id);
      expect(idForms(code.order.id)).toContain(rows[0]!.order_id);
      expect(rows[0]!.next_check_at.getTime()).toBeLessThan(
        Date.now() + 60 * 60_000,
      );

      const audit = await auditRows(code);
      expect(audit).toHaveLength(1);
      const text = JSON.stringify(audit[0]!.event);
      expect(text).toContain(REASON);
      expect(idForms(fx.staff.userId).some((x) => text.includes(x))).toBe(true);
      expect(idForms(approval.approvedBy).some((x) => text.includes(x))).toBe(
        true,
      );
      expect(idForms(approval.overrideId).some((x) => text.includes(x))).toBe(
        true,
      );

      // Not final: the provider has not said anything for good.
      expect((await intentRow(code.intentId)).provider_final_at).toBeNull();
    },
  );

  it("legend-5wn1e the reason is stored trimmed", async () => {
    const code = await openCode();
    fx.gateway.script(code.intentId, { rawStatus: "01" });
    await lapse(code, RELEASE_AFTER_MIN + 1);
    const res = await postVaRelease(code, await approvalFor(code), {
      reason: `   ${REASON}   `,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await releaseRows(code.intentId))[0]!.reason).toBe(REASON);
  });

  it("legend-5wn1e an idempotent repeat of the release changes nothing; a second release of the same code is refused", async () => {
    const code = await openCode();
    fx.gateway.script(code.intentId, { rawStatus: "01" });
    await lapse(code, RELEASE_AFTER_MIN + 1);
    const approval = await approvalFor(code);
    const key = randomUUID();
    const first = await postVaRelease(code, approval, { idempotencyKey: key });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const before = await releaseRows(code.intentId);

    const repeat = await postVaRelease(code, approval, { idempotencyKey: key });
    expect(repeat.status, JSON.stringify(repeat.body)).toBe(200);
    expect(repeat.body).toEqual(first.body);
    expect(await releaseRows(code.intentId)).toEqual(before);
    expect(await auditRows(code)).toHaveLength(1);

    // Another call (new key, new valid approval) cannot release it twice.
    const again = await postVaRelease(code, await approvalFor(code));
    expectError(again, 409);
    expect(await releaseRows(code.intentId)).toEqual(before);
    expect(await auditRows(code)).toHaveLength(1);
    expect(await auditCountForOrder(code)).toBe(1);
  });

  it("legend-5wn1e an approval is used once: it cannot release a second code", async () => {
    const a = await openCode();
    fx.gateway.script(a.intentId, { rawStatus: "01" });
    await lapse(a, RELEASE_AFTER_MIN + 1);
    const approval = await approvalFor(a);
    expect((await postVaRelease(a, approval)).status).toBe(200);

    // The same override on the same order, for a code replaced meanwhile.
    const second = await replace(a.guest, a.order.id, "va");
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    const b = {
      ...a,
      intentId: second.body.data.id as string,
    } as Opened;
    fx.gateway.script(b.intentId, { rawStatus: "01" });
    await lapse(b, RELEASE_AFTER_MIN + 1);
    const reuse = await postVaRelease(b, approval);
    expect(reuse.status, JSON.stringify(reuse.body)).toBeGreaterThanOrEqual(
      400,
    );
    expect(await releaseRows(b.intentId)).toEqual([]);
  });

  it("legend-5wn1e an approval spent on a VA release cannot be spent on another action of the order (VOID_APPROVAL_REQUIRED)", async () => {
    const code = await openCode();
    fx.gateway.script(code.intentId, { rawStatus: "01" });
    await lapse(code, RELEASE_AFTER_MIN + 1);
    const approval = await approvalFor(code);
    expect((await postVaRelease(code, approval)).status).toBe(200);

    // The shared check every POS action (order void, QRIS release, ...) runs.
    await expect(
      withTenant(db, fx.context, (tx) =>
        consumeApproval(tx, fx.context, {
          action: "void",
          purpose: "qris_release",
          outletId: fx.tenant.outletId as never,
          orderId: code.order.id,
          objectType: "order",
          objectId: code.order.id,
          requesterId: fx.staff.userId,
          approvedBy: approval.approvedBy,
          overrideId: approval.overrideId,
          minValueIdr: 0,
          deviceId: null,
          now: new Date(),
        }),
      ),
    ).rejects.toMatchObject({ code: "VOID_APPROVAL_REQUIRED" });
  });
});

describe("legend-5wn1e after the release", () => {
  it("legend-5wn1e the released code no longer blocks a replacement; the poller leaves it to the release queue", async () => {
    const code = await openCode();
    await releaseOk(code, { rawStatus: "01" });

    const reads = fx.gateway.readsOf(code.intentId).length;
    await pollPendingGatewayIntents(fx.context, hoursAfter(new Date(), 5), 200);
    expect(
      fx.gateway.readsOf(code.intentId).length,
      "the payment poller no longer asks about a released code",
    ).toBe(reads);

    const va = await replace(code.guest, code.order.id, "va");
    expect(va.status, JSON.stringify(va.body)).toBe(201);
    // The replacement VA is itself the live code now: another one waits.
    expectError(
      await replace(code.guest, code.order.id, "qris"),
      409,
      "ORDER_CODE_ACTIVE",
    );
    expect((await intentRow(code.intentId)).provider_final_at).toBeNull();
  });

  it("legend-5wn1e the queue keeps asking while the provider is pending; only a final answer ends it (and marks the code final)", async () => {
    const code = await openCode();
    const releasedAt = new Date();
    await releaseOk(code, { rawStatus: "01" });

    await runVaRecon(hoursAfter(releasedAt, 1));
    await runVaRecon(hoursAfter(releasedAt, 2));
    let [row] = await releaseRows(code.intentId);
    expect(row).toMatchObject({
      status: "open",
      attempts: 2,
      last_provider_status: "pending",
      resolution: null,
    });
    expect((await intentRow(code.intentId)).provider_final_at).toBeNull();

    // A not-due row is skipped by a normal run.
    const reads = fx.gateway.readsOf(code.intentId).length;
    await runVaRecon(hoursAfter(releasedAt, 2), { force: false });
    expect(fx.gateway.readsOf(code.intentId).length).toBe(reads);

    fx.gateway.script(code.intentId, { rawStatus: "02" });
    await runVaRecon(hoursAfter(releasedAt, 3));
    [row] = await releaseRows(code.intentId);
    expect(row).toMatchObject({
      status: "resolved",
      resolution: "provider_expired",
    });
    expect(row!.resolved_at).not.toBeNull();
    expect((await intentRow(code.intentId)).provider_final_at).not.toBeNull();
    expect(await unallocatedFunds(fx, code.intentId)).toEqual([]);
  });

  it("legend-5wn1e a provider answer failed ends the queue as provider_failed", async () => {
    const code = await openCode();
    const releasedAt = new Date();
    await releaseOk(code, { rawStatus: "01" });
    fx.gateway.script(code.intentId, { error: "timeout" });
    await runVaRecon(hoursAfter(releasedAt, 1));
    expect((await releaseRows(code.intentId))[0]).toMatchObject({
      status: "open",
      attempts: 1,
      last_provider_status: "unreachable",
    });

    fx.gateway.script(code.intentId, { status: "failed" });
    await runVaRecon(hoursAfter(releasedAt, 2));
    expect((await releaseRows(code.intentId))[0]).toMatchObject({
      status: "resolved",
      resolution: "provider_failed",
    });
    expect((await intentRow(code.intentId)).provider_final_at).not.toBeNull();
  });
});

describe("legend-5wn1e money paid on a released code", () => {
  it("legend-5wn1e webhook first: parked once, BILL_CLOSED, bill unpaid; the queue and replays add nothing; a replacement is blocked until resolved", async () => {
    const code = await openCode();
    const releasedAt = new Date();
    await releaseOk(code, { rawStatus: "01" });

    const failure = await webhookPaid(
      code.intentId,
      code.amount,
      code.providerRef,
    );
    expect(failure, "paid after release is refused").toMatchObject({
      decisionCode: "BILL_CLOSED",
    });
    await expectParkedOnce(code);

    // The replacement is blocked by the open money (not by the old code).
    for (const method of ["va", "qris"] as const) {
      const blocked = await replace(code.guest, code.order.id, method);
      expectError(blocked, 409, "FUNDS_UNRESOLVED");
    }

    // The queue finds the same payment: recorded already, nothing new.
    fx.gateway.script(code.intentId, { status: "paid" });
    await runVaRecon(hoursAfter(releasedAt, 1));
    await runVaRecon(hoursAfter(releasedAt, 2));
    // legend-912 P1-2: no timer closes the row. Past 72 h it stays open
    // (paid is not proof the code is closed) and is asked only every 24 h.
    await runVaRecon(hoursAfter(releasedAt, 73));
    await webhookPaid(code.intentId, code.amount, code.providerRef);
    await pollPendingGatewayIntents(fx.context, hoursAfter(releasedAt, 3), 200);
    await expectParkedOnce(code);
    const [slow] = await releaseRows(code.intentId);
    expect(slow).toMatchObject({
      status: "open",
      resolution: null,
      last_provider_status: "paid",
    });
    expect(slow!.resolved_at).toBeNull();
    expect(slow!.next_check_at.getTime()).toBe(
      hoursAfter(releasedAt, 73).getTime() + 24 * 60 * 60_000,
    );

    // Still blocked until staff resolve the money; then a new code is allowed.
    expectError(
      await replace(code.guest, code.order.id, "va"),
      409,
      "FUNDS_UNRESOLVED",
    );
    await resolveFunds(code.intentId);
    const next = await replace(code.guest, code.order.id, "va");
    expect(next.status, JSON.stringify(next.body)).toBe(201);
  });

  it("legend-5wn1e the queue poll first, then the webhook: parked once", async () => {
    const code = await openCode();
    const releasedAt = new Date();
    await releaseOk(code, { rawStatus: "01" });

    fx.gateway.script(code.intentId, { status: "paid" });
    await runVaRecon(hoursAfter(releasedAt, 1));
    await expectParkedOnce(code);
    // legend-912 P1-2: 72 h later the row is still open (slowed, not closed).
    await runVaRecon(hoursAfter(releasedAt, 73));
    expect((await releaseRows(code.intentId))[0]).toMatchObject({
      status: "open",
      resolution: null,
      last_provider_status: "paid",
    });
    await expectParkedOnce(code);

    // The poll already parked this provider transaction: the webhook is a
    // replay, acknowledged without a second record (not a new refusal).
    const failure = await webhookPaid(
      code.intentId,
      code.amount,
      code.providerRef,
    );
    expect(failure).toBeNull();
    await runVaRecon(hoursAfter(releasedAt, 2));
    await expectParkedOnce(code);
    expectError(
      await replace(code.guest, code.order.id, "va"),
      409,
      "FUNDS_UNRESOLVED",
    );
  });

  it("legend-5wn1e the order cannot be paid twice: the replacement settles the bill once, a second payment of the old code is parked, never applied", async () => {
    const code = await openCode();
    await releaseOk(code, { rawStatus: "01" });

    // The guest pays the replacement first.
    const next = await replace(code.guest, code.order.id, "va");
    expect(next.status, JSON.stringify(next.body)).toBe(201);
    const nextId = next.body.data.id as string;
    const { rows } = await owner.query<{
      amount: number;
      provider_ref: string;
    }>(
      "SELECT amount_idr::int AS amount, provider_ref FROM payment_intents WHERE tenant_id=$1 AND id=$2",
      [fx.tenant.tenantId, nextId],
    );
    expect(
      await webhookPaid(nextId, rows[0]!.amount, rows[0]!.provider_ref),
    ).toBeNull();
    expect(await paidIdr(code.linkId)).toBe(code.amount);

    // Then the released code is paid as well (the payer used the old number).
    const late = await webhookPaid(
      code.intentId,
      code.amount,
      code.providerRef,
    );
    expect(late).toMatchObject({ decisionCode: "BILL_CLOSED" });
    expect(await paidIdr(code.linkId), "never paid twice").toBe(code.amount);
    const funds = await unallocatedFunds(fx, code.intentId);
    expect(funds).toHaveLength(1);
    expect(funds[0]).toMatchObject({
      amountIdr: code.amount,
      resolution: null,
    });

    // Replays (webhook, queue) change nothing.
    await webhookPaid(code.intentId, code.amount, code.providerRef);
    fx.gateway.script(code.intentId, { status: "paid" });
    await runVaRecon(hoursAfter(new Date(), 1));
    expect(await unallocatedFunds(fx, code.intentId)).toHaveLength(1);
    expect(await paidIdr(code.linkId)).toBe(code.amount);
  });
});
