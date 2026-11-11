// legend-pti5r: apps/api/scripts/recovery-refund-final-failure-check.sql lists
// recovery refunds (ORD-09) that ended in a final failure before the fix and
// were never settled. It is read-only and is run by hand with an admin
// connection (docs/runbooks/recovery-refund-final-failure-backfill.md).
// The test seeds one row per category and several clean rows in a tenant
// (foreign keys skipped with session_replication_role = replica, as the other
// recovery refund tests do), runs the whole file as one simple query (as
// `psql -f` would) and asserts exactly the flagged issue ids. The promo
// ledger is not checked (a final failure leaves it untouched, a re-report
// replays the failed refund).
// It also checks that the script wrote nothing (a read-only transaction) and
// that it fails loudly for a role that is neither superuser nor BYPASSRLS
// (FORCE RLS would otherwise hide every row and the result would be empty).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { owner } from "./floor-test-helpers.ts";

const checkSql = readFileSync(
  new URL(
    "../../scripts/recovery-refund-final-failure-check.sql",
    import.meta.url,
  ),
  "utf8",
);

type Tenant = { id: string; outletId: string };
const tenants: Tenant[] = [];

async function makeTenant(): Promise<Tenant> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Uji Cek Refund', 'lengkap', 'active', 'shared', '{}', '{}', $3)`,
    [id, `uji-cek-${id.slice(0, 8)}`, randomUUID()],
  );
  const tenant = { id, outletId: randomUUID() };
  tenants.push(tenant);
  return tenant;
}

type Seed = {
  /** Failure reasons of the failed recovery refunds, oldest first. */
  failed: (string | null)[];
  requestedBy?: string;
  /** A refund of the issue that is not failed. */
  live?: boolean;
  stamped?: boolean;
  firstFiling?: false;
  orderRefundedEvent?: boolean;
  reversalEvent?: boolean;
};

type Seeded = { issueId: string; orderId: string };

