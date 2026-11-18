// Payout 911, finding P2-4 of the second opinion on 905 (so-findings.md): the
// night recon (payroll-payout-recon.service.ts, bead legend-i01jp) must not read
// a LEGIT evidence replacement as a duplicate operation. Written fail-first from
// the finding and the brief, NOT from the implementation of the recon service.
//
// Scenario (no stuck-proof closure involved): finance one proposes a correction
// of a failed item with proof K1; the proposer replaces the open proposal's proof
// with K2 (different bytes); a second person completes the correction over K2
// with a legit journal. Only ONE operation was completed. The binding of K1 stays
// on record on purpose (permanent), but a binding of a superseded proposal is not
// a completed operation.
//
// 911 P1-2 (0420 PAYOUT-73): the proposer can NO LONGER replace the evidence of
// an open proposal through the service. Production data from BEFORE that fix
// still holds such replaced proposals, so this file builds that history by hand
// (`replacedCorrectionWorld`): propose with K1 through the service, then, as
// table owner with guards off, rewrite the open proposal and its step-one
// attestation to K2, bind K2 (trusted binder, creator = the proposer), keep the
// K1 binding and its propose audit row, and add the propose audit row of K2 the
// way the service wrote it before. Then the second person completes over K2
// through the service.
//
// Rules proven here (founder: when in doubt hold the payment, but a false flag
// holds a legit payee and every retry after a legit return):
// - After the replacement and the second person's approval, the night run
//   yields zero flags: no recon exception row and no finance exception
//   `payout_recon_flag`, for the item and for the whole tenant (no
//   `binding_duplicate`).
// - K1 stays unusable: another operation (a return of the same item) over K1 is
//   refused 409 PAYOUT_PROOF_REUSED and changes nothing.
// - Control (the flag is not removed, only the false positive): two truly
//   completed operations of the same kind over the same item-set, each with its
//   own binding, are still flagged `binding_duplicate`.
//
// Assumptions (stated so they can be contested):
// - Steps run through the services (`correctFailedItems`, `returnManualItems`)
//   with `actorOf(userId)`, which carries the test grant issuer (0419); the HTTP
//   routes use the real grantor login, which the test app does not have.
// - The audit row of the K2 proposal is written with `recordPayoutAudit` from the
//   K1 proposal row (same action, object, reason; only `evidenceKey` differs),
//   which is the shape the pre-fix replacement left.
// - Reuse of K1 is probed with a `return` of the now succeeded item (897 pattern:
//   409 PAYOUT_PROOF_REUSED). The item stays `succeeded`.
// - ENTRY POINT of the night run: same adapter as payroll-payout-905-recon.test.ts
//   (`reconcileTrustedPayouts(context, {storage, after})`, paged).
// - The control forges a second binding as table owner with guards off
//   (`session_replication_role = replica`): same kind 'correction', same batch,
//   same item_set_hash as the real binding, another evidence key and other
//   hashes, no attestation and no propose audit row of its own (the shape of a
//   real second completed operation on the same item-set; a real second
//   correction of one item is impossible: the item is no longer failed). The
//   reason column of the recon exception must contain `binding_duplicate`
//   (PayoutReconReason value of the contract).
import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { beforeAll, afterEach, describe, expect, it } from "vitest";
import { listFinanceExceptions } from "../services/accounting-finance-exceptions.service.ts";
import { correctFailedItems } from "../services/payroll-payout-correction.service.ts";
import { returnManualItems } from "../services/payroll-payout-manual.service.ts";
import { ensureProofFingerprintRecord } from "../services/payroll-payout-proof-fingerprint.service.ts";
import { recordPayoutAudit } from "../services/payroll-payout.service.ts";
import {
  actorOf,
  APP,
  APP3,
  BUDI,
  bank,
  evidenceKeyFor,
  installPayoutWorld,
  uploadEvidence,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("911rec");
const NET = 1_000_000;
const NOTE_ITEM = "Mutasi bank menunjukkan transfer ternyata berhasil";
const EXCEPTIONS = "payroll_payout_recon_exceptions";
const ATTESTATIONS = "payroll_payout_attestations";
const PROPOSED_ACTION = "payroll.disbursement.correction_proposed";
const RECON_EXPORTS = [
  "reconcileTrustedPayouts",
  "runTrustedPayoutRecon",
  "runPayoutRecon",
  "reconcilePayoutTrustedBoundary",
  "reconcilePayoutTrusted",
  "runPayoutReconciliation",
];

// ---- People -----------------------------------------------------------------------

type Person = { userId: string };

/**
 * A finance person with the approve permission. `signedInClient` also gives the
 * user a live session with a fresh MFA step-up (what the trusted steps check).
 */
async function finance(label: string): Promise<Person> {
  const { userId } = await W.signedInClient(`Recon911 ${label}`);
  await W.grantRole(userId, ["payroll.view", "payroll.disburse.approve"]);
  return { userId };
}

let one: Person;
let two: Person;

// ---- Cleanup ------------------------------------------------------------------------

const trackedKeys: string[] = [];
const trackKey = (key: string) => (trackedKeys.push(key), key);

afterEach(async () => {
  // 905: the proof rows of the keys are kept. Deleting a binding or a return
  // claim while the item still carries the key leaves an unbound operation in
  // app.payout_proof_operations(), and the global gate then holds every later
  // step (PAYOUT_PROOF_FINGERPRINT_PENDING), in this file and the next ones.
  trackedKeys.splice(0);
  await W.asTenant(async (c) => {
    // Insert-only rows of this file: every test starts without recon exceptions.
    await c.query(`DELETE FROM ${EXCEPTIONS} WHERE tenant_id = $1`, [
      W.tenantId,
    ]);
  }, true);
});

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  one = await finance("One");
  two = await finance("Two");
});

