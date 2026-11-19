// Payout t1ufu (bead legend-t1ufu, tier K: money; SO 1173 P2-1): fail-closed
// re-raise of recon flags. Written fail-first from the card text
// (docs/briefs/sub-1179-payout-so1173.md, "Ronde 2") and from the sibling tests
// payroll-payout-q2nkl-lock-waiter and payroll-payout-990-recon-reopen, NOT from
// the implementation.
//
// Rules under test (CTO decision: a cancelled hold means a payout can go out, so
// when in doubt the slip stays held):
// - A flag that fails for ONE row must not roll back the other flags of the same
//   chunk (one savepoint per row), on both paths:
//   * a NEW flag that cannot be written: the other new flags of the page are
//     still committed, and the page still fails (fail-closed: the cursor does not
//     advance, so the next run retries the failed row);
//   * a KNOWN flag that cannot be raised again: it is recorded as failed, the
//     page does not throw, and the other known flags of the chunk still get
//     their new sighting.
// - A second lock timeout on the same Jakarta day, after the first lock flag was
//   closed by two people, must never leave the slip free: either the new episode
//   flag is written, or the page fails. The best-effort re-raise path may not
//   swallow a failure and leave the old clearance in force.
//
// Assumptions (the card leaves them open, stated so they can be contested):
// - Failure is induced as in 990 phase 6: a temporary trigger of the table owner
//   that refuses one INSERT (on the exceptions table for a new flag, on the
//   sightings table for a re-raise). It is dropped in `finally`.
// - Counters of the page result (flagged, reraised, reraiseFailed) may change, so
//   only database state, the thrown/not thrown outcome and the hold are asserted.
// - "The page fails" = `reconcileTrustedPayouts` rejects; for the lock case both
//   "episode flag written" and "page rejects" are accepted, a finished run with
//   the slip free is not.
// - Changing `last_response_code` of an item changes the flag fingerprint, so a
//   re-raise adds a sighting (990 phase 5 A).
// - The lock case needs a stuck holder (run A inside a held storage read), as in
//   q2nkl; the first lock flag is closed after the holder ended (legend-jsrcs).
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { pool as appPool } from "../db/index.ts";
import { totpCode, totpStep } from "../lib/totp.ts";
import { originHeader } from "./helpers.ts";
import {
  APP,
  APP3,
  bank,
  BUDI,
  installPayoutWorld,
  uploadEvidence,
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("t1ufureraise");
const NET = 1_000_000;
const PASSWORD = "Test-password-123!";
const REASON = "Sudah dicek manual, berkas bukti sudah diperiksa ulang";
const FLAGS = "/api/hris/payroll/payout-recon-flags";
const CLEARANCES = "/api/hris/payroll/payout-recon-clearances";
const EXCEPTIONS = "payroll_payout_recon_exceptions";
const CLEARANCE_TABLE = "payroll_payout_recon_clearances";
const SIGHTINGS = "payroll_payout_recon_flag_sightings";
const OBSERVATIONS = "payroll_payout_recon_evidence_observations";
const GRANTS = "payroll_payout_grants";
const BYTES_A = "t1ufu tampered proof bytes A";
const HANG_BOUND_MS = 15_000;
const TEST_TIMEOUT_MS = 120_000;

const personIds: string[] = [];
const enrolledUsers: string[] = [];
const mfaOwner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

// ---- People (HTTP, TOTP enrolled in this very session) --------------------------------

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
    [W.tenantId, `Template ${key} t1ufu`, key],
  );
  return (await read()).rows[0]!.id;
}

