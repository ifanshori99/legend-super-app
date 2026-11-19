// legend-26ro5 (1135 kartu 1): rilis 1 gate for old counted holds that were
// closed through the rowOf path before 1126 and never bound to a fact
// (matched_fact_id NULL), which can count the same refund twice. Like
// preflight-0301.test.ts, the checked-in SQL runs unchanged against TEMP
// shadows of refund_recon_holds and payment_provider_refunds inside a
// BEGIN/ROLLBACK, so public tables are untouched.
import { existsSync, readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const FILE = "rilis1-legend-26ro5.sql";
const fileUrl = new URL(
  `../../../../scripts/preflight/${FILE}`,
  import.meta.url,
);

function gateText() {
  expect(existsSync(fileUrl), `${FILE} must exist`).toBe(true);
  return readFileSync(fileUrl, "utf8");
}

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 1,
});

const tenantA = "10000000-0000-4000-8000-000000000001";
const tenantB = "10000000-0000-4000-8000-000000000002";
const intent1 = "20000000-0000-4000-8000-000000000001";
const holdId = (n: number) =>
  `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const factId = (n: number) =>
  `40000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

async function shadowed(run: (client: PoolClient) => Promise<void>) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(`CREATE TEMP TABLE refund_recon_holds (
      id uuid PRIMARY KEY, tenant_id uuid NOT NULL, payment_intent_id uuid NOT NULL,
      provider_refund_id varchar(100), provider_refund_id_kind varchar(20),
      amount_idr integer NOT NULL, reason varchar(200) NOT NULL,
      provider_payment_ref varchar(100), resolved_at timestamptz,
      resolution text, matched_fact_id uuid) ON COMMIT DROP`);
    await client.query(`CREATE TEMP TABLE payment_provider_refunds (
      id uuid PRIMARY KEY, tenant_id uuid NOT NULL, payment_intent_id uuid NOT NULL,
      provider varchar(20) NOT NULL, refund_id_kind varchar(20) NOT NULL DEFAULT 'provider',
      provider_refund_id varchar(100) NOT NULL, provider_payment_ref varchar(100) NOT NULL,
      amount_idr integer NOT NULL,
      UNIQUE (tenant_id, provider, refund_id_kind, provider_refund_id))
      ON COMMIT DROP`);
    // Minimal shadows for the pieces the gate reads to tell our own refund
    // echo and the transaction's remainder; unallocated funds
    // stay the (empty) public table.
    await client.query(`CREATE TEMP TABLE payment_intents (
      id uuid NOT NULL, tenant_id uuid NOT NULL, amount_idr integer NOT NULL,
      provider_ref varchar(100), PRIMARY KEY (tenant_id, id)) ON COMMIT DROP`);
    await client.query(`CREATE TEMP TABLE payment_refunds (
      id uuid PRIMARY KEY, tenant_id uuid NOT NULL, payment_intent_id uuid NOT NULL,
      status varchar(20) NOT NULL, amount_idr integer NOT NULL,
      provider_ref varchar(100), unallocated_fund_id uuid) ON COMMIT DROP`);
    await client.query(`CREATE TEMP TABLE payment_evidence (
      id uuid PRIMARY KEY, tenant_id uuid NOT NULL, payment_intent_id uuid NOT NULL,
      provider varchar(20) NOT NULL, provider_ref varchar(100) NOT NULL,
      amount_idr integer NOT NULL) ON COMMIT DROP`);
    await client.query(
      `INSERT INTO payment_intents (id, tenant_id, amount_idr, provider_ref)
       VALUES ($1, $2, 100000, 'tx1'), ($1, $3, 100000, 'tx1')`,
      [intent1, tenantA, tenantB],
    );
    await run(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

interface Hold {
  id: string;
  tenantId?: string;
  refundId?: string | null;
  kind?: string | null;
  amount?: number;
  reason?: string;
  paymentRef?: string | null;
  resolved?: boolean;
  resolution?: string | null;
  matchedFactId?: string | null;
}

// Defaults: a named, closed, counted hold of 5000 that names refund "r1" on
// transaction "tx1" and is not bound to a fact.
async function addHold(client: PoolClient, h: Hold) {
  const named = h.refundId !== null;
  await client.query(
    `INSERT INTO refund_recon_holds
       (id, tenant_id, payment_intent_id, provider_refund_id,
        provider_refund_id_kind, amount_idr, reason, provider_payment_ref,
        resolved_at, resolution, matched_fact_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
       CASE WHEN $9::boolean THEN now() END, $10, $11)`,
    [
      h.id,
      h.tenantId ?? tenantA,
      intent1,
      named ? (h.refundId ?? "r1") : null,
      named ? (h.kind === undefined ? "provider" : h.kind) : null,
      h.amount ?? 5000,
      h.reason ?? "unmatched_refund",
      h.paymentRef === undefined ? "tx1" : h.paymentRef,
      h.resolved ?? true,
      h.resolution === undefined ? "counted_against_intent" : h.resolution,
      h.matchedFactId ?? null,
    ],
  );
}

async function addOwnRefund(
  client: PoolClient,
  r: { id: string; refundId: string; amount: number },
) {
  await client.query(
    `INSERT INTO payment_refunds
       (id, tenant_id, payment_intent_id, status, amount_idr, provider_ref)
     VALUES ($1, $2, $3, 'completed', $4, $5)`,
    [r.id, tenantA, intent1, r.amount, r.refundId],
  );
}

async function addFact(
  client: PoolClient,
  f: {
    id: string;
    tenantId?: string;
    kind?: string;
    refundId?: string;
    amount?: number;
    paymentRef?: string;
  },
) {
  await client.query(
    `INSERT INTO payment_provider_refunds
       (id, tenant_id, payment_intent_id, provider, refund_id_kind,
        provider_refund_id, provider_payment_ref, amount_idr)
     VALUES ($1, $2, $3, 'doit', $4, $5, $6, $7)`,
    [
      f.id,
      f.tenantId ?? tenantA,
      intent1,
      f.kind ?? "provider",
      f.refundId ?? "r1",
      f.paymentRef ?? "tx1",
      f.amount ?? 5000,
    ],
  );
}

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterAll(async () => {
  await owner.end();
});

const ownId = (n: number) =>
  `50000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("[legend-26ro5] counted holds without a bound fact release gate", () => {
  it("[legend-26ro5] has the runner header and exactly one statement", () => {
    const lines = gateText().split(/\r?\n/);
    expect(lines.slice(0, 4)).toEqual([
      "-- gate: legend-26ro5",
      "-- before: none",
      "-- requires: public.refund_recon_holds, public.payment_provider_refunds, public.payment_intents, public.payment_evidence, public.payment_refunds, public.payment_unallocated_funds",
      "-- mode: block",
    ]);
    expect(lines[4]).toMatch(/^-- resolve: .+/);
    const body = lines
      .slice(5)
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n")
      .trim()
      .replace(/;\s*$/, "");
    expect(body).toMatch(/^(select|with)\b/i);
    expect(body).not.toContain(";");
    expect(
      lines.slice(5).some((line) => line.trimStart().startsWith("\\")),
    ).toBe(false);
    expect(body).not.toMatch(
      /\b(insert|update|delete|merge|into|copy|call|do|set|create|alter|drop|truncate|grant|revoke|execute)\b/i,
    );
  });

  it("[legend-26ro5] lists a named hold with no fact: fact_unbound", async () => {
    const sql = gateText();
    await shadowed(async (client) => {
      await addHold(client, { id: holdId(1) });
      const rows = (await client.query(sql)).rows;
      expect(rows).toEqual([
        {
          tenant_id: tenantA,
          hold_id: holdId(1),
          payment_intent_id: intent1,
          kind: "provider",
          provider_refund_id: "r1",
          hold_idr: 5000,
          fact_count: "0",
          covered_idr: "0",
          problem: "fact_unbound",
        },
      ]);
    });
  });

  it("[legend-26ro5] lists an anonymous hold when the intent has a provider fact and the transaction has money left", async () => {
    const sql = gateText();
    await shadowed(async (client) => {
      await addHold(client, { id: holdId(1), refundId: null });
      await addFact(client, { id: factId(1) });
      const rows = (await client.query(sql)).rows;
      expect(rows.map((r) => [r.hold_id, r.problem])).toEqual([
        [holdId(1), "fact_unbound"],
      ]);
    });
  });

  it("[legend-26ro5] does not list an anonymous hold of an intent with no provider fact", async () => {
    const sql = gateText();
    await shadowed(async (client) => {
      await addHold(client, { id: holdId(1), refundId: null });
      // Only a synthetic_full fact: finance cannot pair a hold to it.
      await addFact(client, {
        id: factId(1),
        kind: "synthetic_full",
        refundId: "tx1",
      });
      expect((await client.query(sql)).rows).toEqual([]);
    });
  });

  it("[legend-26ro5] does not list an anonymous hold closed without a fact because nothing was left (left <= 0)", async () => {
    const sql = gateText();
    await shadowed(async (client) => {
      // Payment 100000, provider fact 100000, hold 30000 counted, no fact.
      await addFact(client, { id: factId(1), amount: 100000 });
      await addHold(client, { id: holdId(1), refundId: null, amount: 30000 });
      expect((await client.query(sql)).rows).toEqual([]);
    });
  });

  it("[legend-26ro5] lists a fact of 3000 under a hold of 5000: fact_below_hold", async () => {
    const sql = gateText();
    await shadowed(async (client) => {
      await addHold(client, { id: holdId(1), amount: 5000 });
      await addFact(client, { id: factId(1), amount: 3000 });
      const rows = (await client.query(sql)).rows;
      expect(rows.map((r) => [r.hold_id, r.problem])).toEqual([
        [holdId(1), "fact_below_hold"],
      ]);
      expect(rows[0].covered_idr).toBe("3000");
      expect(rows[0].fact_count).toBe("1");
    });
  });

  it("[legend-26ro5] lists a hold with no payment ref whose fact is smaller", async () => {
    const sql = gateText();
    await shadowed(async (client) => {
      await addHold(client, { id: holdId(1), paymentRef: null, amount: 5000 });
      await addFact(client, { id: factId(1), amount: 4000 });
      const rows = (await client.query(sql)).rows;
      expect(rows.map((r) => [r.hold_id, r.problem])).toEqual([
        [holdId(1), "fact_below_hold"],
      ]);
    });
  });

  // The schema keeps one fact per (tenant, provider, kind, id)
  // (payment_provider_refunds_provider_refund_key), so a hold that names a
  // refund id has at most one fact: a "sum over several transactions" case
  // cannot exist and is not tested (the SQL still sums, which is harmless).

  it("[legend-26ro5] lists an unbound hold whose fact another hold is already bound to: fact_shared", async () => {
    const sql = gateText();
    await shadowed(async (client) => {
      await addFact(client, { id: factId(1), amount: 5000 });
      await addHold(client, { id: holdId(1) });
      await addHold(client, {
        id: holdId(2),
        refundId: "r2",
        matchedFactId: factId(1),
      });
      const rows = (await client.query(sql)).rows;
      expect(rows.map((r) => [r.hold_id, r.problem])).toEqual([
        [holdId(1), "fact_shared"],
      ]);
    });
  });

  it("[legend-26ro5] does not count a fact that echoes a refund of ours", async () => {
    const sql = gateText();
    await shadowed(async (client) => {
      await addFact(client, { id: factId(1), amount: 5000 });
      await addHold(client, { id: holdId(1), amount: 5000 });
      // Our own completed refund carries the provider refund id of the fact
      // on the intent's own transaction: the fact is its echo, not a cover.
      await addOwnRefund(client, {
        id: ownId(1),
        refundId: "r1",
        amount: 5000,
      });
      const rows = (await client.query(sql)).rows;
      expect(rows.map((r) => [r.hold_id, r.problem])).toEqual([
        [holdId(1), "fact_below_hold"],
      ]);
      expect(rows[0].covered_idr).toBe("0");
    });
  });

  it("[legend-26ro5] lists two unbound counted holds of one fact (one with no payment ref, one with tx1): fact_shared", async () => {
    const sql = gateText();
    await shadowed(async (client) => {
      await addFact(client, { id: factId(1), amount: 5000 });
      await addHold(client, { id: holdId(1), paymentRef: null });
      await addHold(client, { id: holdId(2), paymentRef: "tx1" });
      const rows = (await client.query(sql)).rows;
      expect(rows.map((r) => [r.hold_id, r.problem])).toEqual([
        [holdId(1), "fact_shared"],
        [holdId(2), "fact_shared"],
      ]);
    });
  });

  it("[legend-26ro5] subtracts our completed refund only for a hold on the intent's own transaction", async () => {
    const sql = gateText();
    await shadowed(async (client) => {
      // Intent 100000 on tx1; the fund evidence of 100000 is on tx2; our own
      // 100000 refund completed on tx1; provider fact R1 of 30000 on tx2.
      await client.query(
        `INSERT INTO payment_evidence
           (id, tenant_id, payment_intent_id, provider, provider_ref, amount_idr)
         VALUES ($1, $2, $3, 'doit', 'tx2', 100000)`,
        [ownId(90), tenantA, intent1],
      );
      await addOwnRefund(client, {
        id: ownId(1),
        refundId: "own1",
        amount: 100000,
      });
      await addFact(client, {
        id: factId(1),
        amount: 30000,
        paymentRef: "tx2",
      });
      await addHold(client, {
        id: holdId(1),
        refundId: null,
        amount: 30000,
        paymentRef: "tx2",
      });
      await addHold(client, {
        id: holdId(2),
        refundId: null,
        amount: 30000,
        paymentRef: "tx2",
      });
      // tx2 has 70000 left (100000 - 30000); our tx1 refund is not its money.
      const rows = (await client.query(sql)).rows;
      expect(rows.map((r) => r.hold_id)).toContain(holdId(2));
    });
  });

  it("[legend-26ro5] never matches a hold to a fact of another tenant", async () => {
    const sql = gateText();
    await shadowed(async (client) => {
      await addHold(client, { id: holdId(1) });
      await addFact(client, { id: factId(1), tenantId: tenantB });
      const rows = (await client.query(sql)).rows;
      expect(rows.map((r) => [r.tenant_id, r.hold_id, r.problem])).toEqual([
        [tenantA, holdId(1), "fact_unbound"],
      ]);
    });
  });

  it("[legend-26ro5] passes (no rows) for holds that are bound or closed by a legitimate path", async () => {
    const sql = gateText();
    await shadowed(async (client) => {
      // Bound to a fact.
      await addFact(client, { id: factId(1), refundId: "bound" });
      await addHold(client, {
        id: holdId(1),
        refundId: "bound",
        matchedFactId: factId(1),
      });
      // Anonymous hold with its own synthetic_hold fact (keyed by hold id).
      await addFact(client, {
        id: factId(2),
        kind: "synthetic_hold",
        refundId: holdId(2),
      });
      await addHold(client, { id: holdId(2), refundId: null });
      // Legitimate NULL: synthetic_full, credit used before the refund.
      await addHold(client, {
        id: holdId(3),
        refundId: "full",
        kind: "synthetic_full",
      });
      await addHold(client, {
        id: holdId(4),
        refundId: "credit",
        reason: "credit_used_before_provider_refund",
      });
      // Open hold and not_this_intent hold are not counted.
      await addHold(client, {
        id: holdId(5),
        refundId: "open",
        resolved: false,
        resolution: null,
      });
      await addHold(client, {
        id: holdId(6),
        refundId: "other",
        resolution: "not_this_intent",
      });
      // Named hold whose fact covers it and no other hold touches the fact.
      await addFact(client, { id: factId(3), refundId: "covered" });
      await addHold(client, { id: holdId(7), refundId: "covered" });
      expect((await client.query(sql)).rows).toEqual([]);
    });
  });

  it("[legend-26ro5] a hold of tenant A and a fact bound by a hold of tenant B do not interact", async () => {
    const sql = gateText();
    await shadowed(async (client) => {
      await addFact(client, { id: factId(1) });
      await addHold(client, { id: holdId(1) });
      await addHold(client, {
        id: holdId(2),
        tenantId: tenantB,
        matchedFactId: factId(1),
      });
      expect((await client.query(sql)).rows).toEqual([]);
    });
  });
});
