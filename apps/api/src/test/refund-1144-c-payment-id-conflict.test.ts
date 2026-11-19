// (brief 1144 kaart c, tier K "jangan sampai rugi"): red-first tests, written from the
// second-opinion report ronde 15 (docs/qa/second-opinion-refund-ronde15-1143.md, P2-1) and
// the CTO addition (a) of the 1144 brief, on top of refund-1072-harness and
// refund-1119-support (pattern of refund-1139-b-reference-mapper.test.ts), not from the
// implementation.
//
// Rule under test: a signed refund success that NAMES a payment id which is dropped because
// it conflicts (two different payment ids in the same event) or because it maps to no
// payment of the signer must NOT be mapped through its `reference` to a third intent U. U
// stays untouched (no hold, fact, refund, status change), at minute 0 and after the stored
// payload retry. When the named payment id is valid (maps uniquely to a paid intent minted
// by the integration that signed) the hold goes on THAT intent, and a manual refund there
// is refused (total out <= paid). When it is not valid: alert only.
//
// Rules pinned:
//   - 1144-c-01 two conflicting payment ids (T and V, both real) + reference U: U untouched;
//   - 1144-c-02 payment id that maps to no payment + reference U: U untouched;
//   - 1144-c-03 payment id of a paid intent minted by ANOTHER integration than the signer +
//     reference U: neither that intent nor U is touched;
//   - 1144-c-04 valid payment id of T + reference U: one open Rp60.000 hold on T (reason not pinned), U untouched,
//     manual refund on T refused, worst case out <= paid.
//
// Assumptions (the SO report and brief do not fix them):
//   - Conflict shapes (SO example): flat = `data.payment_id` = P and `data.payment.id` = Q;
//     nested = `data.payment_id` = P and `data.refund.payment_id` = Q (flat `object:"refund"`
//     / nested `data.refund`, as in 1139-b).
//   - In the conflict case (c-01) it is NOT pinned whether T or V gets a hold or an alert
//     (the report only says U must not be touched; neither id is "the" named payment).
//   - "Alert only" is not asserted (no observable recipient in the harness, see 1139-b).
//   - "Untouched" = no hold, no payment_provider_refunds fact, no refund row, intent status
//     unchanged (same ledger as 1139-b); the provider is not called.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1144-c-payment-id-conflict.test.ts" heavy pnpm test

import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { outletIdSchema } from "@starter/shared/core";
import {
  setIntegrationStatus,
  upsertIntegration,
} from "../services/platform-integration.service";
import {
  BILL_IDR,
  createRefundHarness,
  type Code,
} from "./refund-1072-harness";
import {
  expectRefused,
  expectWorstCaseWithinPaid,
  installSwitchHooks,
  tryManualOut,
  type Probe,
} from "./refund-1119-support";

const h = createRefundHarness("1144c");
installSwitchHooks(h, true);

const REPORT_IDR = 60_000;

type Shape = "flat" | "nested";
const SHAPES: Shape[] = ["flat", "nested"];

/**
 * Refund success event naming a reference and (maybe) payment ids.
 * `paymentId` = the top-level `payment_id`; `otherPaymentId` = a SECOND, different payment id
 * for the same refund (flat: `data.payment.id`; nested: `data.refund.payment_id`).
 */
function refundSuccess(
  shape: Shape,
  opts: {
    reference: string;
    paymentId?: string;
    otherPaymentId?: string;
    amountIdr?: number;
  },
) {
  const amount = opts.amountIdr ?? REPORT_IDR;
  const refundId = `rf_ext_${randomBytes(6).toString("hex")}`;
  const top = opts.paymentId ? { payment_id: opts.paymentId } : {};
  const data =
    shape === "flat"
      ? {
          object: "refund",
          id: refundId,
          reference: opts.reference,
          status: "succeeded",
          amount,
          ...top,
          ...(opts.otherPaymentId
            ? { payment: { id: opts.otherPaymentId } }
            : {}),
        }
      : {
          refund: {
            id: refundId,
            reference: opts.reference,
            status: "succeeded",
            amount,
            ...(opts.otherPaymentId ? { payment_id: opts.otherPaymentId } : {}),
          },
          ...top,
        };
  return {
    id: `evt_${randomBytes(8).toString("hex")}`,
    type: "refund.succeeded",
    created_at: new Date().toISOString(),
    data,
  };
}

