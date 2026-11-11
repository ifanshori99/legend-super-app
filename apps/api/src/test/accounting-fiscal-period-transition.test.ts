// Finding 2 of docs/briefs/497-findings-fixes.md and the period half of card
// legend-lt0v4 (docs/briefs/500-shareholder-ledger-guards.md):
// - `tenant_id`, `legal_entity_id` and `period` of a fiscal period are
//   immutable after insert: a trigger refuses any UPDATE of them (23514).
//   Without that a closed period could be re-pointed at another month or
//   entity and the closed-month guard (0310) would seal the wrong thing.
// - `fiscal_periods.status` only moves open <-> closed, and only together with
//   `version = old.version + 1`. A direct UPDATE (also as `legend_app`) that
//   flips the status without that bump is refused with FISCAL_PERIOD_TRANSITION
//   (23514). Other columns may change only while the version stays the same.
//
// Assumptions (the brief does not pin these down):
// - Refusals carry SQLSTATE 23514; the status refusals also carry the text
//   FISCAL_PERIOD_TRANSITION in the message.
// - A legal close sets closed_by/closed_at, a legal reopen clears them and sets
//   the reopened_* audit columns (the existing CHECK constraints demand it).
// - Bumping the version by 2, or bumping it without a status change, is refused.
// - Updating a non-status column (reopen audit text) with the version untouched
//   stays allowed.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { userIdSchema } from "@starter/shared/core";
import {
  approvePeriodReopen,
  closeFiscalPeriod,
  requestPeriodReopen,
} from "../services/accounting-period-close.service";
import {
  CLOSE_SQL,
  REOPEN_SQL,
  approver,
  closer,
  ensureUsers,
  entryCount,
  failure,
  key,
  makeEntity,
  makeFixture,
  owner,
  periodRow,
  rawInsertEntry,
  reopener,
  saleLines,
  tenantScope,
  withAppRole,
} from "./accounting-ledger-guard-test-helpers";

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await ensureUsers();
});

afterAll(async () => {
  await owner.end();
});

const sameState = (
  before: Awaited<ReturnType<typeof periodRow>>,
  after: Awaited<ReturnType<typeof periodRow>>,
) => expect(after).toEqual(before);

describe("497 finding 2: tenant, legal entity and month of a fiscal period are immutable", () => {
  it("ACC-02 changing the month of a period is refused, also when the period holds journal entries", async () => {
    const fx = await makeFixture();
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await rawInsertEntry(client, {
        entity: fx.entity,
        periodId: fx.jan,
        date: "2025-01-10",
        lines: saleLines(fx, 9_000),
      });
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const before = await periodRow(fx.jan);

    const error = await failure(
      owner.query(
        "UPDATE fiscal_periods SET period = '2025-03' WHERE id = $1",
        [fx.jan],
      ),
    );
    expect(error.code).toBe("23514");
    sameState(before, await periodRow(fx.jan));
    expect(await entryCount(fx.entity, fx.jan)).toBe(1);
  });

  it("ACC-02 moving a period to another legal entity is refused", async () => {
    const fx = await makeFixture();
    const otherEntity = await makeEntity("Period move target");
    const before = await periodRow(fx.feb);

    const error = await failure(
      owner.query(
        "UPDATE fiscal_periods SET legal_entity_id = $2 WHERE id = $1",
        [fx.feb, otherEntity],
      ),
    );
    expect(error.code).toBe("23514");
    sameState(before, await periodRow(fx.feb));
  });

  it("ACC-02 moving a period to another tenant is refused", async () => {
    const fx = await makeFixture();
    const before = await periodRow(fx.feb);
    const error = await failure(
      owner.query("UPDATE fiscal_periods SET tenant_id = $2 WHERE id = $1", [
        fx.feb,
        "00000000-0000-4000-8000-0000000000aa",
      ]),
    );
    expect(error.code).toBe("23514");
    sameState(before, await periodRow(fx.feb));
  });

  it("ACC-02 the same UPDATE is refused for the application role too", async () => {
    const fx = await makeFixture();
    const before = await periodRow(fx.jan);
    const error = await failure(
      withAppRole((client) =>
        client.query(
          "UPDATE fiscal_periods SET period = '2025-04' WHERE id = $1",
          [fx.jan],
        ),
      ),
    );
    // legend_app has no UPDATE privilege on the column at all (0317); the
    // trigger above still guards the migration owner.
    expect(error.code).toBe("42501");
    sameState(before, await periodRow(fx.jan));
  });
});

describe("legend-lt0v4 legend_app cannot remove fiscal periods", () => {
  // Assumption: the API's database role has no DELETE and no TRUNCATE privilege
  // on fiscal_periods at all, so both fail with 42501 (permission denied) rather
  // than silently matching zero rows. A closed period must stay on record.
  it("ACC-02 legend_app cannot DELETE a fiscal_periods row (permission denied)", async () => {
    const fx = await makeFixture();
    const before = await periodRow(fx.jan);
    const error = await failure(
      withAppRole((client) =>
        client.query("DELETE FROM fiscal_periods WHERE id = $1", [fx.jan]),
      ),
    );
    expect(error.code).toBe("42501");
    sameState(before, await periodRow(fx.jan));
  });

  it("ACC-02 legend_app cannot TRUNCATE fiscal_periods (permission denied)", async () => {
    const fx = await makeFixture();
    const before = await periodRow(fx.jan);
    const error = await failure(
      withAppRole((client) => client.query("TRUNCATE fiscal_periods CASCADE")),
    );
    expect(error.code).toBe("42501");
    sameState(before, await periodRow(fx.jan));
  });
});

