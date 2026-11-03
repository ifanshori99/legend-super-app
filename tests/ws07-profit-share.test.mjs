// WS-07 profit-share back office (bead legend-ogx3; PRD v1.7 §3 F37 "Bagi
// Hasil & Dividen", §4 "Alur P"; SH-03 "Versi porsi yang tidak berjumlah tepat
// 100% atau tanpa approval tidak dapat diaktifkan", SH-04 "Distribusi yang
// sudah disetujui tidak dapat diubah; koreksi dilakukan melalui distribusi
// penyesuaian dengan jurnal pembalik").
//
// Runs with the root node:test suite, no database: it loads the shared
// accounting contract, the web app's mock runtime, this feature's mock handlers
// and its pure helpers with Node type stripping. The screens themselves are
// exercised in e2e/legend-ogx3.mock.spec.ts.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { dispatchMock, resetMocks } from "../apps/web/src/lib/mock/runtime.ts";
// Registers every handler of the feature.
import "../apps/web/src/features/ws07-profit-share/mock.ts";
import * as share from "../apps/web/src/features/ws07-profit-share/lib.ts";
import * as accounting from "../packages/shared/src/accounting/index.ts";
import { cafeLegendAccountingFixtures as fixtures } from "../packages/shared/src/accounting/fixtures.ts";

const profitEntities = fixtures.profitShare.entities;
const legalEntity = profitEntities.find((row) => row.type === "legal_entity");
const outletEntity = profitEntities.find((row) => row.type === "outlet");
assert.ok(legalEntity);
assert.ok(outletEntity);

const SHAREHOLDERS = fixtures.profitShare.shareholders;
const septemberRun = fixtures.profitShare.runs.september;
const octoberRun = fixtures.profitShare.runs.october;

/** Deterministic valid idempotency keys (letters/digits plus . _ : -). */
const key = (n) => `01JBQ9A2B3C4D5E6F7G8H9${String(n).padStart(6, "0")}`;

async function get(path, query) {
  return dispatchMock({ method: "GET", path, query });
}
async function post(path, body) {
  return dispatchMock({ method: "POST", path, body });
}
async function patch(path, body) {
  return dispatchMock({ method: "PATCH", path, body });
}
function failure(promise) {
  return promise.then(
    () => assert.fail("expected the call to fail"),
    (error) => error,
  );
}

const entityPath = (entity = legalEntity) =>
  `/api/accounting/profit-entities/${entity.id}`;
const versionsPath = (entity = legalEntity) =>
  `${entityPath(entity)}/share-versions`;
const versionPath = (version, entity = legalEntity) =>
  `${versionsPath(entity)}/${version}`;
const runsPath = (entity = legalEntity) =>
  `${entityPath(entity)}/distributions`;
const runPath = (runId) => `/api/accounting/distributions/${runId}`;

afterEach(resetMocks);

// ---- SH-03: the exact 100% invariant -------------------------------------