/** The state of a stored event the worker retries, past the retry window. */
const markFailed = (eventId: string) =>
  h.owner.query(
    `UPDATE gateway_webhook_events
        SET status = 'failed', last_error_code = 'INTERNAL_ERROR', attempts = 1,
            received_at = now() - interval '30 minutes',
            updated_at = now() - interval '30 minutes'
      WHERE tenant_id = $1 AND event_id = $2`,
    [h.tenantId, eventId],
  );

async function storedEventCount(eventId: string) {
  const { rows } = await h.owner.query(
    "SELECT id FROM gateway_webhook_events WHERE tenant_id = $1 AND event_id = $2",
    [h.tenantId, eventId],
  );
  return rows.length;
}

/**
 * Deliver (first processing, minute 0), run `check`, let the retry window pass, let the worker
 * replay the stored payload, run `check` again.
 */
async function deliverChecked(
  body: { id: string },
  check: (when: string) => Promise<void>,
) {
  const answered = await h.deliver(body);
  expect(
    [401, 403],
    `signature accepted: ${JSON.stringify(answered.body)}`,
  ).not.toContain(answered.status);
  expect(
    await storedEventCount(body.id),
    "premise: the signed event is stored",
  ).toBe(1);
  await check("minute 0 (first processing)");
  await markFailed(body.id);
  await h.runWorker();
  await h.runWorker();
  await check("after the stored payload retry (past 15 minutes)");
}

async function paidCode(): Promise<Code> {
  const code = await h.newCode(BILL_IDR);
  expect((await h.paid(code, BILL_IDR)).status).toBe(200);
  return code;
}

/** Everything a hold-only event must not change on an intent (any tenant). */
async function untouched(intentId: string) {
  const q = (sql: string) =>
    h.owner
      .query<{ n: string }>(sql, [intentId])
      .then((r) => Number(r.rows[0]!.n));
  const status = await h.owner.query<{ status: string }>(
    "SELECT status FROM payment_intents WHERE id = $1",
    [intentId],
  );
  return {
    holds: await q(
      "SELECT count(*)::text AS n FROM refund_recon_holds WHERE payment_intent_id = $1",
    ),
    facts: await q(
      "SELECT count(*)::text AS n FROM payment_provider_refunds WHERE payment_intent_id = $1",
    ),
    refunds: await q(
      "SELECT count(*)::text AS n FROM payment_refunds WHERE payment_intent_id = $1",
    ),
    status: status.rows[0]?.status,
  };
}

const withoutHolds = (state: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(state).filter(([key]) => key !== "holds"));

/** Full hold-only ledger of a Legend intent of the harness tenant. */
async function ledger(code: Code) {
  return {
    ...(await untouched(code.id)),
    providerEvents: await h.refundEventsOfIntent(code.id),
    fakeCalls: h.fake.calls.length,
  };
}

// ---- fixtures: another tenant, another integration ---------------------------------

const movedIntents: Array<{ intentId: string; original: string | null }> = [];
let extraIntegrationId: string | null = null;

/** A paid intent of the harness tenant that another integration (outlet B) minted. */
async function paidByOtherIntegration(): Promise<Code> {
  const code = await paidCode();
  const { rows } = await h.owner.query<{
    gateway_integration_id: string | null;
  }>("SELECT gateway_integration_id FROM payment_intents WHERE id = $1", [
    code.id,
  ]);
  const original = rows[0]?.gateway_integration_id ?? null;
  expect(
    original,
    "premise: the harness integration minted the intent",
  ).toBeTruthy();
  if (!extraIntegrationId) {
    const outlets = await h.owner.query<{ id: string }>(
      "SELECT id FROM outlets WHERE tenant_id = $1 AND id <> $2 ORDER BY id LIMIT 1",
      [h.tenantId, h.outletId],
    );
    expect(
      outlets.rows[0],
      "premise: the tenant has a second outlet",
    ).toBeDefined();
    const context = establishScopedTenantContext(
      establishTenantContext({
        tenantId: h.tenantId,
        brandId: null,
        source: "session",
      }),
      { kind: "tenant" },
    );
    const created = await upsertIntegration(
      context,
      {
        outletId: outletIdSchema.parse(outlets.rows[0]!.id),
        provider: "doit",
        config: { baseUrl: h.doit.baseUrl },
        credentials: {
          apiKey: `doit-key-1144c-${randomBytes(8).toString("hex")}`,
          webhookSecret: `whsec-1144c-${randomBytes(16).toString("hex")}`,
        },
      },
      randomUUID(),
    );
    await setIntegrationStatus(
      context,
      created.id,
      { status: "active" },
      randomUUID(),
    );
    extraIntegrationId = created.id;
  }
  await h.owner.query(
    "UPDATE payment_intents SET gateway_integration_id = $1 WHERE id = $2",
    [extraIntegrationId, code.id],
  );
  movedIntents.push({ intentId: code.id, original });
  return code;
}

