// Payout 990 card E (bead legend-nsqhm): the proof of a bank return must name the
// bank transaction reference (the identity of the money that came back), not only
// the file fingerprint. Written fail-first from the brief
// (docs/briefs/sub-990-payout-lanjutan.md "Kartu E", "I5") and the contract
// docs/briefs/990/i5-contract.md, NOT from the implementation.
//
// Rules proven (founder: nobody is paid twice or without money moving; when in
// doubt, limit the payment; tenants never touch each other):
// - A return without `bankRef` is refused (400); a reference that is too short
//   once spaces are removed is refused (422); nothing is recorded.
// - A legit return stores the normalized reference (no spaces, upper case) on the
//   claim and on the item; the second step must carry the same reference.
// - One reference is one return per tenant: a second claim with the same
//   reference (any spacing or case) is refused 409, also while the first claim is
//   still open, and when two requests race exactly one passes. Another tenant
//   may use the same reference.
// - A second step with another reference is refused (PAYOUT-89, 409).
// - No payslip is released twice: the refused item stays `succeeded`, has no
//   return journal and is not offered to a follow-up batch.
//
// Assumptions (the contract leaves them open, stated so they can be contested):
// - Route and body are the existing return route plus `bankRef`:
//   POST /api/hris/payroll/disbursement-batches/:id/return {itemIds, evidenceKey,
//   note, bankRef, password}; both steps carry `bankRef`. A step that completes
//   answers 200 or 201.
// - Normalization is "remove all spaces, upper case" (contract); a missing or
//   too short reference is 400 (validator, trimmed length under 4); one that
//   becomes shorter than 4 after the spaces are removed is 422.
// - The SQL contract is proven through pg_proc: no overload of
//   app.payout_return_propose / app.payout_return_confirm without a bank_ref
//   parameter remains (the old path is dropped), and the normalizer
//   app.payout_normalize_bank_ref refuses NULL, empty and too short input with
//   PAYOUT-88. I did not call the propose function directly: its grant binding is
//   not part of the contract, so the PAYOUT-88 of the propose function itself is
//   not asserted.
// - A second tenant is a copy of the first tenant row; its claim is a copy of an
//   existing claim written by the table owner with triggers off (FKs are off in
//   that fixture), as the 905/900 files do for forged rows. The per-tenant
//   unique index is what lets the copy in.
// - Every test uses fresh random references, so leftovers of other tests (claims
//   are kept, see the 905 recon test) never collide.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { totpCode, totpStep } from "../lib/totp.ts";
import { originHeader } from "./helpers.ts";
import {
  ANDI,
  BUDI,
  SITI,
  bank,
  installPayoutWorld,
  uploadEvidence,
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("990ret");
const PASSWORD = "Test-password-123!";
const NOTE = "Bank mengembalikan dana, rekening tujuan ditutup";
const BATCHES = "/api/hris/payroll/disbursement-batches";
const CLAIMS = "payroll_payout_return_claims";
const NET = 1_000_000;
const returnKey = (itemId: string) => `payroll-payout-return:${itemId}`;

const mfaOwner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const enrolledUsers: string[] = [];
const foreignTenants: string[] = [];

// ---- People (HTTP, TOTP enrolled in this very session) -------------------------

type Person = Awaited<ReturnType<typeof finance>>;
async function finance(label: string) {
  const { client, userId } = await W.signedInClient(`Return990 ${label}`);
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
  // Rows of the second tenant of this file (guards off); claims of the first tenant are kept.
  await W.asTenant(async (c) => {
    for (const id of foreignTenants.splice(0)) {
      await c.query(`DELETE FROM ${CLAIMS} WHERE tenant_id = $1`, [id]);
      await c.query(`DELETE FROM tenants WHERE id = $1`, [id]);
    }
  }, true);
});

afterAll(async () => {
  if (enrolledUsers.length > 0)
    await mfaOwner.query(
      "DELETE FROM mfa_factors WHERE user_id = ANY($1::uuid[])",
      [enrolledUsers],
    );
  await mfaOwner.end();
});

// ---- HTTP ----------------------------------------------------------------------------