// ---- The recon (single adapter, see the header) ---------------------------------------

async function runRecon() {
  const mod =
    (await import("../services/payroll-payout-recon.service.ts")) as Record<
      string,
      unknown
    >;
  const name = RECON_EXPORTS.find((n) => typeof mod[n] === "function");
  expect(
    name,
    `payroll-payout-recon.service.ts must export the night run (one of ${RECON_EXPORTS.join(", ")}); it exports: ${Object.keys(mod).join(", ")}`,
  ).toBeDefined();
  const { storage } = W.proofs();
  // 905: the real night run is reconcileTrustedPayouts(context, options), one
  // page per call; page through the whole tenant before returning.
  const run = mod[name!] as (
    context: unknown,
    options: unknown,
  ) => Promise<{ operations: number; last: string | null }>;
  let after: string | null = null;
  for (let page = 0; page < 1000; page += 1) {
    const result = await run(W.scope(), { storage, after });
    if (result.last === null || result.operations === 0) return;
    after = result.last;
  }
  throw new Error("recon did not finish");
}

// ---- Worlds ----------------------------------------------------------------------------

/** An exported batch of Budi, requested by the fixture requester. */
async function exportedBatch() {
  const slips = [bank(BUDI, NET)];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const batchId = await W.exportedBatch(runId);
  return {
    runId,
    batchId,
    itemId: (await W.itemsOf(batchId))[0]!.id as string,
  };
}

/** The only item was closed `failed` by two people. */
async function failedWorld() {
  const w = await exportedBatch();
  await W.resolve(w.batchId, [w.itemId], "failed", APP);
  await W.resolve(w.batchId, [w.itemId], "failed", APP3);
  expect((await itemOf(w.itemId)).status, "premise: failed").toBe("failed");
  return w;
}

type World = { batchId: string; itemId: string };

/** One step of a correction (propose or approve, the service decides) by `who`. */
const correct = (who: Person, w: World, evidenceKey: string) =>
  W.inTx((tx) =>
    correctFailedItems(
      tx,
      actorOf(who.userId),
      w.batchId,
      { itemIds: [w.itemId], evidenceKey, note: NOTE_ITEM },
      W.proofs(),
    ),
  );

/** Two different finance people take the two steps over one proof. */
async function twoSteps(w: World) {
  const key = trackKey(uploadEvidence(w.batchId, `recon-${randomUUID()}.pdf`));
  const first = await correct(one, w, key);
  expect(first.stage, "step 1").toBe("proposed");
  const second = await correct(two, w, key);
  expect(second.stage, "step 2").toBe("corrected");
  return key;
}

