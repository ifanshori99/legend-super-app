// Brief 1184, card legend-6qp12: release a payout GL posting held with
// `payable_account_hold = true` ("payable_account_unknown" in the finance list).
// Written fail-first from docs/briefs/sub-1184-payout-gl-holds.md (Card 2 and the
// shared "Required tests"), the 888 payable-account tests and the 1038/888 step-up
// tests, NOT from the implementation.
//
//   POST /api/hris/payroll/payout-gl-postings/:postingId/payable-hold-release
//   body { password, note }  ->  200 { data: { postingId, resolvedAt } }
//
// Rules proven ("jangan sampai rugi": nobody is paid or journaled twice, and a
// released row never falls back to today's salaries_payable mapping):
// - Finance (and owner) release a held posting with the password step-up: the hold
//   is lifted once, the release is recorded (who, when, trimmed note), one audit row
//   `payroll.payout_gl_payable_hold.released` carries the note as reason, the
//   release itself journals nothing, the row leaves `payable_account_unknown`.
// - Afterwards the posting re-enters the normal flow exactly once: a return journals
//   one entry against the FROZEN account (A), never today's mapping (C). A second
//   release is 409 PAYOUT_GL_ALREADY_RESOLVED and adds nothing.
// - Two concurrent releases: exactly one 200, the other 409; one audit row.
// - Refused without effect and without a success audit: the batch creator (403
//   PAYOUT_GL_SELF_APPROVAL), roles without the permission (hr, general_manager,
//   tenant_admin), stale step-up (401 REAUTH_REQUIRED), no MFA, wrong or missing
//   password, blank / too long / missing note, no session.
// - Another tenant's posting is 404 PAYOUT_GL_POSTING_NOT_FOUND and untouched.
// - A held posting with no frozen account and no lock journal (release would have
//   to guess from today's mapping) is refused 409 PAYOUT_PAYABLE_ACCOUNT_UNKNOWN.
//
// Assumptions (the brief leaves them open, stated so they can be contested):
// - Held posting fixture: a normal confirmed bank payout (lock journal on 2103, so
//   the posting is `settle` with a frozen payable account) is forced to
//   `payable_account_hold = true` by SQL with triggers off. Held rows exist today
//   only from the 0390 backfill; the SQL stands in for it.
// - "Held returns are refused 409": the first return step is refused, or, if the
//   first step is accepted, the second is; either way 409 and no return journal.
// - Frozen-account-missing fixture: a skipped settle (accounting off, no lock
//   journal), frozen account NULL, hold true. The brief says release must refuse
//   409 PAYOUT_PAYABLE_ACCOUNT_UNKNOWN "if the code would fall back to today's
//   mapping"; no lock journal and no frozen account is the case where it would.
// - Roles: finance and owner are default grantees (templates assigned as in the
//   1038 tests); hr, general_manager and tenant_admin must not reach it. Every
//   person also gets payroll.view + payroll.disburse.approve through a custom role so
//   a refusal can only be about payroll.payout.gl_resolve.
// - Missing MFA = no TOTP factor enrolled: 401 or 403. Wrong password 401 or 403
//   (as the 888/905 step-up tests). Missing password: 401 or 422. Blank note: 400 or
//   422 (repo convention for strict validators).
// - Response body is `{ data: { postingId, resolvedAt } }` (tolerates the bare shape).
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { PoolClient } from "pg";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { returnManualItems } from "../services/payroll-payout-manual.service.ts";
import { totpCode, totpStep } from "../lib/totp.ts";
import { agent, originHeader } from "./helpers.ts";
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

const W = installPayoutWorld("1184hold");
const tenantId = () => W.tenantId;

const PASSWORD = "Test-password-123!";
const WRONG = "Salah-password-999!";
const NOTE = "Rekening utang gaji dicek manual terhadap jurnal kunci";
const NET = 1_000_000;
const A = "2103";
const B = "2104";
const C = "2106";
const CODES = ["1102", "1103", "8101", A, B, C] as const;
const RELEASED_ACTION = "payroll.payout_gl_payable_hold.released";
const LIST = "/api/hris/payroll/payout-fee-reposts";
const releasePath = (postingId: string) =>
  `/api/hris/payroll/payout-gl-postings/${encodeURIComponent(postingId)}/payable-hold-release`;

