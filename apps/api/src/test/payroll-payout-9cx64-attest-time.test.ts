// Payout 1175 card C (bead legend-9cx64). Written fail-first from the brief, NOT
// from the implementation of app.payout_attest or of the recon service.
//
// Rule proven here (founder: when in doubt hold the payment, but do not hold it
// for a false reason): an attestation is stamped AFTER the MFA proof it carries was
// read. If MFA is re-verified by a concurrent request after the attest statement
// started but before it read the session, the stored mfa_verified_at is newer than
// a statement-start attested_at. The night recon then reads this as `mfa_stale`
// and holds a slip that was attested correctly. attested_at must therefore be
// >= the mfa_verified_at stored with it.
//
// Deterministic race (no fixed sleeps, only a condition wait):
//   A: BEGIN; LOCK TABLE "session" ACCESS EXCLUSIVE        (holds the table)
//   B: the real app.payout_attest starts, its statement time is fixed, it blocks
//      on reading the session row
//   C: waits on pg_blocking_pids until B is blocked by A
//   A: UPDATE session SET mfa_verified_at = clock_timestamp(); COMMIT
//   B: continues, reads the new mfa_verified_at, stores the attestation
//
// Assumptions (the brief leaves them open, stated so they can be contested):
// - The real function is driven through its `propose` upsert: a real two-person
//   correction leaves a consumed grant and a propose attestation; the test calls
//   app.payout_attest again with the values of that row (ON CONFLICT DO UPDATE
//   overwrites attested_at and mfa_verified_at). The approval log has one row per
//   grant (UNIQUE), so the log row of that grant is removed first (owner, guards
//   off) to let the second call through. Nothing else is edited.
// - The recon names the reason `mfa_stale` (as the brief says); a control test
//   forges mfa_verified_at > attested_at and expects that flag, so the race test
//   cannot pass just because the recon never looks at this attestation.
// - The stored attested_at is compared with the stored mfa_verified_at in SQL
//   (>=), not in JS, to avoid millisecond rounding.
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { totpCode, totpStep } from "../lib/totp.ts";
import { correctFailedItems } from "../services/payroll-payout-correction.service.ts";
import { originHeader } from "./helpers.ts";
import {
  APP,
  APP3,
  BUDI,
  actorOf,
  bank,
  installPayoutWorld,
  uploadEvidence,
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("9cx64att");
const NET = 1_000_000;
const NOTE_ITEM = "Mutasi bank menunjukkan transfer ternyata berhasil";
const EXCEPTIONS = "payroll_payout_recon_exceptions";
const ATTESTATIONS = "payroll_payout_attestations";
const APPROVAL_LOG = "payroll_payout_approval_log";
const RECON_EXPORTS = [
  "reconcileTrustedPayouts",
  "runTrustedPayoutRecon",
  "runPayoutRecon",
  "reconcilePayoutTrustedBoundary",
  "reconcilePayoutTrusted",
  "runPayoutReconciliation",
];

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 5,
});
const enrolledUsers: string[] = [];

// ---- People (HTTP, TOTP enrolled in this very session) ----------------------------------

type Person = Awaited<ReturnType<typeof finance>>;
async function finance(label: string) {
  const { client, userId } = await W.signedInClient(`Attest9cx64 ${label}`);
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
  enrolledUsers.push(userId);
  const verified = await client
    .post("/api/auth/mfa/verify")
    .set(originHeader)
    .send({ factorId, code: totpCode(secretBase32, totpStep(new Date())) });
  expect(verified.status, JSON.stringify(verified.body)).toBe(200);
  return { client, userId };
}

let one: Person;
let two: Person;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  one = await finance("One");
  two = await finance("Two");
});

afterEach(async () => {
  await W.asTenant(async (c) => {
    await c.query(`DELETE FROM ${EXCEPTIONS} WHERE tenant_id = $1`, [
      W.tenantId,
    ]);
  }, true);
});

afterAll(async () => {
  if (enrolledUsers.length > 0)
    await owner.query(
      "DELETE FROM mfa_factors WHERE user_id = ANY($1::uuid[])",
      [enrolledUsers],
    );
  await owner.end();
});

// ---- The recon (single adapter, as in the 990 recon attest test) ------------------------

