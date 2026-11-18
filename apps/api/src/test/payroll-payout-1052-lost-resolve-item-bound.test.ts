// Payout 1052, finding 3 (P2) of the second opinion 1049 round 2
// (docs/briefs/1052-design-so1049.md "Temuan 3"). Written fail-first from the
// brief, NOT from the implementation of the recon service.
//
// The hole: two items A and B sit in ONE batch. A is resolved legitimately by two
// people, then BOTH resolve attestations of A are deleted (privileged test role).
// The night run flags A (`attestation_count`) and holds its slip. Two finance
// people clear that flag; the slip is released. Later B is resolved legitimately
// (a different item of the same batch). Today the run picks the operation of the
// flag from the LATEST resolve of the batch, which is now B's: the operation id
// of A's flag changes, the flag key changes, a NEW flag for A appears that no one
// cleared, and the slip of A is held again although nothing about A changed.
//
// Rule proven (founder: when in doubt hold the payment, nobody is paid twice, but
// a clearance two people gave stays valid while the facts of the item stay the
// same): resolving B creates no new flag for A, the key of A's flag does not
// change, and the slip of A stays released.
//
// Controls: A without a clearance stays flagged and held after B is resolved
// (fail closed); B itself is clean; another tenant is not touched.
//
// Assumptions (stated so they can be contested):
// - Entry point, tampering and held probe follow
//   payroll-payout-1038-resolve-attestations-lost.test.ts; the two-person
//   clearance (HTTP, TOTP, password) follows payroll-payout-1038-evidence-clearance.test.ts.
// - "The flag key of A does not change" is observed as: the set of recon
//   exception rows of A (id, operation_id, reason, kind) is exactly the same
//   before and after the resolve of B (no new row, no changed operation id).
// - Both items are resolved by the same two people (APP, APP3), item by item, in
//   two separate resolve calls (one proposal per item).
// - The flag of A is cleared with the same routes as any recon flag
//   (POST .../payout-recon-flags/:id/clearance, .../payout-recon-clearances/:id/approve).
// - Flags of A can be more than one row (e.g. several reasons); all are cleared.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { totpCode, totpStep } from "../lib/totp.ts";
import { originHeader } from "./helpers.ts";
import {
  APP,
  APP3,
  BUDI,
  SITI,
  bank,
  installPayoutWorld,
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("1052lost");
const NET = 1_000_000;
const PASSWORD = "Test-password-123!";
const REASON = "Sudah dicek manual, resolve dan bukti bank cocok semuanya";
const FLAGS = "/api/hris/payroll/payout-recon-flags";
const CLEARANCES = "/api/hris/payroll/payout-recon-clearances";
const EXCEPTIONS = "payroll_payout_recon_exceptions";
const ATTESTATIONS = "payroll_payout_attestations";
const CLEARANCE_TABLE = "payroll_payout_recon_clearances";
const SIGHTINGS = "payroll_payout_recon_flag_sightings";
const OBSERVATIONS = "payroll_payout_recon_evidence_observations";
const GRANTS = "payroll_payout_grants";
const RECON_EXPORTS = [
  "reconcileTrustedPayouts",
  "runTrustedPayoutRecon",
  "runPayoutRecon",
];

const personIds: string[] = [];
const enrolledUsers: string[] = [];
const foreignTenants: string[] = [];
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
    [W.tenantId, `Template ${key} 1052lost`, key],
  );
  return (await read()).rows[0]!.id;
}