/** A corrected item: failed, then corrected by two people. */
async function correctedWorld() {
  const w = await failedWorld();
  const key = await twoSteps(w);
  expect((await itemOf(w.itemId)).status, "premise: corrected").toBe(
    "succeeded",
  );
  return { ...w, key };
}

/** A transaction of the app role (what the trusted binder is granted to). */
async function appRun(work: (client: PoolClient) => Promise<void>) {
  const client = await W.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [W.tenantId],
    );
    try {
      await work(client);
      await client.query("COMMIT");
      return { code: undefined as string | undefined, message: "" };
    } catch (error) {
      const e = error as { code?: string; message?: string };
      await client.query("ROLLBACK").catch(() => undefined);
      return { code: e.code ?? "unknown", message: e.message ?? "" };
    }
  } finally {
    client.release();
  }
}

/**
 * The history a pre-fix replacement left (see the header): the proposal of
 * `one` over K1 replaced by K2, K1's binding and propose audit row kept, then
 * completed over K2 by `two`. Only one operation was completed.
 */
async function replacedCorrectionWorld() {
  const w = await failedWorld();
  const k1 = trackKey(
    uploadEvidence(w.batchId, `recon-k1-${randomUUID()}.pdf`),
  );
  const k2 = trackKey(
    uploadEvidence(w.batchId, `recon-k2-${randomUUID()}.pdf`),
  );
  expect(k2, "premise: two different keys").not.toBe(k1);

  // Step 1 over K1, through the service.
  const proposed = await correct(one, w, k1);
  expect(proposed.stage, "step 1 over K1").toBe("proposed");

  // K2: upload record (hashes read from the stored proof), then the binding by
  // the trusted binder with the proposer as creator.
  await W.inTx((tx) =>
    ensureProofFingerprintRecord(
      tx,
      W.proofs() as never,
      W.tenantId as never,
      w.batchId,
      k2,
      new Date(),
    ),
  );
  const k2Record = (
    await W.rowsOf(
      `SELECT content_sha256, stored_sha256 FROM payroll_payout_evidence_files
        WHERE tenant_id = $1 AND evidence_key = $2`,
      [W.tenantId, k2],
    )
  )[0];
  expect(k2Record, "premise: upload record of K2").toBeDefined();
  const bound = await appRun(async (c) => {
    await c.query(
      `SELECT app.payout_bind_proof($1::uuid, 'correction', $2::uuid[], $3::varchar, $4::text)`,
      [w.batchId, [w.itemId], k2, one.userId],
    );
  });
  expect(bound.code, `bind K2: ${bound.message}`).toBeUndefined();

  // Owner, guards off: the open proposal and its step-one attestation now name K2.
  await W.asTenant(async (c) => {
    const proposal = await c.query(
      `UPDATE payroll_payout_failed_corrections
          SET evidence_key = $4, content_sha256 = $5, stored_sha256 = $6
        WHERE tenant_id = $1 AND batch_id = $2 AND evidence_key = $3`,
      [
        W.tenantId,
        w.batchId,
        k1,
        k2,
        k2Record!.content_sha256,
        k2Record!.stored_sha256,
      ],
    );
    expect(proposal.rowCount, "premise: open proposal moved to K2").toBe(1);
    const attestation = await c.query(
      `UPDATE ${ATTESTATIONS} SET evidence_key = $4
        WHERE tenant_id = $1 AND batch_id = $2 AND kind = 'correction'
          AND evidence_key = $3`,
      [W.tenantId, w.batchId, k1, k2],
    );
    expect(attestation.rowCount, "premise: step-one attestation on K2").toBe(1);
    // The step-one grant binds the key too (0419): the rewrite moves it with
    // the attestation, so the history reads as one coherent K2 step.
    const grant = await c.query(
      `UPDATE payroll_payout_grants g SET evidence_key = $4
        WHERE g.tenant_id = $1 AND g.evidence_key = $3
          AND g.id IN (SELECT grant_id FROM ${ATTESTATIONS}
                        WHERE tenant_id = $1 AND batch_id = $2 AND kind = 'correction'
                          AND evidence_key = $4)`,
      [W.tenantId, w.batchId, k1, k2],
    );
    expect(grant.rowCount, "premise: step-one grant bound to K2").toBe(1);
  }, true);

  // The propose audit row of K2, as the service wrote it before (K1's row stays).
  const k1Audit = (
    await W.rowsOf(
      `SELECT event FROM audit_logs
        WHERE tenant_id = $1 AND event->>'action' = $2
          AND event #>> '{maskedChanges,after,evidenceKey}' = $3`,
      [W.tenantId, PROPOSED_ACTION, k1],
    )
  )[0]?.event as
    | {
        objectType: string;
        objectId: string;
        reason: string | null;
        maskedChanges: {
          before: Record<string, string | number | null>;
          after: Record<string, string | number | null>;
        };
      }
    | undefined;
  expect(k1Audit, "premise: propose audit row of K1").toBeDefined();
  const afterOfK1 = { ...k1Audit!.maskedChanges.after };
  delete afterOfK1.by;
  await W.inTx((tx) =>
    recordPayoutAudit(tx, actorOf(one.userId), {
      action: PROPOSED_ACTION,
      objectType: k1Audit!.objectType,
      objectId: k1Audit!.objectId,
      reason: k1Audit!.reason,
      before: k1Audit!.maskedChanges.before,
      after: { ...afterOfK1, evidenceKey: k2 },
    }),
  );

  // History premises: both bindings stay on record, only K2 has an attestation.
  const bindings = await W.rowsOf(
    `SELECT evidence_key, created_by FROM payroll_payout_proof_bindings
      WHERE tenant_id = $1 AND batch_id = $2 AND kind = 'correction'`,
    [W.tenantId, w.batchId],
  );
  expect(
    bindings.map((b) => b.evidence_key).sort(),
    "premise: K1 and K2 bindings on record",
  ).toEqual([k1, k2].sort());
  expect(
    bindings.every((b) => b.created_by === one.userId),
    "premise: both bindings made by the proposer",
  ).toBe(true);
  const heldKeys = (await attestationsOf(w.itemId)).map((a) => a.evidence_key);
  expect(heldKeys, "premise: no attestation holds K1").not.toContain(k1);
  expect(heldKeys, "premise: the step-one attestation holds K2").toContain(k2);

  // Step 2 by the second person over K2.
  const second = await correct(two, w, k2);
  expect(second.stage, "step 2 over K2").toBe("corrected");
  expect((await itemOf(w.itemId)).status, "premise: corrected").toBe(
    "succeeded",
  );
  return { ...w, k1, k2 };
}