describe("SH-03 exact 100% and approval", () => {
  const draft = fixtures.profitShare.versions.find(
    (row) =>
      row.profitEntityId === legalEntity.id &&
      row.version === 3 &&
      row.status === "draft",
  );
  assert.ok(draft);

  test("SH-03: a version summing 9.999 or 10.001 bp cannot be activated", async () => {
    // The contract refuses both directions with the exact total.
    for (const allocations of [
      [
        { shareholderId: draft.allocations[0].shareholderId, shareBp: 3_999 },
        { shareholderId: draft.allocations[1].shareholderId, shareBp: 3_000 },
        { shareholderId: draft.allocations[2].shareholderId, shareBp: 3_000 },
      ],
      [
        { shareholderId: draft.allocations[0].shareholderId, shareBp: 4_001 },
        { shareholderId: draft.allocations[1].shareholderId, shareBp: 3_000 },
        { shareholderId: draft.allocations[2].shareholderId, shareBp: 3_000 },
      ],
    ]) {
      assert.throws(
        () => accounting.assertShareAllocationsSum(allocations),
        (error) => error.code === "SHARE_ALLOCATION_NOT_EXACT_100",
      );
      // Submitting is the first activation gate; it re-checks the total.
      assert.throws(
        () =>
          accounting.transitionShareAllocationVersion(
            {
              status: "draft",
              requestedBy: fixtures.users.finance,
              allocations,
            },
            { type: "submit", actorId: fixtures.users.finance },
          ),
        (error) => error.code === "SHARE_ALLOCATION_NOT_EXACT_100",
      );
    }

    // The fixture's draft sums 9,500 bp; the mock (and the API) refuses it.
    const short = await failure(
      post(`${versionPath(3)}/submit`, { idempotencyKey: key(1) }),
    );
    assert.equal(short.code, "SHARE_ALLOCATION_NOT_EXACT_100");
    assert.equal(short.status, 422);

    // Over 100% is also refused: 4.001 + 3.000 + 3.000 = 10.001 bp.
    const over = await patch(versionPath(3), {
      allocations: [
        { shareholderId: draft.allocations[0].shareholderId, shareBp: 4_001 },
        { shareholderId: draft.allocations[1].shareholderId, shareBp: 3_000 },
        { shareholderId: draft.allocations[2].shareholderId, shareBp: 3_000 },
      ],
    });
    assert.equal(
      over.data.allocations.reduce((total, row) => total + row.shareBp, 0),
      10_001,
    );
    const refused = await failure(
      post(`${versionPath(3)}/submit`, { idempotencyKey: key(2) }),
    );
    assert.equal(refused.code, "SHARE_ALLOCATION_NOT_EXACT_100");
  });

  test("SH-03: a version at exactly 10.000 bp still needs a different approver", async () => {
    // Fix the draft to exactly 100%: 4.000 + 3.000 + 3.000.
    const fixed = await patch(versionPath(3), {
      allocations: [
        { shareholderId: draft.allocations[0].shareholderId, shareBp: 4_000 },
        { shareholderId: draft.allocations[1].shareholderId, shareBp: 3_000 },
        { shareholderId: draft.allocations[2].shareholderId, shareBp: 3_000 },
      ],
    });
    assert.equal(
      fixed.data.allocations.reduce((total, row) => total + row.shareBp, 0),
      10_000,
    );

    // Submit succeeds, but a pending or approved version is not usable yet.
    const submitted = await post(`${versionPath(3)}/submit`, {
      idempotencyKey: key(3),
    });
    assert.equal(submitted.data.status, "pending_approval");
    assert.throws(
      () => accounting.assertShareVersionUsable(submitted.data),
      (error) => error.code === "SHARE_VERSION_NOT_APPROVED",
    );

    // A draft is no longer editable once submitted.
    const editAfterSubmit = await failure(
      patch(versionPath(3), { effectiveFrom: "2027-02-01" }),
    );
    assert.equal(editAfterSubmit.code, "INVALID_TRANSITION");

    // The requester can never approve their own version (AUTH-06).
    assert.throws(
      () =>
        accounting.transitionShareAllocationVersion(submitted.data, {
          type: "approve",
          actorId: submitted.data.requestedBy,
          now: "2026-11-06T02:00:00.000Z",
        }),
      (error) => error.code === "APPROVER_IS_REQUESTER",
    );

    // The mock's approver (owner) is a different person.
    const approved = await post(`${versionPath(3)}/decision`, {
      decision: "approve",
      note: null,
      idempotencyKey: key(4),
    });
    assert.equal(approved.data.status, "approved");
    assert.ok(approved.data.decidedBy);
    assert.notEqual(approved.data.decidedBy, approved.data.requestedBy);
    assert.doesNotThrow(() =>
      accounting.assertShareVersionUsable(approved.data),
    );
  });

  test("SH-03: only an approved version in force may split a distribution", async () => {
    // The outlet entity has an approved version effective 2026-01-01.
    const runs = await get(runsPath(outletEntity), { limit: 20 });
    assert.equal(runs.data.length, 0);

    const period = fixtures.fiscalPeriods.find(
      (row) => row.period === "2026-10",
    );
    assert.ok(period);
    const created = await post(runsPath(outletEntity), {
      fiscalPeriodId: period.id,
      idempotencyKey: key(5),
    });
    assert.equal(created.data.status, "draft");
    assert.equal(created.data.basis, "closed_period_net_profit");
    assert.equal(created.data.shareVersion, 1);
    assert.equal(
      created.data.lines.reduce((total, line) => total + line.shareBp, 0),
      10_000,
    );
    // Every line keeps net = gross − tax, and the split is exact.
    for (const line of created.data.lines)
      assert.equal(line.grossIdr - line.taxWithheldIdr, line.netIdr);
    assert.equal(
      created.data.lines.reduce((total, line) => total + line.netIdr, 0),
      created.data.totalNetIdr,
    );

    // A second regular run for the same closed period would pay profit twice.
    const duplicate = await failure(
      post(runsPath(outletEntity), {
        fiscalPeriodId: period.id,
        idempotencyKey: key(6),
      }),
    );
    assert.equal(duplicate.code, "DISTRIBUTION_ALREADY_EXISTS");
  });
});