async function runRecon() {
  const mod =
    (await import("../services/payroll-payout-recon.service.ts")) as Record<
      string,
      unknown
    >;
  const name = RECON_EXPORTS.find((n) => typeof mod[n] === "function");
  expect(
    name,
    `payroll-payout-recon.service.ts must export the night run; it exports: ${Object.keys(mod).join(", ")}`,
  ).toBeDefined();
  const { storage } = W.proofs();
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

// ---- World: a corrected item (two people), the propose attestation is by `one` -----------

const itemOf = async (itemId: string) =>
  (
    await W.rowsOf(
      `SELECT status FROM payroll_disbursement_items WHERE tenant_id = $1 AND id = $2`,
      [W.tenantId, itemId],
    )
  )[0]!;

type World = { batchId: string; itemId: string };

async function correctedWorld() {
  const slips = [bank(BUDI, NET)];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const batchId = await W.exportedBatch(runId);
  const itemId = (await W.itemsOf(batchId))[0]!.id as string;
  await W.resolve(batchId, [itemId], "failed", APP);
  await W.resolve(batchId, [itemId], "failed", APP3);
  expect((await itemOf(itemId)).status, "premise: failed").toBe("failed");

  const w: World = { batchId, itemId };
  const key = uploadEvidence(batchId, `att-${randomUUID()}.pdf`);
  const correct = (who: Person) =>
    W.inTx((tx) =>
      correctFailedItems(
        tx,
        actorOf(who.userId),
        w.batchId,
        { itemIds: [w.itemId], evidenceKey: key, note: NOTE_ITEM },
        W.proofs(),
      ),
    );
  expect((await correct(one)).stage, "step 1").toBe("proposed");
  expect((await correct(two)).stage, "step 2").toBe("corrected");
  expect((await itemOf(itemId)).status, "premise: corrected").toBe("succeeded");
  return w;
}

const proposeAttestation = async (w: World) => {
  const rows = await W.rowsOf(
    `SELECT * FROM ${ATTESTATIONS}
      WHERE tenant_id = $1 AND kind = 'correction' AND step = 'propose'
        AND $2::uuid = ANY(item_ids)`,
    [W.tenantId, w.itemId],
  );
  expect(rows, "premise: one propose attestation for the item").toHaveLength(1);
  return rows[0]!;
};

const mfaReasons = async (itemId: string) =>
  (
    await W.rowsOf(
      `SELECT reason FROM ${EXCEPTIONS} WHERE tenant_id = $1 AND item_id = $2`,
      [W.tenantId, itemId],
    )
  )
    .map((r) => String(r.reason))
    .filter((reason) => reason.includes("mfa_stale"));

// ---- The race --------------------------------------------------------------------------

async function openTenantClient(): Promise<PoolClient> {
  const client = await owner.connect();
  await client.query("BEGIN");
  await client.query(
    "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
    [W.tenantId],
  );
  return client;
}

/**
 * Runs the real app.payout_attest (the propose upsert of `att`) while a
 * concurrent request re-verifies MFA after the statement started but before the
 * function read the session. Returns once both are committed.
 */
async function attestWithConcurrentMfaRefresh(att: Row) {
  // The approval log has one row per grant; the second call needs the first gone.
  await W.asTenant(
    (c) =>
      c.query(
        `DELETE FROM ${APPROVAL_LOG} WHERE tenant_id = $1 AND grant_id = $2`,
        [W.tenantId, att.grant_id],
      ),
    true,
  );

  const a = await openTenantClient(); // holds the session table
  const b = await openTenantClient(); // runs the attest
  const watcher = await owner.connect(); // observes
  let aOpen = true;
  try {
    await a.query("SET LOCAL lock_timeout = '20s'");
    await b.query("SET LOCAL lock_timeout = '20s'");
    const aPid = (await a.query("SELECT pg_backend_pid() AS pid")).rows[0]
      .pid as number;
    const bPid = (await b.query("SELECT pg_backend_pid() AS pid")).rows[0]
      .pid as number;
    await a.query(`LOCK TABLE "session" IN ACCESS EXCLUSIVE MODE`);

    const attest = b
      .query(
        `SELECT app.payout_attest($1::uuid, $2::text, $3::uuid, $4::text, $5::uuid,
                                  $6::uuid[], $7::varchar, $8::uuid, $9::uuid, $10::jsonb)`,
        [
          att.tenant_id,
          att.kind,
          att.operation_id,
          att.step,
          att.batch_id,
          att.item_ids,
          att.evidence_key,
          att.binding_id,
          att.grant_id,
          JSON.stringify(att.assertion ?? {}),
        ],
      )
      .then(
        () => ({ error: null as Error | null }),
        (error: Error) => ({ error }),
      );

    // Condition wait: B is blocked by A (the attest reached the session read).
    const deadline = Date.now() + 15_000;
    let blocked = false;
    while (!blocked && Date.now() < deadline) {
      const seen = await watcher.query(
        `SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND $2::int = ANY(pg_blocking_pids(pid))`,
        [bPid, aPid],
      );
      blocked = (seen.rowCount ?? 0) > 0;
      if (!blocked) await new Promise((r) => setTimeout(r, 10));
    }
    expect(blocked, "premise: the attest is waiting on the session table").toBe(
      true,
    );

    // The concurrent request: MFA re-verified now, after the attest statement began.
    const bumped = await a.query(
      `UPDATE "session" SET mfa_verified_at = clock_timestamp() WHERE id = $1`,
      [att.session_id],
    );
    expect(bumped.rowCount, "premise: the session of the attestation").toBe(1);
    await a.query("COMMIT");
    aOpen = false;

    const result = await attest;
    expect(result.error?.message, "the attest itself succeeds").toBe(undefined);
    await b.query("COMMIT");
  } finally {
    if (aOpen) await a.query("ROLLBACK").catch(() => undefined);
    a.release();
    await b.query("ROLLBACK").catch(() => undefined);
    b.release();
    watcher.release();
  }
}

// =========================================================================
// legend-9cx64
// =========================================================================

describe("1175 C: the attestation is stamped after the MFA proof it carries", () => {
  it("[legend-9cx64-attested-after-mfa] MFA re-verified while the attest waits: stored attested_at is not earlier than the stored mfa_verified_at", async () => {
    const w = await correctedWorld();
    const before = await proposeAttestation(w);

    await attestWithConcurrentMfaRefresh(before);

    const after = await proposeAttestation(w);
    const check = (
      await W.rowsOf(
        `SELECT (mfa_verified_at > $2::timestamptz) AS mfa_moved,
                (attested_at >= mfa_verified_at) AS attested_not_before_mfa
           FROM ${ATTESTATIONS} WHERE tenant_id = $1 AND id = $3`,
        [W.tenantId, before.mfa_verified_at, before.id],
      )
    )[0]!;
    expect(
      check.mfa_moved,
      "premise: the attest stored the MFA time of the concurrent re-verification",
    ).toBe(true);
    expect(after.id, "the same attestation row was updated").toBe(before.id);
    expect(
      check.attested_not_before_mfa,
      "attested_at must not be earlier than the mfa_verified_at stored with it",
    ).toBe(true);
  });

  it("[legend-9cx64-no-false-mfa-stale] the night recon does not flag mfa_stale for an attestation stamped after a concurrent MFA refresh", async () => {
    const w = await correctedWorld();
    const before = await proposeAttestation(w);

    await attestWithConcurrentMfaRefresh(before);

    await runRecon();
    expect(
      await mfaReasons(w.itemId),
      "no recon exception with reason mfa_stale for the item",
    ).toEqual([]);
  });

  it("[legend-9cx64-control-real-stale-still-flagged] control: an attestation whose MFA time is later than its attested_at (forged) is still flagged mfa_stale", async () => {
    const w = await correctedWorld();
    const att = await proposeAttestation(w);
    await W.asTenant(
      (c) =>
        c.query(
          `UPDATE ${ATTESTATIONS} SET mfa_verified_at = attested_at + interval '1 minute'
            WHERE tenant_id = $1 AND id = $2`,
          [W.tenantId, att.id],
        ),
      true,
    );

    await runRecon();
    const reasons = await mfaReasons(w.itemId);
    expect(
      reasons.length,
      "the recon still holds a slip whose MFA proof is newer than its attestation",
    ).toBeGreaterThan(0);
  });
});
