// Payout 911, second-opinion finding P2-3 (docs/qa/second-opinion-payout-905.md
// finding 3; brief-911 CTO decision: "bind and payout_assert_proof require the
// same batch_id and the same legal entity"). Written fail-first from the finding
// and docs/briefs/905/design.md, not from the implementation.
// Everything adversarial runs as the app role (`SET LOCAL ROLE legend_app`), so
// the database boundary is what is proven, not the service.
//
// Rule proven (founder: nobody is paid on another PT's proof; when in doubt,
// limit the payment): a proof upload belongs to ONE batch (and so to that
// batch's legal entity). Another batch of the same tenant, in the same or a
// different legal entity, cannot bind it, and cannot run a correction step on it.
//
// Assumptions (the finding and design leave them open, stated so they can be
// contested):
// - "Different legal entity" is built by moving the batch row of B to a second
//   legal entity (owner, guards off), as payroll-payout-batch-list.test.ts does.
//   Both batches keep the fixture tenant. The same-entity variant (two batches
//   of one PT) is covered too: the finding says "batch record", not only entity.
// - An unbound upload is a row in payroll_payout_evidence_files of batch A with
//   no row in payroll_payout_proof_bindings for its key.
// - A refusal may be any database error. The proof is the unchanged end state:
//   no binding, no attestation, no status change, no correction, posting or
//   journal for B. A "undefined function / table / column" error never counts
//   as a refusal (the test would fail for a setup reason, not the missing rule).
// - payout_assert_proof is an internal helper whose signature the design does
//   not give, so it is proven through the public step that calls it,
//   app.payout_correction_approve(operation, key, grant): a proposal
//   whose binding already points at key A (the shape the pre-fix binder could
//   leave: simulated by the owner rewriting key and hashes of an honest
//   proposal, raw mode) must not be approvable. The approve statement is run
//   rolled back and must itself raise: its COMMIT would fail anyway (no settle
//   posting), which would hide the missing check.
// - The repeat of an accepted bind of key B may return the same binding or
//   raise; the proof is that exactly one binding of key B exists afterwards.
import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  APP,
  APP3,
  BUDI,
  bank,
  evidenceKeyFor,
  installPayoutWorld,
  payoutActorSession,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("911bind");
const NET = 1_000_000;
const NOTE = "Mutasi bank menunjukkan transfer ternyata berhasil";
const hex = () => randomBytes(32).toString("hex");
// Errors that mean "the call was malformed", never "the rule refused it".
const SETUP_ERRORS = ["42883", "42P01", "42703", "42601", "42P02", "22P02"];

const batchIds: string[] = [];
const movedBatches: string[] = [];
const extraEntities: string[] = [];

type Finance = Awaited<ReturnType<typeof payoutActorSession>>;
let financeOne: Finance;
let financeTwo: Finance;

// ---- legend_app helper ---------------------------------------------------------------

/**
 * A legend_app transaction of the fixture tenant. `commit: true` ends with a real
 * COMMIT, otherwise with ROLLBACK (the statements are still checked). Returns the
 * first error (statement or commit), if any.
 */