type Res = {
  status: number;
  body: Row & { data?: Row; error?: { code?: string } };
};
const detail = (res: Res) => JSON.stringify(res.body);
const ok = (res: Res) => [200, 201].includes(res.status);

/** One step of a return; `bankRef: undefined` leaves the field out. */
const returnHttp = (
  who: Person,
  batchId: string,
  itemId: string,
  evidenceKey: string,
  bankRef: unknown,
) =>
  who.client
    .post(`${BATCHES}/${batchId}/return`)
    .set(originHeader)
    .send({
      itemIds: [itemId],
      evidenceKey,
      note: NOTE,
      password: PASSWORD,
      ...(bankRef === undefined ? {} : { bankRef }),
    }) as unknown as Promise<Res>;

const freshKey = (batchId: string) =>
  uploadEvidence(batchId, `return-${randomUUID()}.pdf`);
const freshRef = () => `BCA-RET-${randomUUID().slice(0, 8).toUpperCase()}`;
/** What the contract does to a reference: remove all spaces, upper case. */
const normalized = (ref: string) => ref.replace(/\s+/g, "").toUpperCase();

// ---- Worlds and observations ------------------------------------------------------------

/** Items paid in one batch (confirmed), in the order of the slips (BUDI, SITI, ANDI). */
async function paidBatch(count: 2 | 3) {
  const slips = [bank(BUDI, NET), bank(SITI, NET), bank(ANDI, NET)].slice(
    0,
    count,
  );
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const batchId = await W.exportedBatch(runId);
  const items = (await W.itemsOf(batchId)).filter(
    (i) => i.status === "exported",
  );
  await W.confirm(batchId, W.succeedItems(batchId, items));
  const itemOf = async (person: typeof BUDI) =>
    (await W.itemOfPerson(batchId, person)).id as string;
  return {
    runId,
    batchId,
    a: await itemOf(BUDI),
    b: await itemOf(SITI),
    c: count === 3 ? await itemOf(ANDI) : "",
  };
}

const statusOf = async (itemId: string) =>
  (
    await W.rowsOf(
      `SELECT status, return_bank_ref FROM payroll_disbursement_items
        WHERE tenant_id = $1 AND id = $2`,
      [W.tenantId, itemId],
    )
  )[0]!;
const claimsOfKey = (key: string) =>
  W.rowsOf(
    `SELECT * FROM ${CLAIMS} WHERE tenant_id = $1 AND evidence_key = $2`,
    [W.tenantId, key],
  );
const claimsWithRef = async (ref: string) =>
  Number(
    (
      await W.rowsOf(
        `SELECT count(*)::int AS n FROM ${CLAIMS} WHERE tenant_id = $1 AND bank_ref = $2`,
        [W.tenantId, ref],
      )
    )[0]!.n,
  );
/** The item was not returned: still succeeded, no return journal. */
async function expectNotReleased(itemId: string, label: string) {
  expect((await statusOf(itemId)).status, `${label}: item`).toBe("succeeded");
  expect(await W.countJournals(returnKey(itemId)), `${label}: journal`).toBe(0);
}
/** Both steps of a return, by two different people. */
async function returnBoth(
  batchId: string,
  itemId: string,
  ref: string,
  first = one,
  second = two,
) {
  const key = freshKey(batchId);
  const s1 = await returnHttp(first, batchId, itemId, key, ref);
  expect(ok(s1), `premise: step 1 ${detail(s1)}`).toBe(true);
  const s2 = await returnHttp(second, batchId, itemId, key, ref);
  expect(ok(s2), `premise: step 2 ${detail(s2)}`).toBe(true);
  expect((await statusOf(itemId)).status, "premise: returned").toBe("returned");
  return key;
}

// =========================================================================
// E1: no reference, no return
// =========================================================================

