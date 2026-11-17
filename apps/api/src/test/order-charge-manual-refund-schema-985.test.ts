// legend-9e21l (index) and legend-mrwtp (table only), brief 985.
// - Migration 0565: the partial expression index on domain_event_outbox that
//   the charge refund lookups (payment-admin chargeInUseOfIntent and the
//   accounting guard) use; EXPLAIN with seq scans off must pick it.
// - Migration 0566: order_issue_charge_manual_refunds is tenant + outlet RLS
//   forced, and its CHECKs refuse bad shapes. A row that passes every CHECK is
//   stopped by a foreign key (23503), so no fixture chain is needed.
import { randomUUID } from "node:crypto";
import { Pool, type QueryResult } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendFixtures } from "@starter/shared/core";

const { tenant, outlets } = cafeLegendFixtures;
const tenantId = tenant.id;
const outletId = outlets[0].id;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

/** Run as the migration owner with the tenant settings, then roll back. */
async function inTx<T>(
  run: (
    query: (text: string, params?: unknown[]) => Promise<QueryResult>,
  ) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    return await run((text, params) => client.query(text, params));
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterAll(async () => {
  await owner.end();
});

describe("0565 outbox charge_refunded expression index", () => {
  it("is partial on the event name and covers the payload refundId", async () => {
    const { rows } = await inTx((q) =>
      q(
        `SELECT indexdef FROM pg_indexes
          WHERE indexname = 'domain_event_outbox_charge_refunded_idx'`,
      ),
    );
    expect(rows).toHaveLength(1);
    const def = rows[0].indexdef as string;
    expect(def).toContain(
      "(((event -> 'payload'::text) ->> 'refundId'::text))",
    );
    expect(def).toContain(
      "((event ->> 'name'::text) = 'order_issue.charge_refunded'::text)",
    );
  });

  it("is used by the payment-admin lookup predicate", async () => {
    const plan = await inTx(async (q) => {
      await q("SET LOCAL enable_seqscan = off");
      const { rows } = await q(
        `EXPLAIN SELECT 1 FROM domain_event_outbox o
          WHERE o.tenant_id = $1::uuid
            AND o.event->>'name' = 'order_issue.charge_refunded'
            AND o.event->'payload'->>'refundId' = $2::text`,
        [tenantId, randomUUID()],
      );
      return rows
        .map((r: Record<string, string>) => r["QUERY PLAN"])
        .join("\n");
    });
    expect(plan).toContain("domain_event_outbox_charge_refunded_idx");
  });

  it("is used when joined to the refund row like chargeInUseOfIntent", async () => {
    const plan = await inTx(async (q) => {
      await q("SET LOCAL enable_seqscan = off");
      await q("SET LOCAL enable_hashjoin = off");
      await q("SET LOCAL enable_mergejoin = off");
      const { rows } = await q(
        `EXPLAIN SELECT r.id FROM payment_refunds r
          WHERE r.tenant_id = $1::uuid
            AND EXISTS (
              SELECT 1 FROM domain_event_outbox o
               WHERE o.tenant_id = r.tenant_id
                 AND o.event->>'name' = 'order_issue.charge_refunded'
                 AND o.event->'payload'->>'refundId' = r.id::text)`,
        [tenantId],
      );
      return rows
        .map((r: Record<string, string>) => r["QUERY PLAN"])
        .join("\n");
    });
    expect(plan).toContain("domain_event_outbox_charge_refunded_idx");
  });
});

describe("0566 order_issue_charge_manual_refunds", () => {
  it("has tenant and outlet RLS, forced", async () => {
    const { rows } = await inTx((q) =>
      q(
        `SELECT c.relrowsecurity, c.relforcerowsecurity,
                (SELECT count(*)::int FROM pg_policies p
                  WHERE p.tablename = c.relname) AS policies
           FROM pg_class c
          WHERE c.oid = 'public.order_issue_charge_manual_refunds'::regclass`,
      ),
    );
    expect(rows[0].relrowsecurity).toBe(true);
    expect(rows[0].relforcerowsecurity).toBe(true);
    expect(rows[0].policies).toBeGreaterThanOrEqual(2);
  });

  const insert = (
    q: (text: string, params?: unknown[]) => Promise<QueryResult>,
    row: Partial<Record<string, unknown>>,
  ) => {
    const base: Record<string, unknown> = {
      tenant_id: tenantId,
      outlet_id: outletId,
      charge_id: randomUUID(),
      method: "edc",
      amount_idr: 1000,
      reason: "salah tagih",
      reference: "EDC-123",
      status: "requested",
      requested_by: "nobody",
      ...row,
    };
    const keys = Object.keys(base);
    return q(
      `INSERT INTO order_issue_charge_manual_refunds (${keys.join(", ")})
       VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")})`,
      keys.map((k) => base[k]),
    );
  };

  const code = async (
    row: Partial<Record<string, unknown>>,
  ): Promise<string | undefined> =>
    inTx(async (q) => {
      try {
        await insert(q, row);
        return undefined;
      } catch (error) {
        return (error as { code?: string; constraint?: string }).code ===
          "23514"
          ? `23514:${(error as { constraint?: string }).constraint}`
          : (error as { code?: string }).code;
      }
    });

  it("passes every CHECK for a valid shape (stopped by a foreign key)", async () => {
    expect(await code({})).toBe("23503");
    expect(await code({ method: "cash", reference: null })).toBe("23503");
  });

  it("refuses a non-positive amount", async () => {
    expect(await code({ amount_idr: 0 })).toBe(
      "23514:order_issue_charge_manual_refunds_amount_check",
    );
  });

  it("requires a 3-100 char reference for EDC and none for cash", async () => {
    const ref = "order_issue_charge_manual_refunds_reference_check";
    expect(await code({ reference: null })).toBe(`23514:${ref}`);
    expect(await code({ reference: "ab" })).toBe(`23514:${ref}`);
    expect(await code({ reference: "x".repeat(101) })).toContain("22001");
    expect(await code({ method: "cash", reference: "EDC-123" })).toBe(
      `23514:${ref}`,
    );
  });

  it("refuses an unknown method and status", async () => {
    expect(await code({ method: "bank" })).toBe(
      "23514:order_issue_charge_manual_refunds_method_check",
    );
    // An unknown status also breaks the decided check; Postgres reports the
    // first failing CHECK in constraint-name order, so accept either.
    expect(await code({ status: "paid" })).toMatch(
      /^23514:order_issue_charge_manual_refunds_(status|decided)_check$/,
    );
  });

  it("ties decided_by/decided_at and reject_reason to the status", async () => {
    expect(await code({ status: "completed" })).toBe(
      "23514:order_issue_charge_manual_refunds_decided_check",
    );
    expect(
      await code({
        decided_by: "nobody",
        decided_at: new Date(),
      }),
    ).toBe("23514:order_issue_charge_manual_refunds_decided_check");
    expect(
      await code({
        status: "rejected",
        decided_by: "nobody",
        decided_at: new Date(),
      }),
    ).toBe("23514:order_issue_charge_manual_refunds_reject_check");
  });

  it("ties the cash movement to a completed cash refund", async () => {
    const cash = "order_issue_charge_manual_refunds_cash_check";
    // EDC refund can never hold a cash movement or a shift.
    expect(
      await code({
        status: "completed",
        decided_by: "nobody",
        decided_at: new Date(),
        cash_movement_id: randomUUID(),
        shift_id: randomUUID(),
      }),
    ).toBe(`23514:${cash}`);
    // A completed cash refund has a cash movement.
    expect(
      await code({
        method: "cash",
        reference: null,
        status: "completed",
        decided_by: "nobody",
        decided_at: new Date(),
      }),
    ).toBe(`23514:${cash}`);
  });
});
