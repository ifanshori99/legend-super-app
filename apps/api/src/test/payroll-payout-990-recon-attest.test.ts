// Payout 990, cards C and D (beads legend-y2lk2, legend-r8nas;
// docs/briefs/sub-990-payout-lanjutan.md cards C and D, I4). Written fail-first
// from the brief and the CTO decisions, NOT from the implementation of the
// recon service.
//
// Rules proven here (founder: when in doubt hold the payment; a forged
// attestation must not open the key gate or hide a forged operation):
// - C. A proof closure (two people closed a stuck key) is checked by the night
//   recon: the `closure` attestations (propose and approve) must exist, match
//   proposed_by / closed_by and their sessions. A forged closure is flagged with
//   kind `closure` and holds the slip.
// - D. A batch that only has a `resolve` or `bank_confirm` operation is checked
//   too (before, only corrections, overpaid, returns and posting sources were).
//   A forged attestation there is flagged.
// - D. Grants are compared with what was attested: item_set_hash, detail
//   (resolve outcome) and ref_id. A mismatch is flagged `grant_mismatch`.
// - Legit flows are never flagged; the flags never touch another tenant.
//
// Assumptions (the brief leaves them open, stated so they can be contested):
// - Entry point and tampering are the ones of payroll-payout-905-recon.test.ts
//   (`reconcileTrustedPayouts(context, {storage, after})`, paged; tampering as
//   table owner with guards off, i.e. what a forger with write access could do).
// - A closure flag is attached to the item that holds a proposal over the closed
//   evidence key (recon_exceptions.item_id is NOT NULL; brief: "flag tiap item
//   yang memakai evidence key itu"). The legit control only looks at flags of
//   kind `closure`, so other recon reasons of the stuck-key fixture do not matter.
// - Reasons (from the CTO): `closure_actor_mismatch`, `closure_session_mismatch`
//   and `grant_mismatch`. For a missing closure attestation only the kind
//   `closure` is asserted (the reason name is not fixed).
// - A bank_confirm grant can only carry detail `succeeded` (CHECK), so detail is
//   forged on a resolve grant (failed -> not_sent).
// - The closed-key world is built as in payroll-payout-911-closure-swap: an open
//   correction proposal over key K, K stuck (raw), two people close it over HTTP.
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { totpCode, totpStep } from "../lib/totp.ts";
import { listFinanceExceptions } from "../services/accounting-finance-exceptions.service.ts";
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

const W = installPayoutWorld("990att");
const PASSWORD = "Test-password-123!";
const NET = 1_000_000;
const NOTE_ITEM = "Mutasi bank menunjukkan transfer ternyata berhasil";
const NOTE_CLOSE =
  "Bukti macet, file tidak bisa dibaca lagi, kasus ditutup permanen";
const PROOFS = "/api/hris/payroll/payout-proofs";
const EXCEPTIONS = "payroll_payout_recon_exceptions";
const ATTESTATIONS = "payroll_payout_attestations";
const GRANTS = "payroll_payout_grants";
const CLOSURES = "payroll_payout_proof_closures";
const STUCK = "payroll_payout_proof_backfill_stuck";
const RECON_EXPORTS = [
  "reconcileTrustedPayouts",
  "runTrustedPayoutRecon",
  "runPayoutRecon",
  "reconcilePayoutTrustedBoundary",
  "reconcilePayoutTrusted",
  "runPayoutReconciliation",
];

const mfaOwner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const enrolledUsers: string[] = [];
const closedKeys: string[] = [];

// ---- People (HTTP, TOTP enrolled in this very session) ----------------------------------

type Person = Awaited<ReturnType<typeof finance>>;
async function finance(label: string) {
  const { client, userId } = await W.signedInClient(`Attest990 ${label}`);
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

let one: Person; // proposes corrections and closures' items
let two: Person; // second correction step / proposes the closure
let three: Person; // approves the closure

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  one = await finance("One");
  two = await finance("Two");
  three = await finance("Three");
});

