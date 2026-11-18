// Payout 1038, finding 7 of the second opinion 1036 (bead legend-f1c7n;
// docs/briefs/1038-design-recon-clearance.md "Desain temuan 7"). Written
// fail-first from the brief, NOT from the implementation of the recon service.
//
// The hole: two people legitimately resolved a stuck item (`failed` or
// `not_sent`). Someone with write access then deletes BOTH `resolve`
// attestations (the privileged test role: table owner, guards off). Today the
// night recon only looks at attestations that still exist, so there is nothing
// to check: no flag, no hold, and the slip can be paid again without any trace
// of the two people.
//
// Rule proven here (founder: when in doubt hold the payment, nobody may be paid
// twice): a resolved item whose resolve attestations are gone is flagged with
// reason `attestation_count` and its payslip is held. Nothing is paid; the slip
// stays blocked (follow-up batch refused 409).
//
// Controls (no false alarms): a legit resolve with both attestations, a
// proposal that was withdrawn (item never resolved), and another tenant that is
// not touched, even when it holds copies of our attestations (a query that
// forgets the tenant filter would find them and stay silent).
//
// Assumptions (stated so they can be contested):
// - Entry point, tampering and flag assertions follow
//   payroll-payout-990-recon-attest.test.ts (`reconcileTrustedPayouts`, paged;
//   tampering as table owner with `session_replication_role = replica`).
// - The approval log (`payroll_payout_approval_log`) and the grants are NOT
//   touched: the design relies on them as the independent trace.
// - "Held" is probed two ways, as in payroll-payout-990-recon-reopen.test.ts:
//   SQL helper app.payout_payslip_held_by_recon(tenant, payslip) and a refused
//   (409) follow-up batch for the run.
// - The flag carries reason `attestation_count` (the brief names it) and the
//   item's payslip; kind is not asserted (brief: "kind=resolve" operation).
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { listFinanceExceptions } from "../services/accounting-finance-exceptions.service.ts";
import { createDisbursementBatch } from "../services/payroll-payout.service.ts";
import { withdrawResolutionProposal } from "../services/payroll-payout-withdraw.service.ts";
import {
  APP,
  APP3,
  BUDI,
  REQ,
  actorOf,
  bank,
  installPayoutWorld,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("1038lost");
const NET = 1_000_000;
const EXCEPTIONS = "payroll_payout_recon_exceptions";
const ATTESTATIONS = "payroll_payout_attestations";
const RECON_EXPORTS = [
  "reconcileTrustedPayouts",
  "runTrustedPayoutRecon",
  "runPayoutRecon",
];
const foreignTenants: string[] = [];

afterEach(async () => {
  await W.asTenant(async (c) => {
    await c.query(`DELETE FROM ${EXCEPTIONS} WHERE tenant_id = $1`, [
      W.tenantId,
    ]);
  }, true);
});

afterAll(async () => {
  for (const id of foreignTenants.splice(0)) {
    const c = await W.owner.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      await c.query(`DELETE FROM ${EXCEPTIONS} WHERE tenant_id = $1`, [id]);
      await c.query(`DELETE FROM ${ATTESTATIONS} WHERE tenant_id = $1`, [id]);
      await c.query(`DELETE FROM tenants WHERE id = $1`, [id]);
      await c.query("COMMIT");
    } catch {
      await c.query("ROLLBACK").catch(() => undefined);
    } finally {
      c.release();
    }
  }
});

// ---- The recon (single adapter, as in the 990 attest test) --------------------------------

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

// ---- Worlds ---------------------------------------------------------------------------------

async function exportedBatch() {
  const slips = [bank(BUDI, NET)];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const batchId = await W.exportedBatch(runId);
  const item = (await W.itemsOf(batchId))[0]!;
  return {
    runId,
    batchId,
    itemId: item.id as string,
    payslipId: item.payslip_id as string,
  };
}

const statusOf = async (itemId: string) =>
  (
    await W.rowsOf(
      `SELECT status FROM payroll_disbursement_items WHERE tenant_id = $1 AND id = $2`,
      [W.tenantId, itemId],
    )
  )[0]!.status as string;

/** Two people legitimately close the only item with `outcome`. */
async function resolvedWorld(outcome: "failed" | "not_sent") {
  const w = await exportedBatch();
  await W.resolve(w.batchId, [w.itemId], outcome, APP);
  await W.resolve(w.batchId, [w.itemId], outcome, APP3);
  expect(await statusOf(w.itemId), `premise: ${outcome}`).toBe(outcome);
  return w;
}

// ---- Observations ---------------------------------------------------------------------------

const exceptionsOf = (itemId: string) =>
  W.rowsOf(
    `SELECT * FROM ${EXCEPTIONS} WHERE tenant_id = $1 AND item_id = $2`,
    [W.tenantId, itemId],
  );