// ---- SH-04: frozen approved distributions --------------------------------

describe("SH-04 approved distributions are frozen", () => {
  test("SH-04: an approved distribution rejects edits; the correction is an adjustment distribution with a reversal journal", async () => {
    // The October fixture run is approved (two of four lines paid).
    assert.equal(octoberRun.status, "approved");
    assert.throws(
      () => accounting.assertDistributionEditable(octoberRun),
      (error) => error.code === "DISTRIBUTION_IMMUTABLE",
    );
    assert.throws(
      () =>
        accounting.transitionDistributionRun(octoberRun, {
          type: "submit",
          actorId: octoberRun.requestedBy,
        }),
      (error) => error.code === "DISTRIBUTION_IMMUTABLE",
    );
    const resubmit = await failure(
      post(`${runPath(octoberRun.id)}/submit`, { idempotencyKey: key(7) }),
    );
    assert.equal(resubmit.code, "DISTRIBUTION_IMMUTABLE");

    // The correction is a new adjustment run carrying that run's split.
    const adjustment = await post(`${runPath(octoberRun.id)}/adjustment`, {
      fiscalPeriodId: octoberRun.fiscalPeriodId,
      adjustmentIdr: -1_000_000,
      reason: "Koreksi uji SH-04: kelebihan bayar periode Oktober.",
      idempotencyKey: key(8),
    });
    assert.equal(adjustment.data.type, "adjustment");
    assert.equal(adjustment.data.basis, "approved_run_adjustment");
    assert.equal(adjustment.data.adjustsRunId, octoberRun.id);
    assert.equal(adjustment.data.adjustmentReason?.length > 0, true);
    assert.equal(adjustment.data.distributableIdr, -1_000_000);
    assert.ok(
      adjustment.data.reversalJournalEntryId,
      "the adjustment posts a reversing journal (SH-04)",
    );
    assert.deepEqual(
      adjustment.data.lines.map((line) => line.shareholderId).sort(),
      octoberRun.lines.map((line) => line.shareholderId).sort(),
    );
    assert.equal(adjustment.data.status, "draft");

    // A mismatched split is refused as a correction of another run.
    assert.throws(
      () =>
        accounting.assertAdjustmentMatchesTarget(octoberRun, {
          profitEntityId: outletEntity.id,
          shareVersion: octoberRun.shareVersion,
          lines: adjustment.data.lines,
        }),
      (error) => error.code === "ADJUSTMENT_TARGET_INVALID",
    );

    // The original run is unchanged by the correction.
    const reloaded = await get(runPath(octoberRun.id));
    assert.equal(reloaded.data.status, "approved");
    assert.equal(reloaded.data.distributableIdr, octoberRun.distributableIdr);
  });

  test("SH-04: payment recording is the only write an approved run allows", async () => {
    const pendingLine = octoberRun.lines.find(
      (line) => line.paymentStatus === "pending",
    );
    assert.ok(pendingLine);
    const paid = await post(
      `${runPath(octoberRun.id)}/lines/${pendingLine.id}/payment`,
      {
        paymentRef: "TRF/UJI-SH04",
        paidAt: "2026-11-06T03:00:00.000Z",
        idempotencyKey: key(9),
      },
    );
    const line = paid.data.lines.find((row) => row.id === pendingLine.id);
    assert.equal(line.paymentStatus, "paid");
    assert.equal(line.paymentRef, "TRF/UJI-SH04");
    // Amounts are frozen: only the payment fields changed.
    assert.equal(paid.data.distributableIdr, octoberRun.distributableIdr);
    assert.equal(paid.data.totalNetIdr, octoberRun.totalNetIdr);

    // Paying the same line twice is refused.
    const twice = await failure(
      post(`${runPath(octoberRun.id)}/lines/${pendingLine.id}/payment`, {
        paymentRef: "TRF/UJI-SH04-B",
        paidAt: "2026-11-06T04:00:00.000Z",
        idempotencyKey: key(10),
      }),
    );
    assert.equal(twice.code, "DISTRIBUTION_LINE_ALREADY_PAID");
  });
});

// ---- Formatting, diff and the wizard step ---------------------------------

