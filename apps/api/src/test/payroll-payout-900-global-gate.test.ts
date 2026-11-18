// Payout 900 (card legend-p2v4s; design scratchpad b900/design.md F1 and F2;
// findings "the backfill gate is per tenant" and "two historical operations
// with the same key" in docs/qa/second-opinion-payout-897.md). Written fail-first
// from the CTO decisions and the design rules, not from the implementation.
//
// Rules proven here (founder: nobody is paid twice, a bank proof backs ONE
// operation, when in doubt restrict):
// - F1 global gate. While ANY tenant still has history that is not accounted
//   for (a return claim without hashes, a file without stored hash, an item key
//   without a record, or an operation without a binding of its identity), a
//   return/overpaid/correction step with a new proof is refused 409
//   PAYOUT_PROOF_FINGERPRINT_PENDING in EVERY tenant, with the same text the own
//   tenant gets and nothing of the other tenant in it. After the other tenant's
//   sweep the same bytes answer 409 PAYOUT_PROOF_REUSED.
// - The gate is one boolean the app role can ask (`app.payout_proof_history_pending()`);
//   it reveals nothing else and the app role still cannot read another tenant.
// - F2 shared key. Every operation sharing one evidence key (return claim,
//   overpaid group, correction) is listed as ONE stuck row (reason
//   `shared_key`, never auto resolved) carrying all identities, and every step
//   over those bytes is refused 409 PAYOUT_PROOF_REUSED. The gate stays clear.
// - Operations that are created after deploy are accounted for at once: the
//   gate never counts them (SQL identity equals the TS identity).
//
// Assumptions (the design names them, stated so they can be contested):
// - SQL functions `app.payout_proof_history_pending()` (SECURITY DEFINER,
//   STABLE, returns one boolean), `app.payout_proof_tenant_pending()` and
//   `app.payout_proof_operations()` (columns kind, batch_id, item_set_hash,
//   evidence_key, ...) exist after the migration. On 1c3067deb they do not, so
//   those tests fail with "function does not exist" (missing behaviour).
// - Stuck table `payroll_payout_proof_backfill_stuck` gets reason `shared_key`
//   and a jsonb column `operations` = [{kind, batch_id, item_set_hash}, ...].
// - The advisory lock of a hash is `pg_advisory_xact_lock(hashtextextended(
//   'payout-proof:' || sha, 0))` (documented in payroll-payout-877-proof-lock-order).
// - "Another tenant's historical return" is a return claim without hashes, as
//   migration 0382 left them; where the design says "recorded overpaid" in the
//   other tenant, a historical return claim is used instead (a second full
//   tenant world does not exist in the fixtures). Built as the table owner.
// - A "historical" operation of the main tenant is built by stripping the
//   binding, hash rows and claim hashes of a normally created one (what a
//   database from before deploy looks like).
// - Files run one at a time on one database, so a pending tenant created here
//   is removed again in afterEach; it must never leak into other tests.
import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { FakeObjectStorage } from "@starter/shared/adapters";
import { tenantIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { Pool } from "pg";
import { createApp } from "../app.ts";
import { listFinanceExceptions } from "../services/accounting-finance-exceptions.service.ts";
import { NoopMalwareScanner } from "../services/core-image.ts";
import { uploadPayoutEvidence } from "../services/payroll-payout-evidence-upload.service.ts";
import {
  approveDisbursementBatch,
  createDisbursementBatch,
  submitDisbursementBatch,
} from "../services/payroll-payout.service.ts";
import {
  exportManualBatch,
  returnManualItems,
} from "../services/payroll-payout-manual.service.ts";
import {
  backfillProofFingerprints,
  bindHistoricalOperations,
  itemSetHashOf,
} from "../services/payroll-payout-proof-backfill.service.ts";
import { runPayoutEvidenceBackfillSweep } from "../worker/payout-evidence-backfill.job.ts";
import { totpCode, totpStep } from "../lib/totp.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import { validPdfBytes } from "./helpers/pdf-fixtures.ts";
import { withAppRole } from "./accounting-ledger-guard-test-helpers.ts";
import {
  ANDI,
  APP,
  APP3,
  BUDI,
  SITI,
  actorOf,
  bank,
  installPayoutWorld,
  type Person,
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("900gate");
const PASSWORD = "Test-password-123!";
const BASE = "/api/hris/payroll/disbursement-batches";
const REUSED = "PAYOUT_PROOF_REUSED";
const REUSED_TEXT = "Bukti ini sudah dipakai untuk operasi lain.";
const PENDING = "PAYOUT_PROOF_FINGERPRINT_PENDING";
const STUCK = "payroll_payout_proof_backfill_stuck";
const BUDI_NET = 4_250_000;
const SITI_NET = 3_100_500;
const ANDI_NET = 5_000_001;
const idOf = (row: Row) => row.id as string;
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

// ---- Storage, app and helpers -------------------------------------------------------

const storage = new FakeObjectStorage();
const store = () => ({ storage, context: W.scope() });
const app = createApp({
  storageRuntime: {
    storage,
    scanner: new NoopMalwareScanner(),
    fileSigner: async () => "https://signed.example.test/x",
    hrisDocumentSigner: async () => null,
  },
});
const pdf = (label: string) =>
  validPdfBytes({ marker: `${label} ${randomUUID()}` });
const uploadTo = async (batchId: string, bytes: Uint8Array) =>
  (
    await uploadPayoutEvidence(W.scope(), batchId, bytes, {
      storage,
      scanner: new NoopMalwareScanner(),
    })
  ).evidenceKey;
const sweep = (context = W.scope()) =>
  runPayoutEvidenceBackfillSweep(context, new Date(), { storage });
const scopeOf = (tenantId: string) =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "domain",
    }),
    { kind: "tenant" },
  );

