// 547b finding 5: a reopen and posting committed between the period-status
// read and the ledger read must not change the figures of a closed snapshot.
// All queries hit PostgreSQL; the query wrapper only schedules the concurrent
// writer after the reader has obtained the old period status.
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  getBalanceSheet,
  getCashFlow,
  getEquityChanges,
  getProfitAndLoss,
  getTrialBalance,
} from "../services/accounting-statements.service";
import {
  CLOSE_SQL,
  REOPEN_SQL,
  closer,
  ensureUsers,
  makeFixture,
  owner,
  rawInsertEntry,
  reopener,
  saleLines,
  tenantScope,
  withOwner,
} from "./accounting-ledger-guard-test-helpers";

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await ensureUsers();
});

afterAll(async () => {
  await owner.end();
});

const asOf = "2025-01-31";
const from = "2025-01-01";
const readers = [
  [
    "trial balance",
    (id: string) => getTrialBalance(tenantScope(), { legalEntityId: id, asOf }),
  ],
  [
    "balance sheet",
    (id: string) => getBalanceSheet(tenantScope(), { legalEntityId: id, asOf }),
  ],
  [
    "profit and loss",
    (id: string) =>
      getProfitAndLoss(tenantScope(), { legalEntityId: id, from, to: asOf }),
  ],
  [
    "cash flow",
    (id: string) =>
      getCashFlow(tenantScope(), { legalEntityId: id, from, to: asOf }),
  ],
  [
    "equity changes",
    (id: string) =>
      getEquityChanges(tenantScope(), { legalEntityId: id, from, to: asOf }),
  ],
] as const;

describe("547b statement status and amounts share one database snapshot", () => {
  it.each(readers)(
    "%s stays consistent when a closed period reopens during the read",
    async (_name, read) => {
      const fx = await makeFixture();
      await withOwner((client) =>
        rawInsertEntry(client, {
          entity: fx.entity,
          periodId: fx.jan,
          date: "2025-01-10",
          lines: saleLines(fx, 50_000),
        }),
      );
      await owner.query(CLOSE_SQL, [fx.jan, closer]);
      const closed = await read(fx.entity);
      expect(closed.basis).toBe("closed_snapshot");

      const originalQuery = Client.prototype.query;
      let interleaved = false;
      const querySpy = vi
        .spyOn(Client.prototype, "query")
        .mockImplementation(function (this: Client, ...args: unknown[]) {
          const result: unknown = Reflect.apply(originalQuery, this, args);
          const config = args[0] as
            string | { text?: string; values?: unknown[] };
          const text = typeof config === "string" ? config : config.text;
          const values = (
            typeof config === "string" ? args[1] : (config.values ?? args[1])
          ) as unknown[] | undefined;
          if (
            !interleaved &&
            text?.includes('from "fiscal_periods"') &&
            values?.includes(fx.entity)
          ) {
            interleaved = true;
            return Promise.resolve(result).then(async (rows) => {
              await owner.query(REOPEN_SQL, [fx.jan, reopener]);
              await withOwner((client) =>
                rawInsertEntry(client, {
                  entity: fx.entity,
                  periodId: fx.jan,
                  date: "2025-01-20",
                  lines: saleLines(fx, 10_000),
                }),
              );
              return rows;
            });
          }
          return result;
        } as typeof originalQuery);

      let raced: Awaited<ReturnType<typeof read>>;
      try {
        raced = await read(fx.entity);
      } finally {
        querySpy.mockRestore();
      }
      expect(interleaved, "the writer must commit between the two reads").toBe(
        true,
      );
      expect(raced).toEqual(closed);

      const live = await read(fx.entity);
      expect(live.basis).toBe("live");
      expect(live).not.toEqual(closed);
    },
  );
});
