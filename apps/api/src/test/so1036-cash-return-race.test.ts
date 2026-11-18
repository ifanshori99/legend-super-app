// Second opinion 1036, finding 3 (card legend-3k9qg; docs/qa/second-opinion-
// payout-kas-1036.md, docs/briefs/1037-ctx.md). Written fail-first from the
// report, the founder rule "nobody is paid twice, the outlet does not lose" and
// the public API/fixtures, not from the services.
//
// Scenario: petty cash fund and GL 1102 both hold Rp100.000 (the report's
// "Rp100" scaled to rupiah that pass the API's money validators; the ratio
// return : payroll = 100 : 50 is the one of the report). A petty-cash RETURN of
// Rp100.000 and a payroll CASH payout (handover) that credits 1102 with
// Rp50.000 run at the same time. A barrier holds the return right after it has
// read the balance, so the payroll posting happens inside that window.
//
// Barrier (no service seam needed): a test-only BEFORE INSERT trigger on
// journal_entries, scoped to this test's legal entity and source_type
// 'petty_cash_return', waits on a Postgres advisory lock that the test holds.
// The return reads the 1102 balance before it inserts its journal, so it
// stops at the trigger with its balance already read (and with whatever lock
// it took still held). The test then starts the payroll handover and waits,
// observed from pg_stat_activity/pg_locks, until the payroll either finished
// (old behaviour: it took no common lock) or is blocked by the return's
// backend (fixed behaviour: same lock), and only then releases the barrier.
//
// Expected: 1102 is never spent twice. Rp150.000 cannot leave a Rp100.000
// fund, so either the return or the payroll posting is held or refused, GL
// 1102 never ends below zero and the fund never goes below zero. Which of the
// two is held is left open (the report says "salah satu").
//
// Assumptions where the report is silent:
// - The payroll side is the cash handover (confirmCashHandover) of an approved
//   cash batch: it posts Dr 2103 / Cr 1102 (payroll-payout-gl.test.ts
//   [settle-cash]).
// - "Held or refused" is any outcome in which the second posting does not
//   reach the ledger: an HTTP error, a thrown HttpError, or a wait that ends
//   without a journal. The test only judges the resulting ledger.
// - The fund is seeded through an approved top-up (as AS-2b does), so GL 1102
//   really backs it.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { originHeader } from "./helpers.ts";
import { withLimitSharedLock } from "./helpers/cash-limit-lock.ts";
import {
  closeKit,
  key,
  makeOutlet,
  owner as kitOwner,
  signedIn,
  tenantId,
  type Session,
} from "./helpers/cash-bank-world.ts";
import {
  CASHIER,
  cash,
  installPayoutWorld,
} from "./payroll-payout-fixtures.ts";

const app = createApp();
const MOVEMENTS = "/api/accounting/petty-cash/movements";

const W = installPayoutWorld("so1036");

const FUND = 100_000;
const RETURN_AMOUNT = 100_000;
const PAYROLL_CASH = 50_000;

let finance: Session;
let outletId: string;
let bankAccountId: string;
let pettyGlId: string;

withLimitSharedLock();

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  finance = await signedIn(app, "SO1036 finance", [
    { role: "finance", outletId: null },
  ]);
  // A fresh outlet of the payout world's legal entity: its petty cash fund is
  // backed by the same GL 1102 that the payroll cash payout credits.
  outletId = await makeOutlet(W.entityId());
  const bank = await kitOwner.query<{ id: string }>(
    "SELECT id FROM bank_accounts WHERE tenant_id = $1 AND legal_entity_id = $2 LIMIT 1",
    [tenantId, W.entityId()],
  );
  bankAccountId = bank.rows[0]!.id;
  const gl = await kitOwner.query<{ id: string }>(
    "SELECT id FROM chart_of_accounts WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = '1102'",
    [tenantId, W.entityId()],
  );
  pettyGlId = gl.rows[0]!.id;
});

