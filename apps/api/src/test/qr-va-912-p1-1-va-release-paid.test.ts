// 912 P1-1 (second opinion QRIS/VA 906-908): a staff VA release must never
// free a code the provider says is PAID, whatever the local bookkeeping did.
//
// Brief (docs/briefs/912-3p1.md, decision P1-1), written from the brief and the
// second opinion's proposed test, not from the code:
// - Release only when the provider answer was read AND is not paid.
// - Provider answers paid with amount null or 0, or paid with the exact amount
//   while the bookkeeping write fails once: the release is REFUSED. The money
//   write is still attempted/recovered.
// - A refusal writes no release row, no audit row
//   (payment_va_code.force_released) and does not use the supervisor override.
//   A replacement tender stays blocked.
// - Contract from va-staff-release-5wn1e (unchanged): eligible VA code, 30 min
//   after expires_at, valid override, POST .../va/release.
//
// Assumptions (stated in the report):
// - A refusal is HTTP 409. The exact error code is only asserted where the
//   5wn1e contract already names it (PAID_VA_RELEASE: paid and applied).
// - "Provider answer not read" (provider down/timeout) keeps releasing, as in
//   va-staff-release-5wn1e: that feature exists for a bank that never answers.
//   This file only refuses when the provider said paid (or the bookkeeping of
//   a paid answer failed). The control test proves a pending answer still
//   releases.
// - "Bookkeeping fails once" is simulated with a DB trigger that rejects the
//   payment_links.paid_idr update of one bill, dropped after the first
//   attempt. Payment progress is read from payment_links.paid_idr (5wn1e).
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/qr-va-912-p1-1-va-release-paid.test.ts" heavy pnpm test
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setPaymentGateway } from "../services/payment-gateway.ts";
import { owner } from "./floor-test-helpers.ts";
import {
  holdFixture,
  resetHoldPorts,
  unallocatedFunds,
  type HoldFixture,
  type ManagerApproval,
  type ProviderAnswer,
} from "./pos-qris-hold-test-helpers.ts";
import { releaseKit } from "./qris-hold-so885-d-helpers.ts";
import { enableVaBank } from "./qris-hold-so879-va-gateway.ts";

vi.setConfig({ testTimeout: 180_000 });

const RELEASE_AFTER_MIN = 30;
const REASON = "Bank tidak menjawab status VA lebih dari sehari";
const AUDIT_ACTION = "payment_va_code.force_released";
const TRIGGER = "test_912_p1_1_fail_paid_write";

let fx: HoldFixture;
let kit: ReturnType<typeof releaseKit>;
/** Provider refs whose paid answer carries amount null (the port allows it). */
const paidWithoutAmount = new Set<string>();

beforeAll(async () => {
  fx = await holdFixture("qr-va-912-p1-1");
  enableVaBank(fx.gateway);
  const read = fx.gateway.getStatus.bind(fx.gateway);
  fx.gateway.getStatus = async (input) => {
    const answer = await read(input);
    return answer.status === "paid" && paidWithoutAmount.has(input.providerRef)
      ? { ...answer, amountIdr: null }
      : answer;
  };
  setPaymentGateway(fx.gateway);
  kit = releaseKit(fx);
  await owner.query(`
    CREATE OR REPLACE FUNCTION ${TRIGGER}() RETURNS trigger AS $fn$
    BEGIN
      IF NEW.id::text = TG_ARGV[0] AND NEW.paid_idr IS DISTINCT FROM OLD.paid_idr THEN
        RAISE EXCEPTION 'bookkeeping unavailable (912 P1-1 test)';
      END IF;
      RETURN NEW;
    END
    $fn$ LANGUAGE plpgsql`);
});
afterAll(async () => {
  await owner.query(`DROP TRIGGER IF EXISTS ${TRIGGER} ON payment_links`);
  await owner.query(`DROP FUNCTION IF EXISTS ${TRIGGER}()`);
  resetHoldPorts();
  await owner.end();
});

type Guest = Awaited<ReturnType<HoldFixture["newGuest"]>>;
type Opened = Awaited<ReturnType<typeof openVaCode>>;