describe("990 E: a return needs the bank reference", () => {
  it("[990-E-1-api-requires-bankref] a return step without bankRef or with one under 4 characters is refused 400; one that is too short without its spaces is 422; nothing is recorded; a valid reference then works", async () => {
    const w = await paidBatch(2);

    for (const [label, bankRef, status] of [
      ["missing", undefined, 400],
      ["too short", "ab", 400],
      ["short without spaces", "a b c", 422],
    ] as const) {
      const key = freshKey(w.batchId);
      const res = await returnHttp(one, w.batchId, w.a, key, bankRef);
      expect(res.status, `${label}: ${detail(res)}`).toBe(status);
      expect(await claimsOfKey(key), `${label}: no claim`).toHaveLength(0);
      await expectNotReleased(w.a, label);
      expect((await statusOf(w.a)).return_bank_ref, label).toBeNull();
    }

    const key = freshKey(w.batchId);
    const good = await returnHttp(one, w.batchId, w.a, key, freshRef());
    expect(ok(good), `control: ${detail(good)}`).toBe(true);
    expect(await claimsOfKey(key)).toHaveLength(1);
  });

  it("[990-E-1-api-step-two-requires-bankref] the second step without bankRef is refused 400; the item stays succeeded", async () => {
    const w = await paidBatch(2);
    const key = freshKey(w.batchId);
    const ref = freshRef();
    const s1 = await returnHttp(one, w.batchId, w.a, key, ref);
    expect(ok(s1), `premise: ${detail(s1)}`).toBe(true);

    const s2 = await returnHttp(two, w.batchId, w.a, key, undefined);
    expect(s2.status, detail(s2)).toBe(400);
    await expectNotReleased(w.a, "step 2 without a reference");
  });

  it("[990-E-1-sql-no-path-without-ref] in the database no return function without a bank_ref parameter remains, and the normalizer refuses NULL, empty and too short references with PAYOUT-88", async () => {
    const overloads = await W.rowsOf(
      `SELECT p.proname, pg_get_function_arguments(p.oid) AS args
         FROM pg_proc p
        WHERE p.pronamespace = 'app'::regnamespace
          AND p.proname IN ('payout_return_propose', 'payout_return_confirm')`,
    );
    for (const name of ["payout_return_propose", "payout_return_confirm"]) {
      const mine = overloads.filter((o) => o.proname === name);
      expect(mine.length, `${name} exists`).toBeGreaterThan(0);
      for (const o of mine)
        expect(
          String(o.args),
          `${name}(${String(o.args)}) must take the bank reference`,
        ).toMatch(/bank_ref/);
    }

    for (const bad of [null, "", "   ", "ab", "a b c"]) {
      const error = await W.asTenant((c) =>
        c.query(`SELECT app.payout_normalize_bank_ref($1::varchar)`, [bad]),
      ).then(
        () => null,
        (e: unknown) => e as { message?: string },
      );
      expect(error, `refused: ${JSON.stringify(bad)}`).not.toBeNull();
      expect(error!.message).toMatch(/PAYOUT-88/);
    }
    const [good] = await W.rowsOf(
      `SELECT app.payout_normalize_bank_ref(' bca 12-x '::varchar) AS ref`,
    );
    expect(good!.ref, "trim, no spaces, upper case").toBe("BCA12-X");
  });
});

// =========================================================================
// E2: the reference is stored, normalized
// =========================================================================

describe("990 E: a legit return keeps the normalized reference", () => {
  it("[990-E-2-stored-normalized] step 1 stores the normalized reference on the claim and the item; step 2 with the same reference in another spelling returns the item; claim and item keep it; one journal", async () => {
    const w = await paidBatch(2);
    const typed = ` bca-ret ${randomUUID().slice(0, 8)} 01 `;
    const expected = normalized(typed);
    const key = freshKey(w.batchId);

    const s1 = await returnHttp(one, w.batchId, w.a, key, typed);
    expect(ok(s1), detail(s1)).toBe(true);
    expect((await claimsOfKey(key))[0]!.bank_ref, "claim").toBe(expected);
    expect((await statusOf(w.a)).return_bank_ref, "item").toBe(expected);

    const s2 = await returnHttp(
      two,
      w.batchId,
      w.a,
      key,
      expected.toLowerCase(),
    );
    expect(ok(s2), detail(s2)).toBe(true);
    const done = await statusOf(w.a);
    expect(done.status).toBe("returned");
    expect(done.return_bank_ref).toBe(expected);
    expect((await claimsOfKey(key))[0]!.bank_ref).toBe(expected);
    expect(await W.countJournals(returnKey(w.a))).toBe(1);
  });
});