afterAll(async () => {
  // Runs before the payout world's own cleanup (hooks run in reverse order).
  const client = await kitOwner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "DELETE FROM petty_cash_entries WHERE tenant_id = $1 AND outlet_id = $2",
      [tenantId, outletId],
    );
    await client.query(
      "DELETE FROM petty_cash_funds WHERE tenant_id = $1 AND outlet_id = $2",
      [tenantId, outletId],
    );
    await client.query("DELETE FROM outlets WHERE id = $1", [outletId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  await closeKit();
});

const movement = (kind: "topup" | "return", amountIdr: number) =>
  finance.client
    .post(MOVEMENTS)
    .set(originHeader)
    .send({
      kind,
      outletId,
      bankAccountId,
      amountIdr,
      description:
        kind === "topup" ? "Isi kas kecil SO1036" : "Setor sisa kas kecil",
      idempotencyKey: key(),
    });

/** Debit minus credit of GL 1102 of the payout world's entity. */
async function glBalance(): Promise<number> {
  const { rows } = await kitOwner.query<{ balance: string }>(
    `SELECT coalesce(sum(l.debit_idr - l.credit_idr), 0)::text AS balance
       FROM journal_lines l
       JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
      WHERE l.tenant_id = $1 AND e.legal_entity_id = $2 AND l.account_id = $3`,
    [tenantId, W.entityId(), pettyGlId],
  );
  return Number(rows[0]!.balance);
}

async function fundBalance(): Promise<number> {
  const { rows } = await kitOwner.query<{ balance: string }>(
    "SELECT balance_idr::text AS balance FROM petty_cash_funds WHERE tenant_id = $1 AND outlet_id = $2",
    [tenantId, outletId],
  );
  return Number(rows[0]!.balance);
}

async function journalCountBySource(source: string): Promise<number> {
  const { rows } = await kitOwner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2 AND source_type = $3",
    [tenantId, W.entityId(), source],
  );
  return Number(rows[0]!.n);
}

const advisoryKey = (gateKey: string) =>
  `((classid::bigint << 32) | objid::bigint) = hashtextextended('${gateKey}', 0)`;

/** One outbox event of the payroll GL bridge (status as given). */
async function seedPayrollOutboxEvent(
  name: string,
  payload: Record<string, unknown>,
  status: "pending" | "delivered" = "pending",
): Promise<string> {
  const id = randomUUID();
  await kitOwner.query(
    `INSERT INTO domain_event_outbox
       (tenant_id, id, event_id, aggregate_type, aggregate_id, sequence, event, destination, status)
     VALUES ($1, $2, $3, 'payroll_run', $4, 1, $5, 'cloud-sync', $6)`,
    [
      tenantId,
      id,
      randomUUID(),
      randomUUID(),
      JSON.stringify({ name, tenantId, payload }),
      status,
    ],
  );
  return id;
}

