// Payout 897 review fixes (architect review of 8f7c91126..30a580a91, finding
// P2-1; scratchpad b897/review-result.md). Written fail-first from the finding.
//
// P2-1: before deploy, PT A has an OPEN return (step one done) on bytes P and
// PT B has a finished operation on the same bytes. The backfill reaches A first:
// A gets the normal binding, B a `legacy_duplicate` one. A's step two only sees
// A's own bindings, so on 30a580a91 it finishes the return and frees the item
// for a new payment, backed by a proof that already backed B's money movement.
// Rule proven here: once a hash is contested by a legacy duplicate in ANY
// tenant, no step of any operation over it goes on (409 PAYOUT_PROOF_REUSED,
// the same text, nothing of B in the body) and A's items do not change. The app
// role cannot read or write the contest table; it may only ask yes or no.
//
// Assumption: PT B is a real tenant row with a batch and a proof record copied
// from A as the table owner (a second full tenant world does not exist in the
// fixtures); B's legacy binding is inserted with every trigger on, so the claim
// trigger itself records the contest.
import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { FakeObjectStorage } from "@starter/shared/adapters";
import { NoopMalwareScanner } from "../services/core-image.ts";
import { uploadPayoutEvidence } from "../services/payroll-payout-evidence-upload.service.ts";
import { returnManualItems } from "../services/payroll-payout-manual.service.ts";
import { validPdfBytes } from "./helpers/pdf-fixtures.ts";
import { withAppRole } from "./accounting-ledger-guard-test-helpers.ts";
import {
  APP,
  APP3,
  BUDI,
  SITI,
  actorOf,
  bank,
  installPayoutWorld,
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("897fix");
const REUSED = "PAYOUT_PROOF_REUSED";
const REUSED_TEXT = "Bukti ini sudah dipakai untuk operasi lain.";
const idOf = (row: Row) => row.id as string;

const storage = new FakeObjectStorage();
const store = () => ({ storage, context: W.scope() });
const uploadTo = async (batchId: string, bytes: Uint8Array) =>
  (
    await uploadPayoutEvidence(W.scope(), batchId, bytes, {
      storage,
      scanner: new NoopMalwareScanner(),
    })
  ).evidenceKey;

async function paidBatch() {
  const slips = [bank(BUDI, 4_250_000), bank(SITI, 3_100_500)];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const batchId = await W.exportedBatch(runId);
  const items = (await W.itemsOf(batchId)).filter(
    (i) => i.status === "exported",
  );
  await W.confirm(batchId, W.succeedItems(batchId, items));
  return { batchId, siti: idOf(await W.itemOfPerson(batchId, SITI)) };
}

const returnCall = (
  batchId: string,
  itemIds: string[],
  by: string,
  key: string,
) =>
  W.inTx((tx) =>
    returnManualItems(
      tx,
      actorOf(by),
      batchId,
      {
        itemIds,
        evidenceKey: key,
        note: "Bank mengembalikan dana, rekening tujuan ditutup",
      } as never,
      store(),
    ),
  );

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

/**
 * PT B: a tenant, a batch and the proof record of the same bytes as A's key,
 * then a `legacy_duplicate` binding over those bytes inserted with every
 * trigger on (the backfill reached A first, so A holds the hashes).
 */
async function legacyDuplicateInOtherTenant(batchIdA: string, keyA: string) {
  const tenant = randomUUID();
  const batch = randomUUID();
  const binding = randomUUID();
  const key = `tenants/${tenant}/payroll-payout/${batch}/bukti-lama.pdf`;
  const [file] = await W.rowsOf(
    `SELECT content_sha256, stored_sha256 FROM payroll_payout_evidence_files
      WHERE tenant_id = $1 AND evidence_key = $2`,
    [W.tenantId, keyA],
  );
  const shas = [
    ...new Set([file!.content_sha256 as string, file!.stored_sha256 as string]),
  ];
  const client = await W.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       SELECT $1, $2, 'PT B 897', plan, status, deployment_mode, feature_flags, limits, created_by
         FROM tenants WHERE id = $3`,
      [tenant, `pt-b-897-${tenant}`, W.tenantId],
    );
    // The batch and its proof record are copies of A's (owner, guards off):
    // only the binding below needs to be real.
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `INSERT INTO payroll_disbursement_batches
       SELECT (jsonb_populate_record(b, jsonb_build_object('id', $1::uuid, 'tenant_id', $2::uuid))).*
         FROM payroll_disbursement_batches b WHERE b.tenant_id = $3 AND b.id = $4`,
      [batch, tenant, W.tenantId, batchIdA],
    );
    await client.query(
      `INSERT INTO payroll_payout_evidence_files
         (tenant_id, batch_id, evidence_key, content_sha256, stored_sha256, created_by)
       VALUES ($1, $2, $3, $4, $5, 'holder-b')`,
      [tenant, batch, key, file!.content_sha256, file!.stored_sha256],
    );
    await client.query("SET LOCAL session_replication_role = origin");
    await client.query(
      `INSERT INTO payroll_payout_proof_bindings
         (id, tenant_id, batch_id, kind, item_set_hash, evidence_key,
          content_sha256, stored_sha256, legacy_duplicate, created_by)
       VALUES ($1, $2, $3, 'overpaid', $4, $5, $6, $7, true, 'system')`,
      [
        binding,
        tenant,
        batch,
        createHash("sha256").update(binding).digest("hex"),
        key,
        file!.content_sha256,
        file!.stored_sha256,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  cleanups.push(async () => {
    const owner = await W.owner.connect();
    try {
      await owner.query("BEGIN");
      await owner.query("SET LOCAL session_replication_role = replica");
      await owner.query(
        "DELETE FROM payroll_payout_proof_hash_contests WHERE sha256 = ANY($1::varchar[])",
        [shas],
      );
      await owner.query(
        "DELETE FROM payroll_payout_proof_hashes WHERE binding_id = $1",
        [binding],
      );
      await owner.query(
        "DELETE FROM payroll_payout_proof_bindings WHERE tenant_id = $1",
        [tenant],
      );
      await owner.query(
        "DELETE FROM payroll_payout_evidence_files WHERE tenant_id = $1",
        [tenant],
      );
      await owner.query(
        "DELETE FROM payroll_disbursement_batches WHERE tenant_id = $1",
        [tenant],
      );
      await owner.query("DELETE FROM tenants WHERE id = $1", [tenant]);
      await owner.query("COMMIT");
    } catch {
      await owner.query("ROLLBACK").catch(() => undefined);
    } finally {
      owner.release();
    }
  });
  return { tenant, batch, shas };
}

const itemState = async (itemId: string) =>
  (
    await W.rowsOf(
      `SELECT status, returned_by, returned_by_2, return_evidence_key
         FROM payroll_disbursement_items
        WHERE tenant_id = $1 AND id = $2`,
      [W.tenantId, itemId],
    )
  )[0];
const claimState = async (key: string) =>
  W.rowsOf(
    `SELECT status FROM payroll_payout_return_claims
      WHERE tenant_id = $1 AND evidence_key = $2`,
    [W.tenantId, key],
  );

describe("897 review P2-1: a proof contested by a legacy duplicate in another PT stops an open operation", () => {
  it("[897-fix-cross-tenant-open-winner] A's open return over bytes that PT B's finished operation already used cannot finish: step two answers 409 PAYOUT_PROOF_REUSED, nothing of B in the body, A's item and claim unchanged", async () => {
    const w = await paidBatch();
    const key = await uploadTo(
      w.batchId,
      await validPdfBytes({ marker: `bukti-return-${randomUUID()}` }),
    );
    await returnCall(w.batchId, [w.siti], APP, key);
    const holder = await legacyDuplicateInOtherTenant(w.batchId, key);
    const itemBefore = await itemState(w.siti);
    const claimsBefore = await claimState(key);
    expect(claimsBefore, "premise: step one left an open claim").toHaveLength(
      1,
    );

    const error = await W.httpFailure(
      returnCall(w.batchId, [w.siti], APP3, key),
    );
    expect(error, "step two must be refused").not.toBeNull();
    expect(error!.status).toBe(409);
    expect(error!.code).toBe(REUSED);
    expect(error!.message).toBe(REUSED_TEXT);
    const text = JSON.stringify(error);
    for (const secret of [holder.tenant, holder.batch, ...holder.shas])
      expect(text, "nothing of PT B leaks").not.toContain(secret);

    expect(await itemState(w.siti)).toEqual(itemBefore);
    expect(await claimState(key)).toEqual(claimsBefore);
    expect(await W.countJournals(`payroll-payout-return:${w.siti}`)).toBe(0);
  });

  it("[897-fix-contest-table-private] the app role can neither read nor write the contest table; it can only ask whether hashes are contested", async () => {
    const result = await withAppRole(async (client) => {
      const attempt = async (sql: string) => {
        await client.query("SAVEPOINT try_contest");
        try {
          const res = await client.query(sql);
          return res.rows[0] ?? "ok";
        } catch (error) {
          await client.query("ROLLBACK TO SAVEPOINT try_contest");
          return (error as { code?: string }).code ?? "unknown";
        }
      };
      return {
        select: await attempt(
          "SELECT count(*) FROM payroll_payout_proof_hash_contests",
        ),
        insert: await attempt(
          `INSERT INTO payroll_payout_proof_hash_contests (sha256) VALUES (repeat('a', 64))`,
        ),
        remove: await attempt("DELETE FROM payroll_payout_proof_hash_contests"),
        ask: await attempt(
          `SELECT app.payout_proof_contested(ARRAY[repeat('b', 64)]::varchar[]) AS contested`,
        ),
      };
    });
    expect(result).toEqual({
      select: "42501",
      insert: "42501",
      remove: "42501",
      ask: { contested: false },
    });
  });
});