afterAll(async () => {
  // Put moved intents back before the harness deletes its integration and intents.
  for (const moved of movedIntents)
    await h.owner.query(
      "UPDATE payment_intents SET gateway_integration_id = $1 WHERE id = $2",
      [moved.original, moved.intentId],
    );
  if (extraIntegrationId)
    await h.owner.query("DELETE FROM tenant_integrations WHERE id = $1", [
      extraIntegrationId,
    ]);
});

// ---- scenarios ---------------------------------------------------------------------

describe("1144-c a payment id that is named but unusable never falls back to a third intent via reference", () => {
  for (const shape of SHAPES) {
    it(`1144-c-01 ${shape} two conflicting payment ids (both real) + reference of intent U: U is untouched at minute 0 and after the retry`, async () => {
      const t = await paidCode();
      const v = await paidCode();
      const u = await paidCode();
      const uBefore = await ledger(u);
      const event = refundSuccess(shape, {
        reference: u.id,
        paymentId: t.providerRef,
        otherPaymentId: v.providerRef,
      });
      await deliverChecked(event, async (when) => {
        expect(
          await ledger(u),
          `${when}: the intent only the reference names (no hold, fact, refund, call)`,
        ).toEqual(uBefore);
      });
    });
  }

  for (const shape of SHAPES) {
    it(`1144-c-02 ${shape} payment id that maps to no payment + reference of intent U: U is untouched`, async () => {
      const u = await paidCode();
      const uBefore = await ledger(u);
      const event = refundSuccess(shape, {
        reference: u.id,
        paymentId: `dp_unknown_${randomBytes(6).toString("hex")}`,
      });
      await deliverChecked(event, async (when) => {
        expect(await ledger(u), `${when}: intent U`).toEqual(uBefore);
      });
    });
  }

  for (const shape of SHAPES) {
    it(`1144-c-03 ${shape} payment id of an intent minted by ANOTHER integration + reference of intent U: neither is touched`, async () => {
      const other = await paidByOtherIntegration();
      const u = await paidCode();
      const otherBefore = await ledger(other);
      const uBefore = await ledger(u);
      const event = refundSuccess(shape, {
        reference: u.id,
        paymentId: other.providerRef,
      });
      await deliverChecked(event, async (when) => {
        expect(
          await ledger(other),
          `${when}: the payment the signer did not mint`,
        ).toEqual(otherBefore);
        expect(await ledger(u), `${when}: intent U`).toEqual(uBefore);
      });
    });
  }

  for (const shape of SHAPES) {
    it(`1144-c-04 ${shape} valid payment id of T + reference of intent U: one open hold on T, U untouched, manual refund on T refused`, async () => {
      const t = await paidCode();
      const u = await paidCode();
      const tBefore = await ledger(t);
      const uBefore = await ledger(u);
      const event = refundSuccess(shape, {
        reference: u.id,
        paymentId: t.providerRef,
      });
      await deliverChecked(event, async (when) => {
        const holds = await h.allHolds(t.id);
        const dump = JSON.stringify(holds);
        expect(
          holds.map((hold) => [hold.resolved_at === null, hold.amount_idr]),
          `${when}: one open hold of Rp60.000 on T (${dump})`,
        ).toEqual([[true, REPORT_IDR]]);
        expect(
          withoutHolds(await ledger(t)),
          `${when}: nothing else booked on T`,
        ).toEqual(withoutHolds(tBefore));
        expect(await ledger(u), `${when}: intent U`).toEqual(uBefore);
      });

      const probes: Probe[] = [];
      for (const amount of [BILL_IDR, BILL_IDR - REPORT_IDR + 1_000]) {
        const probe = await tryManualOut(h, t.id, amount);
        expectRefused(probe, `1144-c-04 ${shape}`);
        probes.push(probe);
      }
      expectWorstCaseWithinPaid(REPORT_IDR, 0, probes, `1144-c-04 ${shape}`);
    });
  }
});
