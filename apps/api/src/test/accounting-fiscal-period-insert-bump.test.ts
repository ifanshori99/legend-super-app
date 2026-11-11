// 0270 trigger fiscal_periods_ledger_version_bump_insert: a fiscal period that
// is INSERTed already closed changes the ledger just like a close does, so it
// must raise legal_entities.ledger_version. Otherwise a REPEATABLE READ journal
// writer with an older snapshot would not notice the new closed month.
//
// Assumptions (the brief does not pin these down):
// - The version rises by at least one (the tests assert "greater", as the
//   sibling race test does).
// - A closed row needs `closed_by` and `closed_at` set, like a legal close.
// - Only the owning legal entity's version moves.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closer,
  ensureUsers,
  ledgerVersion,
  makeEntity,
  owner,
  tenantId,
} from "./accounting-ledger-guard-test-helpers";

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await ensureUsers();
});

afterAll(async () => {
  await owner.end();
});

const insertClosedPeriod = (entity: string, period: string) =>
  owner.query(
    `INSERT INTO fiscal_periods
       (tenant_id, legal_entity_id, period, status, closed_by, closed_at)
     VALUES ($1, $2, $3, 'closed', $4, now())`,
    [tenantId, entity, period, closer],
  );

describe("0270 inserting a closed fiscal period raises the ledger version", () => {
  it("ACC-02 inserting a fiscal_periods row with status 'closed' raises legal_entities.ledger_version", async () => {
    const entity = await makeEntity("Closed insert bump");
    const before = await ledgerVersion(entity);

    await insertClosedPeriod(entity, "2025-03");

    expect(await ledgerVersion(entity)).toBeGreaterThan(before);
  });

  it("ACC-02 a closed insert for one legal entity does not move another entity's ledger_version", async () => {
    const inserting = await makeEntity("Closed insert bump");
    const other = await makeEntity("Closed insert bystander");
    const otherBefore = await ledgerVersion(other);

    await insertClosedPeriod(inserting, "2025-03");

    expect(await ledgerVersion(other)).toBe(otherBefore);
  });
});
