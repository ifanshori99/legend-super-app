// Payout 1005 (bead legend-snwnn), recon side: the night recon must understand a
// return-claim withdrawal and must catch a forged one. Written fail-first from
// docs/briefs/1005/design.md ("Recon", "Test" item 6), NOT from the
// implementation. The two-person flow itself is proven in
// payroll-payout-1005-return-withdraw.test.ts.
//
// Rules proven (founder: when in doubt hold the payment; a forged record must
// not pass quietly; a legit flow is never flagged):
// - A withdrawal proposed or approved the legit way, an untouched open claim, and
//   a claim withdrawn and later filed again and confirmed are NOT flagged.
// - An approved withdrawal whose attestations were deleted or forged (missing
//   approve step, same session for both steps, a forged session, a grant that
//   was removed), an approved withdrawal written without attestation, a claim
//   `withdrawn` without an approved withdrawal, and an item whose return columns
//   were emptied without a withdrawn claim are flagged.
//
// Assumptions (the design leaves them open, stated so they can be contested):
// - Entry point is `reconcileTrustedPayouts(context, {storage, after})`, paged,
//   as the 905/915/990 recon tests use it.
// - Tampering is done as the table owner with `session_replication_role =
//   replica` (guards off): what a forger with write access could do.
// - Withdrawal attestations are rows of payroll_payout_attestations with kind
//   `return_withdraw`, operation_id = the withdrawal id, steps `propose` and
//   `approve` (design "Attestasi"), with session_id and grant_id.
// - A flag is a payroll_payout_recon_exceptions row on an item of the claim
//   (item_id is NOT NULL). For the three withdrawal forgeries the kind is
//   `return_withdraw` (migration 0616 adds it); for the emptied-columns forgery
//   only "some flag on the item" is asserted, because the design leaves the kind
//   to the engineer.
// - Same HTTP assumptions as the main 1005 test: propose/approve answer 200 or
//   201; people have tenant-wide owner/finance role, payroll.disburse.approve,
//   TOTP in the session.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { totpCode, totpStep } from "../lib/totp.ts";
import { reconcileTrustedPayouts } from "../services/payroll-payout-recon.service.ts";
import { originHeader } from "./helpers.ts";
import {
  BUDI,
  SITI,
  actorOf,
  bank,
  installPayoutWorld,
  uploadEvidence,
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("1005rc");
const PASSWORD = "Test-password-123!";
const NOTE = "Bank mengembalikan dana, rekening tujuan ditutup";
const REASON = "Klaim salah input, uang tidak pernah kembali dari bank";
const NET = 1_000_000;
const API = "/api/hris/payroll";
const BATCHES = `${API}/disbursement-batches`;
const CLAIM_ROUTE = `${API}/payout-return-claims`;
const WITHDRAWAL_ROUTE = `${API}/payout-return-withdrawals`;
const CLAIMS = "payroll_payout_return_claims";
const WITHDRAWALS = "payroll_payout_return_withdrawals";
const EXCEPTIONS = "payroll_payout_recon_exceptions";
const ATTESTATIONS = "payroll_payout_attestations";
const GRANTS = "payroll_payout_grants";
const KIND = "return_withdraw";

const personIds: string[] = [];
const enrolledUsers: string[] = [];
const allItemIds: string[] = [];
const mfaOwner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

// ---- People ---------------------------------------------------------------------------

type Person = Awaited<ReturnType<typeof makePerson>>;

async function templateRoleId(key: "owner" | "finance") {
  const read = () =>
    W.owner.query<{ id: string }>(
      `SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2`,
      [W.tenantId, key],
    );
  const found = await read();
  if (found.rows[0]) return found.rows[0].id;
  await W.owner.query(
    `INSERT INTO roles
       (tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, true, $3, '[]'::jsonb, false, '["tenant","brand"]'::jsonb)
     ON CONFLICT DO NOTHING`,
    [W.tenantId, `Template ${key} 1005rc`, key],
  );
  return (await read()).rows[0]!.id;
}

async function makePerson(label: string, template: "owner" | "finance") {
  const { client, userId } = await W.signedInClient(
    `WithdrawRecon1005 ${label}`,
  );
  personIds.push(userId);
  await W.grantRole(userId, ["payroll.view", "payroll.disburse.approve"]);
  const roleId = await templateRoleId(template);
  await W.owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [W.tenantId, userId, roleId],
  );
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

let c1: Person;
let c2: Person;
let prop: Person;
let apA: Person;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  c1 = await makePerson("Claim One", "finance");
  c2 = await makePerson("Claim Two", "finance");
  prop = await makePerson("Proposer", "owner");
  apA = await makePerson("Approver", "finance");
});