// =========================================================================
// E3: one reference, one return
// =========================================================================

describe("990 E: the same reference cannot free another payslip", () => {
  it("[990-E-3-duplicate-ref-refused] a reference used by an open or a finished claim is refused 409 for another item (any spacing or case); nothing is recorded for it", async () => {
    const w = await paidBatch(3);
    const ref = freshRef();
    const keyA = freshKey(w.batchId);

    const a1 = await returnHttp(one, w.batchId, w.a, keyA, ref);
    expect(ok(a1), `premise: ${detail(a1)}`).toBe(true);

    // The first claim is still open.
    const keyB = freshKey(w.batchId);
    const b = await returnHttp(
      two,
      w.batchId,
      w.b,
      keyB,
      ` ${ref.toLowerCase().replace("-", " - ")} `,
    );
    expect(b.status, `open claim: ${detail(b)}`).toBe(409);
    expect(await claimsOfKey(keyB), "no claim for B").toHaveLength(0);
    await expectNotReleased(w.b, "B while A is open");

    // The first claim finishes.
    const a2 = await returnHttp(two, w.batchId, w.a, keyA, ref);
    expect(ok(a2), `premise: ${detail(a2)}`).toBe(true);
    expect((await statusOf(w.a)).status).toBe("returned");

    const keyC = freshKey(w.batchId);
    const c = await returnHttp(one, w.batchId, w.c, keyC, ref);
    expect(c.status, `finished claim: ${detail(c)}`).toBe(409);
    expect(await claimsOfKey(keyC), "no claim for C").toHaveLength(0);
    await expectNotReleased(w.c, "C after A is done");
    await expectNotReleased(w.b, "B");

    expect(await claimsWithRef(ref), "one claim owns the reference").toBe(1);
    expect(await W.countJournals(returnKey(w.a))).toBe(1);
  });

  it("[990-E-3-concurrent-same-ref] two people start a return of two different items with the same reference at the same moment: exactly one passes, the other is 409; one claim owns the reference; only the winner is released", async () => {
    const w = await paidBatch(2);
    const ref = freshRef();
    const keyA = freshKey(w.batchId);
    const keyB = freshKey(w.batchId);

    const [ra, rb] = await Promise.all([
      returnHttp(one, w.batchId, w.a, keyA, ref),
      returnHttp(two, w.batchId, w.b, keyB, ref),
    ]);
    const passed = [ra, rb].filter(ok);
    const refused = [ra, rb].filter((r) => r.status === 409);
    const both = `${detail(ra)} | ${detail(rb)}`;
    expect(passed.length, `exactly one passes: ${both}`).toBe(1);
    expect(refused.length, `exactly one is 409: ${both}`).toBe(1);
    expect(await claimsWithRef(ref), "one claim owns the reference").toBe(1);

    const aWon = ok(ra);
    const winner = aWon ? { item: w.a, key: keyA } : { item: w.b, key: keyB };
    const loser = aWon ? { item: w.b, key: keyB } : { item: w.a, key: keyA };
    expect(await claimsOfKey(loser.key), "no claim for the loser").toHaveLength(
      0,
    );
    await expectNotReleased(loser.item, "loser");

    // The winner finishes with the other person; the loser is never released.
    const finisher = aWon ? two : one;
    const s2 = await returnHttp(
      finisher,
      w.batchId,
      winner.item,
      winner.key,
      ref,
    );
    expect(ok(s2), `winner step 2: ${detail(s2)}`).toBe(true);
    expect((await statusOf(winner.item)).status).toBe("returned");
    expect(await W.countJournals(returnKey(winner.item))).toBe(1);
    await expectNotReleased(loser.item, "loser after the winner is done");
  });
});

// =========================================================================
// E4: another tenant
// =========================================================================