describe("pure helpers", () => {
  test("basis points format as exact percentages, never recomputed", () => {
    assert.equal(share.formatShareBp(10_000), "100,00%");
    assert.equal(share.formatShareBp(9_999), "99,99%");
    assert.equal(share.formatShareBp(3_000), "30,00%");
    assert.equal(share.formatShareBp(1), "0,01%");
    assert.equal(share.formatShareBp(0), "0,00%");
    assert.throws(() => share.formatShareBp(-1), RangeError);
    assert.throws(() => share.formatShareBp(1.5), RangeError);

    assert.equal(share.formatShareBpDelta(500), "+5,00%");
    assert.equal(share.formatShareBpDelta(-250), "−2,50%");
    assert.equal(share.formatShareBpDelta(0), "0,00%");

    assert.equal(share.formatShareBpInteger(10_000), "10.000");
    assert.equal(share.shareAllocationSumState(10_000), "exact");
    assert.equal(share.shareAllocationSumState(9_999), "short");
    assert.equal(share.shareAllocationSumState(10_001), "over");
    assert.equal(share.shareAllocationSumDeltaBp(9_500), 500);
    assert.equal(share.canActivateVersion(10_000), true);
    assert.equal(share.canActivateVersion(9_999), false);
    assert.equal(share.canActivateVersion(10_001), false);

    assert.equal(share.parseShareBpInput("10.000"), 10_000);
    assert.equal(share.parseShareBpInput("10000"), 10_000);
    assert.equal(share.parseShareBpInput(""), null);
    assert.equal(share.parseShareBpInput("abc"), null);
    assert.equal(share.parseShareBpInput("10001"), null);
    assert.equal(share.parseAdjustmentIdrInput("-1.000.000"), -1_000_000);
    assert.equal(share.parseAdjustmentIdrInput("250000"), 250_000);
    assert.equal(share.parseAdjustmentIdrInput("0"), null);
    assert.equal(share.parseAdjustmentIdrInput(""), null);
  });

  test("the version diff lists added, removed and changed shareholders with the total delta", () => {
    const before = [
      { shareholderId: "a", shareBp: 3_000 },
      { shareholderId: "b", shareBp: 2_000 },
      { shareholderId: "c", shareBp: 5_000 },
    ];
    const after = [
      { shareholderId: "a", shareBp: 3_500 },
      { shareholderId: "b", shareBp: 2_000 },
      { shareholderId: "d", shareBp: 3_000 },
    ];
    const diff = share.diffShareAllocations(before, after);
    assert.deepEqual(
      diff.rows.map((row) => [
        row.shareholderId,
        row.kind,
        row.beforeBp,
        row.afterBp,
        row.deltaBp,
      ]),
      [
        ["a", "changed", 3_000, 3_500, 500],
        ["d", "added", null, 3_000, 3_000],
        ["c", "removed", 5_000, null, -5_000],
      ],
    );
    assert.equal(diff.beforeTotalBp, 10_000);
    assert.equal(diff.afterTotalBp, 8_500);
    assert.equal(diff.totalDeltaBp, -1_500);

    // A first version has no previous one: every line is an addition.
    const first = share.diffShareAllocations(null, after);
    assert.equal(
      first.rows.every((row) => row.kind === "added"),
      true,
    );
    assert.equal(first.beforeTotalBp, 0);
  });

  test("the wizard step follows the run status, so a reload resumes it", () => {
    assert.equal(share.distributionWizardStep(null), "calculate");
    assert.equal(share.distributionWizardStep({ status: "draft" }), "simulate");
    assert.equal(
      share.distributionWizardStep({ status: "pending_approval" }),
      "approval",
    );
    assert.equal(
      share.distributionWizardStep({ status: "approved" }),
      "payment",
    );
    assert.equal(share.distributionWizardStep({ status: "paid" }), "statement");
    assert.equal(
      share.distributionWizardStep({ status: "cancelled" }),
      "approval",
    );
    assert.deepEqual(
      [...share.DISTRIBUTION_WIZARD_STEPS],
      ["calculate", "simulate", "approval", "payment", "statement"],
    );
    assert.equal(share.distributionWizardStepIndex("calculate"), 1);
    assert.equal(share.distributionWizardStepIndex("statement"), 5);
  });

  test("the list helpers derive totals and payment progress from the contract", () => {
    const summaries = [
      accounting.distributionRunSummarySchema.parse({
        id: septemberRun.id,
        profitEntityId: septemberRun.profitEntityId,
        fiscalPeriodId: septemberRun.fiscalPeriodId,
        period: septemberRun.period,
        type: septemberRun.type,
        status: septemberRun.status,
        shareVersion: septemberRun.shareVersion,
        distributableIdr: septemberRun.distributableIdr,
        totalTaxWithheldIdr: septemberRun.totalTaxWithheldIdr,
        totalNetIdr: septemberRun.totalNetIdr,
        lineCount: septemberRun.lines.length,
        paidLineCount: septemberRun.lines.filter(
          (line) => line.paymentStatus === "paid",
        ).length,
        requestedBy: septemberRun.requestedBy,
        requestedAt: septemberRun.requestedAt,
        approvedBy: septemberRun.approvedBy,
        approvedAt: septemberRun.approvedAt,
        paidAt: septemberRun.paidAt,
      }),
    ];
    assert.equal(
      share.distributedNetIdr(summaries, septemberRun.profitEntityId),
      septemberRun.totalNetIdr,
    );
    assert.equal(share.runSummaryProgress(summaries[0]), 100);
    assert.equal(
      share.openRuns(summaries, septemberRun.profitEntityId).awaitingPayment,
      0,
    );
    assert.equal(
      share.runsOfEntity(summaries, septemberRun.profitEntityId).length,
      1,
    );
    assert.equal(share.runsOfEntity(summaries, outletEntity.id).length, 0);
  });
});