// ---- People (HTTP, TOTP enrolled in this very session) ----------------------------

const mfaOwner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const enrolledUsers: string[] = [];
const foreignTenants: string[] = [];

afterEach(async () => {
  await setPayableMapping(A);
});
afterAll(async () => {
  if (enrolledUsers.length > 0)
    await mfaOwner.query(
      "DELETE FROM mfa_factors WHERE user_id = ANY($1::uuid[])",
      [enrolledUsers],
    );
  if (foreignTenants.length > 0)
    await W.asTenant(async (c) => {
      await c.query(
        "DELETE FROM payroll_payout_gl_postings WHERE tenant_id = ANY($1::uuid[])",
        [foreignTenants],
      );
      await c.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [
        foreignTenants,
      ]);
    }, true);
  await mfaOwner.end();
});

type Template = "owner" | "finance" | "hr" | "general_manager" | "tenant_admin";
type Person = Awaited<ReturnType<typeof makePerson>>;

async function templateRoleId(key: Template) {
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
    [W.tenantId, `Template ${key} 1184hold`, key],
  );
  return (await read()).rows[0]!.id;
}

async function makePerson(
  label: string,
  template: Template,
  { enroll = true }: { enroll?: boolean } = {},
) {
  const { client, userId } = await W.signedInClient(`Hold1184 ${label}`);
  await W.grantRole(userId, ["payroll.view", "payroll.disburse.approve"]);
  const roleId = await templateRoleId(template);
  await W.owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [W.tenantId, userId, roleId],
  );
  if (enroll) {
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
  }
  return { client, userId };
}

// Shared people (one MFA enrolment each, reused across tests).
const cache = new Map<string, Promise<Person>>();
const personOf = (key: string, template: Template, enroll = true) => {
  const hit = cache.get(key);
  if (hit) return hit;
  const made = makePerson(key, template, { enroll });
  cache.set(key, made);
  return made;
};

// ---- HTTP ----------------------------------------------------------------------------

type Res = {
  status: number;
  body: Row & { data?: Row; error?: { code?: string } };
};
const detail = (res: Res) => JSON.stringify(res.body);
const codeOf = (res: Res) => res.body.error?.code;

const releaseHttp = (
  client: Person["client"],
  postingId: string,
  body: Record<string, unknown> = { password: PASSWORD, note: NOTE },
) =>
  client
    .post(releasePath(postingId))
    .set(originHeader)
    .send(body) as unknown as Promise<Res>;

// ---- Switches and ledger -------------------------------------------------------------

async function tenantFlags() {
  const rows = await W.owner.query(
    "SELECT feature_flags AS flags FROM tenants WHERE id = $1",
    [tenantId()],
  );
  return rows.rows[0]!.flags as { modules: string[] } & Record<string, unknown>;
}
async function setFlags(flags: unknown) {
  await W.owner.query(
    "UPDATE tenants SET feature_flags = $2::jsonb WHERE id = $1",
    [tenantId(), JSON.stringify(flags)],
  );
}
async function withAccountingOff<T>(work: () => Promise<T>) {
  const original = await tenantFlags();
  expect(original.modules, "premise: accounting is on").toContain("accounting");
  await setFlags({
    ...original,
    modules: original.modules.filter((m) => m !== "accounting"),
  });
  try {
    return await work();
  } finally {
    await setFlags(original);
  }
}

async function accountId(code: string) {
  const [row] = await W.rowsOf(
    `SELECT id FROM chart_of_accounts
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = $3`,
    [tenantId(), W.entityId(), code],
  );
  expect(row, `premise: the standard chart has ${code}`).toBeDefined();
  return row!.id as string;
}
/** Finance moves the role `salaries_payable` to another account (today's mapping). */
async function setPayableMapping(code: string) {
  const id = await accountId(code);
  await W.asTenant(
    (c) =>
      c.query(
        `UPDATE account_mappings SET account_id = $3
          WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = 'salaries_payable'`,
        [tenantId(), W.entityId(), id],
      ),
    true,
  );
}