// ---- Observations ----------------------------------------------------------------------

const itemOf = async (itemId: string) =>
  (
    await W.rowsOf(
      `SELECT status, gl_posting_id, batch_id FROM payroll_disbursement_items
        WHERE tenant_id = $1 AND id = $2`,
      [W.tenantId, itemId],
    )
  )[0]!;
const exceptionsOf = (itemId: string) =>
  W.rowsOf(
    `SELECT * FROM ${EXCEPTIONS} WHERE tenant_id = $1 AND item_id = $2`,
    [W.tenantId, itemId],
  );
const attestationsOf = (itemId: string) =>
  W.rowsOf(
    `SELECT * FROM ${ATTESTATIONS}
      WHERE tenant_id = $1 AND $2::uuid = ANY(item_ids) ORDER BY attested_at, step`,
    [W.tenantId, itemId],
  );
const financeFlags = async () => {
  const day = (shift: number) =>
    new Date(Date.now() + shift * 86_400_000).toISOString().slice(0, 10);
  const result = await listFinanceExceptions(W.scope(), {
    from: day(-2),
    to: day(2),
    kind: "payout_recon_flag",
  } as never);
  return JSON.stringify(result.items);
};

/** A flag exists as a recon exception row and as a finance exception. */
async function expectFlagged(itemId: string, label: string) {
  const rows = await exceptionsOf(itemId);
  expect(
    rows.length,
    `${label}: recon exception row for the item`,
  ).toBeGreaterThan(0);
  const operations = (await attestationsOf(itemId)).map(
    (a) => a.operation_id as string,
  );
  const shown = await financeFlags();
  expect(
    [itemId, ...operations].some((id) => shown.includes(id)),
    `${label}: finance exception payout_recon_flag mentions the item or operation: ${shown}`,
  ).toBe(true);
}
async function expectNotFlagged(itemId: string, label: string) {
  expect(
    await exceptionsOf(itemId),
    `${label}: no recon exception`,
  ).toHaveLength(0);
  expect(await financeFlags(), `${label}: no finance exception`).not.toContain(
    itemId,
  );
}

