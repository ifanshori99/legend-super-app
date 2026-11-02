// Accounting database invariants (bead legend-kwxj; PRD v1.7 §3.19, §6 F;
// ACC-01, ACC-02). These tests write SQL directly as the migration owner, so
// they prove the constraints hold even when the service layer is bypassed:
// append-only journals, the deferred balance trigger, the account rule, the
// reversal rules and the fiscal-period guard.

import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const unique = () => randomBytes(6).toString("hex");

afterAll(async () => {
  await owner.end();
});

type Fixture = {
  entity: string;
  otherEntity: string;
  cash: string;
  revenue: string;
  otherEntityAccount: string;
  period: string;
};

async function fixture(): Promise<Fixture> {
  const entity = randomUUID();
  const otherEntity = randomUUID();
  const cash = randomUUID();
  const revenue = randomUUID();
  const otherEntityAccount = randomUUID();
  const period = randomUUID();
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name) VALUES ($1, $2, $3), ($4, $5, $6)",
    [
      entity,
      tenantId,
      `DB invariants A ${unique()}`,
      otherEntity,
      tenantId,
      `DB invariants B ${unique()}`,
    ],
  );
  await owner.query(
    `INSERT INTO chart_of_accounts (id, tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $3, $4, '1101', 'Kas', 'asset', 'cash_and_equivalents'),
            ($2, $3, $4, '4101', 'Penjualan', 'revenue', 'revenue'),
            ($5, $3, $6, '1101', 'Kas lain', 'asset', 'cash_and_equivalents')`,
    [cash, revenue, tenantId, entity, otherEntityAccount, otherEntity],
  );
  await owner.query(
    `INSERT INTO fiscal_periods (id, tenant_id, legal_entity_id, period)
     VALUES ($1, $2, $3, '2026-11')`,
    [period, tenantId, entity],
  );
  return { entity, otherEntity, cash, revenue, otherEntityAccount, period };
}

async function insertEntry(
  client: PoolClient,
  input: {
    entity: string;
    period: string;
    reversalOf?: string;
    sourceType?: string;
    entryDate?: string;
    idempotencyKey?: string;
  },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO journal_entries
       (tenant_id, legal_entity_id, entry_date, fiscal_period_id, source_type,
        source_id, description, reversal_of, idempotency_key, request_fingerprint)
     VALUES ($1, $2, $3, $4, $5, NULL, 'DB invariant entry', $6, $7, $8)
     RETURNING id`,
    [
      tenantId,
      input.entity,
      input.entryDate ?? "2026-11-05",
      input.period,
      input.sourceType ?? "sale",
      input.reversalOf ?? null,
      input.idempotencyKey ?? `db-${randomUUID()}`,
      randomBytes(32).toString("hex"),
    ],
  );
  return rows[0]!.id;
}

async function insertLine(
  client: PoolClient,
  entryId: string,
  accountId: string,
  debitIdr: number,
  creditIdr: number,
  lineNo: number,
) {
  await client.query(
    `INSERT INTO journal_lines (tenant_id, entry_id, account_id, line_no, debit_idr, credit_idr)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [tenantId, entryId, accountId, lineNo, debitIdr, creditIdr],
  );
}