async function appRun(
  work: (client: PoolClient) => Promise<void>,
  commit = true,
) {
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
      await client.query(commit ? "COMMIT" : "ROLLBACK");
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

// ---- Fixture --------------------------------------------------------------------------

/** A batch whose only item (Budi) was resolved `failed` by two people: the shape a correction starts from. */
async function failedBatch() {
  const slips = [bank(BUDI, NET)];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const batchId = await W.exportedBatch(runId);
  batchIds.push(batchId);
  const itemId = (await W.itemsOf(batchId))[0]!.id as string;
  await W.resolve(batchId, [itemId], "failed", APP);
  await W.resolve(batchId, [itemId], "failed", APP3);
  expect((await W.itemsOf(batchId))[0]!.status, "premise: failed").toBe(
    "failed",
  );
  return { batchId, itemId };
}

/** Two batches of the fixture tenant; B in a second legal entity unless `sameEntity`. */
async function twoBatches(sameEntity: boolean) {
  const a = await failedBatch();
  const b = await failedBatch();
  if (!sameEntity) {
    const entity = randomUUID();
    extraEntities.push(entity);
    await W.asTenant(async (c) => {
      await c.query(
        "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)",
        [entity, W.tenantId, `PT Binding 911 ${entity.slice(0, 6)}`],
      );
      await c.query(
        "UPDATE payroll_disbursement_batches SET legal_entity_id = $2 WHERE id = $1",
        [b.batchId, entity],
      );
    }, true);
    movedBatches.push(b.batchId);
  }
  return { a, b };
}

/** The upload record of one proof file (what a real upload leaves), unbound. */
async function recordUpload(batchId: string, name: string) {
  const key = evidenceKeyFor(
    W.tenantId,
    batchId,
    `${name}-${randomUUID()}.pdf`,
  );
  const content = hex();
  const stored = hex();
  await W.asTenant(
    (c) =>
      c.query(
        `INSERT INTO payroll_payout_evidence_files
           (tenant_id, batch_id, evidence_key, content_sha256, stored_sha256, created_by)
         VALUES ($1, $2, $3, $4, $5, 'upload-911')`,
        [W.tenantId, batchId, key, content, stored],
      ),
    true,
  );
  return { key, content, stored };
}

const itemRow = async (itemId: string) =>
  (
    await W.rowsOf(
      `SELECT status, settled_at, confirmed_by, confirmation_ref, confirmation_evidence_key
         FROM payroll_disbursement_items WHERE tenant_id = $1 AND id = $2`,
      [W.tenantId, itemId],
    )
  )[0]!;
const count = async (sql: string, params: unknown[]) =>
  Number((await W.rowsOf(sql, params))[0]!.n);
/** Everything a refused step must not have written for batch B (and the tenant's payout journals). */
const trailOf = async (batchId: string, keys: string[]) => ({
  bindings: await count(
    `SELECT count(*)::int AS n FROM payroll_payout_proof_bindings
      WHERE tenant_id = $1 AND (batch_id = $2 OR evidence_key = ANY($3::text[]))`,
    [W.tenantId, batchId, keys],
  ),
  // Whole-row text match: independent of the attestation column names.
  attestations: await count(
    `SELECT count(*)::int AS n FROM payroll_payout_attestations a
      WHERE a.tenant_id = $1
        AND (a::text LIKE '%' || $2 || '%' OR a::text LIKE '%' || $3 || '%')`,
    [W.tenantId, batchId, keys[0] ?? ""],
  ),
  corrections: await count(
    `SELECT count(*)::int AS n FROM payroll_payout_failed_corrections
      WHERE tenant_id = $1 AND batch_id = $2`,
    [W.tenantId, batchId],
  ),
  postings: await count(
    `SELECT count(*)::int AS n FROM payroll_payout_gl_postings
      WHERE tenant_id = $1 AND batch_id = $2`,
    [W.tenantId, batchId],
  ),
  journals: await count(
    `SELECT count(*)::int AS n FROM journal_entries
      WHERE tenant_id = $1 AND idempotency_key LIKE 'payroll-payout%'`,
    [W.tenantId],
  ),
});

const bindSql = `SELECT app.payout_bind_proof($1::uuid, 'correction', $2::uuid[], $3::varchar, $4::text) AS id`;
const bindAs = (batchId: string, itemId: string, key: string, commit = true) =>
  appRun(async (c) => {
    await c.query(bindSql, [batchId, [itemId], key, financeOne.userId]);
  }, commit);

const proposeAs = async (
  batchId: string,
  itemId: string,
  key: string,
  who: Finance,
) => {
  let operation = "";
  // 911: the actor and the session come from a one-time grant.
  const grant = await who.grants.issue({
    kind: "correction",
    step: "propose",
    batchId,
    itemIds: [itemId],
    evidenceKey: key,
    refId: null,
    targetId: null,
  });
  const result = await appRun(async (c) => {
    operation = (
      await c.query(
        `SELECT app.payout_correction_propose($1::uuid, $2::uuid[], $3::varchar, $4::text, $5::text) AS id`,
        [batchId, [itemId], key, NOTE, grant],
      )
    ).rows[0].id as string;
  });
  return { ...result, operation };
};

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  // Two real finance people with a live MFA session, none of them the batch
  // requester or a failure resolver (the fixture constants).
  const people: Finance[] = [];
  for (const label of ["one", "two"]) {
    const { userId } = await W.signedInClient(`Binding911 ${label}`);
    await W.grantRole(userId, ["payroll.disburse.approve"]);
    people.push(await payoutActorSession(W.tenantId, userId));
  }
  [financeOne, financeTwo] = people as [Finance, Finance];
});