/** A signed-in finance person (tenant-level template role, approve permission), TOTP enrolled in this session. */
async function makePerson(label: string, template: "owner" | "finance") {
  const { client, userId } = await W.signedInClient(`Lost1052 ${label}`);
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
let approver: Person;

type Res = {
  status: number;
  body: Row & { data?: Row; error?: { code?: string } };
};
const detail = (res: Res) => JSON.stringify(res.body);

const proposeHttp = (flagId: string) =>
  proposer.client
    .post(`${FLAGS}/${flagId}/clearance`)
    .set(originHeader)
    .send({ reason: REASON, password: PASSWORD }) as unknown as Promise<Res>;
const approveHttp = (clearanceId: string) =>
  approver.client
    .post(`${CLEARANCES}/${clearanceId}/approve`)
    .set(originHeader)
    .send({ password: PASSWORD }) as unknown as Promise<Res>;

/** The two-person clearance of one flag. */
async function clearFlag(flagId: string) {
  const proposed = await proposeHttp(flagId);
  expect(proposed.status, `premise: propose ${detail(proposed)}`).toBe(201);
  const clearanceId = (proposed.body.data?.clearanceId ??
    proposed.body.clearanceId) as string;
  expect(clearanceId, `clearance id: ${detail(proposed)}`).toBeTruthy();
  const approved = await approveHttp(clearanceId);
  expect(approved.status, `premise: approve ${detail(approved)}`).toBe(200);
}

// ---- The recon ------------------------------------------------------------------------------

async function runRecon() {
  const mod =
    (await import("../services/payroll-payout-recon.service.ts")) as Record<
      string,
      unknown
    >;
  const name = RECON_EXPORTS.find((n) => typeof mod[n] === "function");
  expect(name, "the recon service exports the night run").toBeDefined();
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

// ---- World: two items of ONE batch ----------------------------------------------------------

async function twoItemWorld() {
  const slips = [bank(BUDI, NET), bank(SITI, NET)];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const batchId = await W.exportedBatch(runId);
  const a = await W.itemOfPerson(batchId, BUDI);
  const b = await W.itemOfPerson(batchId, SITI);
  expect(a.id, "premise: two different items").not.toBe(b.id);
  return {
    runId,
    batchId,
    a: { itemId: a.id as string, payslipId: a.payslip_id as string },
    b: { itemId: b.id as string, payslipId: b.payslip_id as string },
  };
}
type World = Awaited<ReturnType<typeof twoItemWorld>>;
type Side = World["a"];

const statusOf = async (itemId: string) =>
  (
    await W.rowsOf(
      `SELECT status FROM payroll_disbursement_items WHERE tenant_id = $1 AND id = $2`,
      [W.tenantId, itemId],
    )
  )[0]!.status as string;

/** Two people close one item (one proposal per item). */
async function resolveItem(w: World, side: Side) {
  await W.resolve(w.batchId, [side.itemId], "failed", APP);
  await W.resolve(w.batchId, [side.itemId], "failed", APP3);
  expect(await statusOf(side.itemId), "premise: resolved failed").toBe(
    "failed",
  );
}

/** Both resolve attestations of the item are deleted (table owner, guards off). */
const dropResolveAttestations = (itemId: string) =>
  W.asTenant(async (c) => {
    const res = await c.query(
      `DELETE FROM ${ATTESTATIONS}
        WHERE tenant_id = $1 AND kind = 'resolve' AND $2::uuid = ANY(item_ids)`,
      [W.tenantId, itemId],
    );
    return res.rowCount;
  }, true);

// ---- Observations ---------------------------------------------------------------------------

const flagRows = (itemId: string) =>
  W.rowsOf(
    `SELECT id, operation_id, kind, reason, payslip_id FROM ${EXCEPTIONS}
      WHERE tenant_id = $1 AND item_id = $2 ORDER BY id`,
    [W.tenantId, itemId],
  );
async function heldBySql(payslipId: string) {
  const [row] = await W.rowsOf(
    `SELECT app.payout_payslip_held_by_recon($1::uuid, $2::uuid) AS held`,
    [W.tenantId, payslipId],
  );
  return row!.held as boolean;
}

/** A is resolved, loses both attestations, the run flags and holds it. */
async function flaggedA(w: World) {
  await resolveItem(w, w.a);
  await runRecon();
  expect(await flagRows(w.a.itemId), "premise: no flag while legit").toEqual(
    [],
  );
  expect(
    await dropResolveAttestations(w.a.itemId),
    "premise: both attestations of A deleted",
  ).toBe(2);
  await runRecon();
  const flags = await flagRows(w.a.itemId);
  expect(
    flags.some((f) => String(f.reason).includes("attestation_count")),
    `premise: attestation_count flag for A; got ${JSON.stringify(flags.map((f) => f.reason))}`,
  ).toBe(true);
  expect(await heldBySql(w.a.payslipId), "premise: slip A held").toBe(true);
  return flags;
}

// ---- Setup / teardown -----------------------------------------------------------------------

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  proposer = await makePerson("Proposer", "finance");
  approver = await makePerson("Approver", "finance");
});