/** One issue with its refunds and events, in one replica-mode tx. */
async function seed(tenant: Tenant, spec: Seed): Promise<Seeded> {
  const issueId = randomUUID();
  const orderId = randomUUID();
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)`,
      [tenant.id],
    );
    await client.query(
      `INSERT INTO order_issues (id, tenant_id, outlet_id, order_id, order_item_id, type, reason,
         reason_note, reported_by, resolution, approved_by, cost_idr, status, idempotency_key,
         resolved_at, refund_rejected_at)
       VALUES ($1, $2, $3, $4, $5, 'unfulfillable', 'out_of_stock', 'Roti habis, refund manual disetujui',
         $6, 'manual_refund', $7, 0, 'resolved', $8, now(), $9)`,
      [
        issueId,
        tenant.id,
        tenant.outletId,
        orderId,
        randomUUID(),
        randomUUID(),
        randomUUID(),
        `ck-${randomUUID()}`,
        spec.stamped ? new Date() : null,
      ],
    );
    const intentId = randomUUID();
    let minute = 0;
    const refund = async (status: string, reason: string | null) => {
      minute += 1;
      await client.query(
        `INSERT INTO payment_refunds
           (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
            failure_reason, requested_by, decided_at, order_issue_id, created_at)
         VALUES ($1, $2, $3, $4, 40000, 'Refund item gagal (ORD-09)', $5, $6, $7, now(), $8,
                 now() - ($9 || ' minutes')::interval)`,
        [
          randomUUID(),
          tenant.id,
          tenant.outletId,
          intentId,
          status,
          reason,
          spec.requestedBy ?? "system:recovery",
          issueId,
          String(100 - minute),
        ],
      );
    };
    for (const reason of spec.failed) await refund("failed", reason);
    if (spec.live) await refund("pending", null);
    if (spec.firstFiling !== false)
      await client.query(
        `INSERT INTO payment_admin_idempotency (tenant_id, key, fingerprint, response)
         VALUES ($1, $2, $3, $4)`,
        [
          tenant.id,
          `order-recovery-refund:${issueId}`,
          "f".repeat(64),
          JSON.stringify({
            refundId: randomUUID(),
            resolvedBy: null,
            approvedBy: randomUUID(),
          }),
        ],
      );
    const outbox = (
      aggregateType: string,
      aggregateId: string,
      name: string,
      payload: Record<string, unknown>,
    ) =>
      client.query(
        `INSERT INTO domain_event_outbox
           (tenant_id, id, outlet_id, event_id, aggregate_type, aggregate_id, sequence, event, destination)
         VALUES ($1, $2, $3, $4, $5, $6, 1, $7, 'cloud-sync')`,
        [
          tenant.id,
          randomUUID(),
          tenant.outletId,
          randomUUID(),
          aggregateType,
          aggregateId,
          JSON.stringify({
            name,
            tenantId: tenant.id,
            aggregateType,
            sequence: 1,
            outletId: tenant.outletId,
            payload,
          }),
        ],
      );
    if (spec.orderRefundedEvent)
      await outbox("order", orderId, "order.refunded", { refundId: issueId });
    if (spec.reversalEvent)
      await outbox(
        "order_issue",
        issueId,
        "order_issue.refund_reversal_requested",
        {
          refundId: issueId,
        },
      );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return { issueId, orderId };
}

let a: Tenant;
const clean: Record<string, string> = {};
const named: Record<string, Seeded> = {};

beforeAll(async () => {
  a = await makeTenant();

  // ---- Query 1: flagged
  named.unstamped = await seed(a, { failed: ["provider_declined"] });
  named.noReversal = await seed(a, {
    failed: ["cap_exceeded"],
    stamped: true,
    orderRefundedEvent: true,
  });
  named.refileLimit = await seed(a, {
    failed: ["approval_expired", "approval_expired", "approver_unauthorized"],
  });
  named.noFirstFiling = await seed(a, {
    failed: ["approval_expired"],
    firstFiling: false,
  });
  named.rejectedUnstamped = await seed(a, { failed: ["rejected"] });
  named.unknownReason = await seed(a, { failed: [null] });
  // a final failure after an earlier approval_expired
  named.expiredThenDeclined = await seed(a, {
    failed: ["approval_expired", "source_document"],
  });

  // ---- Query 1: clean
  clean.settled = (
    await seed(a, {
      failed: ["provider_declined"],
      stamped: true,
      orderRefundedEvent: true,
      reversalEvent: true,
    })
  ).issueId;
  clean.openBill = (
    await seed(a, { failed: ["provider_declined"], stamped: true })
  ).issueId;
  clean.live = (
    await seed(a, { failed: ["approval_expired"], live: true })
  ).issueId;
  clean.waitingRefile = (
    await seed(a, { failed: ["approval_expired"] })
  ).issueId;
  clean.notRecovery = (
    await seed(a, {
      failed: ["provider_declined"],
      requestedBy: "user:manual",
    })
  ).issueId;
}, 120_000);

afterAll(async () => {
  for (const tenant of tenants) {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      for (const table of [
        "domain_event_outbox",
        "payment_admin_idempotency",
        "payment_refunds",
        "order_issues",
      ])
        await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [
          tenant.id,
        ]);
      await client.query("DELETE FROM tenants WHERE id = $1", [tenant.id]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
});

type Row = Record<string, unknown>;

/** Runs the whole file as one simple query; returns the rows of its query. */
async function runCheck(): Promise<Row[]> {
  const results = (await owner.query(checkSql)) as unknown as {
    command: string;
    rows: Row[];
  }[];
  const selects = results.filter((result) => result.command === "SELECT");
  expect(selects).toHaveLength(1);
  return selects[0]!.rows;
}

const ours = (rows: Row[]) =>
  rows.filter((row) => tenants.some((tenant) => tenant.id === row.tenant_id));

describe("recovery refund final failure check (legend-pti5r)", () => {
  it("query 1 flags exactly the final failures the live settlement missed", async () => {
    const rows = ours(await runCheck());
    const ids = rows.map((row) => row.issue_id as string).sort();
    const expected = [
      named.unstamped,
      named.noReversal,
      named.refileLimit,
      named.noFirstFiling,
      named.rejectedUnstamped,
      named.unknownReason,
      named.expiredThenDeclined,
    ]
      .map((item) => item!.issueId)
      .sort();
    expect(ids).toEqual(expected);
    const byId = new Map(rows.map((row) => [row.issue_id as string, row]));
    expect(byId.get(named.unstamped!.issueId)).toMatchObject({
      tenant_id: a.id,
      order_id: named.unstamped!.orderId,
      last_reason: "provider_declined",
      missing_stamp: true,
      missing_reversal: false,
    });
    expect(Number(byId.get(named.unstamped!.issueId)!.last_amount_idr)).toBe(
      40_000,
    );
    // stamped, but the journal reversal was never requested
    expect(byId.get(named.noReversal!.issueId)).toMatchObject({
      missing_stamp: false,
      missing_reversal: true,
    });
    expect(byId.get(named.refileLimit!.issueId)).toMatchObject({
      failed_count: "3",
      missing_stamp: true,
    });
    expect(byId.get(named.expiredThenDeclined!.issueId)).toMatchObject({
      last_reason: "source_document",
    });
    for (const id of Object.values(clean)) expect(ids).not.toContain(id);
  });

  it("writes nothing: a second run returns the same rows and the data is unchanged", async () => {
    const count = async () => {
      const { rows } = await owner.query<{ n: string }>(
        `SELECT (SELECT count(*) FROM order_issues WHERE tenant_id = ANY($1) AND refund_rejected_at IS NOT NULL)
              + (SELECT count(*) FROM domain_event_outbox WHERE tenant_id = ANY($1)) AS n`,
        [tenants.map((tenant) => tenant.id)],
      );
      return rows[0]!.n;
    };
    const before = await count();
    const first = await runCheck();
    const second = await runCheck();
    expect(ours(second)).toEqual(ours(first));
    expect(await count()).toBe(before);
  });

  it("runs as a superuser or BYPASSRLS role (the owner connection of the test)", async () => {
    const { rows } = await owner.query<{ ok: boolean }>(
      `SELECT (rolsuper OR rolbypassrls) AS ok FROM pg_roles WHERE rolname = current_user`,
    );
    expect(rows[0]!.ok).toBe(true);
    expect(ours(await runCheck()).length).toBeGreaterThan(0);
  });

  it("fails with a clear error for a role without BYPASSRLS", async () => {
    const role = `uji_cek_nobypass_${randomUUID().slice(0, 8)}`;
    await owner.query(
      `CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    const client = await owner.connect();
    try {
      await client.query(`SET ROLE "${role}"`);
      let message = "";
      try {
        await client.query(checkSql);
      } catch (error) {
        message = (error as Error).message;
        // the file's BEGIN is still open after the error
        await client.query("ROLLBACK");
      }
      expect(message).toContain("superuser or BYPASSRLS");
      expect(message).toContain(role);
      // the read-only transaction was left behind: nothing is open or written
      await client.query("RESET ROLE");
      const { rows } = await client.query<{ n: string }>(
        "SELECT count(*) AS n FROM order_issues WHERE tenant_id = ANY($1)",
        [tenants.map((tenant) => tenant.id)],
      );
      expect(Number(rows[0]!.n)).toBeGreaterThan(0);
    } finally {
      await client.query("RESET ROLE").catch(() => undefined);
      client.release();
      await owner.query(`DROP ROLE IF EXISTS "${role}"`);
    }
  });
});
