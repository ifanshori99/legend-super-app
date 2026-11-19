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
//
// Round 4 (brief "Ronde 4", CTO 19 Nov): the cursor advances when every hold is
// committed. A flag that cannot be written (or a flag transaction that fails at
// COMMIT) no longer fails the page IF the hold of each failed item was committed:
// the page resolves, its result carries `held` (flags held through a hold instead of
// written, a number > 0), `last` is filled (the cursor moves on, the next page is
// processed) and the slip stays held by the hold, so clear-approve and the pay guard
// still refuse. Only when a hold itself cannot be written does the page fail, and
// then the cursor stays (the next run tries the same page again).
// Round 4 assumptions: `held` is read from the page result (`result.held`); "the
// cursor advanced" = the page that reports `held > 0` resolved with `last` set, so the
// night run moved on to the following pages; "hold refused" is induced with a trigger
// on the holds table (the hold function inserts there); the log line of the job is
// not captured by exact text (the logger may bypass process.stdout): the sweep must
// not reject, must not leak, and must surface `held` in its result or output.
//
// Round 3 REVISI (brief "Ronde 3 REVISI", migration 0507; CTO: when writing a flag
// fails, the slip MUST stay held without depending on a row in the exceptions table).
// Design: a HOLD PER ITEM, no observation:
// - table payroll_payout_recon_unwritten_holds (append-only: tenant_id, id, kind,
//   operation_id, item_id, payslip_id, reason, created_at); function
//   app.payout_recon_hold_unwritten(p_tenant uuid, p_kind text, p_operation uuid,
//   p_items uuid[], p_reason text) inserts one hold per item (no second row while one
//   of the same key is not taken over), writes NO observation, takes no operation
//   lock; only legend_payout_recon (SET LOCAL ROLE, like observe_ok) may call it,
//   legend_app gets 42501, and only for its own tenant (PAYOUT-68).
// - app.payout_payslip_held_by_recon: the old rule OR a hold that was not taken over
//   by a flag. A good ('ok') read does NOT release a hold. Takeover (brief round 3
//   P1-3): an exception of the same (kind, operation, item) whose reason matches
//   (hold reason empty, equal, or the exception reason is the hold reason + '#n') and
//   that was flagged at or after the hold, OR is older but not cleared before the hold. Once the flag is written,
//   the exception and its two-person clearance decide.
// - A failed page leaves the slip held (SQL), the pay guard (follow-up batch) refuses.
// Assumptions (stated so they can be contested):
// - The kind, operation, item and slip of a world are read from the flag of a probe
//   run (then the recon tables are emptied again, as after each test): an untouched
//   run records nothing. The kind comes from the `kind` column of the exceptions
//   table (the contract of app.payout_recon_flag(tenant, kind, operation, item, reason)).
// - "Taken over by a flag" = an exception with the same (kind, operation_id, item_id)
//   written AFTER the hold. T3 (second lock timeout) has older exceptions with the
//   same triple (the closed flags of that item); read literally as "no exception with
//   the same triple" the hold would be void from its first second, and the slip would
//   be free. T3 asserts the CTO rule (slip stays held), so it fails on that reading.
// - The pay guard is the follow-up batch of the run (createDisbursementBatch, as in the
//   990 clear test): "refused with a 4xx and no new batch". The item of the corrected
//   world is already paid, so the refusal alone cannot tell the cause: the
//   discriminating assertion is the SQL hold; the guard assertion proves it refuses.
// - Logs: nothing the job/worker prints (console, stdout) and nothing a rejected page
//   carries (util.inspect prints `cause`) may contain the text or ids of the failing
//   query. The trigger message carries a marker for that.
// - Second kind: a returned item (route /return) with a tampered proof, to prove the
//   hold is per (kind, operation, item) and not only for corrections. The kinds
//   missing / posting_source / closure / lost resolve / return_withdraw fallback
//   cannot be induced here without their own worlds (a refused write needs a
//   flaggable difference; those flows have no cheap difference), so they are not
//   covered; two different kinds (correction, return) are.
// - "role lain" is legend_app itself (no SET ROLE), must get 42501; the call goes
//   through legend_payout_recon (SET LOCAL ROLE from legend_app) as the service does; a foreign tenant is a random tenant id in the context naming this tenant,
//   refused with no row written.
import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { pool as appPool } from "../db/index.ts";
import { totpCode, totpStep } from "../lib/totp.ts";
import { createDisbursementBatch } from "../services/payroll-payout.service.ts";
import { originHeader } from "./helpers.ts";
import {
  actorOf,
  APP,
  APP3,
  REQ,
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
const HOLDS = "payroll_payout_recon_unwritten_holds";
const BATCHES = "/api/hris/payroll/disbursement-batches";
const GRANTS = "payroll_payout_grants";
const BYTES_A = "t1ufu tampered proof bytes A";
const LEAK = "T1UFU-LEAK-MARKER";
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
      `CREATE FUNCTION ${guard}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test: insert refused ${LEAK}'; END $$`,
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
/** A flag insert that is accepted by its row but refused at COMMIT (deferred constraint trigger). */
async function blockCommit(table: string, when: string) {
  const guard = `t1ufu_commit_${randomUUID().replaceAll("-", "")}`;
  await W.asTenant(async (c) => {
    await c.query(
      `CREATE FUNCTION ${guard}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test: commit refused ${LEAK}'; END $$`,
    );
    await c.query(
      `CREATE CONSTRAINT TRIGGER ${guard} AFTER INSERT ON ${table} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION ${guard}()`,
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
  held?: number;
};

/** The night run over all pages of the tenant; `extra` are the options under test. */
async function runRecon(
  storage: unknown,
  extra: Record<string, unknown> = {},
): Promise<{
  unreadable: number;
  pages: number;
  held: number;
  results: PageResult[];
}> {
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
  let held = 0;
  const results: PageResult[] = [];
  for (let page = 1; page <= 1000; page += 1) {
    const result = await run(W.scope(), { storage, after, ...extra });
    results.push(result);
    unreadable += result.unreadable;
    held += result.held ?? 0;
    if (result.last === null || result.operations === 0)
      return { unreadable, pages: page, held, results };
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
  return { batchId, itemId, key, runId };
}
type Corrected = Awaited<ReturnType<typeof correctedWorld>>;

/** A returned item: paid, then the bank returned the money (two people, one proof). */
async function returnedWorld() {
  const slips = [bank(BUDI, NET)];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const batchId = await W.exportedBatch(runId);
  await W.confirm(batchId, W.succeedItems(batchId, await W.itemsOf(batchId)));
  const itemId = (await W.itemsOf(batchId))[0]!.id as string;
  const key = uploadEvidence(batchId, `evidt1ufuret-${randomUUID()}.pdf`);
  for (const who of [proposer, approverA]) {
    const res = (await who.client
      .post(`${BATCHES}/${batchId}/return`)
      .set(originHeader)
      .send({
        itemIds: [itemId],
        evidenceKey: key,
        bankRef: `TRX${key.replace(/\W/g, "").slice(-16)}`,
        note: "Bank mengembalikan dana transfer",
        password: PASSWORD,
      })) as unknown as Res;
    expect([200, 201], `return ${detail(res)}`).toContain(res.status);
  }
  const [item] = await W.rowsOf(
    `SELECT status FROM payroll_disbursement_items WHERE tenant_id = $1 AND id = $2`,
    [W.tenantId, itemId],
  );
  expect(item!.status, "premise: returned").toBe("returned");
  return { batchId, itemId, key, runId };
}

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

// ---- Round 3 helpers -----------------------------------------------------------------------

type Outcome3 = { code: string | undefined; message: string; rows: Row[] };
/** legend_app (optionally then `innerRole`) in `tenantId`'s context, one statement, real COMMIT. */
async function sqlAs(
  sqlText: string,
  params: unknown[],
  tenantId: string = W.tenantId,
  innerRole?: string,
): Promise<Outcome3> {
  const client = await W.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    try {
      if (innerRole) await client.query(`SET LOCAL ROLE ${innerRole}`);
      const result = await client.query(sqlText, params);
      await client.query("COMMIT");
      return { code: undefined, message: "", rows: result.rows as Row[] };
    } catch (error) {
      const e = error as { code?: string; message?: string };
      await client.query("ROLLBACK").catch(() => undefined);
      return { code: e.code ?? "unknown", message: e.message ?? "", rows: [] };
    }
  } finally {
    client.release();
  }
}
const HOLD_SQL = `SELECT app.payout_recon_hold_unwritten($1::uuid, $2::text, $3::uuid, $4::uuid[], $5::text)`;
/** `role` defaults to legend_payout_recon (the service's way); `null` = plain legend_app. */
const holdUnwritten = (
  kind: string,
  operationId: string,
  itemIds: string[],
  tenantId?: string,
  role: string | null = "legend_payout_recon",
  reason: string | null = null,
) =>
  sqlAs(
    HOLD_SQL,
    [W.tenantId, kind, operationId, itemIds, reason],
    tenantId,
    role ?? undefined,
  );
const holdRows = async (itemId: string) =>
  W.rowsOf(
    `SELECT * FROM ${HOLDS} WHERE tenant_id = $1 AND item_id = $2 ORDER BY created_at, id`,
    [W.tenantId, itemId],
  );

type Probe = {
  payslipId: string;
  operationId: string;
  itemId: string;
  kind: string;
};
/**
 * The slip, operation, item and kind of a world. An untouched run records nothing, so
 * they are read from the flag a tampered run raises; the recon tables are then emptied
 * again (as after each test): no flag, no observation, no clearance, no hold.
 */
async function slipOf(w: { key: string; itemId: string }): Promise<Probe> {
  await runRecon(makeStorage({ tampered: [w.key] }));
  const flags = await exceptionRows(w.itemId);
  expect(
    flags.length,
    "premise: the probe run flagged the item",
  ).toBeGreaterThan(0);
  const ids = {
    payslipId: flags[0]!.payslip_id as string,
    operationId: flags[0]!.operation_id as string,
    itemId: w.itemId,
    kind: flags[0]!.kind as string,
  };
  await resetRecon();
  return ids;
}
const lastState = async (operationId: string) => {
  const states = await observedStates(operationId);
  return states[states.length - 1];
};

const followUpBatch = (runId: string) =>
  W.inTx((tx) =>
    createDisbursementBatch(tx, actorOf(REQ), {
      payrollRunId: runId,
      channel: "manual_bank",
    } as never),
  );
const batchCount = async (runId: string) => {
  const [row] = await W.rowsOf(
    `SELECT count(*)::int AS n FROM payroll_disbursement_batches
      WHERE tenant_id = $1 AND payroll_run_id = $2`,
    [W.tenantId, runId],
  );
  return row!.n as number;
};
/** The pay guard: a follow-up batch for the run is refused (4xx) and no batch appears. */
async function expectPayGuardRefuses(runId: string, label: string) {
  const before = await batchCount(runId);
  await W.expectRefused(followUpBatch(runId));
  expect(await batchCount(runId), `${label}: no new batch`).toBe(before);
}

/** Everything printed to console / stdout / stderr while `work` runs. */
async function captureOutput<T>(work: () => Promise<T>) {
  const lines: string[] = [];
  const take = (...args: unknown[]) => {
    lines.push(
      args
        .map((a) => (typeof a === "string" ? a : inspect(a, { depth: 10 })))
        .join(" "),
    );
  };
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(take as never),
  );
  const out = vi.spyOn(process.stdout, "write").mockImplementation(((
    c: unknown,
  ) => {
    take(String(c));
    return true;
  }) as never);
  const err = vi.spyOn(process.stderr, "write").mockImplementation(((
    c: unknown,
  ) => {
    take(String(c));
    return true;
  }) as never);
  try {
    return { value: await work(), lines };
  } finally {
    for (const spy of [...spies, out, err]) spy.mockRestore();
  }
}

// ---- Setup / teardown ----------------------------------------------------------------------

async function dropAppendOnly() {
  const [exists] = await W.rowsOf(
    `SELECT to_regclass('public.${OBSERVATIONS}') IS NOT NULL AS found`,
  );
  const [holdsTable] = await W.rowsOf(
    `SELECT to_regclass('public.${HOLDS}') IS NOT NULL AS found`,
  );
  await W.asTenant(async (c) => {
    if (holdsTable!.found)
      await c.query(`DELETE FROM ${HOLDS} WHERE tenant_id = $1`, [W.tenantId]);
    if (exists!.found)
      await c.query(`DELETE FROM ${OBSERVATIONS} WHERE tenant_id = $1`, [
        W.tenantId,
      ]);
    await c.query(`DELETE FROM ${SIGHTINGS} WHERE tenant_id = $1`, [
      W.tenantId,
    ]);
  }, true);
}

async function resetRecon() {
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
  await resetRecon();
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
    "[t1ufu-fresh-flag-one-fails-others-commit] two items get a hash-mismatch flag in one page; writing the flag of the first is refused: the second flag is still committed, the first slip is held by a hold, the page resolves with held > 0 and the cursor advances, and the next run, once the refusal is gone, flags the first and does not duplicate the second",
    async () => {
      const { w1, w2, tampered } = await twoCorrectedWorlds();
      const slip1 = await slipOf(w1);
      const unblock = await blockInserts(
        EXCEPTIONS,
        `NEW.item_id = '${w1.itemId}'`,
      );
      try {
        const outcome = await within(runRecon(makeStorage({ tampered })));
        // Round 4: the hold of the failed row committed, so the page resolves and the
        // cursor moves on; the slip is held by the hold.
        expect(
          outcome.kind,
          `the hold committed: the page resolves, it does not fail (${JSON.stringify(outcome)})`,
        ).toBe("done");
        if (outcome.kind === "done") {
          expect(
            outcome.value.held,
            "the failed flag is reported as held (a hold, not a written flag)",
          ).toBeGreaterThan(0);
          const heldPage = outcome.value.results.find((r) => (r.held ?? 0) > 0);
          expect(
            heldPage?.last,
            "the cursor advanced on the page with a held flag",
          ).toBeTruthy();
        }
        expect(
          (await holdRows(w1.itemId)).length,
          "the failed row left a hold row",
        ).toBeGreaterThan(0);
        expect(
          await heldBySql(slip1.payslipId),
          "the slip of the failed row is held although it has no exception row",
        ).toBe(true);
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
    "[t1ufu-second-timeout-same-day-failing-reraise-keeps-hold] the first lock flag is closed by two people; a second timeout on the SAME Jakarta day meets a refused flag write: either the new episode flag exists and holds the slip, or the page fails; the page resolves (held > 0, cursor advances) because the hold committed, the slip stays held, and no money moves",
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
      expect(
        await heldBySql(payslipId),
        "premise: free, nothing recorded",
      ).toBe(false);

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
        // Round 3: finished or rejected, the slip is held at once, with no new row in
        // the exceptions table needed (the write of the episode flag was refused).
        expect(
          await heldBySql(payslipId),
          `a failed flag write must leave the slip held (${JSON.stringify(second)})`,
        ).toBe(true);
        // Round 4: the hold committed, so the page resolves (held > 0), cursor moves on.
        expect(
          second.kind,
          "the page resolves because the hold committed",
        ).toBe("done");
        if (second.kind === "done") {
          expect(
            second.value.held,
            "the refused episode flag is reported as held",
          ).toBeGreaterThan(0);
          expect(
            second.value.results.find((r) => (r.held ?? 0) > 0)?.last,
            "the cursor advanced on the page with a held flag",
          ).toBeTruthy();
        }
        expect(
          (await holdRows(w.itemId)).length,
          "the refused flag left a hold row for the item",
        ).toBeGreaterThan(0);
        expect(
          await lockedFlags(w.itemId),
          "premise: the refused episode flag is not on record",
        ).toHaveLength(1);
        // Clear-approve: if the old lock flag can be proposed again, its approval is
        // refused (409) and nothing is approved (the last observation is not settled).
        const reproposed = await proposeHttp(
          proposer,
          firstFlags[0]!.id as string,
          REASON,
        );
        if (reproposed.status === 201) {
          const clearanceId = (reproposed.body.data?.clearanceId ??
            reproposed.body.clearanceId) as string;
          const approved = await approveHttp(approverA, clearanceId);
          expect(approved.status, `approve refused: ${detail(approved)}`).toBe(
            409,
          );
        }
        expect(
          await heldBySql(payslipId),
          "still held after the clearance attempt",
        ).toBe(true);
        await expectPayGuardRefuses(w.runId, "second timeout, refused write");
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

// =========================================================================
// Round 3: a flag that cannot be written still holds the slip
// =========================================================================

/**
 * One world, one refused flag write: the page fails, there is no exception row, the
 * slip is held by the hold of the item, the pay guard refuses, no money moves. Then a
 * good read does not release it; the retry writes the flag and the clearance by two
 * people decides (the hold row stays, append-only, but no longer holds anything).
 */
async function refusedWriteScenario(
  w: { itemId: string; key: string; runId: string },
  label: string,
) {
  await runRecon(makeStorage());
  const probe = await slipOf(w);
  const { payslipId, operationId, kind } = probe;
  expect(await heldBySql(payslipId), `${label} premise: free`).toBe(false);
  expect(await exceptionRows(w.itemId), "premise: no flag").toHaveLength(0);
  const before = await moneySnapshot(w.itemId);

  const unblock = await blockInserts(EXCEPTIONS, `NEW.item_id = '${w.itemId}'`);
  try {
    const outcome = await within(runRecon(makeStorage({ tampered: [w.key] })));
    expect(
      outcome.kind,
      `the hold committed: the page resolves (${JSON.stringify(outcome)})`,
    ).toBe("done");
    if (outcome.kind === "done") {
      expect(
        outcome.value.held,
        `${label}: the refused flag is reported as held`,
      ).toBeGreaterThan(0);
      expect(
        outcome.value.results.find((r) => (r.held ?? 0) > 0)?.last,
        `${label}: the cursor advanced on the page with a held flag`,
      ).toBeTruthy();
    }
    expect(
      await exceptionRows(w.itemId),
      "nothing was written: no exception row at all",
    ).toHaveLength(0);
    expect(
      await heldBySql(payslipId),
      `${label}: the slip is held although no flag exists`,
    ).toBe(true);
    const holds = await holdRows(w.itemId);
    expect(holds, "one hold row for the item").toHaveLength(1);
    expect(holds[0]!.kind, "hold kind is the kind of the flag").toBe(kind);
    expect(holds[0]!.operation_id).toBe(operationId);
    expect(holds[0]!.payslip_id, "the slip is found by the function").toBe(
      payslipId,
    );
    expect(
      await observedStates(operationId),
      "the hold writes no observation",
    ).not.toContain("error");
    await expectPayGuardRefuses(w.runId, `${label}: refused flag`);
    expect(await moneySnapshot(w.itemId), "no money moves").toEqual(before);

    // A good read ('ok') does NOT release the hold.
    const good = await within(runRecon(makeStorage()));
    expect(good.kind, `good read finishes (${JSON.stringify(good)})`).toBe(
      "done",
    );
    expect(await exceptionRows(w.itemId), "still no exception").toHaveLength(0);
    expect(
      await heldBySql(payslipId),
      `${label}: a good read does not release the hold`,
    ).toBe(true);
  } finally {
    await unblock();
  }

  // The retry writes the flag: from now on the exception decides.
  const retry = await within(runRecon(makeStorage({ tampered: [w.key] })));
  expect(retry.kind, `the retry finishes (${JSON.stringify(retry)})`).toBe(
    "done",
  );
  if (retry.kind === "done")
    expect(retry.value.held, "nothing is held once the write works").toBe(0);
  const flags = await exceptionRows(w.itemId);
  expect(flags.length, "the retry raises the flag").toBeGreaterThan(0);
  expect(await heldBySql(payslipId), "held by the flag now").toBe(true);
  for (const f of flags) await clearFlag(f.id as string);
  expect(
    await heldBySql(payslipId),
    `${label}: cleared by two people: free (the hold row is taken over by the flag)`,
  ).toBe(false);
  expect(
    (await holdRows(w.itemId)).length,
    "append-only: the hold row is still on record",
  ).toBe(1);
}

describe("t1ufu round 3: a refused flag write holds the slip without any exception row", () => {
  it(
    "[t1ufu-first-ever-flag-fails-slip-held] correction kind: the item has no flag and no observation; the hash-mismatch flag cannot be written: the page resolves with held > 0 and the cursor advances, no exception exists, yet the slip is held (a hold row, no observation), the pay guard refuses, no money moves, a good read does not release it; after the retry wrote the flag, only the two-person clearance frees the slip",
    async () => {
      await refusedWriteScenario(await correctedWorld(), "correction");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "[t1ufu-first-ever-flag-fails-slip-held-returned-kind] return kind: the same for a returned item (a second kind of operation, so the hold is per kind, operation and item)",
    async () => {
      const w = await returnedWorld();
      await refusedWriteScenario(w, "return");
      const probeKinds = await W.rowsOf(
        `SELECT DISTINCT kind FROM ${EXCEPTIONS} WHERE tenant_id = $1 AND item_id = $2`,
        [W.tenantId, w.itemId],
      );
      expect(probeKinds.length, "one kind of flag for the returned item").toBe(
        1,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "[t1ufu-hold-old-flag-not-cleared-takes-over] a hold for an item whose older flag is not cleared yet (a known flag raised again, no new flagged_at) is taken over by that flag: it holds the slip itself, and once two people clear it the slip is free",
    async () => {
      const w = await correctedWorld();
      await runRecon(makeStorage());
      await runRecon(makeStorage({ tampered: [w.key] }));
      const flags = await exceptionRows(w.itemId);
      expect(flags.length, "premise: flagged").toBeGreaterThan(0);
      const payslipId = flags[0]!.payslip_id as string;
      const operationId = flags[0]!.operation_id as string;
      const kind = flags[0]!.kind as string;
      const held = await holdUnwritten(
        kind,
        operationId,
        [w.itemId],
        undefined,
        undefined,
        flags[0]!.reason as string,
      );
      expect(held.code, `hold call: ${held.message}`).toBeUndefined();
      expect(await holdRows(w.itemId)).toHaveLength(1);
      expect(await heldBySql(payslipId), "held by the open flag").toBe(true);
      for (const f of flags) await clearFlag(f.id as string);
      expect(
        await heldBySql(payslipId),
        "the older flag was not cleared before the hold: it took the hold over, two people freed the slip",
      ).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "[t1ufu-hold-old-flag-cleared-before-keeps-hold] the older flag was cleared by two people BEFORE the hold: it does not take the hold over, a good read does not release it, a second call writes no second row",
    async () => {
      const w = await correctedWorld();
      await runRecon(makeStorage());
      await runRecon(makeStorage({ tampered: [w.key] }));
      const flags = await exceptionRows(w.itemId);
      expect(flags.length, "premise: flagged").toBeGreaterThan(0);
      const payslipId = flags[0]!.payslip_id as string;
      const operationId = flags[0]!.operation_id as string;
      const kind = flags[0]!.kind as string;
      const reason = flags[0]!.reason as string;
      for (const f of flags) await clearFlag(f.id as string);
      expect(await heldBySql(payslipId), "premise: cleared, free").toBe(false);
      const held = await holdUnwritten(
        kind,
        operationId,
        [w.itemId],
        undefined,
        undefined,
        reason,
      );
      expect(held.code, `hold call: ${held.message}`).toBeUndefined();
      expect(await heldBySql(payslipId), "held by the new hold").toBe(true);
      await runRecon(makeStorage());
      expect(await lastState(operationId), "premise: ok recorded").toBe("ok");
      expect(
        await heldBySql(payslipId),
        "a good read does not release the hold",
      ).toBe(true);
      await holdUnwritten(
        kind,
        operationId,
        [w.itemId],
        undefined,
        undefined,
        reason,
      );
      expect(
        await holdRows(w.itemId),
        "one hold row, no duplicate while not taken over",
      ).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "[t1ufu-hold-reason-mismatch-keeps-hold] a hold with another reason is not taken over by the older flag: clearing that flag leaves the slip held",
    async () => {
      const w = await correctedWorld();
      await runRecon(makeStorage());
      await runRecon(makeStorage({ tampered: [w.key] }));
      const flags = await exceptionRows(w.itemId);
      expect(flags.length, "premise: flagged").toBeGreaterThan(0);
      const payslipId = flags[0]!.payslip_id as string;
      const held = await holdUnwritten(
        flags[0]!.kind as string,
        flags[0]!.operation_id as string,
        [w.itemId],
        undefined,
        undefined,
        "evidence_read_locked:2031-01-01",
      );
      expect(held.code, `hold call: ${held.message}`).toBeUndefined();
      for (const f of flags) await clearFlag(f.id as string);
      expect(
        await heldBySql(payslipId),
        "the flags of other reasons are cleared, the hold of the lock reason remains",
      ).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "[t1ufu-flag-transaction-commit-fails-slip-held] the transaction of the flags itself fails at COMMIT (deferred trigger) but the hold commits: no flag is on record, the page resolves with held > 0 and the cursor advances, the slip is held by a hold, the pay guard refuses; the retry writes the flag",
    async () => {
      const w = await correctedWorld();
      await runRecon(makeStorage());
      const { payslipId, operationId, kind } = await slipOf(w);
      expect(await heldBySql(payslipId), "premise: free").toBe(false);
      const before = await moneySnapshot(w.itemId);
      const unblock = await blockCommit(
        EXCEPTIONS,
        `NEW.item_id = '${w.itemId}'`,
      );
      try {
        const outcome = await within(
          runRecon(makeStorage({ tampered: [w.key] })),
        );
        // Round 4 (c): the flag transaction failed at COMMIT but the hold committed:
        // the page resolves, held > 0, the cursor advances, the slip stays held.
        expect(
          outcome.kind,
          `the hold committed: the page resolves (${JSON.stringify(outcome)})`,
        ).toBe("done");
        if (outcome.kind === "done") {
          expect(
            outcome.value.held,
            "the flags of the failed transaction are reported as held",
          ).toBeGreaterThan(0);
          expect(
            outcome.value.results.find((r) => (r.held ?? 0) > 0)?.last,
            "the cursor advanced on the page with a held flag",
          ).toBeTruthy();
        }
        expect(
          await exceptionRows(w.itemId),
          "the commit failed: no exception row",
        ).toHaveLength(0);
        expect(
          await heldBySql(payslipId),
          "the slip is held by the hold of the item",
        ).toBe(true);
        const holds = await holdRows(w.itemId);
        expect(holds, "one hold row").toHaveLength(1);
        expect(holds[0]!.kind).toBe(kind);
        expect(holds[0]!.operation_id).toBe(operationId);
        await expectPayGuardRefuses(w.runId, "commit of the flags failed");
        expect(await moneySnapshot(w.itemId), "no money moves").toEqual(before);
      } finally {
        await unblock();
      }
      const retry = await within(runRecon(makeStorage({ tampered: [w.key] })));
      expect(retry.kind, `the retry finishes (${JSON.stringify(retry)})`).toBe(
        "done",
      );
      expect(
        (await exceptionRows(w.itemId)).length,
        "the retry raises the flag",
      ).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );
});

// =========================================================================
// Round 3: app.payout_recon_hold_unwritten
// =========================================================================

describe("t1ufu round 3: app.payout_recon_hold_unwritten", () => {
  it(
    "[t1ufu-hold-unwritten-own-tenant] legend_app in the own tenant holds a free slip: one hold row (kind, operation, item, slip), no observation; a second call writes nothing more; a good read does not release it",
    async () => {
      const w = await correctedWorld();
      await runRecon(makeStorage());
      const { payslipId, operationId, kind } = await slipOf(w);
      expect(await heldBySql(payslipId), "premise: free").toBe(false);
      const observations = (await observedStates(operationId)).length;

      const first = await holdUnwritten(kind, operationId, [w.itemId]);
      expect(first.code, `hold: ${first.message}`).toBeUndefined();
      expect(await heldBySql(payslipId), "held").toBe(true);
      const rows = await holdRows(w.itemId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.kind).toBe(kind);
      expect(rows[0]!.operation_id).toBe(operationId);
      expect(rows[0]!.payslip_id).toBe(payslipId);
      expect(
        (await observedStates(operationId)).length,
        "no observation is written",
      ).toBe(observations);

      const second = await holdUnwritten(kind, operationId, [w.itemId]);
      expect(second.code, `again: ${second.message}`).toBeUndefined();
      expect(
        (await holdRows(w.itemId)).length,
        "idempotent: still one row",
      ).toBe(1);

      // slipOf emptied the observations, and an 'ok' is recorded only after an earlier
      // observation: the good read here writes none, it must not release the hold.
      await runRecon(makeStorage());
      expect(
        await heldBySql(payslipId),
        "a good read does not release it",
      ).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "[t1ufu-hold-unwritten-no-operation-lock-wait] the operation lock is held by a stuck run; the call neither waits for it nor fails, and the slip is held",
    async () => {
      const w = await correctedWorld();
      await runRecon(makeStorage());
      const { payslipId, operationId, kind } = await slipOf(w);
      const a = await startStuckHolder(w.key);
      try {
        const out = await within(
          holdUnwritten(kind, operationId, [w.itemId]),
          5_000,
        );
        expect(out.kind, `no wait on the lock (${JSON.stringify(out)})`).toBe(
          "done",
        );
        if (out.kind === "done")
          expect(out.value.code, out.value.message).toBeUndefined();
        expect(await heldBySql(payslipId), "held").toBe(true);
      } finally {
        a.gate.end("return");
        await a.outcome;
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "[t1ufu-hold-unwritten-other-tenant-refused] a caller in another tenant's context naming this tenant is refused and writes nothing; the slip stays free",
    async () => {
      const w = await correctedWorld();
      await runRecon(makeStorage());
      const { payslipId, operationId, kind } = await slipOf(w);
      const denied = await holdUnwritten(
        kind,
        operationId,
        [w.itemId],
        randomUUID(),
      );
      expect(denied.code, "refused").toBeDefined();
      expect(denied.message, "not a missing function").not.toMatch(
        /does not exist/i,
      );
      expect(await holdRows(w.itemId), "nothing written").toHaveLength(0);
      expect(await heldBySql(payslipId), "still free").toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "[t1ufu-hold-unwritten-other-role-denied] legend_app itself is denied (42501), only legend_payout_recon may call it; nothing is written, and the recon role writes the hold",
    async () => {
      const w = await correctedWorld();
      await runRecon(makeStorage());
      const { payslipId, operationId, kind } = await slipOf(w);
      const denied = await holdUnwritten(
        kind,
        operationId,
        [w.itemId],
        undefined,
        null,
      );
      expect(denied.code, denied.message).toBe("42501");
      expect(await holdRows(w.itemId), "nothing written").toHaveLength(0);
      expect(await heldBySql(payslipId), "still free").toBe(false);
      const allowed = await holdUnwritten(kind, operationId, [w.itemId]);
      expect(allowed.code, allowed.message).toBeUndefined();
      expect(await holdRows(w.itemId), "the recon role wrote it").toHaveLength(
        1,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "[t1ufu-hold-table-append-only] legend_app can read the holds of its tenant but can neither update nor delete one",
    async () => {
      const w = await correctedWorld();
      await runRecon(makeStorage());
      const { operationId, kind } = await slipOf(w);
      const made = await holdUnwritten(kind, operationId, [w.itemId]);
      expect(made.code, `hold call: ${made.message}`).toBeUndefined();
      const read = await sqlAs(
        `SELECT id FROM ${HOLDS} WHERE tenant_id = $1 AND item_id = $2`,
        [W.tenantId, w.itemId],
      );
      expect(read.code, read.message).toBeUndefined();
      expect(read.rows, "the own hold is visible").toHaveLength(1);
      const deleted = await sqlAs(`DELETE FROM ${HOLDS} WHERE tenant_id = $1`, [
        W.tenantId,
      ]);
      expect(deleted.code, "delete refused").toBe("42501");
      const updated = await sqlAs(
        `UPDATE ${HOLDS} SET kind = kind WHERE tenant_id = $1`,
        [W.tenantId],
      );
      expect(updated.code, "update refused").toBe("42501");
      expect(await holdRows(w.itemId), "the hold is intact").toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );
});

// =========================================================================
// Round 3: the logs carry no cause
// =========================================================================

describe("t1ufu round 3: a failed write leaks nothing into logs or errors", () => {
  it(
    "[t1ufu-failed-write-log-without-cause] the flag write is refused with a marker text but the hold commits: the daily sweep and the page do not reject, the sweep reports `held`, and neither its output nor its result contains the marker, the query text or the item id",
    async () => {
      const w = await correctedWorld();
      await runRecon(makeStorage());
      const unblock = await blockInserts(
        EXCEPTIONS,
        `NEW.item_id = '${w.itemId}'`,
      );
      const rejected: unknown[] = [];
      try {
        const { runPayoutTrustedReconSweep } =
          (await import("../worker/payout-trusted-recon.job.ts")) as unknown as {
            runPayoutTrustedReconSweep: (
              context: unknown,
              now: Date,
              options: unknown,
            ) => Promise<unknown>;
          };
        const storage = makeStorage({ tampered: [w.key] });
        let swept: unknown;
        const captured = await captureOutput(async () => {
          swept = await runPayoutTrustedReconSweep(W.scope(), new Date(), {
            storage,
          }).catch((e: unknown) => rejected.push(e));
          await runRecon(storage).catch((e: unknown) => rejected.push(e));
        });
        // Round 4: the hold committed, so neither the sweep nor the page fails; the
        // number of held flags is surfaced (result or output), without the cause.
        expect(
          rejected.map((e) => String(e)),
          "the hold committed: nothing is rejected",
        ).toHaveLength(0);
        expect(
          [JSON.stringify(swept ?? null), ...captured.lines].join("\n"),
          "the sweep reports the held flags",
        ).toMatch(/held/i);
        const text = [
          JSON.stringify(swept ?? null),
          ...captured.lines,
          ...rejected.map((e) => inspect(e, { depth: 10 })),
          ...rejected.map((e) => String(e)),
        ].join("\n");
        expect(text, "no marker of the failing query").not.toContain(LEAK);
        expect(text, "no trigger text").not.toContain("insert refused");
        expect(text, "no item id").not.toContain(w.itemId);
      } finally {
        await unblock();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

// =========================================================================
// Round 4 (b): a hold that cannot be written still fails the page
// =========================================================================

describe("t1ufu round 4: the cursor stays when a hold cannot be written", () => {
  it(
    "[t1ufu-hold-refused-page-fails-cursor-stays] the flag write AND the hold write of one item are refused: the page rejects (no cursor advance), no exception and no hold exist, the error carries no marker; once both refusals are gone the same run (same cursor) flags the item",
    async () => {
      const w = await correctedWorld();
      await runRecon(makeStorage());
      const { payslipId } = await slipOf(w);
      const unblockFlag = await blockInserts(
        EXCEPTIONS,
        `NEW.item_id = '${w.itemId}'`,
      );
      const unblockHold = await blockInserts(
        HOLDS,
        `NEW.item_id = '${w.itemId}'`,
      );
      try {
        const outcome = await within(
          runRecon(makeStorage({ tampered: [w.key] })),
        );
        expect(
          outcome.kind,
          `a hold that is not committed fails the page (${JSON.stringify(outcome)})`,
        ).toBe("threw");
        if (outcome.kind === "threw")
          expect(outcome.error, "no marker of the failing query").not.toContain(
            LEAK,
          );
        expect(await exceptionRows(w.itemId), "no flag written").toHaveLength(
          0,
        );
        expect(await holdRows(w.itemId), "no hold written").toHaveLength(0);
        expect(
          await heldBySql(payslipId),
          "nothing records the item: the slip is free, which is why the cursor must not move",
        ).toBe(false);
      } finally {
        await unblockHold();
        await unblockFlag();
      }
      const retry = await within(runRecon(makeStorage({ tampered: [w.key] })));
      expect(
        retry.kind,
        `the same page is tried again and finishes (${JSON.stringify(retry)})`,
      ).toBe("done");
      if (retry.kind === "done")
        expect(retry.value.held, "written, not held").toBe(0);
      expect(
        (await exceptionRows(w.itemId)).length,
        "the retry raises the flag the failed page could not write",
      ).toBeGreaterThan(0);
      expect(await heldBySql(payslipId), "held by the flag").toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});