afterEach(async () => {
  await W.asTenant(async (c) => {
    await c.query(`DELETE FROM ${EXCEPTIONS} WHERE tenant_id = $1`, [
      W.tenantId,
    ]);
  }, true);
});

afterAll(async () => {
  const keys = closedKeys.splice(0);
  if (keys.length > 0)
    await W.asTenant(async (c) => {
      await c.query(
        `DELETE FROM ${CLOSURES} WHERE tenant_id = $1 AND evidence_key = ANY($2::text[])`,
        [W.tenantId, keys],
      );
      await c.query(
        `DELETE FROM ${STUCK} WHERE tenant_id = $1 AND evidence_key = ANY($2::text[])`,
        [W.tenantId, keys],
      );
    }, true);
  if (enrolledUsers.length > 0)
    await mfaOwner.query(
      "DELETE FROM mfa_factors WHERE user_id = ANY($1::uuid[])",
      [enrolledUsers],
    );
  await mfaOwner.end();
});

// ---- The recon (single adapter) ---------------------------------------------------------

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

// ---- Worlds ----------------------------------------------------------------------------

const itemOf = async (itemId: string) =>
  (
    await W.rowsOf(
      `SELECT status FROM payroll_disbursement_items WHERE tenant_id = $1 AND id = $2`,
      [W.tenantId, itemId],
    )
  )[0]!;

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

/** The only item was closed `failed` by two people (kind `resolve`, nothing else on the batch). */
async function failedWorld() {
  const w = await exportedBatch();
  await W.resolve(w.batchId, [w.itemId], "failed", APP);
  await W.resolve(w.batchId, [w.itemId], "failed", APP3);
  expect((await itemOf(w.itemId)).status, "premise: failed").toBe("failed");
  return w;
}

/** The only item was paid (kind `bank_confirm`, nothing else on the batch). */
async function confirmedWorld() {
  const w = await exportedBatch();
  await W.confirm(
    w.batchId,
    W.succeedItems(w.batchId, await W.itemsOf(w.batchId)),
  );
  expect((await itemOf(w.itemId)).status, "premise: succeeded").toBe(
    "succeeded",
  );
  return w;
}

type World = { batchId: string; itemId: string };
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

/** A corrected item (kind `correction`, two people): its grants carry a ref_id. */
async function correctedWorld() {
  const w = await failedWorld();
  const key = uploadEvidence(w.batchId, `att-${randomUUID()}.pdf`);
  expect((await correct(one, w, key)).stage, "step 1").toBe("proposed");
  expect((await correct(two, w, key)).stage, "step 2").toBe("corrected");
  expect((await itemOf(w.itemId)).status, "premise: corrected").toBe(
    "succeeded",
  );
  return { ...w, key };
}

type Res = {
  status: number;
  body: Row & { data?: Row; error?: { code?: string } };
};
const expectOk = (res: Res, label: string) =>
  expect([200, 201], `${label} ${JSON.stringify(res.body)}`).toContain(
    res.status,
  );

/** A stuck row as the fingerprint backfill leaves it (owner, guards off). */
async function stuck(batchId: string, key: string) {
  const sha = createHash("sha256")
    .update(`fixture proof ${W.tenantId}/${key}`)
    .digest("hex");
  await W.asTenant(async (c) => {
    await c.query(
      `INSERT INTO payroll_payout_evidence_files
         (tenant_id, batch_id, evidence_key, content_sha256, stored_sha256, created_by)
       VALUES ($1, $2, $3, $4, NULL, $5)
       ON CONFLICT (tenant_id, evidence_key) DO NOTHING`,
      [W.tenantId, batchId, key, sha, APP],
    );
    await c.query(
      `INSERT INTO ${STUCK} (tenant_id, batch_id, evidence_key, reason, attempts)
       VALUES ($1, $2, $3, 'shared_key', 3)`,
      [W.tenantId, batchId, key],
    );
  }, true);
}