describe("SO 1036 slice E: pending credits to 1102 count against a petty cash return", () => {
  it("[legend-3k9qg-pending-credit] fund and GL Rp100 with a Rp50 cash credit still in the outbox: return Rp100 is refused, Rp50 goes through", async () => {
    // Premise: fund and GL 1102 both hold exactly Rp100 (the race test below
    // starts from the same empty state, so this test leaves both at zero).
    const topup = await movement("topup", FUND);
    expect(topup.status, JSON.stringify(topup.body)).toBe(201);
    expect(await fundBalance()).toBe(FUND);
    expect(await glBalance()).toBe(FUND);

    const entityId = W.entityId();
    const seeded: string[] = [];
    try {
      // The payroll cash that left but whose 1102 journal is not posted yet.
      seeded.push(
        await seedPayrollOutboxEvent("payroll.paid", {
          payrollRunId: randomUUID(),
          legalEntityId: entityId,
          netIdr: PAYROLL_CASH,
          bankTransferIdr: 0,
          cashIdr: PAYROLL_CASH,
        }),
        // Not counted: another legal entity, a bank loan, a delivered event,
        // a payout settled per item.
        await seedPayrollOutboxEvent("payroll.paid", {
          payrollRunId: randomUUID(),
          legalEntityId: randomUUID(),
          netIdr: 80_000,
          bankTransferIdr: 0,
          cashIdr: 80_000,
        }),
        await seedPayrollOutboxEvent("employee_loan.disbursed", {
          employeeLoanId: randomUUID(),
          legalEntityId: entityId,
          principalIdr: 80_000,
          disbursedVia: "bank",
        }),
        await seedPayrollOutboxEvent(
          "payroll.paid",
          {
            payrollRunId: randomUUID(),
            legalEntityId: entityId,
            netIdr: 80_000,
            bankTransferIdr: 0,
            cashIdr: 80_000,
          },
          "delivered",
        ),
        await seedPayrollOutboxEvent("payroll.paid", {
          payrollRunId: randomUUID(),
          legalEntityId: entityId,
          netIdr: 80_000,
          bankTransferIdr: 0,
          cashIdr: 80_000,
          settledPerItem: true,
        }),
      );

      // Rp100 would leave Rp50 of cash that the books already owe: refused.
      const tooMuch = await movement("return", RETURN_AMOUNT);
      expect(tooMuch.status, JSON.stringify(tooMuch.body)).toBe(422);
      expect(JSON.stringify(tooMuch.body)).toContain(
        "PETTY_CASH_GL_INSUFFICIENT",
      );
      expect(await fundBalance()).toBe(FUND);
      expect(await glBalance()).toBe(FUND);

      // The Rp50 that is really there goes through.
      const fits = await movement("return", PAYROLL_CASH);
      expect(fits.status, JSON.stringify(fits.body)).toBe(201);
      expect(await fundBalance()).toBe(FUND - PAYROLL_CASH);
      expect(await glBalance()).toBe(FUND - PAYROLL_CASH);
    } finally {
      await kitOwner.query(
        "DELETE FROM domain_event_outbox WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [tenantId, seeded],
      );
    }

    // The credit is gone (delivered and posted, in real life): the rest of the
    // fund can be returned, which also leaves both balances at zero.
    const rest = await movement("return", PAYROLL_CASH);
    expect(rest.status, JSON.stringify(rest.body)).toBe(201);
    expect(await fundBalance()).toBe(0);
    expect(await glBalance()).toBe(0);
  });
});