const resolveAttestations = (itemId: string, tenantId = W.tenantId) =>
  W.owner
    .query(
      `SELECT * FROM ${ATTESTATIONS}
        WHERE tenant_id = $1 AND kind = 'resolve' AND $2::uuid = ANY(item_ids)`,
      [tenantId, itemId],
    )
    .then((r) => r.rows);
async function heldBySql(payslipId: string) {
  const [row] = await W.rowsOf(
    `SELECT app.payout_payslip_held_by_recon($1::uuid, $2::uuid) AS held`,
    [W.tenantId, payslipId],
  );
  return row!.held as boolean;
}
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
const batchCount = async (runId: string) =>
  Number(
    (
      await W.rowsOf(
        `SELECT count(*)::int AS n FROM payroll_disbursement_batches
          WHERE tenant_id = $1 AND payroll_run_id = $2`,
        [W.tenantId, runId],
      )
    )[0]!.n,
  );

async function expectClean(
  w: { itemId: string; payslipId: string },
  label: string,
) {
  expect(await exceptionsOf(w.itemId), `${label}: no recon exception`).toEqual(
    [],
  );
  expect(await financeFlags(), `${label}: no finance exception`).not.toContain(
    w.itemId,
  );
  expect(await heldBySql(w.payslipId), `${label}: slip not held`).toBe(false);
}

async function expectFlaggedAndHeld(
  w: { itemId: string; payslipId: string; runId: string },
  label: string,
) {
  const rows = await exceptionsOf(w.itemId);
  expect(rows.length, `${label}: recon exception for the item`).toBeGreaterThan(
    0,
  );
  expect(
    rows.some((r) => String(r.reason).includes("attestation_count")),
    `${label}: reason attestation_count; got ${JSON.stringify(rows.map((r) => r.reason))}`,
  ).toBe(true);
  expect(
    rows.every((r) => r.payslip_id === w.payslipId),
    `${label}: the flag carries the item's payslip`,
  ).toBe(true);
  expect(await heldBySql(w.payslipId), `${label}: slip is held`).toBe(true);
  // Nobody is paid again: a follow-up batch for the held slip is refused.
  const before = await batchCount(w.runId);
  await W.expectRefused(
    W.inTx((tx) =>
      createDisbursementBatch(tx, actorOf(REQ), {
        payrollRunId: w.runId,
        channel: "manual_bank",
      } as never),
    ),
    { status: 409 },
  );
  expect(await batchCount(w.runId), `${label}: no new batch`).toBe(before);
  expect(
    (await financeFlags()).includes(w.itemId) ||
      rows.some((r) =>
        (financeFlagsText ?? "").includes(String(r.operation_id)),
      ),
    `${label}: finance exception payout_recon_flag mentions the item`,
  ).toBe(true);
}
// Filled by expectFlaggedAndHeld's caller-free fallback (operation ids), see above.
let financeFlagsText: string | undefined;

// ---- Tampering (table owner, guards off: the forger the recon exists for) --------------------

/** Both resolve attestations of the item are deleted. The approval log and grants stay. */
const dropResolveAttestations = (itemId: string) =>
  W.asTenant(async (c) => {
    const res = await c.query(
      `DELETE FROM ${ATTESTATIONS}
        WHERE tenant_id = $1 AND kind = 'resolve' AND $2::uuid = ANY(item_ids)`,
      [W.tenantId, itemId],
    );
    return res.rowCount;
  }, true);

// =========================================================================
// The hole
// =========================================================================

describe("1038 finding 7: a resolve whose attestations are gone", () => {
  for (const outcome of ["failed", "not_sent"] as const) {
    it(`[legend-f1c7n-lost-${outcome}] two people resolved the item ${outcome}, both resolve attestations are deleted: the night run flags attestation_count and holds the slip`, async () => {
      const w = await resolvedWorld(outcome);
      await runRecon();
      await expectClean(w, "control before the deletion");

      expect(
        await dropResolveAttestations(w.itemId),
        "premise: both attestations were deleted",
      ).toBe(2);
      expect(
        await resolveAttestations(w.itemId),
        "premise: no resolve attestation is left",
      ).toEqual([]);
      expect(await statusOf(w.itemId), "premise: still resolved").toBe(outcome);

      await runRecon();
      await expectFlaggedAndHeld(w, "resolve without attestations");
      expect(await statusOf(w.itemId), "the item itself is untouched").toBe(
        outcome,
      );
    });
  }

  it("[legend-f1c7n-lost-old-attestation] an attestation from before the cutover (an old withdrawn proposal) does not count: the resolve after the cutover lost its attestations, so it is flagged and held", async () => {
    const w = await resolvedWorld("failed");
    await runRecon();
    await expectClean(w, "control before the deletion");
    // Only the propose attestation is kept, dated before the cutover; the
    // approve one (the second person) is deleted.
    await W.asTenant(async (c) => {
      await c.query(
        `DELETE FROM ${ATTESTATIONS}
          WHERE tenant_id = $1 AND kind = 'resolve' AND step = 'approve'
            AND $2::uuid = ANY(item_ids)`,
        [W.tenantId, w.itemId],
      );
      await c.query(
        `UPDATE ${ATTESTATIONS}
            SET attested_at = app.payout_grants_since() - interval '1 day'
          WHERE tenant_id = $1 AND kind = 'resolve' AND step = 'propose'
            AND $2::uuid = ANY(item_ids)`,
        [W.tenantId, w.itemId],
      );
    }, true);
    expect(
      await resolveAttestations(w.itemId),
      "premise: one old attestation is left",
    ).toHaveLength(1);

    await runRecon();
    await expectFlaggedAndHeld(w, "only a pre-cutover attestation is left");
  });

  it("[legend-f1c7n-lost-stays-held] the hold does not go away by running the recon again", async () => {
    const w = await resolvedWorld("failed");
    await dropResolveAttestations(w.itemId);
    await runRecon();
    expect(await heldBySql(w.payslipId), "held after the first run").toBe(true);
    await runRecon();
    expect(
      await heldBySql(w.payslipId),
      "still held after the second run",
    ).toBe(true);
  });
});