type Balance = { debit: number; credit: number };
type Books = Record<(typeof CODES)[number], Balance>;
async function account(code: string): Promise<Balance> {
  const [row] = await W.rowsOf(
    `SELECT COALESCE(sum(l.debit_idr), 0)::text AS debit,
            COALESCE(sum(l.credit_idr), 0)::text AS credit
       FROM journal_lines l
       JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
       JOIN chart_of_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
      WHERE l.tenant_id = $1 AND e.legal_entity_id = $2 AND a.code = $3`,
    [tenantId(), W.entityId(), code],
  );
  return { debit: Number(row!.debit), credit: Number(row!.credit) };
}
async function books(): Promise<Books> {
  const out = {} as Books;
  for (const code of CODES) out[code] = await account(code);
  return out;
}
function movedSince(before: Books, after: Books): Books {
  const out = {} as Books;
  for (const code of CODES)
    out[code] = {
      debit: after[code].debit - before[code].debit,
      credit: after[code].credit - before[code].credit,
    };
  return out;
}
const untouched: Balance = { debit: 0, credit: 0 };
const journalCountOfEntity = async () =>
  Number(
    (
      await W.rowsOf(
        `SELECT count(*)::int AS n FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2`,
        [tenantId(), W.entityId()],
      )
    )[0]!.n,
  );

const idOf = (row: Row) => row.id as string;
const returnBankRef = (evidenceKey: string, itemIds: string[]) =>
  "TRX" +
  createHash("sha256")
    .update(`${evidenceKey}|${itemIds.join(",")}`)
    .digest("hex")
    .slice(0, 12);
const returnItems = (batchId: string, itemIds: string[], by: string) =>
  W.inTx((tx) =>
    returnManualItems(
      tx,
      actorOf(by),
      batchId,
      {
        itemIds,
        evidenceKey: uploadEvidence(batchId, "dana-kembali.pdf"),
        bankRef: returnBankRef(batchId, itemIds),
        note: "Bank mengembalikan dana, rekening tujuan ditutup",
      } as never,
      W.proofs(),
    ),
  );

// ---- Worlds ---------------------------------------------------------------------------

/**
 * A confirmed bank payout whose lock journal credited A: the posting is `settle`
 * with the frozen payable account A. It is then forced to the held state.
 */
async function heldWorld() {
  const slips = [bank(BUDI, NET)];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const batchId = await W.exportedBatch(runId);
  const items = (await W.itemsOf(batchId)).filter(
    (i) => i.status === "exported",
  );
  await W.confirm(batchId, W.succeedItems(batchId, items));
  const [settled] = await W.postingsOf(batchId);
  expect(settled!.kind, "premise: a normal settle posting").toBe("settle");
  expect(
    settled!.salaries_payable_account_id,
    "premise: the settle froze the lock-journal account A",
  ).toBe(await accountId(A));
  expect(
    await W.journalByKey(settled!.journal_key as string),
    "premise: the settle journal debits exactly the frozen account A",
  ).toEqual({
    [A]: { debit: NET, credit: 0 },
    "1103": { debit: 0, credit: NET },
  });
  await W.asTenant(
    (c) =>
      c.query(
        `UPDATE payroll_payout_gl_postings SET payable_account_hold = true
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId(), settled!.id],
      ),
    true,
  );
  const item = await W.itemOfPerson(batchId, BUDI);
  return {
    runId,
    batchId,
    postingId: idOf(settled!),
    itemId: idOf(item),
    journalKey: settled!.journal_key as string,
  };
}
type Held = Awaited<ReturnType<typeof heldWorld>>;

/** Held, no frozen account, no lock journal: only today's mapping could tell the account. */
async function heldWithoutFrozenAccount() {
  const slips = [bank(BUDI, NET)];
  const runId = await W.seedRun(slips);
  const batchId = await W.exportedBatch(runId);
  const items = await W.itemsOf(batchId);
  await withAccountingOff(() =>
    W.confirm(batchId, W.succeedItems(batchId, items)),
  );
  const [posting] = await W.postingsOf(batchId);
  expect(posting!.kind, "premise: skipped settle, no lock journal").toBe(
    "settle_skipped",
  );
  await W.asTenant(
    (c) =>
      c.query(
        `UPDATE payroll_payout_gl_postings
            SET payable_account_hold = true, salaries_payable_account_id = NULL
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId(), posting!.id],
      ),
    true,
  );
  return { runId, batchId, postingId: idOf(posting!) };
}