// ----------------------------------------------------------------- fixtures

function replaceCode(guest: Guest, orderId: string, method: "qris" | "va") {
  return fx.guestPost(guest, "/payments", {
    target: { kind: "order", orderId },
    method,
    ...(method === "va" ? { bankCode: "bmri" } : {}),
    idempotencyKey: randomUUID(),
  });
}

/** A guest order with one VA code issued (201). */
async function openVaCode() {
  const guest = await fx.newGuest();
  const order = await fx.qrOrder(guest);
  const res = await replaceCode(guest, order.id, "va");
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

/** Still `pending` locally, expired more than the 30 minute release wait. */
async function lapse(code: Opened) {
  await owner.query(
    `UPDATE payment_intents
        SET expires_at = now() - $3::int * interval '1 minute'
      WHERE tenant_id=$1 AND id=$2`,
    [fx.tenant.tenantId, code.intentId, RELEASE_AFTER_MIN + 1],
  );
}

/** A code the provider answers `answer` for, eligible for staff release. */
async function eligibleCode(answer: ProviderAnswer, noAmount = false) {
  const code = await openVaCode();
  fx.gateway.script(code.intentId, answer);
  if (noAmount) paidWithoutAmount.add(code.providerRef);
  await lapse(code);
  return code;
}

const approvalFor = (code: Opened): Promise<ManagerApproval> =>
  kit.managerApproval(code.order.id, code.amount);

function postVaRelease(code: Opened, approval: ManagerApproval) {
  return fx.post(`${fx.base}/${code.order.id}/va/release`, {
    paymentIntentId: code.intentId,
    ...approval,
    idempotencyKey: randomUUID(),
    reason: REASON,
  });
}

async function releaseRowCount(intentId: string) {
  const { rows } = await owner.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM payment_va_releases WHERE tenant_id=$1 AND payment_intent_id=$2",
    [fx.tenant.tenantId, intentId],
  );
  return rows[0]!.n;
}