const dbOwner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const grantedUsers: string[] = [];

// ---- Cleanup registry (a pending tenant must never leak into another test) ---------

const cleanups: (() => Promise<void>)[] = [];
const trackedKeys: string[] = [];
const trackedShas: string[] = [];
const restoredItems: string[] = [];
const trackKey = (key: string) => (trackedKeys.push(key), key);
const trackBytes = (bytes: Uint8Array) => (
  trackedShas.push(sha256(bytes)),
  bytes
);

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup().catch(() => undefined);
  const keys = trackedKeys.splice(0);
  const shas = trackedShas.splice(0);
  const items = restoredItems.splice(0);
  await W.asTenant(async (c) => {
    await c.query(
      `DELETE FROM payroll_payout_proof_hashes
        WHERE binding_id IN (SELECT id FROM payroll_payout_proof_bindings
                              WHERE tenant_id = $1 AND evidence_key = ANY($2::text[])
                                AND NOT EXISTS (SELECT 1 FROM payroll_disbursement_items fi
                         WHERE fi.tenant_id = $1 AND fi.status = 'returned'
                           AND fi.return_evidence_key = payroll_payout_proof_bindings.evidence_key))`,
      [W.tenantId, keys],
    );
    await c.query(
      `DELETE FROM payroll_payout_proof_bindings
        WHERE tenant_id = $1 AND evidence_key = ANY($2::text[])
          AND NOT EXISTS (SELECT 1 FROM payroll_disbursement_items fi
                         WHERE fi.tenant_id = $1 AND fi.status = 'returned'
                           AND fi.return_evidence_key = payroll_payout_proof_bindings.evidence_key)`,
      [W.tenantId, keys],
    );
    await c.query(
      `DELETE FROM payroll_payout_return_claims
        WHERE tenant_id = $1 AND evidence_key = ANY($2::text[])
          AND NOT EXISTS (SELECT 1 FROM payroll_disbursement_items fi
                         WHERE fi.tenant_id = $1 AND fi.status = 'returned'
                           AND fi.return_evidence_key = payroll_payout_return_claims.evidence_key)`,
      [W.tenantId, keys],
    );
    await c.query(`DELETE FROM ${STUCK} WHERE evidence_key = ANY($1::text[])`, [
      keys,
    ]);
    await c.query(
      `UPDATE payroll_disbursement_items
          SET return_evidence_key = NULL, returned_by = NULL, returned_by_2 = NULL,
              return_note = NULL
        WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND status = 'succeeded'`,
      [W.tenantId, items],
    );
    await c.query(
      "DELETE FROM payroll_payout_proof_hash_contests WHERE sha256 = ANY($1::varchar[])",
      [shas],
    );
    // (A finished return - item 'returned' - keeps its claim and binding: it is
    // accounted for and the item cannot be reset.)
    // A test's own history must not outlive it: the gate is global, so one
    // leftover unaccounted operation (an item that still points at a deleted
    // claim's key, an overpaid or correction record whose binding is gone)
    // would hold every later test of every file that shares this database.
    await c.query(
      `UPDATE payroll_disbursement_items
          SET return_evidence_key = NULL, returned_by = NULL, returned_by_2 = NULL,
              return_note = NULL
        WHERE tenant_id = $1 AND return_evidence_key = ANY($2::text[]) AND status = 'succeeded'`,
      [W.tenantId, keys],
    );
    await c.query(
      `DELETE FROM payroll_payout_overpaid_proposals
        WHERE tenant_id = $1 AND evidence_key = ANY($2::text[])`,
      [W.tenantId, keys],
    );
    await c.query(
      `DELETE FROM payroll_payout_failed_corrections
        WHERE tenant_id = $1 AND evidence_key = ANY($2::text[])`,
      [W.tenantId, keys],
    );
  }, true);
});
afterAll(async () => {
  if (grantedUsers.length > 0) {
    await dbOwner.query(
      "DELETE FROM mfa_factors WHERE user_id = ANY($1::uuid[])",
      [grantedUsers],
    );
    await dbOwner.query(
      "DELETE FROM role_assignments WHERE user_id = ANY($1::text[])",
      [grantedUsers],
    );
  }
  await dbOwner.end();
});

// ---- People and worlds ----------------------------------------------------------------

async function approverClient(label: string) {
  const client = agent(app);
  await signUp(client, `Gate ${label}`);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  grantedUsers.push(userId);
  await W.grantRole(userId, ["payroll.view", "payroll.disburse.approve"]);
  const enrolled = await client
    .post("/api/auth/mfa/factors")
    .set(originHeader)
    .send({ type: "totp" });
  expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(201);
  const { factorId, secretBase32 } = enrolled.body.data as {
    factorId: string;
    secretBase32: string;
  };
  const verified = await client
    .post("/api/auth/mfa/verify")
    .set(originHeader)
    .send({ factorId, code: totpCode(secretBase32, totpStep(new Date())) });
  expect(verified.status, JSON.stringify(verified.body)).toBe(200);
  return { client, userId };
}
type Approver = Awaited<ReturnType<typeof approverClient>>;
const trio = async (label: string) => ({
  requester: await approverClient(`${label} Requester`),
  first: await approverClient(`${label} First`),
  second: await approverClient(`${label} Second`),
});