describe("SO 1036 finding 3: petty cash return versus payroll cash payout on GL 1102", () => {
  it("[legend-3k9qg-return-vs-payroll-cash] a return that already read Rp100 and a concurrent payroll cash payout of Rp50 never spend 1102 twice", async () => {
    // Premise: fund and GL 1102 both hold exactly Rp100.
    const topup = await movement("topup", FUND);
    expect(topup.status, JSON.stringify(topup.body)).toBe(201);
    expect(await fundBalance()).toBe(FUND);
    expect(await glBalance()).toBe(FUND);

    // A cash payroll batch ready for handover (Dr 2103 / Cr 1102 = Rp50).
    const slips = [cash(CASHIER, PAYROLL_CASH)];
    const runId = await W.seedRun(slips);
    await W.postLockedJournal(runId, slips);
    const batchId = await W.approvedBatch(runId, "cash");
    const items = await W.itemsOf(batchId);
    expect(items).toHaveLength(1);
    const itemIds = items.map((item) => item.id as string);

    // Barrier: the return stops right before it writes its journal.
    const gateKey = `so1036:${randomUUID()}`;
    const triggerName = `so1036_gate_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const helper = await kitOwner.connect();
    let gateReleased = false;
    const releaseGate = async () => {
      if (gateReleased) return;
      gateReleased = true;
      await helper.query("COMMIT");
    };
    const waitFor = async (what: string, condition: () => Promise<boolean>) => {
      const deadline = Date.now() + 15_000;
      while (!(await condition())) {
        if (Date.now() >= deadline)
          throw new Error(`Race scenario did not reach: ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };

    let returnResult:
      | PromiseSettledResult<{ status: number; body: unknown }>
      | undefined;
    let payrollResult: PromiseSettledResult<unknown> | undefined;
    let returnDone: Promise<void> | undefined;
    let payrollDone: Promise<void> | undefined;
    try {
      await kitOwner.query(`CREATE FUNCTION public.${triggerName}() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.tenant_id::text = TG_ARGV[0]
             AND NEW.legal_entity_id::text = TG_ARGV[1]
             AND NEW.source_type = 'petty_cash_return' THEN
            PERFORM pg_advisory_xact_lock(hashtextextended(TG_ARGV[2], 0));
          END IF;
          RETURN NEW;
        END $$`);
      await kitOwner.query(`CREATE TRIGGER ${triggerName}
        BEFORE INSERT ON journal_entries FOR EACH ROW
        EXECUTE FUNCTION public.${triggerName}('${tenantId}', '${W.entityId()}', '${gateKey}')`);
      await helper.query("BEGIN");
      await helper.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [gateKey],
      );

      // 1. The return runs and stops at the barrier, balance already read.
      returnDone = Promise.allSettled([
        movement("return", RETURN_AMOUNT).then((res) => ({
          status: res.status,
          body: res.body as unknown,
        })),
      ]).then(([settled]) => {
        returnResult = settled;
      });
      let returnPid = 0;
      await waitFor("the return waiting at the barrier", async () => {
        const { rows } = await kitOwner.query<{ pid: number }>(
          `SELECT pid FROM pg_locks
            WHERE locktype = 'advisory' AND NOT granted AND ${advisoryKey(gateKey)}`,
        );
        if (rows[0]) returnPid = rows[0].pid;
        return rows.length > 0;
      });

      // 2. The payroll cash payout runs inside that window.
      payrollDone = Promise.allSettled([W.handover(batchId, itemIds)]).then(
        ([settled]) => {
          payrollResult = settled;
        },
      );
      // 3. Wait until it finished (nothing shared with the return) or is
      //    blocked behind the return's backend (a shared lock). Then let the
      //    return go on.
      await waitFor(
        "the payroll payout finished or waiting for the return",
        async () => {
          if (payrollResult) return true;
          const { rows } = await kitOwner.query(
            "SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
            [returnPid],
          );
          return rows.length > 0;
        },
      );
      await releaseGate();
      await Promise.all([returnDone, payrollDone]);
    } finally {
      await releaseGate().catch(() => {});
      helper.release();
      // Do not leave the gate trigger behind for the shared tenant.
      await kitOwner.query(
        `DROP TRIGGER IF EXISTS ${triggerName} ON journal_entries`,
      );
      await kitOwner.query(`DROP FUNCTION IF EXISTS public.${triggerName}()`);
    }

    const returnPosted = await journalCountBySource("petty_cash_return");
    const payrollSettled = (await W.postingsOf(batchId)).length;
    const detail = JSON.stringify({
      return: returnResult,
      payroll:
        payrollResult?.status === "rejected"
          ? String(payrollResult.reason)
          : payrollResult?.status,
      returnPosted,
      payrollSettled,
    });

    // Rp150 cannot leave a Rp100 cash box: GL 1102 never goes below zero and
    // the fund never does either.
    expect(await glBalance(), `GL 1102 went negative: ${detail}`).toBeGreaterThanOrEqual(0);
    expect(await fundBalance(), detail).toBeGreaterThanOrEqual(0);
    // Money is not spent twice: the return and the payroll payout do not both
    // reach the ledger.
    expect(
      returnPosted > 0 && payrollSettled > 0,
      `both the return and the payroll payout posted against Rp${FUND}: ${detail}`,
    ).toBe(false);
    // Control: the race is not "both refused". At least one of them took the
    // money out, so the held one is the exception, not the rule.
    expect(returnPosted + payrollSettled, detail).toBeGreaterThan(0);
  });
});