/** Two people (propose, approve) close the stuck key for good; returns the closure id. */
async function closeKey(key: string) {
  const proposed = (await two.client
    .post(`${PROOFS}/closures`)
    .set(originHeader)
    .send({
      evidenceKey: key,
      note: NOTE_CLOSE,
      password: PASSWORD,
    })) as unknown as Res;
  expectOk(proposed, "closure propose");
  const closureId = proposed.body.data!.closureId as string;
  const approved = (await three.client
    .post(`${PROOFS}/closures/${closureId}/approve`)
    .set(originHeader)
    .send({ password: PASSWORD })) as unknown as Res;
  expectOk(approved, "closure approve");
  expect(approved.body.data, "premise: closed").toMatchObject({
    stage: "closed",
  });
  closedKeys.push(key);
  return closureId;
}

/** A failed slip with an open correction over K by `one`; K stuck and closed by two and three. */
async function closedWorld() {
  const w = await failedWorld();
  const key = uploadEvidence(w.batchId, `att-k-${randomUUID()}.pdf`);
  expect((await correct(one, w, key)).stage, "premise: proposal over K").toBe(
    "proposed",
  );
  await stuck(w.batchId, key);
  const closureId = await closeKey(key);
  return { ...w, key, closureId };
}

// ---- Observations ----------------------------------------------------------------------