async function inTransaction(
  run: (client: PoolClient) => Promise<void>,
): Promise<void> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await run(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

describe("legend-kwxj accounting database invariants", () => {
  it("ACC-01 rejects an entry with fewer than two lines or unequal totals at commit", async () => {
    const data = await fixture();
    await expect(
      inTransaction(async (client) => {
        const entry = await insertEntry(client, data);
        await insertLine(client, entry, data.cash, 10_000, 0, 1);
      }),
    ).rejects.toThrow(/at least two lines/);

    await expect(
      inTransaction(async (client) => {
        const entry = await insertEntry(client, data);
        await insertLine(client, entry, data.cash, 10_000, 0, 1);
        await insertLine(client, entry, data.revenue, 0, 9_000, 2);
      }),
    ).rejects.toThrow(/unbalanced/);

    await inTransaction(async (client) => {
      const entry = await insertEntry(client, data);
      await insertLine(client, entry, data.cash, 10_000, 0, 1);
      await insertLine(client, entry, data.revenue, 0, 10_000, 2);
    });
  });

  it("pre-review HIGH finalize posted entries: a balanced line pair cannot be appended after posting (ACC-01)", async () => {
    const data = await fixture();
    let entry = "";
    await inTransaction(async (client) => {
      entry = await insertEntry(client, data);
      await insertLine(client, entry, data.cash, 30_000, 0, 1);
      await insertLine(client, entry, data.revenue, 0, 30_000, 2);
    });

    // The deferred balance trigger would accept this balanced pair; the seal
    // makes the entry final at COMMIT, so a later transaction cannot add it.
    await expect(
      inTransaction(async (client) => {
        await insertLine(client, entry, data.cash, 1_000, 0, 3);
        await insertLine(client, entry, data.revenue, 0, 1_000, 4);
      }),
    ).rejects.toThrow(/posted and final/);

    const { rows } = await owner.query<{ count: string }>(
      "SELECT count(*) FROM journal_lines WHERE entry_id = $1",
      [entry],
    );
    expect(Number(rows[0]?.count)).toBe(2);
  });

  it("ACC-01 the application role cannot re-open a posted entry by rewriting or deleting its seal", async () => {
    const data = await fixture();
    let entry = "";
    await inTransaction(async (client) => {
      entry = await insertEntry(client, data);
      await insertLine(client, entry, data.cash, 20_000, 0, 1);
      await insertLine(client, entry, data.revenue, 0, 20_000, 2);
    });
    for (const statement of [
      "UPDATE app.journal_entry_seals SET sealed_xid = pg_current_xact_id() WHERE entry_id = $1",
      "DELETE FROM app.journal_entry_seals WHERE entry_id = $1",
    ]) {
      await expect(
        inTransaction(async (client) => {
          await client.query("SET LOCAL ROLE legend_app");
          await client.query(
            "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
            [tenantId],
          );
          await client.query(statement, [entry]);
        }),
      ).rejects.toThrow(/permission denied/);
    }
  });

  it("ACC-01 refuses an account from another legal entity, an inactive account and a header account", async () => {
    const data = await fixture();
    await expect(
      inTransaction(async (client) => {
        const entry = await insertEntry(client, data);
        await insertLine(client, entry, data.otherEntityAccount, 10_000, 0, 1);
        await insertLine(client, entry, data.revenue, 0, 10_000, 2);
      }),
    ).rejects.toThrow(/ACCOUNT_ENTITY_MISMATCH/);

    await owner.query(
      "UPDATE chart_of_accounts SET is_active = false WHERE id = $1",
      [data.revenue],
    );
    await expect(
      inTransaction(async (client) => {
        const entry = await insertEntry(client, data);
        await insertLine(client, entry, data.cash, 10_000, 0, 1);
        await insertLine(client, entry, data.revenue, 0, 10_000, 2);
      }),
    ).rejects.toThrow(/ACCOUNT_INACTIVE/);
    await owner.query(
      "UPDATE chart_of_accounts SET is_active = true WHERE id = $1",
      [data.revenue],
    );

    await owner.query(
      `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group, parent_id)
       VALUES ($1, $2, '1102', 'Kas Kecil', 'asset', 'cash_and_equivalents', $3)`,
      [tenantId, data.entity, data.cash],
    );
    await expect(
      inTransaction(async (client) => {
        const entry = await insertEntry(client, data);
        await insertLine(client, entry, data.cash, 10_000, 0, 1);
        await insertLine(client, entry, data.revenue, 0, 10_000, 2);
      }),
    ).rejects.toThrow(/ACCOUNT_NOT_POSTABLE/);
  });

  it("ACC-01 allows one reversal, mirrors it in the database, and never reverses a reversal", async () => {
    const data = await fixture();
    let original = "";
    await inTransaction(async (client) => {
      original = await insertEntry(client, data);
      await insertLine(client, original, data.cash, 25_000, 0, 1);
      await insertLine(client, original, data.revenue, 0, 25_000, 2);
    });
    let reversal = "";
    await inTransaction(async (client) => {
      reversal = await insertEntry(client, {
        ...data,
        reversalOf: original,
        sourceType: "reversal",
        entryDate: "2026-11-06",
      });
      await insertLine(client, reversal, data.cash, 0, 25_000, 1);
      await insertLine(client, reversal, data.revenue, 25_000, 0, 2);
    });

    await expect(
      inTransaction(async (client) => {
        const second = await insertEntry(client, {
          ...data,
          reversalOf: original,
          sourceType: "reversal",
          idempotencyKey: `db-${randomUUID()}`,
        });
        await insertLine(client, second, data.cash, 0, 25_000, 1);
        await insertLine(client, second, data.revenue, 25_000, 0, 2);
      }),
    ).rejects.toMatchObject({ code: "23505" });

    await expect(
      inTransaction(async (client) => {
        const again = await insertEntry(client, {
          ...data,
          reversalOf: reversal,
          sourceType: "reversal",
        });
        await insertLine(client, again, data.cash, 0, 25_000, 1);
        await insertLine(client, again, data.revenue, 25_000, 0, 2);
      }),
    ).rejects.toThrow(/cannot be reversed/);
  });

  it("ACC-01 lets a reversal mirror an account deactivated after the original posting", async () => {
    const data = await fixture();
    let original = "";
    await inTransaction(async (client) => {
      original = await insertEntry(client, data);
      await insertLine(client, original, data.cash, 5_000, 0, 1);
      await insertLine(client, original, data.revenue, 0, 5_000, 2);
    });
    await owner.query(
      "UPDATE chart_of_accounts SET is_active = false WHERE id = $1",
      [data.revenue],
    );
    await inTransaction(async (client) => {
      const reversal = await insertEntry(client, {
        ...data,
        reversalOf: original,
        sourceType: "reversal",
      });
      await insertLine(client, reversal, data.cash, 0, 5_000, 1);
      await insertLine(client, reversal, data.revenue, 5_000, 0, 2);
    });
  });

  it("ACC-02 refuses an entry whose date or entity disagrees with its fiscal period", async () => {
    const data = await fixture();
    await expect(
      inTransaction(async (client) => {
        const entry = await insertEntry(client, {
          ...data,
          entryDate: "2026-12-01",
        });
        await insertLine(client, entry, data.cash, 1_000, 0, 1);
        await insertLine(client, entry, data.revenue, 0, 1_000, 2);
      }),
    ).rejects.toThrow(/PERIOD_MISMATCH/);

    const otherPeriod = randomUUID();
    await owner.query(
      `INSERT INTO fiscal_periods (id, tenant_id, legal_entity_id, period)
       VALUES ($1, $2, $3, '2026-11')`,
      [otherPeriod, tenantId, data.otherEntity],
    );
    await expect(
      inTransaction(async (client) => {
        const entry = await insertEntry(client, {
          ...data,
          period: otherPeriod,
        });
        await insertLine(client, entry, data.cash, 1_000, 0, 1);
        await insertLine(client, entry, data.revenue, 0, 1_000, 2);
      }),
    ).rejects.toThrow(/does not belong/);
  });

  it("ACC-01 chart rules live in the database: type, cycle and cross-entity parent", async () => {
    const data = await fixture();
    await expect(
      owner.query(
        `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group, parent_id)
         VALUES ($1, $2, '4102', 'Anak salah tipe', 'revenue', 'revenue', $3)`,
        [tenantId, data.entity, data.cash],
      ),
    ).rejects.toThrow(/needs a parent of type/);

    await expect(
      owner.query(
        `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group, parent_id)
         VALUES ($1, $2, '4103', 'Anak entitas lain', 'asset', 'cash_and_equivalents', $3)`,
        [tenantId, data.entity, data.otherEntityAccount],
      ),
    ).rejects.toThrow(/not in this legal entity chart/);

    // A two-account cycle is refused by the trigger.
    const first = randomUUID();
    const second = randomUUID();
    await owner.query(
      `INSERT INTO chart_of_accounts (id, tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $2, $3, '1105', 'Siklus A', 'asset', 'cash_and_equivalents')`,
      [first, tenantId, data.entity],
    );
    await owner.query(
      `INSERT INTO chart_of_accounts (id, tenant_id, legal_entity_id, code, name, type, report_group, parent_id)
       VALUES ($1, $2, $3, '1106', 'Siklus B', 'asset', 'cash_and_equivalents', $4)`,
      [second, tenantId, data.entity, first],
    );
    await expect(
      owner.query("UPDATE chart_of_accounts SET parent_id = $1 WHERE id = $2", [
        second,
        first,
      ]),
    ).rejects.toThrow(/parent cycle/);
  });

  it("TEN-01 enables and forces tenant RLS on every accounting table", async () => {
    const { rows } = await owner.query<{ table: string; ok: boolean }>(
      `SELECT c.relname AS table,
              c.relrowsecurity AND c.relforcerowsecurity AND EXISTS (
                SELECT 1 FROM pg_policy p
                WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation' AND NOT p.polpermissive
              ) AS ok
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = ANY($1::text[])`,
      [
        [
          "chart_of_accounts",
          "account_mappings",
          "fiscal_periods",
          "journal_entries",
          "journal_lines",
        ],
      ],
    );
    expect(rows).toHaveLength(5);
    expect(rows.every((row) => row.ok)).toBe(true);
  });
});