const currentSourceBank = async () =>
  (
    await W.rowsOf(
      `SELECT manual_source_bank_account_id AS id FROM payroll_payout_configs
        WHERE tenant_id = $1 AND legal_entity_id = $2`,
      [W.tenantId, W.entityId()],
    )
  )[0]!.id as string;

/** Same world as payroll-payout-897-proof-binding: `failed` people resolved failed, others paid. */
async function world(
  requester: Approver,
  options: { failed: Person[]; retriesPaid?: boolean },
) {
  const slips = [
    bank(BUDI, BUDI_NET),
    bank(SITI, SITI_NET),
    bank(ANDI, ANDI_NET),
  ];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  await W.inTx((tx) =>
    createDisbursementBatch(tx, actorOf(requester.userId), {
      payrollRunId: runId,
      channel: "manual_bank",
    } as never),
  );
  const [batch] = await W.rowsOf(
    `SELECT id FROM payroll_disbursement_batches
      WHERE tenant_id = $1 AND payroll_run_id = $2 ORDER BY created_at DESC LIMIT 1`,
    [W.tenantId, runId],
  );
  const batchId = batch!.id as string;
  await W.inTx((tx) =>
    submitDisbursementBatch(tx, actorOf(requester.userId), batchId),
  );
  const hash = (await W.batchById(batchId)).content_hash as string;
  const sourceBankAccountId = await currentSourceBank();
  await W.inTx((tx) =>
    approveDisbursementBatch(tx, actorOf(APP), batchId, {
      contentHash: hash,
      sourceBankAccountId,
    }),
  );
  await W.inTx((tx) => exportManualBatch(tx, actorOf(APP), batchId));
  const items = (await W.itemsOf(batchId)).filter(
    (i) => i.status === "exported",
  );
  const isFailed = (i: Row) =>
    options.failed.some((p) => p.id === i.employee_id);
  const paid = items.filter((i) => !isFailed(i));
  if (paid.length > 0) await W.confirm(batchId, W.succeedItems(batchId, paid));
  const failedIds = items.filter(isFailed).map(idOf);
  if (failedIds.length > 0) {
    await W.resolve(batchId, failedIds, "failed", APP);
    await W.resolve(batchId, failedIds, "failed", APP3);
  }
  if (options.retriesPaid) {
    const followUp = await W.exportedBatch(runId);
    const retries = (await W.itemsOf(followUp)).filter(
      (i) => i.status === "exported",
    );
    await W.confirm(followUp, W.succeedItems(followUp, retries));
  }
  const of = async (p: Person) => idOf(await W.itemOfPerson(batchId, p));
  return {
    runId,
    batchId,
    budi: await of(BUDI),
    siti: await of(SITI),
    andi: await of(ANDI),
  };
}

/** Budi and Siti paid in one exported batch (for the return-only checks). */
async function paidBatch() {
  const slips = [bank(BUDI, BUDI_NET), bank(SITI, SITI_NET)];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const batchId = await W.exportedBatch(runId);
  const items = (await W.itemsOf(batchId)).filter(
    (i) => i.status === "exported",
  );
  await W.confirm(batchId, W.succeedItems(batchId, items));
  return {
    runId,
    batchId,
    budi: idOf(await W.itemOfPerson(batchId, BUDI)),
    siti: idOf(await W.itemOfPerson(batchId, SITI)),
  };
}

// ---- Operations -------------------------------------------------------------------------

const overpaidCall = (
  who: Approver,
  w: { batchId: string },
  itemIds: string[],
  evidenceKey: string,
) =>
  who.client.post(`${BASE}/${w.batchId}/overpaid`).set(originHeader).send({
    itemIds,
    evidenceKey,
    note: "Mutasi bank menunjukkan transfer pertama ternyata berhasil",
    password: PASSWORD,
  });
const correctCall = (
  who: Approver,
  w: { batchId: string },
  itemIds: string[],
  evidenceKey: string,
) =>
  who.client
    .post(`${BASE}/${w.batchId}/correct-failed`)
    .set(originHeader)
    .send({
      itemIds,
      evidenceKey,
      note: "Mutasi bank menunjukkan transfer ternyata berhasil, tidak ada transfer lain",
      password: PASSWORD,
    });
/** Bank reference of a return: one per claim, the same in both steps (990). */
const returnBankRef = (evidenceKey: string, itemIds: string[]) =>
  "TRX" +
  createHash("sha256")
    .update(`${evidenceKey}|${itemIds.join(",")}`)
    .digest("hex")
    .slice(0, 12);

const returnCall = (
  w: { batchId: string },
  itemIds: string[],
  by: string,
  evidenceKey: string,
) =>
  W.inTx((tx) =>
    returnManualItems(
      tx,
      actorOf(by),
      w.batchId,
      {
        itemIds,
        evidenceKey,
        bankRef: returnBankRef(evidenceKey, itemIds),
        note: "Bank mengembalikan dana, rekening tujuan ditutup",
      } as never,
      store(),
    ),
  );
type Res = Awaited<ReturnType<typeof overpaidCall>>;
const expectOk = (res: Res, label = "") =>
  expect(res.status, `${label} ${JSON.stringify(res.body)}`).toBe(200);

