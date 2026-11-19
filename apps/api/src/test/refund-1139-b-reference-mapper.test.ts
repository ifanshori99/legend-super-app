// (brief 1139 P1-2, tier K "jangan sampai rugi"): red-first tests, written from
// docs/briefs/1139-fix-so-refund-ronde14.md (CTO decision 2) and the second-opinion report
// ronde 14 (P1-2), on top of refund-1072-harness and refund-1119-support (pattern of
// refund-1126-unmatched-hold.test.ts), not from the implementation.
//
// Rule under test: a signed refund success that carries NO payment id but whose `reference`
// is the Legend payment intent id of a paid intent, of the receiving tenant and minted by the
// integration that signed the webhook, is mapped to that intent: ONE open CONFLICT hold worth
// the reported amount. A refund made in the provider's dashboard then reduces the refund room,
// so a manual refund cannot pay the guest twice.
// Scenario: T paid Rp100.000, no refund of ours, signed success of Rp60.000, reference = T.
//
// Rules pinned:
//   - 1139-b-01 (flat `object: "refund"` and nested `refund.reference`, stored payload
//     replayed by the worker for retry): exactly one open conflict hold of Rp60.000 on T,
//     nothing else booked, replays add no hold, manual refund of Rp100.000 (and anything
//     above the Rp40.000 room) refused, worst case out <= paid;
//   - 1139-b-02 reference naming an intent of ANOTHER tenant: no hold or fact on that intent,
//     none on ours (alert only, see assumptions);
//   - 1139-b-03 reference naming an intent of the same tenant minted by ANOTHER integration
//     than the one that signed: that intent is not touched (alert only);
//   - 1139-b-04 reference contradicting the payment id: the payment id wins (hold on T, the
//     payment the id names), the intent the reference names is not touched;
//   - 1139-b-05 that contradiction is alerted.
//
// Assumptions (the brief does not fix them):
//   - "Past the retry window": like the 1126 tests the stored event is put back as `failed`,
//     30 minutes old, then the harness worker runs (this is the "stored payload replay").
//     Nothing is pinned about the first-processing hold (that is P1-1, tested elsewhere).
//   - Hold-only result: no fact, no journal/outbox event, no refund row, no provider call,
//     intent status unchanged (the 1126 rule). The hold's provider_refund_id and webhook key
//     are NOT pinned (a stable per-refund-id key is allowed).
//   - Flat shape: `data = { object: "refund", id, reference, status, amount }`; nested shape:
//     `data = { refund: { id, reference, status, amount } }`; with a payment id it is added as
//     top-level `payment_id` (as payment-doit-refund-webhook.test.ts "nested under data.refund").
//   - "Another integration": a second active DOIT integration of the same tenant (outlet B)
//     minted U (its gateway_integration_id); the webhook is signed with the harness's
//     tenant-wide integration secret.
//   - The alert of 1139-b-05 is read as a notification to the outlet supervisor of T's outlet
//     (the only alert channel the harness can observe). Cross-tenant and other-integration
//     alerts (no hold, alert only) are NOT asserted: unmappable alerts have no observable
//     recipient in the harness (see refund-1126 assumptions).
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1139-b-reference-mapper.test.ts" heavy pnpm test

import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { outletIdSchema } from "@starter/shared/core";
import { HOLD_TRANSACTION_CONFLICT_REASON } from "../services/refund-hold-reasons";
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
import { paymentTestScope } from "./payment-test-scope";

const h = createRefundHarness("1139b");
installSwitchHooks(h, true);

const REPORT_IDR = 60_000;

type Shape = "flat" | "nested";
const SHAPES: Shape[] = ["flat", "nested"];