/** The batch creator becomes `userId` (so the actor is the requester). */
async function setBatchCreator(batchId: string, userId: string) {
  await W.asTenant(
    (c) =>
      c.query(
        `UPDATE payroll_disbursement_batches SET requested_by = $3
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId(), batchId, userId],
      ),
    true,
  );
}

// ---- Observations ---------------------------------------------------------------------

const postingState = async (postingId: string) =>
  (
    await W.rowsOf(
      `SELECT payable_account_hold, payable_hold_released_at, payable_hold_released_by,
              payable_hold_release_note, salaries_payable_account_id, kind
         FROM payroll_payout_gl_postings WHERE tenant_id = $1 AND id = $2`,
      [tenantId(), postingId],
    )
  )[0]!;
const auditRows = (postingId: string) =>
  W.rowsOf(
    `SELECT event FROM audit_logs
      WHERE tenant_id = $1 AND event->>'action' = $2
        AND event::text LIKE '%' || $3 || '%'`,
    [tenantId(), RELEASED_ACTION, postingId],
  );

function expectStillHeld(state: Row, why: string) {
  expect(state.payable_account_hold, `${why}: still held`).toBe(true);
  expect(state.payable_hold_released_at, `${why}: no release time`).toBeNull();
  expect(state.payable_hold_released_by, `${why}: no releaser`).toBeNull();
  expect(state.payable_hold_release_note, `${why}: no note`).toBeNull();
}

/** Refused with one of `statuses`, and nothing moved: still held, no audit, no journal. */
async function expectRefusedUntouched(
  res: Res,
  statuses: number[],
  postingId: string,
  journalsBefore: number,
  why: string,
) {
  expect(statuses, `${why}: ${detail(res)}`).toContain(res.status);
  expectStillHeld(await postingState(postingId), why);
  expect(await auditRows(postingId), `${why}: no success audit`).toHaveLength(
    0,
  );
  expect(await journalCountOfEntity(), `${why}: no journal`).toBe(
    journalsBefore,
  );
}

/** First attempt of a return while held: refused 409 at one of its two steps, no journal. */
async function returnWhileHeld(w: Held) {
  const firstError = await W.httpFailure(returnItems(w.batchId, [w.itemId], APP));
  let refusal = firstError;
  if (!firstError) {
    refusal = await W.httpFailure(returnItems(w.batchId, [w.itemId], APP3));
  }
  expect(refusal, "premise: a held posting refuses its return").not.toBeNull();
  expect(refusal!.status).toBe(409);
  expect(await W.countJournals(`payroll-payout-return:${w.itemId}`)).toBe(0);
  return { firstStepDone: !firstError };
}

// ================================================================================
describe("1184 6qp12: release a payable_account_hold", () => {
  it("[legend-6qp12-release-main] finance releases a held posting: 200 with postingId and resolvedAt, the hold is lifted once with who/when/trimmed note, one audit row carries the note, nothing is journaled, the row leaves payable_account_unknown, a second release is 409", async () => {
    const w = await heldWorld();
    const finance = await personOf("finance main", "finance");
    const journalsBefore = await journalCountOfEntity();
    const booksBefore = await books();
    await returnWhileHeld(w);
    // The refused return changed no journal either.
    expect(await journalCountOfEntity()).toBe(journalsBefore);

    const res = await releaseHttp(finance.client, w.postingId, {
      password: PASSWORD,
      note: `  ${NOTE}  `,
    });
    expect(res.status, detail(res)).toBe(200);
    const data = (res.body.data ?? res.body) as Row;
    expect(data.postingId).toBe(w.postingId);
    expect(typeof data.resolvedAt).toBe("string");
    expect(new Date(data.resolvedAt as string).toISOString()).toBe(
      data.resolvedAt,
    );

    const state = await postingState(w.postingId);
    expect(state.payable_account_hold, "hold lifted").toBe(false);
    expect(state.payable_hold_released_at).not.toBeNull();
    expect(state.payable_hold_released_by).toBe(finance.userId);
    expect(state.payable_hold_release_note, "note is stored trimmed").toBe(NOTE);
    expect(
      state.salaries_payable_account_id,
      "the frozen account is untouched by the release",
    ).toBe(await accountId(A));
    expect(state.kind).toBe("settle");

    const audits = await auditRows(w.postingId);
    expect(audits, "exactly one success audit").toHaveLength(1);
    expect((audits[0]!.event as { reason?: string }).reason).toBe(NOTE);

    expect(await journalCountOfEntity(), "the release journals nothing").toBe(
      journalsBefore,
    );
    expect(movedSince(booksBefore, await books())).toEqual({
      "1102": untouched,
      "1103": untouched,
      "8101": untouched,
      [A]: untouched,
      [B]: untouched,
      [C]: untouched,
    });

    // The row left the finance list for the unknown payable account.
    const list = await finance.client.get(LIST);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const listed = (list.body.data as Row[]).find(
      (row) => row.postingId === w.postingId,
    );
    expect(listed?.reason, "no longer payable_account_unknown").not.toBe(
      "payable_account_unknown",
    );

    // Second release: 409, nothing added.
    const again = await releaseHttp(finance.client, w.postingId);
    expect(again.status, detail(again)).toBe(409);
    expect(codeOf(again)).toBe("PAYOUT_GL_ALREADY_RESOLVED");
    expect(await auditRows(w.postingId)).toHaveLength(1);
    expect(await journalCountOfEntity()).toBe(journalsBefore);
    expect((await postingState(w.postingId)).payable_hold_released_by).toBe(
      finance.userId,
    );
  });

  it("[legend-6qp12-release-owner] the owner template may release too", async () => {
    const w = await heldWorld();
    const owner = await personOf("owner", "owner");
    const res = await releaseHttp(owner.client, w.postingId);
    expect(res.status, detail(res)).toBe(200);
    expect((await postingState(w.postingId)).payable_account_hold).toBe(false);
    expect(await auditRows(w.postingId)).toHaveLength(1);
  });

  it("[legend-6qp12-release-then-return-frozen] after release the next return journals exactly once against the FROZEN account A, never today's mapping C; a second release is 409 and adds nothing", async () => {
    const w = await heldWorld();
    const finance = await personOf("finance return", "finance");
    const { firstStepDone } = await returnWhileHeld(w);

    const released = await releaseHttp(finance.client, w.postingId);
    expect(released.status, detail(released)).toBe(200);

    // Finance has meanwhile moved the role to C: the return must still use A.
    await setPayableMapping(C);
    const before = await books();
    if (!firstStepDone) await returnItems(w.batchId, [w.itemId], APP);
    expect((await W.itemOfPerson(w.batchId, BUDI)).status).toBe("succeeded");
    await returnItems(w.batchId, [w.itemId], APP3);
    expect((await W.itemOfPerson(w.batchId, BUDI)).status).toBe("returned");

    const key = `payroll-payout-return:${w.itemId}`;
    expect(await W.countJournals(key), "journaled exactly once").toBe(1);
    expect(await W.journalByKey(key)).toEqual({
      "1103": { debit: NET, credit: 0 },
      [A]: { debit: 0, credit: NET },
    });
    const moved = movedSince(before, await books());
    expect(moved[A], "the employee is owed on A again").toEqual({
      debit: 0,
      credit: NET,
    });
    expect(moved[B]).toEqual(untouched);
    expect(moved[C], "today's mapping never sees the return").toEqual(
      untouched,
    );

    // Replays: second release 409; a repeated return adds nothing.
    const journals = await journalCountOfEntity();
    const again = await releaseHttp(finance.client, w.postingId);
    expect(again.status, detail(again)).toBe(409);
    expect(codeOf(again)).toBe("PAYOUT_GL_ALREADY_RESOLVED");
    await W.expectRefused(returnItems(w.batchId, [w.itemId], APP));
    expect(await W.countJournals(key)).toBe(1);
    expect(await journalCountOfEntity(), "no extra journal").toBe(journals);
    expect(await auditRows(w.postingId)).toHaveLength(1);
  });

  it("[legend-6qp12-concurrent] two releases at the same time: exactly one 200, the other 409 PAYOUT_GL_ALREADY_RESOLVED, one audit row, no journal", async () => {
    const w = await heldWorld();
    const first = await personOf("finance race 1", "finance");
    const second = await personOf("finance race 2", "finance");
    const journalsBefore = await journalCountOfEntity();

    // A rival connection holds the posting row so both requests queue on it,
    // then lets go. The assertions hold for every interleaving.
    const raw: PoolClient = await W.owner.connect();
    let results: Res[] = [];
    try {
      await raw.query("BEGIN");
      await raw.query("SELECT set_config('app.tenant_id', $1, true)", [
        tenantId(),
      ]);
      await raw.query(
        `SELECT id FROM payroll_payout_gl_postings WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [tenantId(), w.postingId],
      );
      const rawPid = Number(
        (await raw.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
      );
      let settled = 0;
      const running = Promise.all(
        [first, second].map((who) =>
          releaseHttp(who.client, w.postingId).finally(() => {
            settled += 1;
          }),
        ),
      );
      for (let i = 0; i < 200 && settled < 2; i++) {
        const blocked = Number(
          (
            await W.owner.query(
              `SELECT count(*)::int AS n FROM pg_stat_activity
                WHERE $1 = ANY(pg_blocking_pids(pid))`,
              [rawPid],
            )
          ).rows[0].n,
        );
        if (blocked > 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      await raw.query("ROLLBACK");
      results = await running;
    } finally {
      await raw.query("ROLLBACK").catch(() => undefined);
      raw.release();
    }

    expect(
      results.map((r) => r.status).sort(),
      results.map(detail).join(" | "),
    ).toEqual([200, 409]);
    const loser = results.find((r) => r.status === 409)!;
    expect(codeOf(loser)).toBe("PAYOUT_GL_ALREADY_RESOLVED");
    expect(await auditRows(w.postingId), "one success audit").toHaveLength(1);
    const state = await postingState(w.postingId);
    expect(state.payable_account_hold).toBe(false);
    expect([first.userId, second.userId]).toContain(
      state.payable_hold_released_by,
    );
    expect(await journalCountOfEntity(), "no journal").toBe(journalsBefore);
  });
});