const exceptionsOf = (itemId: string, kind?: string) =>
  W.rowsOf(
    `SELECT * FROM ${EXCEPTIONS}
      WHERE tenant_id = $1 AND item_id = $2 AND ($3::text IS NULL OR kind = $3)`,
    [W.tenantId, itemId, kind ?? null],
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

async function expectNotFlagged(itemId: string, label: string, kind?: string) {
  expect(
    await exceptionsOf(itemId, kind),
    `${label}: no recon exception`,
  ).toHaveLength(0);
  if (!kind)
    expect(
      await financeFlags(),
      `${label}: no finance exception`,
    ).not.toContain(itemId);
}
async function expectFlagged(
  itemId: string,
  label: string,
  expected: { kind?: string; reason?: string } = {},
) {
  const rows = await exceptionsOf(itemId, expected.kind);
  expect(
    rows.length,
    `${label}: recon exception row${expected.kind ? ` of kind ${expected.kind}` : ""} for the item`,
  ).toBeGreaterThan(0);
  if (expected.reason)
    expect(
      rows.some((r) => String(r.reason).includes(expected.reason!)),
      `${label}: reason ${expected.reason}; got ${JSON.stringify(rows.map((r) => r.reason))}`,
    ).toBe(true);
  expect(
    rows.every((r) => r.payslip_id !== null),
    `${label}: the flag carries the payslip, so the slip is held`,
  ).toBe(true);
  const shown = await financeFlags();
  expect(
    [itemId, ...rows.map((r) => r.operation_id as string)].some((id) =>
      shown.includes(id),
    ),
    `${label}: finance exception payout_recon_flag mentions the item or operation`,
  ).toBe(true);
}

// ---- Tampering (owner, guards off: the forger the recon exists for) ---------------------

const tamper = (run: (c: import("pg").PoolClient) => Promise<unknown>) =>
  W.asTenant(run, true);

const closureAttestations = `tenant_id = $1 AND kind = 'closure' AND (evidence_key = $2
  OR operation_id IN (SELECT id FROM ${CLOSURES} WHERE tenant_id = $1 AND evidence_key = $2))`;

const dropClosureAttestations = (key: string) =>
  tamper((c) =>
    c.query(`DELETE FROM ${ATTESTATIONS} WHERE ${closureAttestations}`, [
      W.tenantId,
      key,
    ]),
  );
const forgeClosureActor = (key: string) =>
  tamper((c) =>
    c.query(
      `UPDATE ${ATTESTATIONS} SET actor = $3 WHERE ${closureAttestations}`,
      [W.tenantId, key, randomUUID()],
    ),
  );
const forgeClosureSession = (key: string) =>
  tamper((c) =>
    c.query(
      `UPDATE ${ATTESTATIONS} SET session_id = $3 WHERE ${closureAttestations}`,
      [W.tenantId, key, `forged-session-${randomUUID()}`],
    ),
  );
const dropSecondAttestation = (itemId: string, kind: string) =>
  tamper((c) =>
    c.query(
      `DELETE FROM ${ATTESTATIONS}
        WHERE tenant_id = $1 AND kind = $3 AND $2::uuid = ANY(item_ids)
          AND attested_at > (SELECT min(attested_at) FROM ${ATTESTATIONS}
                              WHERE tenant_id = $1 AND kind = $3 AND $2::uuid = ANY(item_ids))`,
      [W.tenantId, itemId, kind],
    ),
  );
const sameSession = (itemId: string, kind: string) =>
  tamper((c) =>
    c.query(
      `UPDATE ${ATTESTATIONS} SET session_id =
         (SELECT session_id FROM ${ATTESTATIONS}
           WHERE tenant_id = $1 AND kind = $3 AND $2::uuid = ANY(item_ids)
           ORDER BY attested_at LIMIT 1)
        WHERE tenant_id = $1 AND kind = $3 AND $2::uuid = ANY(item_ids)`,
      [W.tenantId, itemId, kind],
    ),
  );
const forgeAttestationSession = (itemId: string, kind: string) =>
  tamper((c) =>
    c.query(
      `UPDATE ${ATTESTATIONS} SET session_id = $3
        WHERE tenant_id = $1 AND kind = $4 AND $2::uuid = ANY(item_ids)`,
      [W.tenantId, itemId, `forged-session-${randomUUID()}`, kind],
    ),
  );
/** Changes one column of every grant that an attestation of the item was made under. */
const forgeGrants = (itemId: string, set: string, params: unknown[] = []) =>
  tamper(async (c) => {
    const res = await c.query(
      `UPDATE ${GRANTS} SET ${set}
        WHERE tenant_id = $1 AND id IN (
          SELECT grant_id FROM ${ATTESTATIONS}
           WHERE tenant_id = $1 AND $2::uuid = ANY(item_ids) AND grant_id IS NOT NULL)`,
      [W.tenantId, itemId, ...params],
    );
    expect(
      res.rowCount,
      "premise: the item's attestations have grants",
    ).toBeGreaterThan(0);
  });

// =========================================================================
// C: proof closures
// =========================================================================

describe("990 C recon: a proof closure is checked", () => {
  it("[legend-y2lk2-closure-legit] two people closing a stuck key: the night run flags no closure", async () => {
    const w = await closedWorld();
    await runRecon();
    await expectNotFlagged(w.itemId, "legit closure", "closure");
  });

  it("[legend-y2lk2-closure-no-attestation] a closure without its closure attestations is flagged kind closure", async () => {
    const w = await closedWorld();
    await runRecon();
    await expectNotFlagged(w.itemId, "control before the forgery", "closure");

    await dropClosureAttestations(w.key);
    await runRecon();
    await expectFlagged(w.itemId, "closure without attestation", {
      kind: "closure",
    });
  });

  it("[legend-y2lk2-closure-actor-mismatch] closure attestations by another actor than proposed_by / closed_by: flagged closure_actor_mismatch", async () => {
    const w = await closedWorld();
    await runRecon();
    await expectNotFlagged(w.itemId, "control before the forgery", "closure");

    await forgeClosureActor(w.key);
    await runRecon();
    await expectFlagged(w.itemId, "closure actor mismatch", {
      kind: "closure",
      reason: "closure_actor_mismatch",
    });
  });

  it("[legend-y2lk2-closure-session-mismatch] closure attestations from another session than the closure rows: flagged closure_session_mismatch", async () => {
    const w = await closedWorld();
    await runRecon();
    await expectNotFlagged(w.itemId, "control before the forgery", "closure");

    await forgeClosureSession(w.key);
    await runRecon();
    await expectFlagged(w.itemId, "closure session mismatch", {
      kind: "closure",
      reason: "closure_session_mismatch",
    });
  });
});

// =========================================================================
// D: batches with only a resolve or a bank_confirm
// =========================================================================

describe("990 D recon: resolve-only and bank_confirm-only batches are checked", () => {
  it("[legend-r8nas-legit-operations] a resolve (two people), a bank confirmation and a correction, all legit: nothing is flagged", async () => {
    const resolved = await failedWorld();
    const confirmed = await confirmedWorld();
    const corrected = await correctedWorld();
    await runRecon();
    await expectNotFlagged(resolved.itemId, "resolve only");
    await expectNotFlagged(confirmed.itemId, "bank_confirm only");
    await expectNotFlagged(corrected.itemId, "correction");
  });

  it("[legend-r8nas-resolve-missing-step] a resolve with only one attestation left: flagged", async () => {
    const w = await failedWorld();
    expect(
      (await attestationsOf(w.itemId)).filter((a) => a.kind === "resolve")
        .length,
      "premise: two resolve attestations",
    ).toBeGreaterThanOrEqual(2);
    await runRecon();
    await expectNotFlagged(w.itemId, "control before the forgery");

    await dropSecondAttestation(w.itemId, "resolve");
    await runRecon();
    await expectFlagged(w.itemId, "resolve with one attestation");
  });

  it("[legend-r8nas-resolve-same-session] a resolve whose two attestations share one session: flagged", async () => {
    const w = await failedWorld();
    await runRecon();
    await expectNotFlagged(w.itemId, "control before the forgery");

    await sameSession(w.itemId, "resolve");
    const sessions = new Set(
      (await attestationsOf(w.itemId))
        .filter((a) => a.kind === "resolve")
        .map((a) => a.session_id),
    );
    expect(sessions.size, "premise: one session").toBe(1);
    await runRecon();
    await expectFlagged(w.itemId, "resolve same session");
  });

  it("[legend-r8nas-bank-confirm-forged-session] a bank confirmation whose attestation names another session than its grant: flagged", async () => {
    const w = await confirmedWorld();
    expect(
      (await attestationsOf(w.itemId)).some((a) => a.kind === "bank_confirm"),
      "premise: a bank_confirm attestation",
    ).toBe(true);
    await runRecon();
    await expectNotFlagged(w.itemId, "control before the forgery");

    await forgeAttestationSession(w.itemId, "bank_confirm");
    await runRecon();
    await expectFlagged(w.itemId, "bank_confirm forged session");
  });
});

// =========================================================================
// D: grants against attestations
// =========================================================================

describe("990 D recon: the grant must match what was attested", () => {
  it("[legend-r8nas-grant-item-set-hash-resolve] a resolve grant for another item set: flagged grant_mismatch", async () => {
    const w = await failedWorld();
    await runRecon();
    await expectNotFlagged(w.itemId, "control before the forgery");

    await forgeGrants(w.itemId, "item_set_hash = repeat('0', 64)");
    await runRecon();
    await expectFlagged(w.itemId, "grant item_set_hash (resolve)", {
      reason: "grant_mismatch",
    });
  });

  it("[legend-r8nas-grant-item-set-hash-bank-confirm] a bank_confirm grant for another item set: flagged grant_mismatch", async () => {
    const w = await confirmedWorld();
    await runRecon();
    await expectNotFlagged(w.itemId, "control before the forgery");

    await forgeGrants(w.itemId, "item_set_hash = repeat('0', 64)");
    await runRecon();
    await expectFlagged(w.itemId, "grant item_set_hash (bank_confirm)", {
      reason: "grant_mismatch",
    });
  });

  it("[legend-r8nas-grant-detail] a resolve grant for outcome not_sent while the item was resolved failed: flagged grant_mismatch", async () => {
    const w = await failedWorld();
    await runRecon();
    await expectNotFlagged(w.itemId, "control before the forgery");

    await forgeGrants(w.itemId, "detail = 'not_sent'");
    await runRecon();
    await expectFlagged(w.itemId, "grant detail", { reason: "grant_mismatch" });
  });

  it("[legend-r8nas-grant-ref-id] the grants of a correction point at another operation (ref_id): flagged grant_mismatch", async () => {
    const w = await correctedWorld();
    await runRecon();
    await expectNotFlagged(w.itemId, "control before the forgery");

    // Only the grants of the correction; the resolve grants of the same item stay.
    await tamper(async (c) => {
      const res = await c.query(
        `UPDATE ${GRANTS} SET ref_id = gen_random_uuid()
          WHERE tenant_id = $1 AND id IN (
            SELECT grant_id FROM ${ATTESTATIONS}
             WHERE tenant_id = $1 AND kind = 'correction'
               AND $2::uuid = ANY(item_ids) AND grant_id IS NOT NULL)`,
        [W.tenantId, w.itemId],
      );
      expect(res.rowCount, "premise: correction grants exist").toBeGreaterThan(
        0,
      );
    });
    await runRecon();
    await expectFlagged(w.itemId, "grant ref_id", { reason: "grant_mismatch" });
  });
});

// =========================================================================
// Other tenants are never touched
// =========================================================================

describe("990 C/D recon: the flags stay inside the tenant", () => {
  it("[legend-y2lk2-other-tenant] another tenant holds a forged closure over the same evidence key: our legit closure is not flagged, the other tenant gets no flag, and our own forgery is flagged only in our tenant", async () => {
    const w = await closedWorld();
    const other = randomUUID();
    const client = await W.owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
         SELECT $1, $2, 'PT B 990', plan, status, deployment_mode, feature_flags, limits, created_by
           FROM tenants WHERE id = $3`,
        [other, `pt-b-990-${other}`, W.tenantId],
      );
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        `INSERT INTO ${CLOSURES}
           (tenant_id, evidence_key, note, proposed_by, proposed_session_id,
            closed_by, closed_session_id, closed_at)
         VALUES ($1, $2, $3, $4, 'forged-a', $5, 'forged-b', now())`,
        [other, w.key, NOTE_CLOSE, randomUUID(), randomUUID()],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    try {
      const flagsOfOther = async () =>
        Number(
          (
            await W.owner.query(
              `SELECT count(*)::int AS n FROM ${EXCEPTIONS} WHERE tenant_id = $1`,
              [other],
            )
          ).rows[0].n,
        );

      await runRecon();
      await expectNotFlagged(
        w.itemId,
        "our legit closure next to a forged copy elsewhere",
        "closure",
      );
      expect(await flagsOfOther(), "the other tenant got no flag").toBe(0);

      await dropClosureAttestations(w.key);
      await runRecon();
      await expectFlagged(w.itemId, "our forged closure", { kind: "closure" });
      expect(await flagsOfOther(), "still no flag in the other tenant").toBe(0);
      expect(
        (
          await W.owner.query(
            `SELECT count(*)::int AS n FROM ${CLOSURES} WHERE tenant_id = $1`,
            [other],
          )
        ).rows[0].n,
        "the other tenant's closure was not touched",
      ).toBe(1);
    } finally {
      const cleanup = await W.owner.connect();
      try {
        await cleanup.query("BEGIN");
        await cleanup.query("SET LOCAL session_replication_role = replica");
        await cleanup.query(`DELETE FROM ${EXCEPTIONS} WHERE tenant_id = $1`, [
          other,
        ]);
        await cleanup.query(`DELETE FROM ${CLOSURES} WHERE tenant_id = $1`, [
          other,
        ]);
        await cleanup.query(`DELETE FROM tenants WHERE id = $1`, [other]);
        await cleanup.query("COMMIT");
      } catch {
        await cleanup.query("ROLLBACK").catch(() => undefined);
      } finally {
        cleanup.release();
      }
    }
  });
});