// Registered after the world's own hook: runs first (stack order). The moved
// batches go back to the fixture entity before the extra entities are deleted;
// the world then deletes batches, bindings, attestations and upload records.
afterAll(async () => {
  await W.asTenant(async (c) => {
    if (movedBatches.length > 0)
      await c.query(
        "UPDATE payroll_disbursement_batches SET legal_entity_id = $2 WHERE id = ANY($1)",
        [movedBatches, W.entityId()],
      );
    if (extraEntities.length > 0)
      await c.query("DELETE FROM legal_entities WHERE id = ANY($1)", [
        extraEntities,
      ]);
  }, true);
});

// =========================================================================
// bind: key A of another batch
// =========================================================================

describe("911 payout_bind_proof takes only an upload of the SAME batch", () => {
  for (const sameEntity of [false, true]) {
    const where = sameEntity
      ? "another batch of the same legal entity"
      : "a batch of another legal entity";
    it(`[911-bind-other-batch-refused${sameEntity ? "-same-entity" : ""}] as legend_app, binding an unbound upload of batch A to a failed item of ${where} (B) is refused: no binding, attestation, status change, correction, posting or journal`, async () => {
      const { a, b } = await twoBatches(sameEntity);
      const keyA = await recordUpload(a.batchId, "bukti-a");
      const before = await trailOf(b.batchId, [keyA.key]);
      expect(before.bindings, "premise: key A is unbound").toBe(0);

      const refused = await bindAs(b.batchId, b.itemId, keyA.key);

      expect(
        refused.code,
        "binding the proof of another batch must be refused",
      ).toBeDefined();
      expect(SETUP_ERRORS, refused.message).not.toContain(refused.code);
      expect(await trailOf(b.batchId, [keyA.key])).toEqual(before);
      const item = await itemRow(b.itemId);
      expect(item.status, "the slip of B must not move").toBe("failed");
      expect(item.settled_at).toBeNull();
      expect(item.confirmed_by).toBeNull();
      expect(item.confirmation_evidence_key).toBeNull();
      expect(
        await count(
          `SELECT count(*)::int AS n FROM payroll_payout_proof_bindings
            WHERE tenant_id = $1 AND evidence_key = $2`,
          [W.tenantId, keyA.key],
        ),
        "key A stays unbound",
      ).toBe(0);
    });
  }

  it("[911-bind-own-batch-works-once] control: the upload of B itself binds B's item through the same call, and a repeat does not add a second binding", async () => {
    const { b } = await twoBatches(false);
    const keyB = await recordUpload(b.batchId, "bukti-b");

    const first = await bindAs(b.batchId, b.itemId, keyB.key);
    expect(first.code, first.message).toBeUndefined();
    const bound = async () =>
      count(
        `SELECT count(*)::int AS n FROM payroll_payout_proof_bindings
          WHERE tenant_id = $1 AND batch_id = $2 AND evidence_key = $3`,
        [W.tenantId, b.batchId, keyB.key],
      );
    expect(await bound(), "bound once").toBe(1);

    // May return the same binding or refuse as a duplicate: either way no second one.
    await bindAs(b.batchId, b.itemId, keyB.key);
    expect(await bound(), "still exactly one binding").toBe(1);
    expect(
      (await itemRow(b.itemId)).status,
      "binding alone moves no money",
    ).toBe("failed");
  });
});

// =========================================================================
// payout_assert_proof: a binding that already points at another batch's proof
// =========================================================================