// ================================================================================
describe("1184 6qp12: refused without effect", () => {
  let shared: Promise<Held> | undefined;
  const world = () => (shared ??= heldWorld());

  it("[legend-6qp12-self-approval] the person who created the batch cannot release its posting: 403 PAYOUT_GL_SELF_APPROVAL", async () => {
    const w = await heldWorld();
    const creator = await personOf("finance creator", "finance");
    await setBatchCreator(w.batchId, creator.userId);
    const journals = await journalCountOfEntity();
    const res = await releaseHttp(creator.client, w.postingId);
    await expectRefusedUntouched(res, [403], w.postingId, journals, "creator");
    expect(codeOf(res)).toBe("PAYOUT_GL_SELF_APPROVAL");
  });

  for (const template of ["hr", "general_manager", "tenant_admin"] as const) {
    it(`[legend-6qp12-no-permission-${template}] ${template} does not have payroll.payout.gl_resolve: 403, nothing changes`, async () => {
      const w = await world();
      const person = await personOf(`denied ${template}`, template);
      const journals = await journalCountOfEntity();
      const res = await releaseHttp(person.client, w.postingId);
      await expectRefusedUntouched(
        res,
        [403],
        w.postingId,
        journals,
        template,
      );
    });
  }

  it("[legend-6qp12-no-session] without a session: 401, nothing changes", async () => {
    const w = await world();
    const journals = await journalCountOfEntity();
    const res = (await agent(W.app)
      .post(releasePath(w.postingId))
      .set(originHeader)
      .send({ password: PASSWORD, note: NOTE })) as unknown as Res;
    await expectRefusedUntouched(res, [401], w.postingId, journals, "anon");
  });

  it("[legend-6qp12-stale-stepup] an MFA step-up older than 15 minutes is refused 401 REAUTH_REQUIRED even with the right password", async () => {
    const w = await world();
    const person = await makePerson("stale", "finance");
    const aged = await W.owner.query(
      `UPDATE "session"
          SET created_at = now() - interval '30 minutes',
              mfa_verified_at = now() - interval '16 minutes',
              mfa_challenge_verified_at = CASE WHEN mfa_challenge_verified_at IS NULL
                THEN NULL ELSE now() - interval '16 minutes' END
        WHERE revoked_at IS NULL AND user_id = $1
          AND id NOT LIKE 'payout-fixture-session-%'`,
      [person.userId],
    );
    expect(aged.rowCount, "premise: the session was aged").toBe(1);
    const journals = await journalCountOfEntity();
    const res = await releaseHttp(person.client, w.postingId);
    await expectRefusedUntouched(res, [401], w.postingId, journals, "stale");
    expect(codeOf(res)).toBe("REAUTH_REQUIRED");
  });

  it("[legend-6qp12-no-mfa] a finance user with no second factor enrolled is refused (401/403), nothing changes", async () => {
    const w = await world();
    const person = await personOf("finance no mfa", "finance", false);
    const journals = await journalCountOfEntity();
    const res = await releaseHttp(person.client, w.postingId);
    await expectRefusedUntouched(
      res,
      [401, 403],
      w.postingId,
      journals,
      "no mfa",
    );
  });

  it("[legend-6qp12-wrong-password] a wrong password is refused 401/403, nothing changes", async () => {
    const w = await world();
    const person = await personOf("finance wrong password", "finance");
    const journals = await journalCountOfEntity();
    const res = await releaseHttp(person.client, w.postingId, {
      password: WRONG,
      note: NOTE,
    });
    await expectRefusedUntouched(
      res,
      [401, 403],
      w.postingId,
      journals,
      "wrong password",
    );
  });

  it("[legend-6qp12-missing-password] no password at all is refused (401, or 422 for the strict body), nothing changes", async () => {
    const w = await world();
    const person = await personOf("finance no password", "finance");
    const journals = await journalCountOfEntity();
    const res = await releaseHttp(person.client, w.postingId, { note: NOTE });
    await expectRefusedUntouched(
      res,
      [401, 422],
      w.postingId,
      journals,
      "no password",
    );
  });

  it("[legend-6qp12-bad-note] a blank, whitespace-only, missing or over-long note is refused (400/422), nothing changes", async () => {
    const w = await world();
    const person = await personOf("finance bad note", "finance");
    const journals = await journalCountOfEntity();
    const bodies: Record<string, Record<string, unknown>> = {
      empty: { password: PASSWORD, note: "" },
      whitespace: { password: PASSWORD, note: "   \n\t " },
      missing: { password: PASSWORD },
      "too long": { password: PASSWORD, note: "x".repeat(1001) },
      "unknown field": { password: PASSWORD, note: NOTE, extra: true },
    };
    for (const [label, body] of Object.entries(bodies)) {
      const res = await releaseHttp(person.client, w.postingId, body);
      await expectRefusedUntouched(res, [400, 422], w.postingId, journals, label);
    }
  });

  it("[legend-6qp12-other-tenant] a posting of another tenant is 404 PAYOUT_GL_POSTING_NOT_FOUND and stays untouched; so does an id that does not exist", async () => {
    const w = await world();
    const person = await personOf("finance isolation", "finance");
    const foreignTenant = randomUUID();
    const foreignPosting = randomUUID();
    foreignTenants.push(foreignTenant);
    await W.asTenant(async (c) => {
      await c.query(
        `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
         SELECT $1, $2, 'Payout 1184 hold tenant B', plan, status, deployment_mode, feature_flags, limits, created_by
           FROM tenants WHERE id = $3`,
        [foreignTenant, `payout-1184h-${foreignTenant.slice(0, 8)}`, tenantId()],
      );
      // A copy of the held posting under another tenant (FKs are off with guards off).
      await c.query(
        `INSERT INTO payroll_payout_gl_postings
         SELECT (jsonb_populate_record(NULL::payroll_payout_gl_postings,
                  to_jsonb(p) || jsonb_build_object('id', $1::text, 'tenant_id', $2::text))).*
           FROM payroll_payout_gl_postings p WHERE p.tenant_id = $3 AND p.id = $4`,
        [foreignPosting, foreignTenant, tenantId(), w.postingId],
      );
    }, true);

    const journals = await journalCountOfEntity();
    const res = await releaseHttp(person.client, foreignPosting);
    expect(res.status, detail(res)).toBe(404);
    expect(codeOf(res)).toBe("PAYOUT_GL_POSTING_NOT_FOUND");
    const [foreign] = (
      await W.owner.query(
        `SELECT payable_account_hold, payable_hold_released_at
           FROM payroll_payout_gl_postings WHERE tenant_id = $1 AND id = $2`,
        [foreignTenant, foreignPosting],
      )
    ).rows;
    expect(foreign.payable_account_hold, "foreign row untouched").toBe(true);
    expect(foreign.payable_hold_released_at).toBeNull();
    expect(await auditRows(foreignPosting)).toHaveLength(0);
    expect(await journalCountOfEntity()).toBe(journals);
    expectStillHeld(await postingState(w.postingId), "own posting");

    const missing = await releaseHttp(person.client, randomUUID());
    expect(missing.status, detail(missing)).toBe(404);
    expect(codeOf(missing)).toBe("PAYOUT_GL_POSTING_NOT_FOUND");
  });

  it("[legend-6qp12-frozen-account-unknown] a held posting with no frozen payable account and no lock journal is refused 409 PAYOUT_PAYABLE_ACCOUNT_UNKNOWN: release must not fall back to today's mapping; still held, no audit, no journal", async () => {
    const w = await heldWithoutFrozenAccount();
    const person = await personOf("finance frozen null", "finance");
    const journals = await journalCountOfEntity();
    // Today's mapping points somewhere else than the (unknown) original account.
    await setPayableMapping(B);
    const res = await releaseHttp(person.client, w.postingId);
    await expectRefusedUntouched(res, [409], w.postingId, journals, "unknown");
    expect(codeOf(res)).toBe("PAYOUT_PAYABLE_ACCOUNT_UNKNOWN");
    expect((await postingState(w.postingId)).salaries_payable_account_id).toBe(
      null,
    );
  });

  // Fix round 1 (F1): release needs proof. The settle journal must exist and
  // debit exactly the frozen account; otherwise the row stays held.
  it("[legend-6qp12-settle-debited-other-account] the settle journal debited a DIFFERENT payable account (B) than the frozen one (A): 409 PAYOUT_PAYABLE_ACCOUNT_UNKNOWN, still held, no audit, no journal", async () => {
    const w = await heldWorld();
    const person = await personOf("finance other account", "finance");
    // Re-point the debit line of the settle journal from A to B (setup by SQL, guards off).
    await W.asTenant(
      (c) =>
        c.query(
          `UPDATE journal_lines SET account_id = $4
            WHERE tenant_id = $1 AND account_id = $3
              AND entry_id = (SELECT id FROM journal_entries
                               WHERE tenant_id = $1 AND legal_entity_id = $2
                                 AND idempotency_key = $5)`,
          [
            tenantId(),
            W.entityId(),
            await accountId(A),
            await accountId(B),
            w.journalKey,
          ],
        ),
      true,
    );
    expect(await W.journalByKey(w.journalKey), "premise: debit moved to B").toEqual(
      { [B]: { debit: NET, credit: 0 }, "1103": { debit: 0, credit: NET } },
    );
    const journals = await journalCountOfEntity();
    const res = await releaseHttp(person.client, w.postingId);
    await expectRefusedUntouched(res, [409], w.postingId, journals, "other account");
    expect(codeOf(res)).toBe("PAYOUT_PAYABLE_ACCOUNT_UNKNOWN");
  });

  it("[legend-6qp12-null-frozen-with-settle-journal] a held settle posting whose frozen account is NULL: 409 PAYOUT_PAYABLE_ACCOUNT_UNKNOWN, still held, no audit", async () => {
    const w = await heldWorld();
    const person = await personOf("finance null frozen", "finance");
    await W.asTenant(
      (c) =>
        c.query(
          `UPDATE payroll_payout_gl_postings SET salaries_payable_account_id = NULL
            WHERE tenant_id = $1 AND id = $2`,
          [tenantId(), w.postingId],
        ),
      true,
    );
    const journals = await journalCountOfEntity();
    const res = await releaseHttp(person.client, w.postingId);
    await expectRefusedUntouched(res, [409], w.postingId, journals, "null frozen");
    expect(codeOf(res)).toBe("PAYOUT_PAYABLE_ACCOUNT_UNKNOWN");
  });

  it("[legend-6qp12-settle-journal-missing] the settle journal of the posting does not exist: 409 PAYOUT_PAYABLE_ACCOUNT_UNKNOWN, still held, no audit", async () => {
    const w = await heldWorld();
    const person = await personOf("finance no journal", "finance");
    await W.asTenant(
      (c) =>
        c.query(
          `UPDATE payroll_payout_gl_postings SET journal_key = $3
            WHERE tenant_id = $1 AND id = $2`,
          [tenantId(), w.postingId, `missing-settle-${randomUUID()}`],
        ),
      true,
    );
    const journals = await journalCountOfEntity();
    const res = await releaseHttp(person.client, w.postingId);
    await expectRefusedUntouched(res, [409], w.postingId, journals, "no journal");
    expect(codeOf(res)).toBe("PAYOUT_PAYABLE_ACCOUNT_UNKNOWN");
  });
});