afterEach(async () => {
  await W.asTenant(async (c) => {
    await c.query(`DELETE FROM ${EXCEPTIONS} WHERE tenant_id = $1`, [
      W.tenantId,
    ]);
  }, true);
});

// Registered after the world's own hook: runs first (stack order).
afterAll(async () => {
  await W.asTenant(async (c) => {
    if (allItemIds.length > 0)
      await c.query(
        `DELETE FROM ${ATTESTATIONS} WHERE tenant_id = $1 AND item_ids && $2::uuid[]`,
        [W.tenantId, allItemIds],
      );
    await c.query(
      `DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::uuid[])`,
      [W.tenantId, personIds],
    );
  }, true).catch(() => undefined);
  if (enrolledUsers.length > 0)
    await mfaOwner.query(
      "DELETE FROM mfa_factors WHERE user_id = ANY($1::uuid[])",
      [enrolledUsers],
    );
  await mfaOwner.end();
});

// ---- HTTP -----------------------------------------------------------------------------

type Res = {
  status: number;
  body: Row & { data?: Row; error?: { code?: string } };
};
const detail = (res: Res) => JSON.stringify(res.body);
const ok = (res: Res) => [200, 201].includes(res.status);

const returnHttp = (
  who: Person,
  batchId: string,
  itemId: string,
  evidenceKey: string,
  bankRef: string,
) =>
  who.client
    .post(`${BATCHES}/${batchId}/return`)
    .set(originHeader)
    .send({
      itemIds: [itemId],
      evidenceKey,
      note: NOTE,
      password: PASSWORD,
      bankRef,
    }) as unknown as Promise<Res>;
const proposeHttp = (who: Person, claimId: string) =>
  who.client
    .post(`${CLAIM_ROUTE}/${claimId}/withdrawal`)
    .set(originHeader)
    .send({ reason: REASON, password: PASSWORD }) as unknown as Promise<Res>;
const approveHttp = (who: Person, withdrawalId: string) =>
  who.client
    .post(`${WITHDRAWAL_ROUTE}/${withdrawalId}/approve`)
    .set(originHeader)
    .send({ password: PASSWORD }) as unknown as Promise<Res>;

// ---- Worlds ---------------------------------------------------------------------------

const freshKey = (batchId: string) =>
  uploadEvidence(batchId, `return-${randomUUID()}.pdf`);
const freshRef = () => `BCA-RET-${randomUUID().slice(0, 8).toUpperCase()}`;

async function paidBatch() {
  const slips = [bank(BUDI, NET), bank(SITI, NET)];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const batchId = await W.exportedBatch(runId);
  const items = (await W.itemsOf(batchId)).filter(
    (i) => i.status === "exported",
  );
  await W.confirm(batchId, W.succeedItems(batchId, items));
  const a = (await W.itemOfPerson(batchId, BUDI)).id as string;
  const b = (await W.itemOfPerson(batchId, SITI)).id as string;
  allItemIds.push(a, b);
  return { runId, batchId, a, b };
}

type Claim = {
  key: string;
  ref: string;
  claimId: string;
  batchId: string;
  itemId: string;
};

const claimRow = async (claimId: string) =>
  (
    await W.rowsOf(`SELECT * FROM ${CLAIMS} WHERE tenant_id = $1 AND id = $2`, [
      W.tenantId,
      claimId,
    ])
  )[0]!;
const itemRow = async (itemId: string) =>
  (
    await W.rowsOf(
      `SELECT * FROM payroll_disbursement_items WHERE tenant_id = $1 AND id = $2`,
      [W.tenantId, itemId],
    )
  )[0]!;
const withdrawalsOf = (claimId: string) =>
  W.rowsOf(
    `SELECT * FROM ${WITHDRAWALS} WHERE tenant_id = $1 AND claim_id = $2 ORDER BY proposed_at, id`,
    [W.tenantId, claimId],
  );