afterEach(async () => {
  const [exists] = await W.rowsOf(
    `SELECT to_regclass('public.${OBSERVATIONS}') IS NOT NULL AS found`,
  );
  await W.asTenant(async (c) => {
    const tenants = [W.tenantId, ...foreignTenants];
    if (exists!.found)
      await c.query(
        `DELETE FROM ${OBSERVATIONS} WHERE tenant_id = ANY($1::uuid[])`,
        [tenants],
      );
    await c.query(
      `DELETE FROM ${SIGHTINGS} WHERE tenant_id = ANY($1::uuid[])`,
      [tenants],
    );
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
    for (const id of foreignTenants.splice(0)) {
      await c.query(`DELETE FROM ${EXCEPTIONS} WHERE tenant_id = $1`, [id]);
      await c.query(`DELETE FROM ${ATTESTATIONS} WHERE tenant_id = $1`, [id]);
      await c.query(`DELETE FROM tenants WHERE id = $1`, [id]);
    }
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

// =========================================================================
// The hole
// =========================================================================

describe("1052 finding 3: resolving another item of the batch does not touch the flag of a cleared item", () => {
  it("[1052-lost-resolve-other-item-no-new-flag] A resolved, A's attestations deleted, flagged, cleared by two people (slip free); B of the same batch is resolved legitimately: the run creates NO new flag for A, A's flag rows are exactly the same, the slip of A stays free", async () => {
    const w = await twoItemWorld();
    const flagsBefore = await flaggedA(w);
    for (const f of flagsBefore) await clearFlag(f.id as string);
    expect(
      await heldBySql(w.a.payslipId),
      "premise: slip A is free after the clearance",
    ).toBe(false);

    // Same facts, run again: still free (no change from the run alone).
    await runRecon();
    expect(
      await flagRows(w.a.itemId),
      "premise: a run without any change adds no flag",
    ).toEqual(flagsBefore);
    expect(await heldBySql(w.a.payslipId), "premise: still free").toBe(false);

    // B of the same batch is resolved by two people: nothing about A changed.
    await resolveItem(w, w.b);
    await runRecon();

    expect(
      await flagRows(w.a.itemId),
      "no new flag for A and no changed operation id: the key of A's flag stays",
    ).toEqual(flagsBefore);
    expect(
      await heldBySql(w.a.payslipId),
      "the slip of A stays free: two people cleared exactly these facts",
    ).toBe(false);
    // B is legit (both attestations there): clean.
    expect(await flagRows(w.b.itemId), "B is not flagged").toEqual([]);
    expect(await heldBySql(w.b.payslipId), "slip B is not held").toBe(false);
  });

  it("[1052-lost-resolve-other-item-stays-stable] the key of A's flag does not move however many other items are resolved and however often the run repeats", async () => {
    const w = await twoItemWorld();
    const flagsBefore = await flaggedA(w);
    await resolveItem(w, w.b);
    await runRecon();
    await runRecon();
    const after = await flagRows(w.a.itemId);
    // The slip is held either way (nobody cleared it); the point is that A's
    // flag rows do not change identity when B is resolved.
    expect(
      after.map((f) => [f.operation_id, f.reason, f.kind]),
      "A's flag keeps its operation id and reason",
    ).toEqual(flagsBefore.map((f) => [f.operation_id, f.reason, f.kind]));
    expect(after, "no extra flag row for A").toHaveLength(flagsBefore.length);
  });
});

// =========================================================================
// Controls
// =========================================================================

describe("1052 finding 3: controls (fail closed, other tenant)", () => {
  it("[1052-lost-resolve-no-clearance-stays-held] A without a clearance stays flagged and held after B is resolved, and the follow-up flag set never frees it", async () => {
    const w = await twoItemWorld();
    await flaggedA(w);
    await resolveItem(w, w.b);
    await runRecon();
    expect(
      (await flagRows(w.a.itemId)).some((f) =>
        String(f.reason).includes("attestation_count"),
      ),
      "A is still flagged attestation_count",
    ).toBe(true);
    expect(await heldBySql(w.a.payslipId), "slip A is still held").toBe(true);
    await runRecon();
    expect(await heldBySql(w.a.payslipId), "still held, second run").toBe(true);
    expect(await statusOf(w.a.itemId), "item A is untouched").toBe("failed");
    expect(await statusOf(w.b.itemId), "item B is untouched").toBe("failed");
  });

  it("[1052-lost-resolve-other-tenant] another tenant holding copies of A's resolve attestations gets no flag and stays untouched while A is cleared and B is resolved", async () => {
    const w = await twoItemWorld();
    await resolveItem(w, w.a);
    const other = randomUUID();
    foreignTenants.push(other);
    await W.asTenant(async (c) => {
      await c.query(
        `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
         SELECT $1, $2, 'PT B 1052', plan, status, deployment_mode, feature_flags, limits, created_by
           FROM tenants WHERE id = $3`,
        [other, `pt-b-1052-${other}`, W.tenantId],
      );
      await c.query(
        `CREATE TEMP TABLE att1052_copy ON COMMIT DROP AS
           SELECT * FROM ${ATTESTATIONS}
            WHERE tenant_id = $1 AND kind = 'resolve' AND $2::uuid = ANY(item_ids)`,
        [W.tenantId, w.a.itemId],
      );
      await c.query(
        `UPDATE att1052_copy SET id = gen_random_uuid(), tenant_id = $1`,
        [other],
      );
      await c.query(`INSERT INTO ${ATTESTATIONS} SELECT * FROM att1052_copy`);
    }, true);
    const foreign = async () => ({
      flags: Number(
        (
          await W.owner.query(
            `SELECT count(*)::int AS n FROM ${EXCEPTIONS} WHERE tenant_id = $1`,
            [other],
          )
        ).rows[0].n,
      ),
      attestations: Number(
        (
          await W.owner.query(
            `SELECT count(*)::int AS n FROM ${ATTESTATIONS} WHERE tenant_id = $1`,
            [other],
          )
        ).rows[0].n,
      ),
    });
    expect(await foreign(), "premise: the copies exist").toEqual({
      flags: 0,
      attestations: 2,
    });

    await runRecon();
    await dropResolveAttestations(w.a.itemId);
    await runRecon();
    const flags = await flagRows(w.a.itemId);
    expect(flags.length, "premise: A flagged").toBeGreaterThan(0);
    for (const f of flags) await clearFlag(f.id as string);
    await resolveItem(w, w.b);
    await runRecon();

    expect(await heldBySql(w.a.payslipId), "our slip A stays free").toBe(false);
    expect(await foreign(), "the other tenant is not touched").toEqual({
      flags: 0,
      attestations: 2,
    });
  });
});