describe("911 payout_assert_proof rejects a proof of another batch", () => {
  for (const sameEntity of [false, true]) {
    it(`[911-assert-proof-other-batch${sameEntity ? "-same-entity" : ""}] the second person cannot approve a correction of B whose proof record belongs to batch A (${sameEntity ? "same" : "other"} legal entity): the approve step raises, item stays failed, nothing is posted`, async () => {
      const { a, b } = await twoBatches(sameEntity);
      const keyA = await recordUpload(a.batchId, "bukti-a");
      const keyB = await recordUpload(b.batchId, "bukti-b");
      // The service binds the upload to the item set before step one; the
      // propose step only accepts a proof that is already bound to it.
      const bound = await bindAs(b.batchId, b.itemId, keyB.key);
      expect(bound.code, `premise: B's own proof binds, ${bound.message}`).toBe(
        undefined,
      );

      const proposal = await proposeAs(
        b.batchId,
        b.itemId,
        keyB.key,
        financeOne,
      );
      expect(proposal.code, proposal.message).toBeUndefined();

      // 911: one grant per run, bound to the key it is spent with (a rolled
      // back run leaves its grant unconsumed, but each key needs its own).
      const approve = async (key: string) => {
        const grant = await financeTwo.grants.issue({
          kind: "correction",
          step: "approve",
          batchId: b.batchId,
          itemIds: [b.itemId],
          evidenceKey: key,
          refId: proposal.operation,
          targetId: null,
        });
        return async (c: PoolClient) => {
          await c.query(
            `SELECT app.payout_correction_approve($1::uuid, $2::varchar, $3::text)`,
            [proposal.operation, key, grant],
          );
        };
      };
      // Control: with B's own proof the second person's step is accepted
      // (rolled back: the COMMIT needs a settle posting this test never makes).
      const honest = await appRun(await approve(keyB.key), false);
      expect(
        honest.code,
        `premise: the honest step is accepted, ${honest.message}`,
      ).toBeUndefined();

      // The shape a pre-fix binder could leave: proposal, binding and
      // attestation of B name key A, with A's hashes (owner, guards off).
      await W.asTenant(async (c) => {
        await c.query(
          `UPDATE payroll_payout_failed_corrections
              SET evidence_key = $3, content_sha256 = $4, stored_sha256 = $5
            WHERE tenant_id = $1 AND operation_id = $2`,
          [W.tenantId, proposal.operation, keyA.key, keyA.content, keyA.stored],
        );
        await c.query(
          `UPDATE payroll_payout_proof_bindings
              SET evidence_key = $4, content_sha256 = $5, stored_sha256 = $6
            WHERE tenant_id = $1 AND batch_id = $2 AND evidence_key = $3`,
          [
            W.tenantId,
            b.batchId,
            keyB.key,
            keyA.key,
            keyA.content,
            keyA.stored,
          ],
        );
        const hasColumn = await c.query(
          `SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'payroll_payout_attestations'
              AND column_name = 'evidence_key'`,
        );
        if (hasColumn.rowCount)
          await c.query(
            `UPDATE payroll_payout_attestations SET evidence_key = $3
              WHERE tenant_id = $1 AND evidence_key = $2`,
            [W.tenantId, keyB.key, keyA.key],
          );
      }, true);
      const rebound = await count(
        `SELECT count(*)::int AS n FROM payroll_payout_proof_bindings
          WHERE tenant_id = $1 AND batch_id = $2 AND evidence_key = $3`,
        [W.tenantId, b.batchId, keyA.key],
      );
      expect(rebound, "premise: B's binding names key A").toBe(1);

      const before = await trailOf(b.batchId, [keyA.key]);
      const refused = await appRun(await approve(keyA.key), false);

      expect(
        refused.code,
        "the approve step itself must refuse a proof of another batch",
      ).toBeDefined();
      expect(SETUP_ERRORS, refused.message).not.toContain(refused.code);
      expect(await trailOf(b.batchId, [keyA.key])).toEqual(before);
      expect((await itemRow(b.itemId)).status).toBe("failed");
    });
  }
});