async function expectRefusedService(
  work: Promise<unknown>,
  code: string,
  label = "",
) {
  const error = await W.httpFailure(work);
  expect(error, `${label}: must be refused`).not.toBeNull();
  expect(error!.status, label).toBe(409);
  expect(error!.code, label).toBe(code);
  return error!;
}

// ---- Observations -----------------------------------------------------------------------

const countOf = async (sql: string, params: unknown[]) =>
  Number((await W.rowsOf(sql, params))[0]!.n);
const claims = (key: string) =>
  countOf(
    `SELECT count(*)::int AS n FROM payroll_payout_return_claims
      WHERE tenant_id = $1 AND evidence_key = $2`,
    [W.tenantId, key],
  );
const bindingsOf = (key: string) =>
  countOf(
    `SELECT count(*)::int AS n FROM payroll_payout_proof_bindings
      WHERE tenant_id = $1 AND evidence_key = $2`,
    [W.tenantId, key],
  );
const itemState = async (itemId: string) =>
  (
    await W.rowsOf(
      `SELECT status, returned_by, returned_by_2, return_evidence_key
         FROM payroll_disbursement_items WHERE tenant_id = $1 AND id = $2`,
      [W.tenantId, itemId],
    )
  )[0];
const stuckRows = (key: string) =>
  W.rowsOf(
    `SELECT evidence_key, reason, operations FROM ${STUCK}
      WHERE tenant_id = $1 AND evidence_key = $2 AND resolved_at IS NULL`,
    [W.tenantId, key],
  );
const financeStuck = async () => {
  const day = (shift: number) =>
    new Date(Date.now() + shift * 86_400_000).toISOString().slice(0, 10);
  const result = await listFinanceExceptions(W.scope(), {
    from: day(-2),
    to: day(2),
    kind: "payout_proof_stuck",
  } as never);
  return JSON.stringify(result.items);
};

// ---- Simulating history -------------------------------------------------------------------

/** Remove the binding and hash rows of a key (what a database from before deploy looks like). */
const unbind = (key: string) =>
  W.asTenant(async (c) => {
    await c.query(
      `DELETE FROM payroll_payout_proof_hashes
        WHERE binding_id IN (SELECT id FROM payroll_payout_proof_bindings
                              WHERE tenant_id = $1 AND evidence_key = $2)`,
      [W.tenantId, key],
    );
    await c.query(
      `DELETE FROM payroll_payout_proof_bindings
        WHERE tenant_id = $1 AND evidence_key = $2`,
      [W.tenantId, key],
    );
  }, true);

/** A return claim as migration 0382 left it: no hashes, no upload record, no binding. */
const makeClaimHistorical = (key: string) =>
  W.asTenant(async (c) => {
    await c.query(
      `UPDATE payroll_payout_return_claims
          SET content_sha256 = NULL, stored_sha256 = NULL
        WHERE tenant_id = $1 AND evidence_key = $2`,
      [W.tenantId, key],
    );
    await c.query(
      `DELETE FROM payroll_payout_evidence_files
        WHERE tenant_id = $1 AND evidence_key = $2`,
      [W.tenantId, key],
    );
  }, true);
const makeReturnHistorical = async (key: string) => {
  await unbind(key);
  await makeClaimHistorical(key);
};

/** A pre-deploy OPEN return (step one done, no hashes): claim + item fields. `ageSeconds` orders it. */
async function legacyOpenReturn(
  batchId: string,
  itemId: string,
  key: string,
  ageSeconds: number,
) {
  trackKey(key);
  restoredItems.push(itemId);
  await W.asTenant(async (c) => {
    await c.query(
      `INSERT INTO payroll_payout_return_claims
         (tenant_id, batch_id, evidence_key, item_set_hash, status, created_by, created_at)
       VALUES ($1, $2, $3, $4, 'open', 'legacy-900',
               now() - ($5::int || ' seconds')::interval)`,
      [W.tenantId, batchId, key, itemSetHashOf([itemId]), ageSeconds],
    );
    await c.query(
      `UPDATE payroll_disbursement_items
          SET return_evidence_key = $3, returned_by = 'legacy-900',
              return_note = 'Dana kembali sebelum klaim'
        WHERE tenant_id = $1 AND id = $2`,
      [W.tenantId, itemId, key],
    );
    await c.query(
      `DELETE FROM payroll_payout_evidence_files
        WHERE tenant_id = $1 AND evidence_key = $2`,
      [W.tenantId, key],
    );
  }, true);
}

// ---- A second tenant (PT B) --------------------------------------------------------------

type OtherTenant = {
  tenant: string;
  batch: string;
  sourceBatch: string;
  scope: ReturnType<typeof scopeOf>;
};