describe("legend-lt0v4 fiscal_periods.status only changes through a legal transition with a version bump", () => {
  it("ACC-02 a direct status flip without a version bump is refused with FISCAL_PERIOD_TRANSITION (migration owner)", async () => {
    const fx = await makeFixture();
    const before = await periodRow(fx.jan);
    const error = await failure(
      owner.query(
        `UPDATE fiscal_periods SET status = 'closed', closed_by = $2, closed_at = now()
          WHERE id = $1`,
        [fx.jan, closer],
      ),
    );
    expect(error.code).toBe("23514");
    expect(error.message).toMatch(/FISCAL_PERIOD_TRANSITION/);
    sameState(before, await periodRow(fx.jan));
  });

  it("ACC-02 a direct status flip without a version bump is refused for legend_app (the API's database role): no UPDATE privilege on the column", async () => {
    const fx = await makeFixture();
    const before = await periodRow(fx.jan);
    const error = await failure(
      withAppRole((client) =>
        client.query(
          `UPDATE fiscal_periods SET status = 'closed', closed_by = $2, closed_at = now()
            WHERE id = $1`,
          [fx.jan, closer],
        ),
      ),
    );
    expect(error.code).toBe("42501");
    sameState(before, await periodRow(fx.jan));
  });

  it("ACC-02 a status flip that raises the version by two is refused", async () => {
    const fx = await makeFixture();
    const before = await periodRow(fx.jan);
    const jump = await failure(
      owner.query(
        `UPDATE fiscal_periods
            SET status = 'closed', closed_by = $2, closed_at = now(), version = version + 2
          WHERE id = $1`,
        [fx.jan, closer],
      ),
    );
    expect(jump.code).toBe("23514");
    expect(jump.message).toMatch(/FISCAL_PERIOD_TRANSITION/);
    sameState(before, await periodRow(fx.jan));
  });

  it("ACC-02 a legal close (status flip with version + 1) passes the transition trigger (migration owner; legend_app goes through the close function)", async () => {
    const fx = await makeFixture();
    await owner.query(CLOSE_SQL, [fx.jan, closer]);
    const after = await periodRow(fx.jan);
    expect(after.status).toBe("closed");
    expect(after.version).toBe(2);
    expect(after.closed_by).toBe(closer);
  });

  it("ACC-02 a reopen without a version bump is refused, a legal reopen (version + 1) succeeds", async () => {
    const fx = await makeFixture();
    await owner.query(CLOSE_SQL, [fx.jan, closer]);
    const closed = await periodRow(fx.jan);

    const refused = await failure(
      owner.query(
        `UPDATE fiscal_periods
            SET status = 'open', closed_by = NULL, closed_at = NULL,
                reopened_by = $2, reopened_at = now(), reopened_reason = 'tanpa versi'
          WHERE id = $1`,
        [fx.jan, reopener],
      ),
    );
    expect(refused.code).toBe("23514");
    expect(refused.message).toMatch(/FISCAL_PERIOD_TRANSITION/);
    sameState(closed, await periodRow(fx.jan));

    await owner.query(REOPEN_SQL, [fx.jan, reopener]);
    const reopened = await periodRow(fx.jan);
    expect(reopened.status).toBe("open");
    expect(reopened.version).toBe(closed.version + 1);
    expect(reopened.reopened_by).toBe(reopener);
  });

  it("ACC-02 a version bump without a status change is refused", async () => {
    const fx = await makeFixture();
    const before = await periodRow(fx.jan);
    const error = await failure(
      owner.query(
        "UPDATE fiscal_periods SET version = version + 1 WHERE id = $1",
        [fx.jan],
      ),
    );
    expect(error.code).toBe("23514");
    sameState(before, await periodRow(fx.jan));
  });

  it("ACC-02 a non-status column may change while status and version stay put (the trigger is not over-strict)", async () => {
    const fx = await makeFixture();
    await owner.query(
      `UPDATE fiscal_periods
          SET reopened_by = $2, reopened_at = now(), reopened_reason = 'catatan audit'
        WHERE id = $1`,
      [fx.jan, reopener],
    );
    const after = await periodRow(fx.jan);
    expect(after.status).toBe("open");
    expect(after.version).toBe(1);
    expect(after.reopened_by).toBe(reopener);
  });

  it("ACC-02 the close and reopen services still work with the trigger and raise the version one step at a time", async () => {
    const fx = await makeFixture();
    const closed = await closeFiscalPeriod(
      tenantScope(),
      fx.jan,
      { expectedVersion: 1, idempotencyKey: key("close") },
      userIdSchema.parse(closer),
    );
    expect(closed.status).toBe("closed");
    expect((await periodRow(fx.jan)).version).toBe(2);

    const request = await requestPeriodReopen(
      tenantScope(),
      fx.jan,
      { reason: "Koreksi kas Januari (transition test)" },
      userIdSchema.parse(reopener),
    );
    await approvePeriodReopen(
      tenantScope(),
      request.id,
      { note: null },
      userIdSchema.parse(approver),
    );
    const reopened = await periodRow(fx.jan);
    expect(reopened.status).toBe("open");
    expect(reopened.version).toBe(3);
  });

  it("ACC-02 a refused transition leaves the month writable: nothing was sealed by the failed UPDATE", async () => {
    const fx = await makeFixture();
    await failure(
      owner.query(
        `UPDATE fiscal_periods SET status = 'closed', closed_by = $2, closed_at = now()
          WHERE id = $1`,
        [fx.jan, closer],
      ),
    );
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await rawInsertEntry(client, {
        entity: fx.entity,
        periodId: fx.jan,
        date: "2025-01-12",
        lines: saleLines(fx, 2_500),
      });
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    expect(await entryCount(fx.entity, fx.jan)).toBe(1);
  });
});