async function openClaim(
  batchId: string,
  itemId: string,
  ref = freshRef(),
): Promise<Claim> {
  const key = freshKey(batchId);
  const res = await returnHttp(c1, batchId, itemId, key, ref);
  expect(ok(res), `premise: step 1 ${detail(res)}`).toBe(true);
  const [claim] = await W.rowsOf(
    `SELECT * FROM ${CLAIMS} WHERE tenant_id = $1 AND evidence_key = $2`,
    [W.tenantId, key],
  );
  expect(claim, "premise: the claim is on record").toBeDefined();
  expect(claim!.status, "premise: open").toBe("open");
  return { key, ref, claimId: claim!.id as string, batchId, itemId };
}
async function confirmClaim(claim: Claim) {
  const res = await returnHttp(
    c2,
    claim.batchId,
    claim.itemId,
    claim.key,
    claim.ref,
  );
  expect(ok(res), `premise: step 2 ${detail(res)}`).toBe(true);
  expect((await itemRow(claim.itemId)).status, "premise: returned").toBe(
    "returned",
  );
}
async function proposed(claim: Claim) {
  const res = await proposeHttp(prop, claim.claimId);
  expect(ok(res), `premise: propose ${detail(res)}`).toBe(true);
  const rows = await withdrawalsOf(claim.claimId);
  expect(rows, "premise: one withdrawal on record").toHaveLength(1);
  return rows[0]!.id as string;
}
const attestationsOfOperation = (withdrawalId: string) =>
  W.rowsOf(
    `SELECT * FROM ${ATTESTATIONS}
      WHERE tenant_id = $1 AND kind = '${KIND}' AND operation_id = $2::uuid
      ORDER BY attested_at, id`,
    [W.tenantId, withdrawalId],
  );
/** Propose + approve over HTTP; the legit attestations are checked as a premise. */
async function legitWithdrawal(batchId: string, itemId: string) {
  const claim = await openClaim(batchId, itemId);
  const id = await proposed(claim);
  const res = await approveHttp(apA, id);
  expect(ok(res), `premise: approve ${detail(res)}`).toBe(true);
  expect((await claimRow(claim.claimId)).status, "premise: withdrawn").toBe(
    "withdrawn",
  );
  const attestations = await attestationsOfOperation(id);
  expect(
    attestations.map((a) => a.step).sort(),
    "premise: both steps are attested",
  ).toEqual(["approve", "propose"]);
  expect(
    new Set(attestations.map((a) => a.session_id)).size,
    "premise: two different sessions",
  ).toBe(2);
  return { claim, id };
}

// ---- Recon ----------------------------------------------------------------------------

async function runRecon() {
  const { storage } = W.proofs();
  let after: string | null = null;
  for (let page = 0; page < 1000; page += 1) {
    const result: { operations: number; last: string | null } =
      await reconcileTrustedPayouts(W.scope(), { storage, after } as never);
    if (result.last === null || result.operations === 0) return;
    after = result.last;
  }
  throw new Error("recon did not finish");
}
const exceptionsOf = (itemId: string, kind?: string) =>
  W.rowsOf(
    `SELECT * FROM ${EXCEPTIONS}
      WHERE tenant_id = $1 AND item_id = $2 AND ($3::text IS NULL OR kind = $3)`,
    [W.tenantId, itemId, kind ?? null],
  );
async function expectNotFlagged(itemId: string, label: string) {
  expect(
    await exceptionsOf(itemId),
    `${label}: no recon exception on the item`,
  ).toHaveLength(0);
}
async function expectFlagged(itemId: string, label: string, kind?: string) {
  expect(
    (await exceptionsOf(itemId, kind)).length,
    `${label}: recon exception${kind ? ` of kind ${kind}` : ""} on the item`,
  ).toBeGreaterThan(0);
}
const tamper = (sql: string, params: unknown[]) =>
  W.asTenant((c) => c.query(sql, params), true);

// =========================================================================
// 1: legit flows are never flagged
// =========================================================================

describe("1005 recon: legit withdrawals are not flagged", () => {
  it("[1005-recon-1-clean] an untouched open claim, a proposal alone, an approved withdrawal, and a claim withdrawn then filed again and confirmed raise no flag", async () => {
    const w = await paidBatch();
    const untouched = await openClaim(w.batchId, w.a);
    const claim = await openClaim(w.batchId, w.b);

    await runRecon();
    await expectNotFlagged(w.a, "open claim, nothing proposed");
    await expectNotFlagged(w.b, "open claim before the proposal");

    const id = await proposed(claim);
    await runRecon();
    await expectNotFlagged(w.b, "a proposal alone");

    const approved = await approveHttp(apA, id);
    expect(ok(approved), detail(approved)).toBe(true);
    expect(
      (await attestationsOfOperation(id)).map((a) => a.step).sort(),
      "premise: both steps attested",
    ).toEqual(["approve", "propose"]);
    await runRecon();
    await expectNotFlagged(w.b, "an approved withdrawal");
    await expectNotFlagged(w.a, "the other open claim, after the withdraw");

    const again = await openClaim(w.batchId, w.b);
    await confirmClaim(again);
    await runRecon();
    await expectNotFlagged(w.b, "withdrawn first, returned later");
    expect((await claimRow(untouched.claimId)).status).toBe("open");
  });
});