// ---- Forged second binding (control) ------------------------------------------------

const hex = () => randomBytes(32).toString("hex");

/** A second, completed-looking binding of the same kind, batch and item-set. */
async function forgeSecondBinding(batchId: string, key: string) {
  const forgedKey = evidenceKeyFor(
    W.tenantId,
    batchId,
    `911-forged-${randomUUID()}.pdf`,
  );
  await W.asTenant(
    (c) =>
      c.query(
        `INSERT INTO payroll_payout_proof_bindings
           (tenant_id, batch_id, kind, item_set_hash, evidence_key,
            content_sha256, stored_sha256, created_by)
         SELECT tenant_id, batch_id, kind, item_set_hash, $3, $4, $5, 'forged-911'
           FROM payroll_payout_proof_bindings
          WHERE tenant_id = $1 AND evidence_key = $2`,
        [W.tenantId, key, forgedKey, hex(), hex()],
      ),
    true,
  );
  const rows = await W.rowsOf(
    `SELECT id FROM payroll_payout_proof_bindings
      WHERE tenant_id = $1 AND evidence_key = $2`,
    [W.tenantId, forgedKey],
  );
  expect(rows, "premise: the second binding is on record").toHaveLength(1);
}

// Scoped to the world's own item: other files share the tenant and may leave
// their own recon rows behind.
const tenantExceptionCount = async (itemId: string) =>
  (
    await W.rowsOf(
      `SELECT count(*)::int AS n FROM ${EXCEPTIONS}
        WHERE tenant_id = $1 AND item_id = $2`,
      [W.tenantId, itemId],
    )
  )[0]!.n as number;

// =========================================================================
// P2-4: a legit evidence replacement is not a duplicate operation
// =========================================================================

describe("911 recon: legit proposal evidence replacement", () => {
  it("[911-recon-replacement-no-flag] correction proposed over K1, replaced by K2, completed by a second person: the night run flags nothing (no binding_duplicate)", async () => {
    const w = await replacedCorrectionWorld();

    await runRecon();
    await expectNotFlagged(w.itemId, "replaced proof, one completed operation");
    expect(
      await tenantExceptionCount(w.itemId),
      "no recon exception at all for the legit replacement",
    ).toBe(0);
    expect(
      await financeFlags(),
      "no finance exception binding_duplicate",
    ).not.toContain("binding_duplicate");
  });

  it("[911-recon-replacement-old-key-unusable] after the replacement and the completed correction, K1 cannot back another operation: 409 PAYOUT_PROOF_REUSED and nothing changes", async () => {
    const w = await replacedCorrectionWorld();
    const attestationsBefore = (await attestationsOf(w.itemId)).length;

    await W.expectRefused(
      W.inTx((tx) =>
        returnManualItems(
          tx,
          actorOf(one.userId),
          w.batchId,
          {
            itemIds: [w.itemId],
            evidenceKey: w.k1,
            bankRef: `TRX${randomUUID().slice(0, 8)}`,
            note: NOTE_ITEM,
          } as never,
          W.proofs(),
        ),
      ),
      { status: 409, code: "PAYOUT_PROOF_REUSED" },
    );
    expect(
      (await itemOf(w.itemId)).status,
      "the item stays succeeded: no return over the old key",
    ).toBe("succeeded");
    expect(
      (await attestationsOf(w.itemId)).length,
      "no attestation from the refused operation",
    ).toBe(attestationsBefore);
  });

  it("[911-recon-replacement-control-duplicate] two truly completed operations of one kind over the same item-set (two bindings) are still flagged binding_duplicate", async () => {
    const w = await correctedWorld();
    await runRecon();
    await expectNotFlagged(w.itemId, "control before the second binding");

    await forgeSecondBinding(w.batchId, w.key);
    await runRecon();
    await expectFlagged(w.itemId, "second completed operation on the item-set");
    const reasons = (await exceptionsOf(w.itemId)).map((r) => String(r.reason));
    expect(
      reasons.some((r) => r.includes("binding_duplicate")),
      `a recon exception reason binding_duplicate: ${reasons.join(" | ")}`,
    ).toBe(true);
  });
});
