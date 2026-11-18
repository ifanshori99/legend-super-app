// legend-1tke7: rilis 1 data gate for legacy payout postings that can never
// settle (settle_net_idr IS NULL AND kind IN ('settle_pending','settle_skipped')).
// Like preflight-rilis1-deploy.test.ts, the gate runs unchanged against a temp
// shadow of payroll_payout_gl_postings so pre-migration states can be built
// without touching public data.
//
// Assumptions (the card is silent):
//  - A missing settle_net_idr column is NOT a pass: the gate reads it through
//    to_jsonb(p) ->> 'settle_net_idr', so a missing key is NULL like a legacy
//    row and blocks (ragu = gagal). A missing table is handled by the runner
//    through the `-- requires:` header, so the header must list
//    public.payroll_payout_gl_postings.
//  - A blocked result has at least one row; the resolve hint lives in the
//    `-- resolve:` header, which the runner prints. Whether the gate returns one row per posting or
//    one aggregate row is not fixed, so tests only assert "rows > 0".
//  - The gate must resolve the table through search_path (bare name), like the
//    other rilis1 gates, so the temp shadow is the table it reads.
import { existsSync, readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parsePreflightFile } from "../db/release-gates";

const FILE = "rilis1-legend-1tke7.sql";
const fileUrl = new URL(
  `../../../../scripts/preflight/${FILE}`,
  import.meta.url,
);

function gateSql() {
  expect(existsSync(fileUrl), `${FILE} must exist`).toBe(true);
  return readFileSync(fileUrl, "utf8");
}

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 1,
});

const tenant = "10000000-0000-4000-8000-0000000000a1";
const batch = "10000000-0000-4000-8000-0000000000b1";

const columnsWithSettleNet = `
  id serial PRIMARY KEY, tenant_id uuid NOT NULL, batch_id uuid NOT NULL,
  kind text NOT NULL, item_set_hash text NOT NULL, journal_key text NOT NULL,
  posted_at timestamptz NOT NULL DEFAULT now(), fee_posted boolean NOT NULL DEFAULT true,
  source_gl_account_id uuid, salaries_payable_account_id uuid,
  payable_account_hold boolean NOT NULL DEFAULT false,
  settle_net_idr bigint, fee_idr bigint`;
const columnsWithoutSettleNet = columnsWithSettleNet.replace(
  "settle_net_idr bigint, ",
  "",
);

async function shadowed(
  columns: string,
  run: (client: PoolClient) => Promise<void>,
) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `CREATE TEMP TABLE payroll_payout_gl_postings (${columns}) ON COMMIT DROP`,
    );
    await run(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

let seq = 0;
async function addPosting(
  client: PoolClient,
  kind: string,
  settleNet: number | null | "absent",
) {
  seq += 1;
  const cols = [
    "tenant_id",
    "batch_id",
    "kind",
    "item_set_hash",
    "journal_key",
  ];
  const vals: unknown[] = [tenant, batch, kind, `hash-${seq}`, `key-${seq}`];
  if (settleNet !== "absent") {
    cols.push("settle_net_idr");
    vals.push(settleNet);
  }
  await client.query(
    `INSERT INTO payroll_payout_gl_postings (${cols.join(", ")})
     VALUES (${vals.map((_, i) => `$${i + 1}`).join(", ")})`,
    vals,
  );
}

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterAll(async () => {
  await owner.end();
});

describe("[legend-1tke7] legacy payout postings gate", () => {
  it("[legend-1tke7] passes (no rows) when the table has no legacy posting", async () => {
    const sql = gateSql();
    await shadowed(columnsWithSettleNet, async (client) => {
      expect((await client.query(sql)).rows).toEqual([]);
    });
  });

  it("[legend-1tke7] blocks on one settle_pending posting without settle_net_idr", async () => {
    const sql = gateSql();
    await shadowed(columnsWithSettleNet, async (client) => {
      await addPosting(client, "settle_pending", null);
      const rows = (await client.query(sql)).rows;
      expect(rows.length).toBeGreaterThan(0);
    });
  });

  it("[legend-1tke7] blocks on one settle_skipped posting without settle_net_idr", async () => {
    const sql = gateSql();
    await shadowed(columnsWithSettleNet, async (client) => {
      await addPosting(client, "settle_skipped", null);
      expect((await client.query(sql)).rows.length).toBeGreaterThan(0);
    });
  });

  it("[legend-1tke7] ignores settled postings and other kinds", async () => {
    const sql = gateSql();
    await shadowed(columnsWithSettleNet, async (client) => {
      // settle_net_idr present: already carries the sealed net amount.
      await addPosting(client, "settle_pending", 1_000_000);
      await addPosting(client, "settle_skipped", 0);
      // other kinds without settle_net_idr are not legacy settle rows.
      await addPosting(client, "settle", null);
      await addPosting(client, "return", null);
      await addPosting(client, "overpaid", null);
      expect((await client.query(sql)).rows).toEqual([]);
    });
  });

  it("[legend-1tke7] counts the legacy row among clean ones", async () => {
    const sql = gateSql();
    await shadowed(columnsWithSettleNet, async (client) => {
      await addPosting(client, "settle", 500);
      await addPosting(client, "settle_pending", 700);
      await addPosting(client, "settle_pending", null);
      expect((await client.query(sql)).rows.length).toBeGreaterThan(0);
    });
  });

  it("[legend-1tke7] blocks (rows > 0, no error) when settle_net_idr does not exist yet", async () => {
    const sql = gateSql();
    await shadowed(columnsWithoutSettleNet, async (client) => {
      await addPosting(client, "settle_pending", "absent");
      await addPosting(client, "settle_skipped", "absent");
      expect((await client.query(sql)).rows.length).toBeGreaterThan(0);
    });
  });

  it("[legend-1tke7] does not block a missing column when no settle_pending/settle_skipped rows exist", async () => {
    const sql = gateSql();
    await shadowed(columnsWithoutSettleNet, async (client) => {
      await addPosting(client, "settle", "absent");
      expect((await client.query(sql)).rows).toEqual([]);
    });
  });
});

describe("[legend-1tke7] gate file shape", () => {
  it("[legend-1tke7] passes the runner validator with block mode and the table in requires", () => {
    const gate = parsePreflightFile(FILE, gateSql());
    expect(gate.gate).toBe("legend-1tke7");
    expect(gate.mode).toBe("block");
    expect(gate.requires).toContain("public.payroll_payout_gl_postings");
    expect(gate.resolve.length).toBeGreaterThan(0);
  });

  it("[legend-1tke7] columns the gate reads exist in the migrated schema", async () => {
    const result = await owner.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'payroll_payout_gl_postings'`,
    );
    const present = result.rows.map((row) => row.column_name);
    expect(present).toEqual(expect.arrayContaining(["kind", "settle_net_idr"]));
  });
});