// ---- Mock behaviour -------------------------------------------------------

describe("mock handlers", () => {
  test("the mock refuses a distribution from an open period (SH-02)", async () => {
    const openPeriod = fixtures.fiscalPeriods.find(
      (row) => row.period === "2026-11",
    );
    assert.ok(openPeriod);
    assert.equal(openPeriod.status, "open");
    // SH-02: official figures come from a closed period only.
    const refused = await failure(
      post(runsPath(outletEntity), {
        fiscalPeriodId: openPeriod.id,
        idempotencyKey: key(11),
      }),
    );
    assert.equal(refused.code, "PERIOD_NOT_CLOSED");
  });

  test("the mock masks NPWP and payout accounts on read", async () => {
    const created = await post("/api/accounting/shareholders", {
      name: "Pemegang Saham Uji",
      type: "person",
      userId: null,
      npwp: "123456789012345",
      payoutAccount: {
        bank: "BCA",
        accountNumber: "1234567890",
        accountHolder: "Pemegang Saham Uji",
      },
    });
    assert.equal(created.data.npwpMasked, "****2345");
    assert.equal(created.data.payoutAccount.accountNumberMasked, "****7890");
    const serialized = JSON.stringify(created.data);
    assert.equal(serialized.includes("123456789012345"), false);
    assert.equal(serialized.includes("1234567890"), false);
    const rows = await get("/api/accounting/shareholders");
    const row = rows.data.find((item) => item.id === created.data.id);
    assert.ok(row);
    assert.equal(row.type, "person");
    assert.equal(row.status, "active");
  });

  test("a distribution statement is per shareholder and official from a closed period", async () => {
    const line = septemberRun.lines.find((row) => row.paymentStatus === "paid");
    assert.ok(line);
    const statement = await get(
      `${runPath(septemberRun.id)}/lines/${line.id}/statement`,
    );
    assert.equal(statement.data.distributionRunId, septemberRun.id);
    assert.equal(statement.data.shareholderId, line.shareholderId);
    assert.equal(
      statement.data.shareholderName,
      SHAREHOLDERS.find((row) => row.id === line.shareholderId).name,
    );
    assert.equal(statement.data.basis, "closed_period");
    assert.equal(statement.data.period, septemberRun.period);
    assert.equal(statement.data.grossIdr, line.grossIdr);
    assert.equal(statement.data.netIdr, line.netIdr);
    // SH-01: no other shareholder's share or account is in the object.
    assert.equal("allocations" in statement.data, false);
    assert.equal("totalNetIdr" in statement.data, false);
  });

  test("a new version copies nothing implicitly and starts after the approved one", async () => {
    const created = await post(versionsPath(), {
      effectiveFrom: "2027-02-01",
      allocations: [
        { shareholderId: SHAREHOLDERS[0].id, shareBp: 4_000 },
        { shareholderId: SHAREHOLDERS[1].id, shareBp: 3_000 },
        { shareholderId: SHAREHOLDERS[2].id, shareBp: 3_000 },
      ],
      idempotencyKey: key(12),
    });
    assert.equal(created.data.version, 4);
    assert.equal(created.data.status, "draft");

    // An effective date that does not advance past the approved version is
    // refused (a closed period's split must never change retroactively).
    const backwards = await failure(
      post(versionsPath(), {
        effectiveFrom: "2026-07-01",
        allocations: [{ shareholderId: SHAREHOLDERS[0].id, shareBp: 10_000 }],
        idempotencyKey: key(13),
      }),
    );
    assert.equal(backwards.code, "SHARE_VERSION_EFFECTIVE_DATE_ORDER");
  });
});