// =========================================================================
// Controls
// =========================================================================

describe("1038 finding 7: no false alarms", () => {
  it("[legend-f1c7n-legit-resolve] a legit resolve with both attestations is never flagged", async () => {
    const w = await resolvedWorld("failed");
    await runRecon();
    await expectClean(w, "legit resolve");
    await runRecon();
    await expectClean(w, "legit resolve, second run");
    expect(
      await resolveAttestations(w.itemId),
      "premise: both attestations are there",
    ).toHaveLength(2);
  });

  it("[legend-f1c7n-withdrawn-proposal] a proposal that was withdrawn (item never resolved) is not flagged, even with no resolve attestation left", async () => {
    const w = await exportedBatch();
    await W.resolve(w.batchId, [w.itemId], "failed", APP);
    await W.inTx((tx) =>
      withdrawResolutionProposal(tx, actorOf(APP), w.batchId, {
        itemIds: [w.itemId],
      }),
    );
    expect(await statusOf(w.itemId), "premise: not resolved").toBe("exported");
    await runRecon();
    await expectClean(w, "withdrawn proposal");

    // Whatever attestation the withdrawal left behind goes too: there is no
    // resolved item, so there is nothing to hold.
    await dropResolveAttestations(w.itemId);
    await runRecon();
    await expectClean(w, "withdrawn proposal, attestations gone");
  });

  it("[legend-f1c7n-other-tenant] another tenant is not touched, even when it holds copies of our resolve attestations", async () => {
    const w = await resolvedWorld("failed");
    const other = randomUUID();
    foreignTenants.push(other);
    await W.asTenant(async (c) => {
      await c.query(
        `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
         SELECT $1, $2, 'PT B 1038', plan, status, deployment_mode, feature_flags, limits, created_by
           FROM tenants WHERE id = $3`,
        [other, `pt-b-1038-${other}`, W.tenantId],
      );
      // Copies of our resolve attestations under the other tenant (FKs are off in this fixture).
      await c.query(
        `CREATE TEMP TABLE att1038_copy ON COMMIT DROP AS
           SELECT * FROM ${ATTESTATIONS}
            WHERE tenant_id = $1 AND kind = 'resolve' AND $2::uuid = ANY(item_ids)`,
        [W.tenantId, w.itemId],
      );
      await c.query(
        `UPDATE att1038_copy SET id = gen_random_uuid(), tenant_id = $1`,
        [other],
      );
      await c.query(`INSERT INTO ${ATTESTATIONS} SELECT * FROM att1038_copy`);
    }, true);
    const foreignRows = () =>
      W.owner
        .query(
          `SELECT count(*)::int AS n FROM ${ATTESTATIONS} WHERE tenant_id = $1`,
          [other],
        )
        .then((r) => Number(r.rows[0].n));
    const foreignFlags = () =>
      W.owner
        .query(
          `SELECT count(*)::int AS n FROM ${EXCEPTIONS} WHERE tenant_id = $1`,
          [other],
        )
        .then((r) => Number(r.rows[0].n));
    expect(await foreignRows(), "premise: the copies exist").toBe(2);

    await runRecon();
    await expectClean(w, "our legit resolve next to foreign copies");
    expect(await foreignFlags(), "the other tenant got no flag").toBe(0);

    await dropResolveAttestations(w.itemId);
    await runRecon();
    await expectFlaggedAndHeld(
      w,
      "our lost attestations, foreign copies do not count",
    );
    expect(await foreignFlags(), "still no flag in the other tenant").toBe(0);
    expect(
      await foreignRows(),
      "the other tenant's rows were not touched",
    ).toBe(2);
  });
});