/** Tenant B with a copy of A's batch (owner, guards off). Removed again in afterEach. */
async function tenantB(batchIdA: string): Promise<OtherTenant> {
  const tenant = randomUUID();
  const batch = randomUUID();
  const client = await W.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       SELECT $1, $2, 'PT B 900', plan, status, deployment_mode, feature_flags, limits, created_by
         FROM tenants WHERE id = $3`,
      [tenant, `pt-b-900-${tenant}`, W.tenantId],
    );
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `INSERT INTO payroll_disbursement_batches
       SELECT (jsonb_populate_record(b, jsonb_build_object('id', $1::uuid, 'tenant_id', $2::uuid))).*
         FROM payroll_disbursement_batches b WHERE b.tenant_id = $3 AND b.id = $4`,
      [batch, tenant, W.tenantId, batchIdA],
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
        `DELETE FROM payroll_payout_proof_hashes
          WHERE binding_id IN (SELECT id FROM payroll_payout_proof_bindings WHERE tenant_id = $1)`,
        [tenant],
      );
      for (const table of [
        "payroll_payout_proof_bindings",
        "payroll_payout_return_claims",
        STUCK,
        "payroll_payout_evidence_files",
        "payroll_disbursement_items",
        "payroll_disbursement_batches",
      ])
        await owner.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [
          tenant,
        ]);
      await owner.query("DELETE FROM tenants WHERE id = $1", [tenant]);
      await owner.query("COMMIT");
    } catch {
      await owner.query("ROLLBACK").catch(() => undefined);
    } finally {
      owner.release();
    }
  });
  return { tenant, batch, sourceBatch: batchIdA, scope: scopeOf(tenant) };
}

/** B's historical return claim over `bytes`: object in storage, claim without hashes, no record. */
async function historicalClaimOfB(b: OtherTenant, bytes: Uint8Array) {
  const key = `tenants/${b.tenant}/payroll-payout/${b.batch}/bukti-lama-${randomUUID()}.pdf`;
  await storage.put(b.scope, {
    tenantId: b.tenant,
    outletId: null,
    reference: "payout-900-gate-test",
    key,
    contentType: "application/pdf",
    content: bytes,
  } as never);
  const client = await W.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    // 905: the trusted binder recomputes the item set hash from real items; B
    // gets a returned item (cloned from A's batch, FKs off) behind the key. The
    // clone drops A's own proof keys (confirmation/resolution): in B they have no
    // upload record and would hold B's gate for ever.
    const item = (
      await client.query(
        `WITH src AS (SELECT * FROM payroll_disbursement_items
                       WHERE batch_id = $1 ORDER BY id LIMIT 1),
              ins AS (
                INSERT INTO payroll_disbursement_items
                SELECT (jsonb_populate_record(NULL::payroll_disbursement_items, to_jsonb(s) || jsonb_build_object(
                          'id', gen_random_uuid(), 'tenant_id', $2::uuid, 'batch_id', $3::uuid,
                          'status', 'returned', 'attempt_no', 1000,
                          'idempotency_key', 'payslip:' || (to_jsonb(s)->>'payslip_id') || ':attempt:1000',
                          'return_evidence_key', $4::text,
                          'confirmation_evidence_key', NULL, 'resolution_evidence_key', NULL,
                          'returned_by', 'legacy-b-900', 'return_note', 'legacy b', 'returned_by_2', 'legacy-b-900-2',
                          'returned_at', now()))).*
                  FROM src s
                RETURNING id)
         SELECT id::text AS id FROM ins`,
        [b.sourceBatch, b.tenant, b.batch, key],
      )
    ).rows[0].id as string;
    await client.query(
      `INSERT INTO payroll_payout_return_claims
         (tenant_id, batch_id, evidence_key, item_set_hash, status, created_by, created_at)
       VALUES ($1, $2, $3, encode(sha256(convert_to($4::text, 'UTF8')), 'hex'), 'open', 'legacy-b-900', now() - interval '3 days')`,
      [b.tenant, b.batch, key, item],
    );
    await client.query("COMMIT");
  } finally {
    client.release();
  }
  return key;
}

/** Own-tenant pending text: a return claim without hashes in A, measured, then removed. */
async function ownPendingMessage(w: { batchId: string; siti: string }) {
  const missing = trackKey(
    `tenants/${W.tenantId}/payroll-payout/${w.batchId}/900-own-${randomUUID()}.pdf`,
  );
  await W.asTenant(async (c) => {
    await c.query(
      `INSERT INTO payroll_payout_return_claims
         (tenant_id, batch_id, evidence_key, item_set_hash, status, created_by, created_at)
       VALUES ($1, $2, $3, $4, 'open', 'legacy-900', now() - interval '3 days')`,
      [
        W.tenantId,
        w.batchId,
        missing,
        sha256(Buffer.from(`900-own-${missing}`)),
      ],
    );
  }, true);
  try {
    const probe = trackKey(await uploadTo(w.batchId, await pdf("probe-own")));
    const error = await expectRefusedService(
      returnCall(w, [w.siti], APP, probe),
      PENDING,
      "own pending",
    );
    return error.message;
  } finally {
    await W.asTenant(
      (c) =>
        c.query(
          `DELETE FROM payroll_payout_return_claims WHERE tenant_id = $1 AND evidence_key = $2`,
          [W.tenantId, missing],
        ),
      true,
    );
  }
}

// =========================================================================
// F1: the gate is global
// =========================================================================

describe("900 the backfill gate is global (F1)", () => {
  it("[900-gate-other-tenant-history-holds] PT B has a historical unbound return on bytes P: a clean PT A is refused 409 PENDING (same text as its own pending, nothing of B in it, A unchanged); after B's sweep the same bytes answer 409 REUSED", async () => {
    const w = await paidBatch();
    const ownText = await ownPendingMessage(w);

    const bytes = trackBytes(await pdf("bukti-bersama"));
    const b = await tenantB(w.batchId);
    const keyB = trackKey(await historicalClaimOfB(b, bytes));
    const keyA = trackKey(await uploadTo(w.batchId, bytes));
    const itemBefore = await itemState(w.siti);

    const error = await expectRefusedService(
      returnCall(w, [w.siti], APP, keyA),
      PENDING,
      "other tenant pending",
    );

    expect(error.message, "same text as the own-tenant pending").toBe(ownText);
    const text = JSON.stringify(error) + error.message;
    for (const secret of [b.tenant, b.batch, keyB, sha256(bytes)])
      expect(text, "nothing of PT B in the refusal").not.toContain(secret);
    expect(await claims(keyA), "A has no claim").toBe(0);
    expect(await bindingsOf(keyA), "A has no binding").toBe(0);
    expect(await itemState(w.siti), "A's item is untouched").toEqual(
      itemBefore,
    );

    // B's sweep accounts for B's history; the gate opens and the bytes are B's.
    await sweep(b.scope);
    await sweep(b.scope);
    await expectRefusedService(
      returnCall(w, [w.siti], APP, keyA),
      REUSED,
      "after B's sweep",
    );
    expect(await claims(keyA)).toBe(0);
    expect(await itemState(w.siti)).toEqual(itemBefore);
  });

  it("[900-gate-race-sweep-vs-step2] B's contest of the bytes is written while A's step two waits on the same hash lock: after B commits, A's step two answers 409 REUSED and A's items are unchanged", async () => {
    const w = await paidBatch();
    const bytes = trackBytes(await pdf("balapan-sapuan"));
    const keyA = trackKey(await uploadTo(w.batchId, bytes));
    await returnCall(w, [w.siti], APP, keyA); // step one: A holds the bytes
    const itemBefore = await itemState(w.siti);

    // Raw side: the hash lock first (as the service does), then PT B's legacy
    // duplicate binding of the same bytes, not yet committed.
    const [file] = await W.rowsOf(
      `SELECT content_sha256, stored_sha256 FROM payroll_payout_evidence_files
        WHERE tenant_id = $1 AND evidence_key = $2`,
      [W.tenantId, keyA],
    );
    const shas = [
      ...new Set([
        file!.content_sha256 as string,
        file!.stored_sha256 as string,
      ]),
    ].sort();
    const tenant = randomUUID();
    const batch = randomUUID();
    const binding = randomUUID();
    const keyB = `tenants/${tenant}/payroll-payout/${batch}/bukti-lama.pdf`;
    const raw = await W.owner.connect();
    cleanups.push(async () => {
      await raw.query("ROLLBACK").catch(() => undefined);
      raw.release();
      const owner = await W.owner.connect();
      try {
        await owner.query("BEGIN");
        await owner.query("SET LOCAL session_replication_role = replica");
        await owner.query(
          "DELETE FROM payroll_payout_proof_hashes WHERE binding_id = $1",
          [binding],
        );
        for (const table of [
          "payroll_payout_proof_bindings",
          "payroll_payout_evidence_files",
          "payroll_disbursement_batches",
        ])
          await owner.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [
            tenant,
          ]);
        await owner.query("DELETE FROM tenants WHERE id = $1", [tenant]);
        await owner.query("COMMIT");
      } catch {
        await owner.query("ROLLBACK").catch(() => undefined);
      } finally {
        owner.release();
      }
    });
    await raw.query("BEGIN");
    for (const sha of shas)
      await raw.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `payout-proof:${sha}`,
      ]);
    await raw.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       SELECT $1, $2, 'PT B 900 race', plan, status, deployment_mode, feature_flags, limits, created_by
         FROM tenants WHERE id = $3`,
      [tenant, `pt-b-900-race-${tenant}`, W.tenantId],
    );
    await raw.query("SET LOCAL session_replication_role = replica");
    await raw.query(
      `INSERT INTO payroll_disbursement_batches
       SELECT (jsonb_populate_record(b, jsonb_build_object('id', $1::uuid, 'tenant_id', $2::uuid))).*
         FROM payroll_disbursement_batches b WHERE b.tenant_id = $3 AND b.id = $4`,
      [batch, tenant, W.tenantId, w.batchId],
    );
    await raw.query(
      `INSERT INTO payroll_payout_evidence_files
         (tenant_id, batch_id, evidence_key, content_sha256, stored_sha256, created_by)
       VALUES ($1, $2, $3, $4, $5, 'holder-b')`,
      [tenant, batch, keyB, file!.content_sha256, file!.stored_sha256],
    );
    await raw.query("SET LOCAL session_replication_role = origin");
    await raw.query(
      `INSERT INTO payroll_payout_proof_bindings
         (id, tenant_id, batch_id, kind, item_set_hash, evidence_key,
          content_sha256, stored_sha256, legacy_duplicate, created_by)
       VALUES ($1, $2, $3, 'overpaid', $4, $5, $6, $7, true, 'system')`,
      [
        binding,
        tenant,
        batch,
        sha256(Buffer.from(binding)),
        keyB,
        file!.content_sha256,
        file!.stored_sha256,
      ],
    );
    const rawPid = Number(
      (await raw.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
    );

    let settled = false;
    const stepTwo = W.httpFailure(returnCall(w, [w.siti], APP3, keyA)).finally(
      () => {
        settled = true;
      },
    );
    // A must be waiting on the raw transaction (not finished, not failed).
    let blocked = false;
    for (let i = 0; i < 100 && !blocked && !settled; i++) {
      blocked =
        Number(
          (
            await W.owner.query(
              `SELECT count(*)::int AS n FROM pg_stat_activity
                WHERE wait_event_type = 'Lock' AND $1 = ANY(pg_blocking_pids(pid))`,
              [rawPid],
            )
          ).rows[0].n,
        ) > 0;
      if (!blocked) await new Promise((r) => setTimeout(r, 50));
    }
    expect(blocked, "A's step two waits for B's hash lock").toBe(true);
    await raw.query("COMMIT");

    const error = await stepTwo;
    expect(error, "step two must be refused").not.toBeNull();
    expect(error!.status).toBe(409);
    expect(error!.code).toBe(REUSED);
    expect(error!.message).toBe(REUSED_TEXT);
    expect(await itemState(w.siti), "A's items unchanged").toEqual(itemBefore);
    expect(await W.countJournals(`payroll-payout-return:${w.siti}`)).toBe(0);
    trackedShas.push(...shas);
  });

  it("[900-half-finished-cross-tenant] A has an open historical return on P and B a historical return on P: sweeping A only leaves A's step two at 409 PENDING; sweeping B makes it 409 REUSED", async () => {
    const w = await paidBatch();
    const bytes = trackBytes(await pdf("setengah-jalan"));
    const keyA = trackKey(await uploadTo(w.batchId, bytes));
    await returnCall(w, [w.siti], APP, keyA); // step one, then turn it into history
    await makeReturnHistorical(keyA);
    const b = await tenantB(w.batchId);
    trackKey(await historicalClaimOfB(b, bytes));
    const itemBefore = await itemState(w.siti);

    await sweep();
    await sweep();
    expect(await bindingsOf(keyA), "premise: A's own history is bound").toBe(1);
    await expectRefusedService(
      returnCall(w, [w.siti], APP3, keyA),
      PENDING,
      "B is still unaccounted",
    );
    expect(await itemState(w.siti)).toEqual(itemBefore);

    await sweep(b.scope);
    await sweep(b.scope);
    await expectRefusedService(
      returnCall(w, [w.siti], APP3, keyA),
      REUSED,
      "B is accounted: the bytes are contested",
    );
    expect(await itemState(w.siti)).toEqual(itemBefore);
  });

  it("[900-history-pending-is-boolean-only] the app role gets one boolean column from app.payout_proof_history_pending() and still sees 0 rows of another tenant's stuck and binding tables", async () => {
    const w = await paidBatch();
    const b = await tenantB(w.batchId);
    const keyB = trackKey(await historicalClaimOfB(b, await pdf("bool-b")));
    // B's own stuck and binding rows (owner, guards off).
    await W.owner.query(
      `INSERT INTO ${STUCK} (tenant_id, batch_id, evidence_key, reason)
       VALUES ($1, $2, $3, 'unreadable')`,
      [b.tenant, b.batch, keyB],
    );

    const result = await withAppRole(async (client) => {
      const call = await client.query(
        "SELECT app.payout_proof_history_pending()",
      );
      return {
        columns: call.fields.map((f) => f.name),
        rows: call.rows.length,
        value: Object.values(call.rows[0] as Record<string, unknown>)[0],
        stuck: Number(
          (
            await client.query(
              `SELECT count(*) AS n FROM ${STUCK} WHERE tenant_id = $1`,
              [b.tenant],
            )
          ).rows[0].n,
        ),
        bindings: Number(
          (
            await client.query(
              `SELECT count(*) AS n FROM payroll_payout_proof_bindings WHERE tenant_id = $1`,
              [b.tenant],
            )
          ).rows[0].n,
        ),
      };
    });
    expect(result.columns, "one column, nothing else").toHaveLength(1);
    expect(result.rows).toBe(1);
    expect(result.value, "B's pending history is visible as true").toBe(true);
    expect(result.stuck).toBe(0);
    expect(result.bindings).toBe(0);

    const [meta] = await W.rowsOf(
      `SELECT p.prosecdef AS definer, p.provolatile AS volatility,
              has_function_privilege('legend_app', p.oid, 'EXECUTE') AS app_may,
              has_function_privilege('public', p.oid, 'EXECUTE') AS public_may
         FROM pg_proc p
        WHERE p.proname = 'payout_proof_history_pending'
          AND p.pronamespace = 'app'::regnamespace`,
    );
    expect(meta, "the function exists").toBeDefined();
    expect(meta).toEqual({
      definer: true,
      volatility: "s",
      app_may: true,
      public_may: false,
    });
  });

  it("[900-fresh-ops-leave-gate-clear] a new return, a new overpaid record (two items) and a new correction are accounted for at once: payout_proof_tenant_pending() is false and the SQL identity of every operation equals its binding", async () => {
    const { requester, first, second } = await trio("Fresh");
    const w = await world(requester, {
      failed: [BUDI, ANDI],
      retriesPaid: true,
    });
    const retKey = trackKey(
      await uploadTo(w.batchId, await pdf("segar-return")),
    );
    await returnCall(w, [w.siti], APP, retKey);
    await returnCall(w, [w.siti], APP3, retKey);
    const overKey = trackKey(
      await uploadTo(w.batchId, await pdf("segar-overpaid")),
    );
    expectOk(await overpaidCall(first, w, [w.budi, w.andi], overKey), "ov 1");
    expectOk(await overpaidCall(second, w, [w.budi, w.andi], overKey), "ov 2");
    const c = await world(requester, { failed: [BUDI] });
    const corrKey = trackKey(
      await uploadTo(c.batchId, await pdf("segar-koreksi")),
    );
    expectOk(await correctCall(first, c, [c.budi], corrKey), "corr 1");
    expectOk(await correctCall(second, c, [c.budi], corrKey), "corr 2");

    const [state] = await W.rowsOf(
      `SELECT app.payout_proof_tenant_pending() AS tenant_pending,
              app.payout_proof_history_pending() AS history_pending`,
    );
    expect(state).toEqual({ tenant_pending: false, history_pending: false });
    const [parity] = await W.rowsOf(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE NOT EXISTS (
                SELECT 1 FROM payroll_payout_proof_bindings b
                 WHERE b.tenant_id = $1 AND b.evidence_key = o.evidence_key
                   AND b.kind = o.kind AND b.item_set_hash = o.item_set_hash
              ))::int AS unmatched
         FROM app.payout_proof_operations() o
        WHERE o.evidence_key = ANY($2::text[])`,
      [W.tenantId, [retKey, overKey, corrKey]],
    );
    expect(parity!.total, "the three operations are listed").toBe(3);
    expect(parity!.unmatched, "SQL identity equals the TS identity").toBe(0);
  });
});

// =========================================================================
// F2: operations sharing one key
// =========================================================================

/** A recorded overpaid op over `key` that is then turned into history (no binding). */
async function historicalOverpaid(
  first: Approver,
  second: Approver,
  w: { batchId: string; andi: string },
  key: string,
) {
  expectOk(await overpaidCall(first, w, [w.andi], key), "overpaid 1");
  expectOk(await overpaidCall(second, w, [w.andi], key), "overpaid 2");
  await unbind(key);
}

describe("900 operations that share one key are all listed and the key is blocked (F2)", () => {
  it("[900-shared-key-all-listed] an open historical return and a recorded historical overpaid share key K: one stuck row (shared_key) with both identities, finance lists K, the return's step two is refused 409 REUSED with its items unchanged, and another key still works", async () => {
    const { requester, first, second } = await trio("Shared");
    const w = await world(requester, {
      failed: [BUDI, ANDI],
      retriesPaid: true,
    });
    const bytes = trackBytes(await pdf("kunci-bersama"));
    const key = trackKey(await uploadTo(w.batchId, bytes));
    await historicalOverpaid(first, second, w, key);
    // The return is the earliest identity.
    await legacyOpenReturn(w.batchId, w.siti, key, 100_000);
    const itemBefore = await itemState(w.siti);

    await sweep();
    await sweep();

    const stuck = await stuckRows(key);
    expect(stuck, "one stuck row for the key").toHaveLength(1);
    expect(stuck[0]!.reason).toBe("shared_key");
    const operations = stuck[0]!.operations as {
      kind: string;
      batch_id: string;
      item_set_hash: string;
    }[];
    expect(operations, "every identity is carried").toHaveLength(2);
    expect(operations.map((o) => o.kind).sort()).toEqual([
      "overpaid",
      "return",
    ]);
    for (const op of operations) {
      expect(op.batch_id).toBe(w.batchId);
      expect(op.item_set_hash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(await financeStuck(), "finance lists the key").toContain(key);

    await expectRefusedService(
      returnCall(w, [w.siti], APP3, key),
      REUSED,
      "step two of the return",
    );
    expect(await itemState(w.siti), "items unchanged").toEqual(itemBefore);

    // The gate itself stays clear: another key is not held.
    // (A fresh all-paid batch: in this one Budi and Andi failed and Siti is
    // the open return.)
    const c = await world(requester, { failed: [] });
    const other = trackKey(await uploadTo(c.batchId, await pdf("kunci-lain")));
    await returnCall(c, [c.budi], APP, other);
    expect(await claims(other)).toBe(1);
  });

  it("[900-shared-key-split-window] the same case when the window splits the two operations (limit 1: the return is bound by sweep one, the overpaid is found by sweep two): the key is still stuck as shared_key and contested", async () => {
    const { requester, first, second } = await trio("Split");
    const w = await world(requester, {
      failed: [BUDI, ANDI],
      retriesPaid: true,
    });
    const bytes = trackBytes(await pdf("kunci-terpisah"));
    const key = trackKey(await uploadTo(w.batchId, bytes));
    await historicalOverpaid(first, second, w, key);
    await legacyOpenReturn(w.batchId, w.siti, key, 100_000);
    const itemBefore = await itemState(w.siti);

    await backfillProofFingerprints(W.scope(), storage, new Date());
    const one = await bindHistoricalOperations(W.scope(), new Date(), {
      limit: 1,
    });
    expect(one.operations, "premise: sweep one looked at one operation").toBe(
      1,
    );
    await bindHistoricalOperations(W.scope(), new Date(), { limit: 1 });
    await bindHistoricalOperations(W.scope(), new Date(), { limit: 1 });

    const stuck = await stuckRows(key);
    expect(stuck, "one stuck row for the key").toHaveLength(1);
    expect(stuck[0]!.reason).toBe("shared_key");
    expect((stuck[0]!.operations as unknown[]).length).toBe(2);
    await expectRefusedService(
      returnCall(w, [w.siti], APP3, key),
      REUSED,
      "step two of the return",
    );
    expect(await itemState(w.siti)).toEqual(itemBefore);
  });
});
