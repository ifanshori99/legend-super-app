// Payout 905 card 1 (bead legend-i01jp; docs/briefs/905/brief.md, second-opinion
// finding "Role aplikasi dapat memalsukan koreksi dan melewati jurnal" in
// docs/briefs/905/so-888-891.md, and the contest_own note of so-900). Written
// fail-first from the brief and the findings, not from the implementation.
// Everything adversarial runs as the app role (`SET LOCAL ROLE legend_app`) with
// a REAL commit, so the database boundary is what is proven, not the service.
//
// Rules proven here (founder: nobody is paid without money moving, the GL
// matches what moved, one PT cannot block another):
// - The app role has no INSERT/UPDATE on the correction, overpaid-proposal,
//   return-claim and proof-binding tables, and no UPDATE of an item's
//   `status` or `confirmed_*` columns: every statement on the four tables, and
//   every write to the item return_* columns, fails 42501; an UPDATE of an
//   item's `status` or `confirmed_*` (columns legend_app may still name, as
//   the legacy resolve/export paths move non-final items) fails 23514 from
//   the item guard on a failed item.
//   The app role can still READ the rows (the screens list them).
// - The forged sequence of the finding (INSERT a proposal by an invented
//   proposer, UPDATE it to corrected by an invented approver, set the
//   self-set GUC app.payout_correction=on, flip the failed item to
//   succeeded with matching proof fields) is refused as a whole: after the
//   commit attempt the item is still `failed` with no confirmation fields, no
//   correction row exists, no posting and no journal appeared.
// - The status moves belong to SECURITY DEFINER functions owned by a new,
//   NOLOGIN, non-superuser payout role that the app role cannot assume.
// - app.payout_proof_contest_own does not trust the tenant setting of the app
//   role: asked (with the self-set tenant GUC of the victim, or of a stranger)
//   about a sound key, it contests nothing, so another PT's proof bytes are
//   never blocked by it.
//
// Assumptions (the brief does not pin these down, stated so they can be contested):
// - The payout role is recognisable by "payout" in its name (rolname ~ 'payout'),
//   is NOLOGIN, not superuser, owns at least one SECURITY DEFINER function in
//   schema `app`, and legend_app is not allowed to SET ROLE to it (checked from
//   a session whose session user is legend_app: a superuser session user
//   could SET ROLE to anything, so it proves nothing).
// - A refusal of the forged sequence may be any database error (42501 on the
//   first DML, or a guard code); the proof is the unchanged state afterwards.
// - A refused contest_own may raise or silently do nothing; the proof is that no
//   hash of the sound binding lands in payroll_payout_proof_hash_contests.
// - Item columns refused to the app role: status, confirmed_by,
//   confirmation_ref, confirmation_evidence_key (brief: "status/confirmed_*").
//   Other item columns (returned_by, resolved_*, ...) are not asserted here.
// - Not covered here (names are not in the brief/contract): the nightly
//   reconciliation worker job; add when its job name and exception kind are fixed.
// - The legitimate paths keep working through the functions; that is proven by
//   the existing suites (891 correction, 888 overpaid, 870 return, 900 gate),
//   which must stay green.
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
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("905tb");
const NET = 1_000_000;
const PRIVILEGE = "42501";
const GUARD = "23514";
const hex = () => randomBytes(32).toString("hex");

const batchIds: string[] = [];
const contestedHashes: string[] = [];

// ---- legend_app helpers --------------------------------------------------------------

/** A legend_app transaction with a real COMMIT; first error (statement or commit), if any. */
async function appTx(
  work: (client: PoolClient) => Promise<void>,
  tenant: string = W.tenantId,
) {
  const client = await W.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant],
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