// =========================================================================
// 2: forged or missing attestations of an approved withdrawal
// =========================================================================

describe("1005 recon: a forged approved withdrawal is flagged", () => {
  const variants: [string, (id: string) => Promise<unknown>][] = [
    [
      "all attestations deleted",
      (id) =>
        tamper(
          `DELETE FROM ${ATTESTATIONS} WHERE tenant_id = $1 AND kind = '${KIND}' AND operation_id = $2::uuid`,
          [W.tenantId, id],
        ),
    ],
    [
      "approve attestation deleted",
      (id) =>
        tamper(
          `DELETE FROM ${ATTESTATIONS} WHERE tenant_id = $1 AND kind = '${KIND}' AND operation_id = $2::uuid AND step = 'approve'`,
          [W.tenantId, id],
        ),
    ],
    [
      "both steps in the same session",
      (id) =>
        tamper(
          `UPDATE ${ATTESTATIONS}
              SET session_id = (SELECT session_id FROM ${ATTESTATIONS}
                                 WHERE tenant_id = $1 AND kind = '${KIND}'
                                   AND operation_id = $2::uuid AND step = 'propose')
            WHERE tenant_id = $1 AND kind = '${KIND}' AND operation_id = $2::uuid AND step = 'approve'`,
          [W.tenantId, id],
        ),
    ],
    [
      "forged approve session",
      (id) =>
        tamper(
          `UPDATE ${ATTESTATIONS} SET session_id = $3
            WHERE tenant_id = $1 AND kind = '${KIND}' AND operation_id = $2::uuid AND step = 'approve'`,
          [W.tenantId, id, `forged-session-${randomUUID()}`],
        ),
    ],
    [
      "grant removed",
      (id) =>
        tamper(
          `DELETE FROM ${GRANTS}
            WHERE tenant_id = $1 AND id IN (
              SELECT grant_id FROM ${ATTESTATIONS}
               WHERE tenant_id = $1 AND kind = '${KIND}' AND operation_id = $2::uuid)`,
          [W.tenantId, id],
        ),
    ],
  ];

  for (const [label, forge] of variants)
    it(`[1005-recon-2-forged-attestation] ${label}: the item is flagged return_withdraw; before the forgery it is not`, async () => {
      const w = await paidBatch();
      const { id } = await legitWithdrawal(w.batchId, w.a);
      await runRecon();
      await expectNotFlagged(w.a, `${label}: before the forgery`);

      await forge(id);
      await runRecon();
      await expectFlagged(w.a, label, KIND);
    });
});

// =========================================================================
// 2b: grant ids of the row must be the ones attested
// =========================================================================