describe("990 E: references are unique per tenant", () => {
  it("[990-E-4-other-tenant-same-ref] another tenant holding the same reference does not block this tenant, and this tenant's claim does not block the other", async () => {
    const w = await paidBatch(2);
    const refA = freshRef();
    const refB = freshRef();
    const keyA = freshKey(w.batchId);
    const a = await returnHttp(one, w.batchId, w.a, keyA, refA);
    expect(ok(a), `premise: ${detail(a)}`).toBe(true);

    const foreign = randomUUID();
    foreignTenants.push(foreign);
    await W.asTenant(async (c) => {
      await c.query(
        `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
         SELECT $1, $2, 'Payout 990 tenant B', plan, status, deployment_mode, feature_flags, limits, created_by
           FROM tenants WHERE id = $3`,
        [foreign, `payout-990-${foreign.slice(0, 8)}`, W.tenantId],
      );
      await c.query(
        `CREATE TEMP TABLE claim990_copy ON COMMIT DROP AS
           SELECT * FROM ${CLAIMS} WHERE tenant_id = $1 AND evidence_key = $2`,
        [W.tenantId, keyA],
      );
      // The other tenant has the SAME reference as my open claim (refA) and the one I am about to use (refB).
      for (const ref of [refA, refB]) {
        await c.query(
          `UPDATE claim990_copy
              SET id = gen_random_uuid(), tenant_id = $1, bank_ref = $2,
                  evidence_key = 'foreign-' || gen_random_uuid()::text`,
          [foreign, ref],
        );
        await c.query(`INSERT INTO ${CLAIMS} SELECT * FROM claim990_copy`);
      }
    }, true);

    const keyB = freshKey(w.batchId);
    const b = await returnHttp(two, w.batchId, w.b, keyB, refB);
    expect(
      ok(b),
      `the other tenant's reference does not block: ${detail(b)}`,
    ).toBe(true);
    expect(await claimsOfKey(keyB)).toHaveLength(1);
    expect(await claimsWithRef(refA), "my claim keeps refA").toBe(1);
  });
});

// =========================================================================
// E5: the second step must match
// =========================================================================

describe("990 E: the second step carries the same reference", () => {
  it("[990-E-5-step-two-other-ref-refused] step 2 with another reference is refused (409, PAYOUT-89): the item stays succeeded, the claim keeps its reference, no journal; the matching reference then completes it", async () => {
    const w = await paidBatch(2);
    const ref = freshRef();
    const key = freshKey(w.batchId);
    const s1 = await returnHttp(one, w.batchId, w.a, key, ref);
    expect(ok(s1), `premise: ${detail(s1)}`).toBe(true);

    const other = await returnHttp(two, w.batchId, w.a, key, freshRef());
    expect(other.status, detail(other)).toBe(409);
    await expectNotReleased(w.a, "other reference");
    expect((await claimsOfKey(key))[0]!.bank_ref, "claim keeps its ref").toBe(
      ref,
    );

    const same = await returnHttp(two, w.batchId, w.a, key, ref);
    expect(ok(same), `control: ${detail(same)}`).toBe(true);
    expect((await statusOf(w.a)).status).toBe("returned");
    expect(await W.countJournals(returnKey(w.a))).toBe(1);
  });
});

// =========================================================================
// E6: no payslip is released twice
// =========================================================================

describe("990 E: no payslip is released twice", () => {
  it("[990-E-6-no-double-release] after a return with reference R, a second return with R for another item is refused: only the really returned item is offered to a follow-up batch, each journaled once", async () => {
    const w = await paidBatch(2);
    const ref = freshRef();
    await returnBoth(w.batchId, w.a, ref);

    const keyB = freshKey(w.batchId);
    const b = await returnHttp(one, w.batchId, w.b, keyB, ref);
    expect(b.status, detail(b)).toBe(409);
    const b2 = await returnHttp(two, w.batchId, w.b, keyB, ref);
    expect(ok(b2), "the second step cannot complete either").toBe(false);
    await expectNotReleased(w.b, "B");

    const followUp = await W.createBatch(w.runId);
    const offered = (await W.itemsOf(followUp)).map((i) => i.employee_id);
    expect(offered, "only A is paid again, B keeps its payment").toEqual([
      BUDI.id,
    ]);
    expect(await W.countJournals(returnKey(w.a))).toBe(1);
    expect(await W.countJournals(returnKey(w.b))).toBe(0);
  });
});