/** Refund success event naming (maybe) a payment id and (maybe) a reference. */
function refundSuccess(
  shape: Shape,
  opts: { reference: string; paymentId?: string; amountIdr?: number },
) {
  const amount = opts.amountIdr ?? REPORT_IDR;
  const refundId = `rf_ext_${randomBytes(6).toString("hex")}`;
  const data =
    shape === "flat"
      ? {
          object: "refund",
          id: refundId,
          reference: opts.reference,
          status: "succeeded",
          amount,
          ...(opts.paymentId ? { payment_id: opts.paymentId } : {}),
        }
      : {
          refund: {
            id: refundId,
            reference: opts.reference,
            status: "succeeded",
            amount,
          },
          ...(opts.paymentId ? { payment_id: opts.paymentId } : {}),
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

/** Deliver, let the retry window pass, let the worker replay the stored payload. */
async function deliverPastWindow(body: { id: string }) {
  const answered = await h.deliver(body);
  expect(
    [401, 403],
    `signature accepted: ${JSON.stringify(answered.body)}`,
  ).not.toContain(answered.status);
  expect(
    await storedEventCount(body.id),
    "premise: the signed event is stored",
  ).toBe(1);
  await markFailed(body.id);
  await h.runWorker();
  await h.runWorker();
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

const tenantHoldCount = () =>
  h.count(
    "SELECT count(*)::text AS n FROM refund_recon_holds WHERE tenant_id = $1",
    [h.tenantId],
  );

/** Full hold-only ledger of a Legend intent of the harness tenant. */
async function ledger(code: Code) {
  return {
    ...(await untouched(code.id)),
    providerEvents: await h.refundEventsOfIntent(code.id),
    fakeCalls: h.fake.calls.length,
  };
}

// ---- fixtures: another tenant, another integration ---------------------------------

const foreign = paymentTestScope();
let foreignSeeded = false;
const foreignIntentIds: string[] = [];
const foreignLinkIds: string[] = [];
const movedIntents: Array<{ intentId: string; original: string | null }> = [];
let extraIntegrationId: string | null = null;

/** A paid intent of ANOTHER tenant (own tenant, outlet, link). */
async function foreignPaidIntent(): Promise<string> {
  if (!foreignSeeded) {
    await foreign.seed(h.owner);
    foreignSeeded = true;
  }
  const linkId = randomUUID();
  const intentId = randomUUID();
  foreignLinkIds.push(linkId);
  foreignIntentIds.push(intentId);
  await h.owner.query(
    `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $6, $7)`,
    [
      linkId,
      foreign.tenantId,
      foreign.outletId,
      randomBytes(32).toString("hex"),
      `F1139-${randomBytes(4).toString("hex")}`,
      BILL_IDR,
      randomUUID(),
    ],
  );
  await h.owner.query(
    `INSERT INTO payment_intents (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key, status, paid_at, instructions, expires_at, provider_ref)
     VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'paid', now(), '{"method":"qris","qrPayload":"test","issuer":null}', now(), $7)`,
    [
      intentId,
      foreign.tenantId,
      foreign.outletId,
      linkId,
      BILL_IDR,
      `f1139-${intentId}`,
      `dp_foreign_${randomBytes(8).toString("hex")}`,
    ],
  );
  return intentId;
}

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
          apiKey: `doit-key-1139b-${randomBytes(8).toString("hex")}`,
          webhookSecret: `whsec-1139b-${randomBytes(16).toString("hex")}`,
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
  if (foreignIntentIds.length > 0) {
    await h.owner.query(
      "DELETE FROM payment_intents WHERE id = ANY($1::uuid[])",
      [foreignIntentIds],
    );
    await h.owner.query(
      "DELETE FROM payment_links WHERE id = ANY($1::uuid[])",
      [foreignLinkIds],
    );
  }
});

// ---- scenarios ---------------------------------------------------------------------

describe("1139-b a refund success naming only the Legend intent as `reference` is held", () => {
  for (const shape of SHAPES) {
    it(`1139-b-01 reference-only, ${shape} shape (switch on, Rp60.000 of Rp100.000): one conflict hold on the intent, nothing booked, replays add none, manual refund of Rp100.000 refused`, async () => {
      const t = await paidCode();
      const before = await ledger(t);
      const event = refundSuccess(shape, { reference: t.id });
      await deliverPastWindow(event);

      const expectHeld = async (label: string) => {
        const holds = await h.allHolds(t.id);
        const dump = JSON.stringify(holds);
        expect(holds, `${label}: exactly ONE hold on T (${dump})`).toHaveLength(
          1,
        );
        expect(holds[0]!.resolved_at, `${label}: open (${dump})`).toBeNull();
        expect(holds[0]!.reason, `${label}: conflict reason (${dump})`).toBe(
          HOLD_TRANSACTION_CONFLICT_REASON,
        );
        expect(holds[0]!.amount_idr, `${label}: reported value`).toBe(
          REPORT_IDR,
        );
        return holds[0]!;
      };
      await expectHeld("after the stored payload retry");
      expect(
        withoutHolds(await ledger(t)),
        "no fact, refund, intent change or provider call",
      ).toEqual(withoutHolds(before));

      // Same stored event again, and a worker retry of it: still one hold.
      await h.replayAll(() => event, 2);
      await markFailed(event.id);
      await h.runWorker();
      await h.runWorker();
      await expectHeld("after replays");

      // Room is Rp40.000: the dashboard refund of Rp60.000 may not be paid out again.
      const probes: Probe[] = [];
      for (const amount of [BILL_IDR, BILL_IDR - REPORT_IDR + 1_000]) {
        const probe = await tryManualOut(h, t.id, amount);
        expectRefused(probe, `1139-b-01 ${shape}`);
        probes.push(probe);
      }
      expectWorstCaseWithinPaid(REPORT_IDR, 0, probes, `1139-b-01 ${shape}`);
    });
  }

  for (const shape of SHAPES) {
    it(`1139-b-02 ${shape} reference naming an intent of ANOTHER tenant: that intent and ours get no hold, fact or refund`, async () => {
      const ours = await paidCode();
      const foreignIntent = await foreignPaidIntent();
      const ourBefore = await ledger(ours);
      const foreignBefore = await untouched(foreignIntent);
      const holdsBefore = await tenantHoldCount();

      await deliverPastWindow(
        refundSuccess(shape, { reference: foreignIntent }),
      );

      expect(
        await untouched(foreignIntent),
        "the other tenant's intent",
      ).toEqual(foreignBefore);
      expect(await ledger(ours), "our own intent").toEqual(ourBefore);
      expect(await tenantHoldCount(), "no hold in the receiving tenant").toBe(
        holdsBefore,
      );
    });
  }

  for (const shape of SHAPES) {
    it(`1139-b-03 ${shape} reference naming an intent minted by ANOTHER integration than the signer: that intent is not touched`, async () => {
      const other = await paidByOtherIntegration();
      const before = await ledger(other);
      const holdsBefore = await tenantHoldCount();

      await deliverPastWindow(refundSuccess(shape, { reference: other.id }));

      expect(await ledger(other), "the other integration's intent").toEqual(
        before,
      );
      expect(await tenantHoldCount(), "no hold in the tenant").toBe(
        holdsBefore,
      );
    });
  }

  for (const shape of SHAPES) {
    it(`1139-b-04 ${shape} reference contradicting the payment id: the payment id wins, the referenced intent is not touched`, async () => {
      const named = await paidCode(); // the payment id names this one
      const referenced = await paidCode(); // the reference names this one
      const referencedBefore = await ledger(referenced);

      await deliverPastWindow(
        refundSuccess(shape, {
          reference: referenced.id,
          paymentId: named.providerRef,
        }),
      );

      const holds = await h.allHolds(named.id);
      expect(
        holds.map((hold) => [hold.resolved_at === null, hold.amount_idr]),
        `one open hold of Rp60.000 on the payment the id names (${JSON.stringify(holds)})`,
      ).toEqual([[true, REPORT_IDR]]);
      expect(
        await ledger(referenced),
        "the intent the reference names is untouched (no hold, fact, refund)",
      ).toEqual(referencedBefore);
    });
  }

  for (const shape of SHAPES) {
    it(`1139-b-05 ${shape} reference contradicting the payment id is alerted to the outlet supervisor`, async () => {
      const named = await paidCode();
      const referenced = await paidCode();
      const alertsBefore = (await h.supervisorAlertRows()).length;

      await deliverPastWindow(
        refundSuccess(shape, {
          reference: referenced.id,
          paymentId: named.providerRef,
        }),
      );

      expect(
        (await h.supervisorAlertRows()).length,
        "an alert reached the outlet supervisor",
      ).toBeGreaterThan(alertsBefore);
    });
  }
});