describe("1005 recon: the grants on the row are the attested grants", () => {
  for (const [label, set] of [
    [
      "approved_grant_id is another real grant (the propose grant)",
      "approved_grant_id = proposed_grant_id",
    ],
    [
      "proposed_grant_id is another real grant (the approve grant)",
      "proposed_grant_id = approved_grant_id",
    ],
  ] as const)
    it(`[1005-recon-2b-grant-mismatch] ${label}: the item is flagged return_withdraw; before the forgery it is not`, async () => {
      const w = await paidBatch();
      const { id } = await legitWithdrawal(w.batchId, w.a);
      await runRecon();
      await expectNotFlagged(w.a, "before the forgery");

      const [row] = await W.rowsOf(
        `SELECT proposed_grant_id, approved_grant_id FROM ${WITHDRAWALS}
          WHERE tenant_id = $1 AND id = $2`,
        [W.tenantId, id],
      );
      expect(
        row!.proposed_grant_id,
        "premise: real propose grant",
      ).toBeTruthy();
      expect(
        row!.approved_grant_id,
        "premise: real approve grant",
      ).toBeTruthy();
      expect(row!.proposed_grant_id).not.toBe(row!.approved_grant_id);

      await tamper(
        `UPDATE ${WITHDRAWALS} SET ${set} WHERE tenant_id = $1 AND id = $2`,
        [W.tenantId, id],
      );
      await runRecon();
      await expectFlagged(w.a, label, KIND);
    });

  it("[1005-recon-2b-null-grant-refused-by-check] an approved withdrawal row with a NULL approved grant is refused by payroll_payout_return_withdrawals_approved_check, even with guards off", async () => {
    const w = await paidBatch();
    const source = await openClaim(w.batchId, w.a);
    await proposed(source);
    const target = await openClaim(w.batchId, w.b);

    const error = await W.asTenant(
      (c) =>
        c.query(
          `INSERT INTO ${WITHDRAWALS}
           SELECT (jsonb_populate_record(t, $1::jsonb)).* FROM ${WITHDRAWALS} t
            WHERE t.tenant_id = $2 AND t.claim_id = $3`,
          [
            JSON.stringify({
              id: randomUUID(),
              claim_id: target.claimId,
              approved_by: apA.userId,
              approved_session_id: actorOf(apA.userId).sessionId,
              approved_at: new Date().toISOString(),
              approved_grant_id: null,
            }),
            W.tenantId,
            source.claimId,
          ],
        ),
      true,
    ).then(
      () => null,
      (e: unknown) => e as { code?: string; constraint?: string },
    );
    expect(error, "the insert must be refused").not.toBeNull();
    expect(error!.code).toBe("23514");
    expect(error!.constraint).toBe(
      "payroll_payout_return_withdrawals_approved_check",
    );
    expect(
      await withdrawalsOf(target.claimId),
      "nothing was written",
    ).toHaveLength(0);
  });
});

// =========================================================================
// 3 to 5: forged states without a legit withdrawal
// =========================================================================

describe("1005 recon: states a withdrawal cannot produce are flagged", () => {
  it("[1005-recon-3-approved-without-attestation] a withdrawal written as approved straight into the table (no approve attestation, a borrowed grant id, claim still open) is flagged return_withdraw", async () => {
    const w = await paidBatch();
    const claim = await openClaim(w.batchId, w.a);
    const id = await proposed(claim);
    await runRecon();
    await expectNotFlagged(w.a, "before the forgery: a proposal alone");

    await tamper(
      // A real grant id of the tenant (the propose grant of the same row): the CHECK
      // refuses an approved row without one, so the forger borrows a grant.
      `UPDATE ${WITHDRAWALS}
          SET approved_by = $3, approved_session_id = $4, approved_at = now(),
              approved_grant_id = proposed_grant_id
        WHERE tenant_id = $1 AND id = $2`,
      [W.tenantId, id, apA.userId, actorOf(apA.userId).sessionId],
    );
    await runRecon();
    await expectFlagged(w.a, "approved without attestation", KIND);
  });

  it("[1005-recon-4-withdrawn-without-withdrawal] a claim set to withdrawn with no approved withdrawal (none at all, or only a proposal) is flagged return_withdraw", async () => {
    const w = await paidBatch();
    const bare = await openClaim(w.batchId, w.a);
    const proposalOnly = await openClaim(w.batchId, w.b);
    await proposed(proposalOnly);
    await runRecon();
    await expectNotFlagged(w.a, "before the forgery: no withdrawal");
    await expectNotFlagged(w.b, "before the forgery: a proposal alone");

    for (const claim of [bare, proposalOnly])
      await tamper(
        `UPDATE ${CLAIMS} SET status = 'withdrawn', withdrawn_at = now()
          WHERE tenant_id = $1 AND id = $2`,
        [W.tenantId, claim.claimId],
      );
    await runRecon();
    await expectFlagged(w.a, "withdrawn claim without a withdrawal", KIND);
    await expectFlagged(w.b, "withdrawn claim with a proposal only", KIND);
  });

  it("[1005-recon-5-item-cleared-without-withdrawn-claim] an item whose return columns were emptied while its claim is still open is flagged", async () => {
    const w = await paidBatch();
    await openClaim(w.batchId, w.a);
    await runRecon();
    await expectNotFlagged(w.a, "before the forgery");

    await tamper(
      `UPDATE payroll_disbursement_items
          SET returned_by = NULL, return_evidence_key = NULL, return_note = NULL,
              return_claim_id = NULL, return_bank_ref = NULL
        WHERE tenant_id = $1 AND id = $2`,
      [W.tenantId, w.a],
    );
    await runRecon();
    await expectFlagged(
      w.a,
      "return columns emptied without a withdrawn claim",
    );
  });
});