async function auditCount(code: Opened) {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_logs
      WHERE tenant_id=$1 AND event->>'action'=$2 AND event::text LIKE $3`,
    [fx.tenant.tenantId, AUDIT_ACTION, `%${code.intentId}%`],
  );
  return rows[0]!.n;
}

async function providerFinalAt(intentId: string) {
  const { rows } = await owner.query<{ provider_final_at: Date | null }>(
    "SELECT provider_final_at FROM payment_intents WHERE tenant_id=$1 AND id=$2",
    [fx.tenant.tenantId, intentId],
  );
  return rows[0]!.provider_final_at;
}

async function paidIdr(linkId: string) {
  const { rows } = await owner.query<{ paid: number }>(
    "SELECT paid_idr::int AS paid FROM payment_links WHERE tenant_id=$1 AND id=$2",
    [fx.tenant.tenantId, linkId],
  );
  return rows[0]!.paid;
}

/** Refused: 409, nothing released, nothing audited, code still live. */
async function expectRefused(
  code: Opened,
  res: Awaited<ReturnType<HoldFixture["post"]>>,
  errorCode?: string,
) {
  expect(res.status, JSON.stringify(res.body)).toBe(409);
  if (errorCode) expect(res.body.error.code).toBe(errorCode);
  expect(await releaseRowCount(code.intentId), "no release row").toBe(0);
  expect(await auditCount(code), "no release audit").toBe(0);
  expect(await providerFinalAt(code.intentId)).toBeNull();
  for (const method of ["va", "qris"] as const) {
    const replacement = await replaceCode(code.guest, code.order.id, method);
    expect(
      replacement.status,
      `a ${method} replacement stays blocked: ${JSON.stringify(replacement.body)}`,
    ).toBe(409);
  }
}

/**
 * The supervisor override of a refused release is not spent: the same approval
 * releases the code once the provider answers pending.
 */
async function expectOverrideUnused(code: Opened, approval: ManagerApproval) {
  fx.gateway.script(code.intentId, { rawStatus: "01" });
  paidWithoutAmount.delete(code.providerRef);
  const res = await postVaRelease(code, approval);
  expect(
    res.status,
    `the same override still works: ${JSON.stringify(res.body)}`,
  ).toBe(200);
  expect(await releaseRowCount(code.intentId)).toBe(1);
  expect(await auditCount(code)).toBe(1);
}

// -------------------------------------------------------------------- tests

describe("912 P1-1 VA release refuses a code the provider says is paid", () => {
  it.each<{
    label: string;
    answer: ProviderAnswer;
    noAmount: boolean;
  }>([
    {
      label: "paid with amount null",
      answer: { status: "paid" },
      noAmount: true,
    },
    {
      label: "paid with amount 0",
      answer: { status: "paid", amountIdr: 0 },
      noAmount: false,
    },
    {
      label: "Duitku style 00 with amount 0",
      answer: { rawStatus: "00", amountIdr: 0 },
      noAmount: false,
    },
  ])(
    "912-p1-1 $label: refused, no release, no audit, override unused, replacement blocked",
    async ({ answer, noAmount }) => {
      const code = await eligibleCode(answer, noAmount);
      const approval = await approvalFor(code);

      await expectRefused(code, await postVaRelease(code, approval));
      // Nothing to record from an amount that is not positive, and the bill
      // is never settled by it.
      expect(await paidIdr(code.linkId)).toBe(0);
      expect(await unallocatedFunds(fx, code.intentId)).toEqual([]);

      await expectOverrideUnused(code, approval);
    },
  );

  it("912-p1-1 paid with amount null now, the next read pays the exact amount: refused both times, the money is recorded once and settles the bill once", async () => {
    const code = await eligibleCode({ status: "paid" }, true);
    const approval = await approvalFor(code);
    await expectRefused(code, await postVaRelease(code, approval));
    expect(await paidIdr(code.linkId)).toBe(0);

    // The provider read recovers: same paid answer, now with the amount.
    paidWithoutAmount.delete(code.providerRef);
    const again = await postVaRelease(code, await approvalFor(code));
    expect(again.status, JSON.stringify(again.body)).toBe(409);
    expect(await releaseRowCount(code.intentId)).toBe(0);
    expect(await auditCount(code)).toBe(0);
    expect(await paidIdr(code.linkId), "paid once, never twice").toBe(
      code.amount,
    );
    expect(await unallocatedFunds(fx, code.intentId)).toEqual([]);
  });

  it("912-p1-1 paid with the exact amount while the bookkeeping write fails once: refused, no release, no audit, override unused; once bookkeeping recovers the money is recorded and the release stays refused (PAID_VA_RELEASE)", async () => {
    const code = await eligibleCode({ status: "paid" });
    const approval = await approvalFor(code);

    await owner.query(
      `CREATE TRIGGER ${TRIGGER} BEFORE UPDATE ON payment_links
         FOR EACH ROW EXECUTE FUNCTION ${TRIGGER}('${code.linkId}')`,
    );
    try {
      const failed = await postVaRelease(code, approval);
      await expectRefused(code, failed);
      expect(
        await paidIdr(code.linkId),
        "the write failed, nothing booked",
      ).toBe(0);
    } finally {
      await owner.query(`DROP TRIGGER IF EXISTS ${TRIGGER} ON payment_links`);
    }

    // Bookkeeping is back: the same (unused) override is still refused
    // because the provider says paid, and the money is now on the bill once.
    const recovered = await postVaRelease(code, approval);
    expect(recovered.status, JSON.stringify(recovered.body)).toBe(409);
    expect(recovered.body.error.code).toBe("PAID_VA_RELEASE");
    expect(await releaseRowCount(code.intentId)).toBe(0);
    expect(await auditCount(code)).toBe(0);
    expect(await paidIdr(code.linkId)).toBe(code.amount);
    expect(await unallocatedFunds(fx, code.intentId)).toEqual([]);
  });

  it("912-p1-1 control: provider pending still releases (one release row, one audit, not final)", async () => {
    const code = await eligibleCode({ rawStatus: "01" });
    const res = await postVaRelease(code, await approvalFor(code));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await releaseRowCount(code.intentId)).toBe(1);
    expect(await auditCount(code)).toBe(1);
    expect(await providerFinalAt(code.intentId)).toBeNull();
  });
});