/** One statement as legend_app, always rolled back; the error code, or undefined when it ran. */
async function appStatement(sql: string, params: unknown[] = []) {
  const client = await W.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [W.tenantId],
    );
    try {
      await client.query(sql, params);
      return undefined as string | undefined;
    } catch (error) {
      return (error as { code?: string }).code ?? "unknown";
    }
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
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
  const item = (await W.itemsOf(batchId))[0]!;
  expect(item.status, "premise: the item is failed").toBe("failed");
  return { runId, batchId, itemId };
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
const trailOf = async (batchId: string) => ({
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

/** Removes what a (wrongly) accepted forgery or a setup row could leave behind; the owner, guards off. */
async function cleanBatches(ids: string[]) {
  if (ids.length === 0) return;
  await W.asTenant(async (c) => {
    await c.query(
      `DELETE FROM payroll_payout_proof_hashes
        WHERE binding_id IN (SELECT id FROM payroll_payout_proof_bindings
                              WHERE tenant_id = $1 AND batch_id = ANY($2))`,
      [W.tenantId, ids],
    );
    for (const table of [
      "payroll_payout_proof_bindings",
      "payroll_payout_failed_corrections",
      "payroll_payout_overpaid_proposals",
    ])
      await c.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND batch_id = ANY($2)`,
        [W.tenantId, ids],
      );
    await c.query(
      `UPDATE payroll_disbursement_items SET return_claim_id = NULL
        WHERE tenant_id = $1 AND batch_id = ANY($2)`,
      [W.tenantId, ids],
    );
    await c.query(
      `DELETE FROM payroll_payout_return_claims WHERE tenant_id = $1 AND batch_id = ANY($2)`,
      [W.tenantId, ids],
    );
  }, true);
}

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

// Registered after the world's own hook: runs first (stack order), so rows that
// reference the batches are gone before the world deletes the batches.
afterAll(async () => {
  await cleanBatches(batchIds);
  if (contestedHashes.length > 0)
    await W.owner.query(
      "DELETE FROM payroll_payout_proof_hash_contests WHERE sha256 = ANY($1)",
      [contestedHashes],
    );
});

// =========================================================================
// 1. the app role has no write on the trusted tables
// =========================================================================

describe("905 the app role cannot write the trusted payout tables", () => {
  it("[905-app-role-no-dml] INSERT and UPDATE on corrections, overpaid proposals, return claims and proof bindings, and UPDATE of item status and confirmed_*, fail 42501 for legend_app", async () => {
    const { batchId, itemId } = await failedBatch();
    const key = evidenceKeyFor(W.tenantId, batchId, "905-direct.pdf");
    const id = randomUUID();
    const statements: {
      name: string;
      sql: string;
      params: unknown[];
      code?: string;
    }[] = [
      {
        name: "INSERT correction",
        sql: `INSERT INTO payroll_payout_failed_corrections
                (id, tenant_id, batch_id, item_id, operation_id, evidence_key,
                 content_sha256, stored_sha256, note, status, proposed_by)
              VALUES ($1, $2, $3, $4, $1, $5, $6, $6, 'catatan', 'proposed', 'forged-one')`,
        params: [id, W.tenantId, batchId, itemId, key, hex()],
      },
      {
        name: "UPDATE correction",
        sql: `UPDATE payroll_payout_failed_corrections
                 SET status = 'corrected', corrected_by = 'forged-two', corrected_at = now()
               WHERE tenant_id = $1`,
        params: [W.tenantId],
      },
      {
        name: "INSERT overpaid proposal",
        sql: `INSERT INTO payroll_payout_overpaid_proposals
                (tenant_id, batch_id, item_id, evidence_key, note, proposed_by)
              VALUES ($1, $2, $3, $4, 'catatan', 'forged-one')`,
        params: [W.tenantId, batchId, itemId, key],
      },
      {
        name: "UPDATE overpaid proposal",
        sql: `UPDATE payroll_payout_overpaid_proposals
                 SET status = 'recorded', recorded_by = 'forged-two', recorded_at = now()
               WHERE tenant_id = $1`,
        params: [W.tenantId],
      },
      {
        name: "INSERT return claim",
        sql: `INSERT INTO payroll_payout_return_claims
                (tenant_id, batch_id, evidence_key, item_set_hash, created_by)
              VALUES ($1, $2, $3, $4, 'forged-one')`,
        params: [W.tenantId, batchId, key, hex()],
      },
      {
        name: "UPDATE return claim",
        sql: `UPDATE payroll_payout_return_claims
                 SET status = 'consumed', consumed_at = now()
               WHERE tenant_id = $1`,
        params: [W.tenantId],
      },
      {
        name: "INSERT proof binding",
        sql: `INSERT INTO payroll_payout_proof_bindings
                (tenant_id, batch_id, kind, item_set_hash, evidence_key,
                 content_sha256, stored_sha256, created_by)
              VALUES ($1, $2, 'correction', $3, $4, $5, $6, 'forged-one')`,
        params: [W.tenantId, batchId, hex(), key, hex(), hex()],
      },
      {
        name: "UPDATE item status",
        code: GUARD,
        sql: `UPDATE payroll_disbursement_items SET status = 'succeeded' WHERE tenant_id = $1 AND id = $2`,
        params: [W.tenantId, itemId],
      },
      {
        name: "UPDATE item confirmed_by",
        code: GUARD,
        sql: `UPDATE payroll_disbursement_items SET confirmed_by = 'forged' WHERE tenant_id = $1 AND id = $2`,
        params: [W.tenantId, itemId],
      },
      {
        name: "UPDATE item confirmation_ref",
        code: GUARD,
        sql: `UPDATE payroll_disbursement_items SET confirmation_ref = 'FORGED' WHERE tenant_id = $1 AND id = $2`,
        params: [W.tenantId, itemId],
      },
      {
        name: "UPDATE item confirmation_evidence_key",
        code: GUARD,
        sql: `UPDATE payroll_disbursement_items SET confirmation_evidence_key = $3 WHERE tenant_id = $1 AND id = $2`,
        params: [W.tenantId, itemId, key],
      },
      {
        name: "UPDATE item returned_by",
        sql: `UPDATE payroll_disbursement_items SET returned_by = 'forged' WHERE tenant_id = $1 AND id = $2`,
        params: [W.tenantId, itemId],
      },
      {
        name: "UPDATE item return_claim_id",
        sql: `UPDATE payroll_disbursement_items SET return_claim_id = $3 WHERE tenant_id = $1 AND id = $2`,
        params: [W.tenantId, itemId, randomUUID()],
      },
    ];
    const outcome: Record<string, string | undefined> = {};
    for (const s of statements)
      outcome[s.name] = await appStatement(s.sql, s.params);
    const expected = Object.fromEntries(
      statements.map((s) => [s.name, s.code ?? PRIVILEGE]),
    );
    expect(outcome).toEqual(expected);
    expect((await itemRow(itemId)).status).toBe("failed");
  });

  it("[905-app-role-still-reads] legend_app can still read corrections, proposals, claims and items of its tenant (screens list them)", async () => {
    const { batchId } = await failedBatch();
    const read = await appTx(async (c) => {
      for (const table of [
        "payroll_payout_failed_corrections",
        "payroll_payout_overpaid_proposals",
        "payroll_payout_return_claims",
        "payroll_payout_proof_bindings",
        "payroll_disbursement_items",
      ])
        await c.query(
          `SELECT count(*) FROM ${table} WHERE tenant_id = $1 AND batch_id = $2`,
          [W.tenantId, batchId],
        );
    });
    expect(read.code, read.message).toBeUndefined();
  });
});

// =========================================================================
// 2. the forged sequence of the finding
// =========================================================================

describe("905 the forged correction sequence is refused atomically", () => {
  it("[905-forged-sequence-refused] proposal by an invented proposer, corrected by an invented approver, app.payout_correction=on, then failed -> succeeded with matching proof fields, in one legend_app transaction: refused; item, corrections, postings and journals unchanged", async () => {
    const { batchId, itemId } = await failedBatch();
    const before = await trailOf(batchId);
    // A key whose object was never stored: the real path checks the stored proof.
    const key = evidenceKeyFor(W.tenantId, batchId, "905-never-stored.pdf");
    const correctionId = randomUUID();
    const sha = hex();

    const attempt = await appTx(async (c) => {
      await c.query(
        `INSERT INTO payroll_payout_failed_corrections
           (id, tenant_id, batch_id, item_id, operation_id, evidence_key,
            content_sha256, stored_sha256, note, status, proposed_by)
         VALUES ($1, $2, $3, $4, $1, $5, $6, $6, 'catatan', 'proposed', 'forged-one')`,
        [correctionId, W.tenantId, batchId, itemId, key, sha],
      );
      await c.query(
        `UPDATE payroll_payout_failed_corrections
            SET status = 'corrected', corrected_by = 'forged-two', corrected_at = now()
          WHERE id = $1`,
        [correctionId],
      );
      await c.query("SELECT set_config('app.payout_correction', 'on', true)");
      await c.query(
        `UPDATE payroll_disbursement_items
            SET status = 'succeeded', settled_at = now(),
                confirmed_by = 'forged-two', confirmation_ref = 'FORGED-REF',
                confirmation_evidence_key = $3
          WHERE tenant_id = $1 AND id = $2`,
        [W.tenantId, itemId, key],
      );
    });

    expect(
      attempt.code,
      "the forged sequence must be refused (statement or commit)",
    ).toBeDefined();
    const item = await itemRow(itemId);
    expect(item.status, "the slip must not look paid").toBe("failed");
    expect(item.settled_at).toBeNull();
    expect(item.confirmed_by).toBeNull();
    expect(item.confirmation_ref).toBeNull();
    expect(item.confirmation_evidence_key).toBeNull();
    expect(await trailOf(batchId), "no correction, posting or journal").toEqual(
      before,
    );
    expect(before.corrections).toBe(0);
  });

  it("[905-forged-sequence-no-guc] the flip alone, with the self-set GUC and no correction row, is refused too and the item stays failed", async () => {
    const { batchId, itemId } = await failedBatch();
    const before = await trailOf(batchId);
    const attempt = await appTx(async (c) => {
      await c.query("SELECT set_config('app.payout_correction', 'on', true)");
      await c.query(
        `UPDATE payroll_disbursement_items
            SET status = 'succeeded', settled_at = now(),
                confirmed_by = 'forged', confirmation_ref = 'FORGED-REF'
          WHERE tenant_id = $1 AND id = $2`,
        [W.tenantId, itemId],
      );
    });
    expect(attempt.code, "refused").toBeDefined();
    expect((await itemRow(itemId)).status).toBe("failed");
    expect(await trailOf(batchId)).toEqual(before);
  });
});

// =========================================================================
// 3. the trusted role
// =========================================================================

describe("905 the status moves belong to a NOLOGIN payout role", () => {
  it("[905-payout-role] a NOLOGIN non-superuser payout role owns SECURITY DEFINER functions in schema app, and legend_app cannot assume it", async () => {
    const owners = (await W.rowsOf(
      `SELECT r.rolname, r.rolcanlogin, r.rolsuper,
              count(p.oid)::int AS definer_functions
         FROM pg_roles r
         JOIN pg_proc p ON p.proowner = r.oid AND p.prosecdef
         JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'app'
        WHERE r.rolname ~ 'payout'
        GROUP BY r.rolname, r.rolcanlogin, r.rolsuper`,
    )) as Row[];
    const trusted = owners.filter((r) => !r.rolcanlogin && !r.rolsuper);
    expect(
      trusted.length,
      `a NOLOGIN, non-superuser payout role must own definer functions (found: ${JSON.stringify(owners)})`,
    ).toBeGreaterThan(0);
    const name = trusted[0]!.rolname as string;
    // SET ROLE is checked against the SESSION user. The test pool is a
    // superuser and could become anyone, so the session user is made
    // legend_app (a non-superuser) first, as in production.
    const client = await W.owner.connect();
    let code: string | undefined;
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL SESSION AUTHORIZATION legend_app");
      try {
        await client.query(`SET LOCAL ROLE "${name}"`);
      } catch (error) {
        code = (error as { code?: string }).code ?? "unknown";
      }
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    expect(code, "legend_app must not be able to become the payout role").toBe(
      PRIVILEGE,
    );
  });
});

// =========================================================================
// 4. contest_own does not trust the tenant setting of the app role
// =========================================================================

describe("905 contest_own cannot block another PT's proof", () => {
  /** A sound binding of the fixture tenant (the victim PT), made by the owner with guards off. */
  async function soundBinding(batchId: string) {
    const key = evidenceKeyFor(
      W.tenantId,
      batchId,
      `905-sound-${randomUUID()}.pdf`,
    );
    const content = hex();
    const stored = hex();
    contestedHashes.push(content, stored);
    await W.asTenant(
      (c) =>
        c.query(
          `INSERT INTO payroll_payout_proof_bindings
             (tenant_id, batch_id, kind, item_set_hash, evidence_key,
              content_sha256, stored_sha256, created_by)
           VALUES ($1, $2, 'correction', $3, $4, $5, $6, 'sound-905')`,
          [W.tenantId, batchId, hex(), key, content, stored],
        ),
      true,
    );
    return { key, content, stored };
  }
  const contestedRows = (hashes: string[]) =>
    count(
      `SELECT count(*)::int AS n FROM payroll_payout_proof_hash_contests WHERE sha256 = ANY($1)`,
      [hashes],
    );

  it("[905-contest-own-spoofed-tenant] the app role sets the victim's tenant itself and asks to contest the victim's sound, unshared key: nothing is contested", async () => {
    const { batchId } = await failedBatch();
    const sound = await soundBinding(batchId);
    await appTx(async (c) => {
      await c.query("SELECT app.payout_proof_contest_own($1)", [sound.key]);
    });
    expect(
      await contestedRows([sound.content, sound.stored]),
      "the victim's proof bytes must stay usable",
    ).toBe(0);
    const gate = await W.rowsOf(
      `SELECT app.payout_proof_contested($1::varchar[]) AS contested`,
      [[sound.content, sound.stored]],
    );
    expect(gate[0]!.contested).toBe(false);
  });

  it("[905-contest-own-stranger-tenant] a session claiming another (stranger) tenant cannot contest the victim's key either", async () => {
    const { batchId } = await failedBatch();
    const sound = await soundBinding(batchId);
    await appTx(async (c) => {
      await c.query("SELECT app.payout_proof_contest_own($1)", [sound.key]);
    }, randomUUID());
    expect(await contestedRows([sound.content, sound.stored])).toBe(0);
  });
});