async function makePerson(label: string, template: "owner" | "finance") {
  const { client, userId } = await W.signedInClient(`Reraise t1ufu ${label}`);
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

let proposer: Person;
let approverA: Person;

// ---- HTTP ----------------------------------------------------------------------------------

type Res = {
  status: number;
  body: Row & { data?: Row; error?: { code?: string } };
};
const detail = (res: Res) => JSON.stringify(res.body);

const proposeHttp = (who: Person, flagId: string, reason: string) =>
  who.client
    .post(`${FLAGS}/${flagId}/clearance`)
    .set(originHeader)
    .send({ reason, password: PASSWORD }) as unknown as Promise<Res>;
const approveHttp = (who: Person, clearanceId: string) =>
  who.client
    .post(`${CLEARANCES}/${clearanceId}/approve`)
    .set(originHeader)
    .send({ password: PASSWORD }) as unknown as Promise<Res>;

/** The two-person clearance of one flag as the evidence is now. */
async function clearFlag(flagId: string) {
  const proposed = await proposeHttp(proposer, flagId, REASON);
  expect(proposed.status, `premise: propose ${detail(proposed)}`).toBe(201);
  const clearanceId = (proposed.body.data?.clearanceId ??
    proposed.body.clearanceId) as string;
  expect(clearanceId, `clearance id: ${detail(proposed)}`).toBeTruthy();
  const approved = await approveHttp(approverA, clearanceId);
  expect(approved.status, `premise: approve ${detail(approved)}`).toBe(200);
}

// ---- Rows ----------------------------------------------------------------------------------

const exceptionRows = (itemId: string) =>
  W.rowsOf(
    `SELECT * FROM ${EXCEPTIONS} WHERE tenant_id = $1 AND item_id = $2 ORDER BY id`,
    [W.tenantId, itemId],
  );
async function lockedFlags(itemId: string) {
  return (await exceptionRows(itemId)).filter((f) =>
    String(f.reason).includes("evidence_read_locked"),
  );
}
async function sightingCount(flagIds: string[]) {
  if (flagIds.length === 0) return 0;
  const [row] = await W.rowsOf(
    `SELECT count(*)::int AS n FROM ${SIGHTINGS}
      WHERE tenant_id = $1 AND exception_id = ANY($2::uuid[])`,
    [W.tenantId, flagIds],
  );
  return row!.n as number;
}
async function heldBySql(payslipId: string) {
  const [row] = await W.rowsOf(
    `SELECT app.payout_payslip_held_by_recon($1::uuid, $2::uuid) AS held`,
    [W.tenantId, payslipId],
  );
  return row!.held as boolean;
}
async function observedStates(operationId: string) {
  const rows = await W.rowsOf(
    `SELECT state FROM ${OBSERVATIONS} WHERE tenant_id = $1 AND operation_id = $2
      ORDER BY observed_at, id`,
    [W.tenantId, operationId],
  );
  return rows.map((r) => r.state as string);
}

/** Everything that moves money for the tenant: counts and the item status. */
async function moneySnapshot(itemId: string) {
  const count = async (table: string, extra = "") => {
    const [row] = await W.rowsOf(
      `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1${extra}`,
      [W.tenantId],
    );
    return row!.n as number;
  };
  const [item] = await W.rowsOf(
    `SELECT status FROM payroll_disbursement_items WHERE tenant_id = $1 AND id = $2`,
    [W.tenantId, itemId],
  );
  return {
    batches: await count("payroll_disbursement_batches"),
    items: await count("payroll_disbursement_items"),
    glPostings: await count("payroll_payout_gl_postings"),
    journalEntries: await count("journal_entries"),
    grants: await count(GRANTS, " AND kind <> 'recon_clear'"),
    itemStatus: item!.status as string,
  };
}

/** A non-volatile column of the item changes: the fingerprint of its flags changes. */
const changeItemData = (itemId: string, value = "FORGED-T1UFU") =>
  W.asTenant(
    (c) =>
      c.query(
        `UPDATE payroll_disbursement_items SET last_response_code = $3
          WHERE tenant_id = $1 AND id = $2`,
        [W.tenantId, itemId, value],
      ),
    true,
  );

/**
 * A temporary trigger of the table owner that refuses INSERTs of `table` that match
 * `when` (a SQL condition on NEW). Returns the function that drops it.
 */
async function blockInserts(table: string, when: string) {
  const guard = `t1ufu_block_${randomUUID().replaceAll("-", "")}`;
  await W.asTenant(async (c) => {
    await c.query(
      `CREATE FUNCTION ${guard}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test: insert refused'; END $$`,
    );
    await c.query(
      `CREATE TRIGGER ${guard} BEFORE INSERT ON ${table} FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION ${guard}()`,
    );
  }, true);
  return () =>
    W.asTenant(async (c) => {
      await c.query(`DROP TRIGGER IF EXISTS ${guard} ON ${table}`);
      await c.query(`DROP FUNCTION IF EXISTS ${guard}()`);
    }, true);
}
const uuidList = (ids: string[]) => ids.map((id) => `'${id}'`).join(",");

// ---- A storage the test controls -----------------------------------------------------------

type Gate = {
  reached: Promise<void>;
  signalReached: () => void;
  end: (how: "return" | "reject") => void;
  ended: Promise<"return" | "reject">;
  isEnded: () => boolean;
};
const gates: Gate[] = [];
function makeGate(): Gate {
  let signalReached!: () => void;
  let end!: (how: "return" | "reject") => void;
  let done = false;
  const reached = new Promise<void>((r) => (signalReached = r));
  const ended = new Promise<"return" | "reject">((r) => {
    end = (how) => {
      done = true;
      r(how);
    };
  });
  const gate: Gate = {
    reached,
    signalReached,
    end,
    ended,
    isEnded: () => done,
  };
  gates.push(gate);
  return gate;
}

/** `tampered` keys return other bytes; `hold` blocks the read of `holdKey`. */
type StorageOptions = { tampered?: string[]; holdKey?: string; hold?: Gate };
function makeStorage(options: StorageOptions = {}) {
  const base = W.proofs().storage;
  const real = (context: unknown, input: unknown) =>
    (base.get as (c: unknown, i: unknown) => Promise<Record<string, unknown>>)(
      context,
      input,
    );
  return {
    async get(context: unknown, input: { key: string }) {
      if (options.hold && input.key === options.holdKey) {
        options.hold.signalReached();
        if ((await options.hold.ended) === "reject")
          throw new Error("storage went away");
        return real(context, input);
      }
      const object = await real(context, input);
      return options.tampered?.includes(input.key)
        ? { ...object, content: BYTES_A }
        : object;
    },
  };
}

type PageResult = {
  operations: number;
  last: string | null;
  unreadable: number;
};

/** The night run over all pages of the tenant; `extra` are the options under test. */
async function runRecon(
  storage: unknown,
  extra: Record<string, unknown> = {},
): Promise<{ unreadable: number; pages: number }> {
  const mod =
    (await import("../services/payroll-payout-recon.service.ts")) as Record<
      string,
      unknown
    >;
  const run = mod.reconcileTrustedPayouts as (
    context: unknown,
    options: unknown,
  ) => Promise<PageResult>;
  expect(run, "the recon service exports reconcileTrustedPayouts").toBeTypeOf(
    "function",
  );
  let after: string | null = null;
  let unreadable = 0;
  for (let page = 1; page <= 1000; page += 1) {
    const result = await run(W.scope(), { storage, after, ...extra });
    unreadable += result.unreadable;
    if (result.last === null || result.operations === 0)
      return { unreadable, pages: page };
    after = result.last;
  }
  throw new Error("recon did not finish");
}

type Outcome<T> =
  | { kind: "done"; value: T }
  | { kind: "threw"; error: string }
  | { kind: "hung" };
async function within<T>(promise: Promise<T>, ms = HANG_BOUND_MS) {
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<Outcome<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "hung" }), ms);
  });
  try {
    return await Promise.race([
      promise.then(
        (value): Outcome<T> => ({ kind: "done", value }),
        (error: unknown): Outcome<T> => ({
          kind: "threw",
          error: String(error),
        }),
      ),
      bound,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const settle = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => String(error),
  );

// ---- Worlds --------------------------------------------------------------------------------

/** A real corrected item with a stored proof; an untouched run does not flag it. */
async function correctedWorld() {
  const slips = [bank(BUDI, NET)];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const batchId = await W.exportedBatch(runId);
  const itemId = (await W.itemsOf(batchId))[0]!.id as string;
  await W.resolve(batchId, [itemId], "failed", APP);
  await W.resolve(batchId, [itemId], "failed", APP3);
  const key = uploadEvidence(batchId, `evidt1ufu-${randomUUID()}.pdf`);
  for (const who of [proposer, approverA]) {
    const res = (await who.client
      .post(`/api/hris/payroll/disbursement-batches/${batchId}/correct-failed`)
      .set(originHeader)
      .send({
        itemIds: [itemId],
        evidenceKey: key,
        note: "Mutasi bank menunjukkan transfer ternyata berhasil",
        password: PASSWORD,
      })) as unknown as Res;
    expect([200, 201], `correct-failed ${detail(res)}`).toContain(res.status);
  }
  const [item] = await W.rowsOf(
    `SELECT status FROM payroll_disbursement_items WHERE tenant_id = $1 AND id = $2`,
    [W.tenantId, itemId],
  );
  expect(item!.status, "premise: corrected").toBe("succeeded");
  return { batchId, itemId, key };
}
type Corrected = Awaited<ReturnType<typeof correctedWorld>>;

/** Two corrected items, both with an untouched proof (no flag yet). */
async function twoCorrectedWorlds() {
  const w1 = await correctedWorld();
  const w2 = await correctedWorld();
  await runRecon(makeStorage());
  for (const w of [w1, w2])
    expect(
      await exceptionRows(w.itemId),
      "control: an untouched corrected item is not flagged",
    ).toHaveLength(0);
  return { w1, w2, tampered: [w1.key, w2.key] };
}

// ---- Setup / teardown ----------------------------------------------------------------------

async function dropAppendOnly() {
  const [exists] = await W.rowsOf(
    `SELECT to_regclass('public.${OBSERVATIONS}') IS NOT NULL AS found`,
  );
  await W.asTenant(async (c) => {
    if (exists!.found)
      await c.query(`DELETE FROM ${OBSERVATIONS} WHERE tenant_id = $1`, [
        W.tenantId,
      ]);
    await c.query(`DELETE FROM ${SIGHTINGS} WHERE tenant_id = $1`, [
      W.tenantId,
    ]);
  }, true);
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  proposer = await makePerson("Proposer", "finance");
  approverA = await makePerson("Approver A", "finance");
});

afterEach(async () => {
  for (const gate of gates.splice(0)) if (!gate.isEnded()) gate.end("return");
  for (let i = 0; i < 200 && appPool.totalCount !== appPool.idleCount; i += 1)
    await new Promise((r) => setTimeout(r, 50));
  await dropAppendOnly();
  await W.asTenant(async (c) => {
    await c.query(`DELETE FROM ${CLEARANCE_TABLE} WHERE tenant_id = $1`, [
      W.tenantId,
    ]);
    await c.query(
      `DELETE FROM ${GRANTS} WHERE tenant_id = $1 AND kind = 'recon_clear'`,
      [W.tenantId],
    );
    await c.query(`DELETE FROM ${EXCEPTIONS} WHERE tenant_id = $1`, [
      W.tenantId,
    ]);
  }, true);
});

afterAll(async () => {
  await W.asTenant(
    (c) =>
      c.query(
        `DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::uuid[])`,
        [W.tenantId, personIds],
      ),
    true,
  ).catch(() => undefined);
  if (enrolledUsers.length > 0)
    await mfaOwner.query(
      "DELETE FROM mfa_factors WHERE user_id = ANY($1::uuid[])",
      [enrolledUsers],
    );
  await mfaOwner.end();
});

/** Run A holds the operation lock inside a held storage read. */
async function startStuckHolder(key: string) {
  const gate = makeGate();
  const run = runRecon(makeStorage({ holdKey: key, hold: gate }), {
    storageTimeoutMs: 120_000,
  });
  const outcome = settle(run);
  const first = await Promise.race([
    gate.reached.then(() => "held" as const),
    outcome.then(() => "ended" as const),
  ]);
  expect(first, "setup: run A is inside the read and holds the lock").toBe(
    "held",
  );
  return { gate, run, outcome };
}

// =========================================================================
// T1: a new flag that fails does not take the other new flags of the page down
// =========================================================================

describe("t1ufu T1: one new flag that cannot be written does not roll back the others", () => {
  it(
    "[t1ufu-fresh-flag-one-fails-others-commit] two items get a hash-mismatch flag in one page; writing the flag of the first is refused: the second flag is still committed, the page fails (the cursor does not advance), and the next run, once the refusal is gone, flags the first and does not duplicate the second",
    async () => {
      const { w1, w2, tampered } = await twoCorrectedWorlds();
      const unblock = await blockInserts(
        EXCEPTIONS,
        `NEW.item_id = '${w1.itemId}'`,
      );
      try {
        const outcome = await within(runRecon(makeStorage({ tampered })));
        expect(
          outcome.kind,
          `fail-closed: the page must fail, not finish (${JSON.stringify(outcome)})`,
        ).toBe("threw");
        expect(
          (await exceptionRows(w2.itemId)).length,
          "the other row of the chunk is committed: its slip is held",
        ).toBeGreaterThan(0);
        expect(
          await exceptionRows(w1.itemId),
          "the failed row wrote nothing (rolled back alone)",
        ).toHaveLength(0);
      } finally {
        await unblock();
      }
      const secondFlags = (await exceptionRows(w2.itemId)).length;
      const retry = await within(runRecon(makeStorage({ tampered })));
      expect(retry.kind, `the retry finishes (${JSON.stringify(retry)})`).toBe(
        "done",
      );
      expect(
        (await exceptionRows(w1.itemId)).length,
        "the retry raises the flag the failed row could not write",
      ).toBeGreaterThan(0);
      expect(
        (await exceptionRows(w2.itemId)).length,
        "the retry does not duplicate the flag that was already committed",
      ).toBe(secondFlags);
    },
    TEST_TIMEOUT_MS,
  );
});

// =========================================================================
// T2: a known flag that fails to be raised again does not take the chunk down
// =========================================================================

describe("t1ufu T2: one known flag that cannot be raised again is recorded, the others still are", () => {
  it(
    "[t1ufu-reraise-one-fails-others-commit] two known flags are raised again in one chunk after their items changed; the sighting of the first is refused: the run does not throw, the second flag still gets its new sighting, the first slip stays held",
    async () => {
      const { w1, w2, tampered } = await twoCorrectedWorlds();
      await runRecon(makeStorage({ tampered }));
      const flags1 = (await exceptionRows(w1.itemId)).map(
        (f) => f.id as string,
      );
      const flags2 = (await exceptionRows(w2.itemId)).map(
        (f) => f.id as string,
      );
      expect(flags1.length, "premise: first item flagged").toBeGreaterThan(0);
      expect(flags2.length, "premise: second item flagged").toBeGreaterThan(0);
      const payslip1 = (await exceptionRows(w1.itemId))[0]!
        .payslip_id as string;
      const before1 = await sightingCount(flags1);
      const before2 = await sightingCount(flags2);

      await changeItemData(w1.itemId);
      await changeItemData(w2.itemId);
      const unblock = await blockInserts(
        SIGHTINGS,
        `NEW.exception_id IN (${uuidList(flags1)})`,
      );
      try {
        const outcome = await within(runRecon(makeStorage({ tampered })));
        expect(
          outcome.kind,
          `a known flag that fails is recorded, the run does not throw (${JSON.stringify(outcome)})`,
        ).toBe("done");
        expect(
          await sightingCount(flags1),
          "the failed flag got no new sighting",
        ).toBe(before1);
        expect(
          await sightingCount(flags2),
          "the other flag of the chunk still got its new sighting (its own savepoint)",
        ).toBeGreaterThan(before2);
        expect(
          await heldBySql(payslip1),
          "the slip of the failed flag stays held",
        ).toBe(true);
      } finally {
        await unblock();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

// =========================================================================
// T3: a second lock timeout the same day never frees the slip
// =========================================================================

describe("t1ufu T3: a second lock timeout on the same day cannot be swallowed", () => {
  it(
    "[t1ufu-second-timeout-same-day-failing-reraise-keeps-hold] the first lock flag is closed by two people; a second timeout on the SAME Jakarta day meets a refused flag write: either the new episode flag exists and holds the slip, or the page fails; the run never finishes with the slip free, and no money moves",
    async () => {
      // The slip is free with an old ok (as in q2nkl), then a first lock flag
      // for day1 is raised and closed.
      const w: Corrected = await correctedWorld();
      await runRecon(makeStorage());
      await runRecon(makeStorage({ tampered: [w.key] }));
      const mismatch = await exceptionRows(w.itemId);
      expect(mismatch.length, "premise: a mismatch flag").toBeGreaterThan(0);
      const payslipId = mismatch[0]!.payslip_id as string;
      const operationId = mismatch[0]!.operation_id as string;
      for (const f of mismatch) await clearFlag(f.id as string);
      const good = await runRecon(makeStorage());
      expect(good.unreadable, "premise: the good read is readable").toBe(0);
      const states = await observedStates(operationId);
      expect(states[states.length - 1], "premise: last observation is ok").toBe(
        "ok",
      );
      expect(await heldBySql(payslipId), "premise: free after ok").toBe(false);

      const day1 = new Date("2031-04-10T05:00:00Z"); // 12:00 Jakarta
      let a = await startStuckHolder(w.key);
      let unblock: (() => Promise<void>) | undefined;
      try {
        const first = await within(
          runRecon(makeStorage(), { lockTimeoutMs: 300, now: day1 }),
        );
        expect(first.kind, "first waiter finishes").toBe("done");
        const firstFlags = await lockedFlags(w.itemId);
        expect(firstFlags, "premise: one lock flag").toHaveLength(1);
        a.gate.end("return");
        await a.outcome;
        await clearFlag(firstFlags[0]!.id as string);
        expect(
          await heldBySql(payslipId),
          "premise: the closed lock flag frees the slip",
        ).toBe(false);
        const before = await moneySnapshot(w.itemId);
        a = await startStuckHolder(w.key);

        // The write of a new lock flag for this item is refused from now on.
        unblock = await blockInserts(
          EXCEPTIONS,
          `NEW.item_id = '${w.itemId}' AND NEW.reason LIKE '%evidence_read_locked%'`,
        );
        const second = await within(
          runRecon(makeStorage(), { lockTimeoutMs: 300, now: day1 }),
        );
        expect(
          second.kind,
          `the second waiter must not hang (${JSON.stringify(second)})`,
        ).not.toBe("hung");
        if (second.kind === "done") {
          // The run finished: then the slip may not be free.
          expect(
            await heldBySql(payslipId),
            "a finished run with a refused flag write must not leave the slip free",
          ).toBe(true);
        }
        // (A rejected page is accepted: fail-closed, the cursor does not advance.)
        expect(
          await moneySnapshot(w.itemId),
          "no money moves in either case",
        ).toEqual(before);
      } finally {
        if (unblock) await unblock();
        if (!a.gate.isEnded()) a.gate.end("return");
        await a.outcome;
      }
    },
    TEST_TIMEOUT_MS,
  );
});
