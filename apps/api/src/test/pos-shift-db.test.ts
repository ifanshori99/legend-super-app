// Database backstop of the shift close (bead legend-6c0, review-K slice C;
// POS-03). Raw SQL as the migration owner inside a rolled-back transaction:
// each rule is refused by the database itself, not by the service.
//   - pos_shifts.count_id is a composite FK to pos_shift_counts
//   - an open shift has no count_id
//   - a closed shift uses a count of its own shift with the same counted cash
//   - pos_shift_counts.forced: cashier counts by the cashier, forced counts
//     (supervisor force close, U9) by anyone but the cashier
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { owner, seededOutletA, seededTenantId } from "./floor-test-helpers.ts";

const FLOAT_IDR = 100_000;

afterAll(async () => {
  await owner.end();
});

/** One rolled-back owner transaction with the seeded tenant context. */
async function inRolledBackTx(
  run: (client: PoolClient) => Promise<void>,
): Promise<void> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [seededTenantId],
    );
    await run(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

/** The statement must fail with `pattern`; the transaction stays usable. */
async function expectRefused(
  client: PoolClient,
  text: string,
  values: unknown[],
  pattern: RegExp,
): Promise<void> {
  await client.query("SAVEPOINT refused");
  await expect(client.query(text, values), text).rejects.toThrow(pattern);
  await client.query("ROLLBACK TO SAVEPOINT refused");
}

async function newUser(client: PoolClient): Promise<string> {
  const id = randomUUID();
  await client.query(
    'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
    [id, "Shift DB", `${id}@example.com`],
  );
  return id;
}

async function newShift(client: PoolClient, cashierId: string) {
  const id = randomUUID();
  await client.query(
    `INSERT INTO pos_shifts
       (id, tenant_id, outlet_id, device_id, cashier_id, business_date, status,
        opened_at, opening_float_idr, open_key, open_fingerprint)
     VALUES ($1, $2, $3, $4, $5, current_date, 'open', now(), $6, $7, $8)`,
    [
      id,
      seededTenantId,
      seededOutletA,
      randomUUID(),
      cashierId,
      FLOAT_IDR,
      randomUUID(),
      "a".repeat(64),
    ],
  );
  return id;
}

const COUNT_SQL = `INSERT INTO pos_shift_counts
    (id, tenant_id, outlet_id, shift_id, sequence, counts, counts_fingerprint,
     counted_idr, expected_idr, variance_idr, submitted_by, submitted_at, forced,
     idempotency_key, request_fingerprint)
  VALUES ($1, $2, $3, $4, $5, '[]'::jsonb, $6, $7, $8, $9, $10, now(), $11, $12, $6)`;

function countValues(input: {
  id?: string;
  shiftId: string;
  sequence?: number;
  countedIdr?: number;
  submittedBy: string;
  forced?: boolean;
}): unknown[] {
  const counted = input.countedIdr ?? FLOAT_IDR;
  return [
    input.id ?? randomUUID(),
    seededTenantId,
    seededOutletA,
    input.shiftId,
    input.sequence ?? 1,
    "b".repeat(64),
    counted,
    FLOAT_IDR,
    counted - FLOAT_IDR,
    input.submittedBy,
    input.forced ?? false,
    randomUUID(),
  ];
}

async function newCount(
  client: PoolClient,
  input: Parameters<typeof countValues>[0],
) {
  const values = countValues(input);
  await client.query(COUNT_SQL, values);
  return values[0] as string;
}

/** The close UPDATE the service writes (no cash movement: expected = float). */
function closeSql(shiftId: string, countId: string, countedIdr: number) {
  return {
    text: `UPDATE pos_shifts SET status = 'closed', expected_idr = $3::bigint,
             counted_idr = $4::bigint, variance_idr = $4::bigint - $3::bigint,
             variance_note = 'Selisih kas dicatat',
             counts = '[]'::jsonb, count_id = $5, approved_by = $6,
             approval_request_id = $7, approval_override_id = $7,
             approved_at = now(), closed_at = now(), closed_by = $6,
             close_key = $8, close_fingerprint = $9
           WHERE tenant_id = $1 AND id = $2`,
    values: (approverId: string): unknown[] => [
      seededTenantId,
      shiftId,
      FLOAT_IDR,
      countedIdr,
      countId,
      approverId,
      randomUUID(),
      randomUUID(),
      "c".repeat(64),
    ],
  };
}

describe("POS-03 pos_shifts.count_id", () => {
  it("must reference an existing count (composite FK)", async () => {
    await inRolledBackTx(async (client) => {
      const cashier = await newUser(client);
      const approver = await newUser(client);
      const shiftId = await newShift(client, cashier);
      const close = closeSql(shiftId, randomUUID(), FLOAT_IDR);
      await expectRefused(
        client,
        close.text,
        close.values(approver),
        // The guard trigger runs before the FK check and refuses it first.
        /pos_shifts_count_fk|foreign key|must close with its own count/i,
      );
    });
  });

  it("is refused on an open shift (open check)", async () => {
    await inRolledBackTx(async (client) => {
      const cashier = await newUser(client);
      const shiftId = await newShift(client, cashier);
      const countId = await newCount(client, { shiftId, submittedBy: cashier });
      await expectRefused(
        client,
        "UPDATE pos_shifts SET count_id = $3 WHERE tenant_id = $1 AND id = $2",
        [seededTenantId, shiftId, countId],
        /pos_shifts_open_check/,
      );
    });
  });

  it("must be a count of the same shift", async () => {
    await inRolledBackTx(async (client) => {
      const cashier = await newUser(client);
      const otherCashier = await newUser(client);
      const approver = await newUser(client);
      const shiftId = await newShift(client, cashier);
      const otherShiftId = await newShift(client, otherCashier);
      const foreignCountId = await newCount(client, {
        shiftId: otherShiftId,
        submittedBy: otherCashier,
      });
      const close = closeSql(shiftId, foreignCountId, FLOAT_IDR);
      await expectRefused(
        client,
        close.text,
        close.values(approver),
        /POS-03: shift .* must close with its own count/,
      );
    });
  });

  it("must carry the same counted cash as the shift close", async () => {
    await inRolledBackTx(async (client) => {
      const cashier = await newUser(client);
      const approver = await newUser(client);
      const shiftId = await newShift(client, cashier);
      const countId = await newCount(client, {
        shiftId,
        submittedBy: cashier,
        countedIdr: FLOAT_IDR - 5_000,
      });
      const mismatch = closeSql(shiftId, countId, FLOAT_IDR);
      await expectRefused(
        client,
        mismatch.text,
        mismatch.values(approver),
        /POS-03: shift .* must close with its own count/,
      );

      const matching = closeSql(shiftId, countId, FLOAT_IDR - 5_000);
      const result = await client.query(
        matching.text,
        matching.values(approver),
      );
      expect(result.rowCount).toBe(1);
    });
  });
});

describe("POS-03 pos_shift_counts.forced", () => {
  it("defaults to false", async () => {
    await inRolledBackTx(async (client) => {
      const cashier = await newUser(client);
      const shiftId = await newShift(client, cashier);
      const countId = await newCount(client, { shiftId, submittedBy: cashier });
      const row = await client.query(
        "SELECT forced FROM pos_shift_counts WHERE id = $1",
        [countId],
      );
      expect(row.rows[0]).toEqual({ forced: false });

      const id = randomUUID();
      await client.query(
        `INSERT INTO pos_shift_counts
           (id, tenant_id, outlet_id, shift_id, sequence, counts, counts_fingerprint,
            counted_idr, expected_idr, variance_idr, submitted_by, submitted_at,
            idempotency_key, request_fingerprint)
         VALUES ($1, $2, $3, $4, 2, '[]'::jsonb, $5, 0, $6, $7, $8, now(), $9, $5)`,
        [
          id,
          seededTenantId,
          seededOutletA,
          shiftId,
          "b".repeat(64),
          FLOAT_IDR,
          -FLOAT_IDR,
          cashier,
          randomUUID(),
        ],
      );
      const omitted = await client.query(
        "SELECT forced FROM pos_shift_counts WHERE id = $1",
        [id],
      );
      expect(omitted.rows[0]).toEqual({ forced: false });
    });
  });

  it("a non-forced count must be submitted by the shift cashier", async () => {
    await inRolledBackTx(async (client) => {
      const cashier = await newUser(client);
      const supervisor = await newUser(client);
      const shiftId = await newShift(client, cashier);
      await expectRefused(
        client,
        COUNT_SQL,
        countValues({ shiftId, submittedBy: supervisor, forced: false }),
        /POS-03: shift count must be submitted by the shift cashier/,
      );
    });
  });

  it("a forced count must not be submitted by the shift cashier", async () => {
    await inRolledBackTx(async (client) => {
      const cashier = await newUser(client);
      const shiftId = await newShift(client, cashier);
      await expectRefused(
        client,
        COUNT_SQL,
        countValues({ shiftId, submittedBy: cashier, forced: true }),
        /POS-03: a forced shift count cannot be submitted by the shift cashier/,
      );
    });
  });

  it("a forced count by someone else lands and can close the shift", async () => {
    await inRolledBackTx(async (client) => {
      const cashier = await newUser(client);
      const supervisor = await newUser(client);
      const witness = await newUser(client);
      const shiftId = await newShift(client, cashier);
      const countId = await newCount(client, {
        shiftId,
        submittedBy: supervisor,
        forced: true,
      });
      const close = closeSql(shiftId, countId, FLOAT_IDR);
      const result = await client.query(close.text, close.values(witness));
      expect(result.rowCount).toBe(1);
    });
  });
});

// ---- legend-67dt: held cash out (needs_approval) and held_cash_out_idr ----------------

/** A cash movement row as the service writes it; `needsApproval` is optional. */
function movementSql(withFlag: boolean) {
  return `INSERT INTO cash_movements
      (tenant_id, outlet_id, shift_id, type, amount_idr, reason_note, recorded_by,
       recorded_at, idempotency_key, request_fingerprint${withFlag ? ", needs_approval" : ""})
    VALUES ($1, $2, $3, $4, $5, 'Beli gas elpiji', $6, now(), $7, $8${withFlag ? ", $9" : ""})`;
}

function movementValues(input: {
  shiftId: string;
  cashierId: string;
  type: "cash_in" | "cash_out" | "drop";
  amountIdr?: number;
  needsApproval?: boolean;
}): unknown[] {
  const values: unknown[] = [
    seededTenantId,
    seededOutletA,
    input.shiftId,
    input.type,
    input.amountIdr ?? 150_000,
    input.cashierId,
    randomUUID(),
    "a".repeat(64),
  ];
  if (input.needsApproval !== undefined) values.push(input.needsApproval);
  return values;
}

const HELD_COUNT_SQL = `INSERT INTO pos_shift_counts
    (id, tenant_id, outlet_id, shift_id, sequence, counts, counts_fingerprint,
     counted_idr, expected_idr, variance_idr, submitted_by, submitted_at, forced,
     idempotency_key, request_fingerprint, held_cash_out_idr)
  VALUES ($1, $2, $3, $4, $5, '[]'::jsonb, $6, $7, $8, $9, $10, now(), $11, $12, $6, $13)`;

describe("POS-03 cash_movements.needs_approval", () => {
  it("defaults to false and is allowed on a cash_out or drop that exceeded the drawer", async () => {
    await inRolledBackTx(async (client) => {
      const cashier = await newUser(client);
      const shiftId = await newShift(client, cashier);
      await client.query(
        movementSql(false),
        movementValues({ shiftId, cashierId: cashier, type: "cash_out" }),
      );
      for (const type of ["cash_out", "drop"] as const)
        await client.query(
          movementSql(true),
          movementValues({
            shiftId,
            cashierId: cashier,
            type,
            needsApproval: true,
          }),
        );
      const { rows } = await client.query<{
        type: string;
        needs_approval: boolean;
      }>(
        `SELECT type, needs_approval FROM cash_movements
          WHERE tenant_id = $1 AND shift_id = $2 ORDER BY recorded_at, id`,
        [seededTenantId, shiftId],
      );
      expect(rows.map((row) => row.needs_approval).sort()).toEqual([
        false,
        true,
        true,
      ]);
      expect(
        rows.filter((row) => row.type === "cash_out" && row.needs_approval),
      ).toHaveLength(1);
    });
  });

  it("is refused on a cash_in (cash_movements_needs_approval_type_check)", async () => {
    await inRolledBackTx(async (client) => {
      const cashier = await newUser(client);
      const shiftId = await newShift(client, cashier);
      await expectRefused(
        client,
        movementSql(true),
        movementValues({
          shiftId,
          cashierId: cashier,
          type: "cash_in",
          needsApproval: true,
        }),
        /cash_movements_needs_approval_type_check/,
      );
      // A plain cash_in is fine.
      const result = await client.query(
        movementSql(true),
        movementValues({
          shiftId,
          cashierId: cashier,
          type: "cash_in",
          needsApproval: false,
        }),
      );
      expect(result.rowCount).toBe(1);
    });
  });

  it("cannot be changed afterwards: the movement guard trigger refuses the UPDATE", async () => {
    await inRolledBackTx(async (client) => {
      const cashier = await newUser(client);
      const shiftId = await newShift(client, cashier);
      await client.query(
        movementSql(true),
        movementValues({
          shiftId,
          cashierId: cashier,
          type: "cash_out",
          needsApproval: true,
        }),
      );
      for (const flag of [false, true])
        await expectRefused(
          client,
          "UPDATE cash_movements SET needs_approval = $3 WHERE tenant_id = $1 AND shift_id = $2",
          [seededTenantId, shiftId, flag],
          /POS-03/,
        );
      const { rows } = await client.query(
        "SELECT needs_approval FROM cash_movements WHERE tenant_id = $1 AND shift_id = $2",
        [seededTenantId, shiftId],
      );
      expect(rows).toEqual([{ needs_approval: true }]);
    });
  });
});

describe("POS-03 pos_shift_counts.held_cash_out_idr", () => {
  function heldValues(shiftId: string, submittedBy: string, held?: number) {
    const values = countValues({ shiftId, submittedBy });
    values.push(held ?? 0);
    return values;
  }

  it("defaults to 0 when omitted", async () => {
    await inRolledBackTx(async (client) => {
      const cashier = await newUser(client);
      const shiftId = await newShift(client, cashier);
      const countId = await newCount(client, { shiftId, submittedBy: cashier });
      const { rows } = await client.query(
        "SELECT held_cash_out_idr::int AS held FROM pos_shift_counts WHERE id = $1",
        [countId],
      );
      expect(rows[0]).toEqual({ held: 0 });
    });
  });

  it("stores a positive held sum and refuses a negative one (pos_shift_counts_held_cash_out_check)", async () => {
    await inRolledBackTx(async (client) => {
      const cashier = await newUser(client);
      const shiftId = await newShift(client, cashier);
      const values = heldValues(shiftId, cashier, 150_000);
      await client.query(HELD_COUNT_SQL, values);
      const { rows } = await client.query(
        "SELECT held_cash_out_idr::int AS held FROM pos_shift_counts WHERE id = $1",
        [values[0]],
      );
      expect(rows[0]).toEqual({ held: 150_000 });

      const negative = heldValues(shiftId, cashier, -1);
      negative[4] = 2; // next sequence
      await expectRefused(
        client,
        HELD_COUNT_SQL,
        negative,
        /pos_shift_counts_held_cash_out_check/,
      );
    });
  });

  it("a close must carry the same held cash out as the named count (pos_shifts_guard, 23514)", async () => {
    await inRolledBackTx(async (client) => {
      const cashier = await newUser(client);
      const approver = await newUser(client);
      const shiftId = await newShift(client, cashier);
      const countValuesWithHeld = heldValues(shiftId, cashier, 150_000);
      await client.query(HELD_COUNT_SQL, countValuesWithHeld);
      const countId = countValuesWithHeld[0] as string;

      // The service close UPDATE plus the shift's own held_cash_out_idr ($10).
      const base = closeSql(shiftId, countId, FLOAT_IDR);
      const text = base.text.replace(
        "WHERE tenant_id",
        ", held_cash_out_idr = $10::bigint WHERE tenant_id",
      );
      const closeWith = (held: number) => [...base.values(approver), held];

      await client.query("SAVEPOINT refused");
      await expect(
        client.query(text, closeWith(100_000)),
      ).rejects.toMatchObject({
        code: "23514",
        message: expect.stringMatching(/POS-03/),
      });
      await client.query("ROLLBACK TO SAVEPOINT refused");

      const result = await client.query(text, closeWith(150_000));
      expect(result.rowCount).toBe(1);
    });
  });
});
