// legend-knev: one bill (payment_links) may carry several unallocated funds,
// one per provider evidence. Resolving a fund refunds exactly that fund, and
// the bill-level invariants fail closed with 409. Real HTTP and PostgreSQL.
//
// Seeding model: by default every evidence sits on its own paid intent of the
// bill. Bill excess = sum(evidence) - payment_links.paid_idr (the applied part,
// default paid_idr = total). Assumptions (from the sub-brief):
// - list/resolve endpoints live under /api/payments/admin/unallocated-funds
// - tenant isolation is proven with the cafe-legend admin against a fund that
//   belongs to a second seeded tenant (the fixtures give no second-tenant admin)
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app";
import { setPaymentRefundGateway } from "../services/payment-refund-gateway";
import { sweepApprovedRefundPayouts } from "../services/payment-refund.service";
import { FakeRefundGateway } from "./refund-fake-gateway";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers";

import { paymentTestScope } from "./payment-test-scope";

const scope = paymentTestScope();
const app = createApp();
const tenantId = scope.tenantId;
const outletA = scope.outletId;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const ADMIN = "/api/payments/admin";
const otherTenant = randomUUID();
const otherBrand = randomUUID();
const otherLegal = randomUUID();
const otherOutlet = randomUUID();
const tenantWide: ScopedTenantContext = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "session" }),
  { kind: "tenant" },
);
let userId = "";
let financeSupId = "";
let manager: ReturnType<typeof agent>;
let financeSup: ReturnType<typeof agent>;
let fake: FakeRefundGateway;

type Bill = {
  linkId: string;
  intentIds: string[];
  evidenceIds: string[];
  fundIds: string[];
  fundIntentIds: string[];
};
const seeded: Bill[] = [];

/** One bill: `evidences[i]` is paid on its own intent; `funds[i].evidence` indexes it. */
async function seedBill(opts: {
  total: number;
  evidences: number[];
  funds: { amount: number; evidence: number }[];
  /** payment_links.paid_idr, the applied part of the bill. Default: total. */
  paid?: number;
  /** Paid intent index carrying each evidence. Default: one intent per evidence. */
  evidenceIntent?: number[];
  /** Extra intents that never received money (still pending). */
  unpaidIntents?: number;
  tenant?: string;
  outlet?: string;
}): Promise<Bill> {
  const tenant = opts.tenant ?? tenantId;
  const outlet = opts.outlet ?? outletA;
  const linkId = randomUUID();
  const bill: Bill = {
    linkId,
    intentIds: [],
    evidenceIds: [],
    fundIds: [],
    fundIntentIds: [],
  };
  seeded.push(bill);
  await owner.query(
    `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8)`,
    [
      linkId,
      tenant,
      outlet,
      randomBytes(32).toString("hex"),
      `MF-${linkId.slice(0, 8)}`,
      opts.total,
      opts.paid ?? opts.total,
      opts.tenant ? "seed" : userId,
    ],
  );
  const evidenceIntent =
    opts.evidenceIntent ?? opts.evidences.map((_, index) => index);
  const paidIntents =
    evidenceIntent.length === 0 ? 0 : Math.max(...evidenceIntent) + 1;
  for (let i = 0; i < paidIntents; i++) {
    const intentId = randomUUID();
    const amount = opts.evidences
      .filter((_, index) => evidenceIntent[index] === i)
      .reduce((sum, value) => sum + value, 0);
    await owner.query(
      `INSERT INTO payment_intents (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key, status, paid_at, instructions, expires_at)
       VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'paid', now(), '{"method":"qris","qrPayload":"test","issuer":null}', now())`,
      [intentId, tenant, outlet, linkId, amount || 1, `mf-${intentId}`],
    );
    bill.intentIds.push(intentId);
  }
  for (let i = 0; i < (opts.unpaidIntents ?? 0); i++) {
    const intentId = randomUUID();
    await owner.query(
      `INSERT INTO payment_intents (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key, status, instructions, expires_at)
       VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'pending', '{"method":"qris","qrPayload":"test","issuer":null}', now() + interval '1 hour')`,
      [intentId, tenant, outlet, linkId, opts.total, `mf-${intentId}`],
    );
    bill.intentIds.push(intentId);
  }
  for (const [index, amount] of opts.evidences.entries()) {
    const evidenceId = randomUUID();
    await owner.query(
      `INSERT INTO payment_evidence (id, tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
       VALUES ($1, $2, $3, $4, 'doit', $5, 'qris', 'verified_webhook', $6, now())`,
      [
        evidenceId,
        tenant,
        outlet,
        bill.intentIds[evidenceIntent[index]!],
        `mf-${evidenceId}`,
        amount,
      ],
    );
    bill.evidenceIds.push(evidenceId);
  }
  for (const fund of opts.funds) {
    const fundId = randomUUID();
    const intentId = bill.intentIds[evidenceIntent[fund.evidence]!]!;
    await owner.query(
      `INSERT INTO payment_unallocated_funds (id, tenant_id, outlet_id, payment_intent_id, evidence_id, amount_idr, reason)
       VALUES ($1, $2, $3, $4, $5, $6, 'overpayment')`,
      [
        fundId,
        tenant,
        outlet,
        intentId,
        bill.evidenceIds[fund.evidence],
        fund.amount,
      ],
    );
    bill.fundIds.push(fundId);
    bill.fundIntentIds.push(intentId);
  }
  return bill;
}

function resolve(fundId: string, key = `mf-${randomUUID()}`) {
  return manager
    .post(`${ADMIN}/unallocated-funds/${fundId}/resolve`)
    .set(originHeader)
    .send({ idempotencyKey: key, resolution: "refund", note: "Return excess" });
}

async function refundsOf(fundIds: string[]) {
  const { rows } = await owner.query<{
    unallocated_fund_id: string;
    amount_idr: string;
    status: string;
  }>(
    "SELECT unallocated_fund_id, amount_idr::text, status FROM payment_refunds WHERE unallocated_fund_id = ANY($1::uuid[]) ORDER BY array_position($1::uuid[], unallocated_fund_id)",
    [fundIds],
  );
  return rows;
}

async function resolvedFundIds(fundIds: string[]) {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM payment_unallocated_funds WHERE id = ANY($1::uuid[]) AND resolution = 'refund' ORDER BY id",
    [fundIds],
  );
  return rows.map((r) => r.id);
}

async function listFundIds(outletId = outletA) {
  const response = await manager.get(
    `${ADMIN}/unallocated-funds?outletId=${outletId}`,
  );
  return response;
}

function statusOf(
  response: { body: { data: { id: string; status: string }[] } },
  fundId: string,
): string | undefined {
  return response.body.data.find((f) => f.id === fundId)?.status;
}

/** Fund rows as stored, to prove that listing or a refused resolve mutates nothing. */
async function fundRows(fundIds: string[]) {
  const { rows } = await owner.query(
    "SELECT id, amount_idr::text, resolution FROM payment_unallocated_funds WHERE id = ANY($1::uuid[]) ORDER BY id",
    [fundIds],
  );
  return rows;
}

async function cleanupBills() {
  for (const bill of seeded.splice(0)) {
    await owner.query(
      "DELETE FROM payment_refunds WHERE payment_intent_id = ANY($1::uuid[])",
      [bill.intentIds],
    );
    await owner.query(
      "DELETE FROM payment_unallocated_funds WHERE payment_intent_id = ANY($1::uuid[])",
      [bill.intentIds],
    );
    await owner.query(
      "DELETE FROM payment_evidence WHERE payment_intent_id = ANY($1::uuid[])",
      [bill.intentIds],
    );
    await owner.query(
      "DELETE FROM payment_intents WHERE id = ANY($1::uuid[])",
      [bill.intentIds],
    );
    await owner.query("DELETE FROM payment_links WHERE id = $1", [bill.linkId]);
  }
}

beforeAll(async () => {
  await scope.seed(owner);
  manager = agent(app).set("Host", scope.hostname);
  const email = await signUp(manager, "Multi fund admin");
  const session = await manager.get("/api/auth/get-session");
  userId = session.body.user.id as string;
  await verifySessionMfa(email);
  const role = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'owner'",
    [tenantId],
  );
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenantId, userId, role.rows[0]!.id],
  );
  // Finance (tenant) + supervisor (outlet): may retry a held refund payout.
  financeSup = agent(app).set("Host", scope.hostname);
  const supEmail = await signUp(financeSup, "Multi fund finance supervisor");
  const supSession = await financeSup.get("/api/auth/get-session");
  financeSupId = supSession.body.user.id as string;
  await verifySessionMfa(supEmail);
  for (const [template, scope] of [
    ["finance", "tenant"],
    ["supervisor", "outlet"],
  ] as const) {
    const roleRow = await owner.query<{ id: string }>(
      "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
      [tenantId, template],
    );
    await owner.query(
      `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $2)`,
      [
        tenantId,
        financeSupId,
        roleRow.rows[0]!.id,
        scope,
        scope === "outlet" ? outletA : null,
      ],
    );
  }
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Other tenant', 'lengkap', 'active', 'shared', '{"modules":[],"integrationProviders":[]}', $3, $4)`,
    [
      otherTenant,
      `other-${otherTenant}`,
      JSON.stringify(cafeLegendPlatformFixtures.packages[0].defaultLimits),
      randomUUID(),
    ],
  );
  await owner.query(
    "INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Other')",
    [otherBrand, otherTenant, `brand-${otherBrand}`],
  );
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'Other', false)",
    [otherLegal, otherTenant],
  );
  await owner.query(
    "INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours) VALUES ($1, $2, $3, $4, 'OTHER', 'Other', 'Other', '{}')",
    [otherOutlet, otherTenant, otherBrand, otherLegal],
  );
});

afterEach(cleanupBills);

afterAll(async () => {
  await cleanupBills();
  await owner.query(
    "DELETE FROM payment_admin_idempotency WHERE tenant_id = $1",
    [otherTenant],
  );
  await owner.query("DELETE FROM outlets WHERE id = $1", [otherOutlet]);
  await owner.query("DELETE FROM legal_entities WHERE id = $1", [otherLegal]);
  await owner.query("DELETE FROM brands WHERE id = $1", [otherBrand]);
  await owner.query("DELETE FROM tenants WHERE id = $1", [otherTenant]);
  await owner.query(
    "DELETE FROM role_assignments WHERE user_id = ANY($1::text[])",
    [[userId, financeSupId]],
  );
  await owner.end();
});

describe("legend-knev multi-fund unallocated resolve", () => {
  it("MF-01 two funds on one bill both list and each refunds its own amount", async () => {
    // Paid 70k + 60k on a 100k bill: excess 30k = fund 10k + fund 20k.
    const bill = await seedBill({
      total: 100_000,
      evidences: [70_000, 60_000],
      funds: [
        { amount: 10_000, evidence: 0 },
        { amount: 20_000, evidence: 1 },
      ],
    });
    const list = await listFundIds();
    expect(list.status).toBe(200);
    const listed = (list.body.data as { id: string }[]).map((f) => f.id);
    expect(listed).toEqual(expect.arrayContaining(bill.fundIds));

    expect((await resolve(bill.fundIds[0]!)).status).toBe(200);
    expect((await resolve(bill.fundIds[1]!)).status).toBe(200);
    const refunds = await refundsOf(bill.fundIds);
    expect(
      refunds.map((r) => [r.unallocated_fund_id, r.amount_idr, r.status]),
    ).toEqual([
      [bill.fundIds[0], "10000", "pending"],
      [bill.fundIds[1], "20000", "pending"],
    ]);
    // Assumption: "resolved" at request time means a live pending refund holds
    // the fund (the fund row itself is only stamped on approval), so a second
    // resolve of either fund is refused.
    expect((await resolve(bill.fundIds[0]!)).status).toBe(409);
    expect((await resolve(bill.fundIds[1]!)).status).toBe(409);
    expect(await refundsOf(bill.fundIds)).toHaveLength(2);
  });

  it("MF-02 three funds resolved one by one refund exactly the bill excess", async () => {
    // Paid 60k + 50k + 40k on a 100k bill: excess 50k.
    const bill = await seedBill({
      total: 100_000,
      evidences: [60_000, 50_000, 40_000],
      funds: [
        { amount: 10_000, evidence: 0 },
        { amount: 15_000, evidence: 1 },
        { amount: 25_000, evidence: 2 },
      ],
    });
    for (const fundId of bill.fundIds) {
      expect((await resolve(fundId)).status).toBe(200);
    }
    const refunds = await refundsOf(bill.fundIds);
    expect(refunds).toHaveLength(3);
    expect(refunds.reduce((sum, r) => sum + Number(r.amount_idr), 0)).toBe(
      50_000,
    );
    expect((await resolve(bill.fundIds[2]!)).status).toBe(409);
  });

  it("MF-03 a fund larger than its own evidence is refused on resolve and listed as needs_review", async () => {
    // Evidence 20k + 110k on a 100k bill: excess 30k, and the one fund is 30k
    // (sums are consistent) but its evidence only carries 20k.
    // legend-ftqf: the list no longer fails (409); the inconsistent row stays
    // visible with status needs_review. Resolve keeps refusing with 409.
    const bill = await seedBill({
      total: 100_000,
      evidences: [20_000, 110_000],
      funds: [{ amount: 30_000, evidence: 0 }],
    });
    const before = await fundRows(bill.fundIds);
    const list = await listFundIds();
    expect(list.status).toBe(200);
    expect(statusOf(list, bill.fundIds[0]!)).toBe("needs_review");
    const response = await resolve(bill.fundIds[0]!);
    expect(response.status).toBe(409);
    expect(await refundsOf(bill.fundIds)).toEqual([]);
    expect(await resolvedFundIds(bill.fundIds)).toEqual([]);
    expect(await fundRows(bill.fundIds)).toEqual(before);
  });

  it("MF-04 funds that add up above the bill excess fail closed on resolve and show needs_review on the list", async () => {
    // Excess = evidence 130k - paid_idr 100k = 30k, but funds are 20k + 20k = 40k.
    // legend-ftqf: the list answers 200 and flags both rows needs_review.
    const bill = await seedBill({
      total: 100_000,
      evidences: [80_000, 50_000],
      funds: [
        { amount: 20_000, evidence: 0 },
        { amount: 20_000, evidence: 1 },
      ],
    });
    const before = await fundRows(bill.fundIds);
    expect((await resolve(bill.fundIds[0]!)).status).toBe(409);
    const list = await listFundIds();
    expect(list.status).toBe(200);
    expect(statusOf(list, bill.fundIds[0]!)).toBe("needs_review");
    expect(statusOf(list, bill.fundIds[1]!)).toBe("needs_review");
    expect((await resolve(bill.fundIds[1]!)).status).toBe(409);
    expect(await refundsOf(bill.fundIds)).toEqual([]);
    expect(await fundRows(bill.fundIds)).toEqual(before);
  });

  it("MF-14 one inconsistent bill does not hide the healthy ones: list 200, healthy open, bad needs_review, nobody paid more", async () => {
    // legend-ftqf. Healthy bill: evidence 120k on a 100k bill, fund 20k.
    // Bad bill: funds 20k + 20k against an excess of 30k.
    const healthy = await seedBill({
      total: 100_000,
      evidences: [120_000],
      funds: [{ amount: 20_000, evidence: 0 }],
    });
    const bad = await seedBill({
      total: 100_000,
      evidences: [80_000, 50_000],
      funds: [
        { amount: 20_000, evidence: 0 },
        { amount: 20_000, evidence: 1 },
      ],
    });
    const everyFund = [...healthy.fundIds, ...bad.fundIds];
    const before = await fundRows(everyFund);
    const list = await listFundIds();
    expect(list.status).toBe(200);
    expect(statusOf(list, healthy.fundIds[0]!)).toBe("open");
    for (const fundId of bad.fundIds)
      expect(statusOf(list, fundId)).toBe("needs_review");
    // Listing moves nothing.
    expect(await fundRows(everyFund)).toEqual(before);
    expect(await refundsOf(everyFund)).toEqual([]);

    // A needs_review row cannot be resolved or paid; the healthy one still can,
    // and the total refunded never exceeds the healthy excess (20k).
    for (const fundId of bad.fundIds)
      expect((await resolve(fundId)).status).toBe(409);
    expect((await resolve(healthy.fundIds[0]!)).status).toBe(200);
    expect(await refundsOf(bad.fundIds)).toEqual([]);
    const refunds = await refundsOf(everyFund);
    expect(refunds.reduce((sum, r) => sum + Number(r.amount_idr), 0)).toBe(
      20_000,
    );
    expect(await resolvedFundIds(bad.fundIds)).toEqual([]);
    // After the healthy refund the list still answers 200 and keeps the flag.
    const after = await listFundIds();
    expect(after.status).toBe(200);
    expect(statusOf(after, bad.fundIds[0]!)).toBe("needs_review");
  });

  it("MF-05 live refunds that already cover the excess block another resolve", async () => {
    // Excess 30k = 15k + 15k, but a pending 20k refund already sits on fund 2:
    // 20k + 15k for fund 1 would be 35k > 30k.
    const bill = await seedBill({
      total: 100_000,
      evidences: [65_000, 65_000],
      funds: [
        { amount: 15_000, evidence: 0 },
        { amount: 15_000, evidence: 1 },
      ],
    });
    await owner.query(
      `INSERT INTO payment_refunds (tenant_id, outlet_id, payment_intent_id, unallocated_fund_id, amount_idr, reason, status, requested_by)
       VALUES ($1, $2, $3, $4, 20000, 'Seeded live refund', 'pending', 'seed')`,
      [tenantId, outletA, bill.fundIntentIds[1], bill.fundIds[1]],
    );
    const response = await resolve(bill.fundIds[0]!);
    expect(response.status).toBe(409);
    const refunds = await refundsOf([bill.fundIds[0]!]);
    expect(refunds).toEqual([]);
  });

  it("MF-06 resolve is idempotent per key and refuses a new key on a resolved fund", async () => {
    const bill = await seedBill({
      total: 100_000,
      evidences: [120_000],
      funds: [{ amount: 20_000, evidence: 0 }],
    });
    const key = `mf-${randomUUID()}`;
    const first = await resolve(bill.fundIds[0]!, key);
    const again = await resolve(bill.fundIds[0]!, key);
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(await refundsOf(bill.fundIds)).toHaveLength(1);

    const other = await resolve(bill.fundIds[0]!);
    expect(other.status).toBe(409);
    expect(await refundsOf(bill.fundIds)).toHaveLength(1);
  });

  describe("MF-07 concurrent resolves queue on the bill lock", () => {
    /** Hold the bill row lock, fire both resolves, wait until both are blocked. */
    async function raceOnBill(
      linkId: string,
      fundIds: [string, string],
    ): Promise<
      [Awaited<ReturnType<typeof resolve>>, Awaited<ReturnType<typeof resolve>>]
    > {
      const holder = await owner.connect();
      let pending: Promise<
        [
          Awaited<ReturnType<typeof resolve>>,
          Awaited<ReturnType<typeof resolve>>,
        ]
      > | null = null;
      try {
        await holder.query("BEGIN");
        await holder.query(
          "SELECT 1 FROM payment_links WHERE id = $1 FOR UPDATE",
          [linkId],
        );
        const { rows: pidRows } = await holder.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid",
        );
        const holderPid = pidRows[0]!.pid;
        pending = Promise.all([
          resolve(fundIds[0]).then((r) => r),
          resolve(fundIds[1]).then((r) => r),
        ]);
        // Both requests are provably in flight once two backends wait on the
        // holder, directly (first waiter) or via the first waiter's queue.
        await vi.waitFor(
          async () => {
            const { rows } = await owner.query<{ n: number }>(
              `WITH direct AS (
                 SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))
               )
               SELECT count(*)::int AS n FROM pg_stat_activity a
               WHERE a.pid IN (SELECT pid FROM direct)
                  OR EXISTS (SELECT 1 FROM direct d WHERE d.pid = ANY(pg_blocking_pids(a.pid)))`,
              [holderPid],
            );
            expect(rows[0]!.n).toBeGreaterThanOrEqual(2);
          },
          { timeout: 15_000, interval: 25 },
        );
      } finally {
        await holder.query("COMMIT").catch(() => undefined);
        holder.release();
      }
      return pending!;
    }

    it("two different funds of one bill both succeed and never refund more than the excess", async () => {
      // Excess 30k = 10k + 20k.
      const bill = await seedBill({
        total: 100_000,
        evidences: [70_000, 60_000],
        funds: [
          { amount: 10_000, evidence: 0 },
          { amount: 20_000, evidence: 1 },
        ],
      });
      const [a, b] = await raceOnBill(bill.linkId, [
        bill.fundIds[0]!,
        bill.fundIds[1]!,
      ]);
      expect([a.status, b.status]).toEqual([200, 200]);
      const refunds = await refundsOf(bill.fundIds);
      expect(refunds).toHaveLength(2);
      expect(refunds.reduce((sum, r) => sum + Number(r.amount_idr), 0)).toBe(
        30_000,
      );
    });

    it("one fund resolved twice under different keys yields one 200 and one 409", async () => {
      const bill = await seedBill({
        total: 100_000,
        evidences: [120_000],
        funds: [{ amount: 20_000, evidence: 0 }],
      });
      const [a, b] = await raceOnBill(bill.linkId, [
        bill.fundIds[0]!,
        bill.fundIds[0]!,
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      expect(await refundsOf(bill.fundIds)).toHaveLength(1);
    });
  });

  it("MF-08 a single fund covering the whole excess still resolves as before", async () => {
    const bill = await seedBill({
      total: 100_000,
      evidences: [120_000],
      funds: [{ amount: 20_000, evidence: 0 }],
    });
    const response = await resolve(bill.fundIds[0]!);
    expect(response.status).toBe(200);
    expect(await refundsOf(bill.fundIds)).toEqual([
      {
        unallocated_fund_id: bill.fundIds[0],
        amount_idr: "20000",
        status: "pending",
      },
    ]);
    expect((await resolve(bill.fundIds[0]!)).status).toBe(409);
  });

  it("MF-09 another tenant's fund is invisible and cannot be resolved", async () => {
    const foreign = await seedBill({
      tenant: otherTenant,
      outlet: otherOutlet,
      total: 100_000,
      evidences: [120_000],
      funds: [{ amount: 20_000, evidence: 0 }],
    });
    const own = await seedBill({
      total: 100_000,
      evidences: [120_000],
      funds: [{ amount: 20_000, evidence: 0 }],
    });
    const response = await resolve(foreign.fundIds[0]!);
    expect(response.status).toBe(404);
    expect(await refundsOf(foreign.fundIds)).toEqual([]);
    expect(await resolvedFundIds(foreign.fundIds)).toEqual([]);

    const list = await listFundIds();
    expect(list.status).toBe(200);
    const listed = (list.body.data as { id: string }[]).map((f) => f.id);
    expect(listed).toContain(own.fundIds[0]);
    expect(listed).not.toContain(foreign.fundIds[0]);
  });
  it("MF-10 an underpaid bill with nothing applied can still refund its whole evidence", async () => {
    // Bill 100k, only 90k arrived and none of it was applied (paid_idr 0):
    // excess = evidence 90k - paid_idr 0 = 90k = the one fund.
    const bill = await seedBill({
      total: 100_000,
      paid: 0,
      evidences: [90_000],
      funds: [{ amount: 90_000, evidence: 0 }],
    });
    const list = await listFundIds();
    expect(list.status).toBe(200);
    expect((list.body.data as { id: string }[]).map((f) => f.id)).toContain(
      bill.fundIds[0],
    );
    expect((await resolve(bill.fundIds[0]!)).status).toBe(200);
    expect(await refundsOf(bill.fundIds)).toEqual([
      {
        unallocated_fund_id: bill.fundIds[0],
        amount_idr: "90000",
        status: "pending",
      },
    ]);
  });

  it("MF-11 a split bill with one double-paid intent and one unpaid intent resolves the double payment", async () => {
    // Bill 100k split in two intents of 50k. Intent A was paid twice (50k + 50k
    // evidence); intent B never paid. Applied part paid_idr = A's share 50k, so
    // excess = 100k - 50k = 50k = the fund on A's second evidence.
    const bill = await seedBill({
      total: 100_000,
      paid: 50_000,
      evidences: [50_000, 50_000],
      evidenceIntent: [0, 0],
      unpaidIntents: 1,
      funds: [{ amount: 50_000, evidence: 1 }],
    });
    const list = await listFundIds();
    expect(list.status).toBe(200);
    expect((list.body.data as { id: string }[]).map((f) => f.id)).toContain(
      bill.fundIds[0],
    );
    expect((await resolve(bill.fundIds[0]!)).status).toBe(200);
    expect(await refundsOf(bill.fundIds)).toEqual([
      {
        unallocated_fund_id: bill.fundIds[0],
        amount_idr: "50000",
        status: "pending",
      },
    ]);
  });

  describe("MF-12 mapping evidence to a fund refund", () => {
    beforeEach(() => {
      fake = new FakeRefundGateway();
      setPaymentRefundGateway(fake);
    });
    afterEach(() => {
      setPaymentRefundGateway(null);
    });

    it("refuses evidence smaller than the fund with 409 and leaves the fund unmapped", async () => {
      // One intent carries two evidences: 10k and 120k on a 100k bill, so the
      // excess is 30k = the fund. A approved 30k refund has no evidence yet.
      const bill = await seedBill({
        total: 100_000,
        evidences: [10_000, 120_000],
        evidenceIntent: [0, 0],
        funds: [],
      });
      const intentId = bill.intentIds[0]!;
      const fundId = randomUUID();
      await owner.query(
        `INSERT INTO payment_unallocated_funds (id, tenant_id, outlet_id, payment_intent_id, evidence_id, amount_idr, reason)
         VALUES ($1, $2, $3, $4, NULL, 30000, 'overpayment')`,
        [fundId, tenantId, outletA, intentId],
      );
      const refundId = randomUUID();
      await owner.query(
        `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
                                      requested_by, approved_by, decided_at, payout_attempts, updated_at, unallocated_fund_id)
         VALUES ($1, $2, $3, $4, 30000, 'Kembalikan kelebihan bayar', 'approved', $5, $6, now(), 0, now() - interval '2 hours', $7)`,
        [refundId, tenantId, outletA, intentId, userId, financeSupId, fundId],
      );
      // The payout worker holds a fund with several candidate evidences.
      await sweepApprovedRefundPayouts(tenantWide, new Date(), 100);

      const retry = (evidenceId: string) =>
        financeSup
          .post(`${ADMIN}/refunds/${refundId}/retry`)
          .set(originHeader)
          .send({
            idempotencyKey: `mf-retry-${randomUUID()}`,
            sourceEvidenceId: evidenceId,
          });
      const evidenceOf = async () =>
        (
          await owner.query<{ evidence_id: string | null }>(
            "SELECT evidence_id FROM payment_unallocated_funds WHERE id = $1",
            [fundId],
          )
        ).rows[0]!.evidence_id;

      const small = await retry(bill.evidenceIds[0]!);
      expect(small.status).toBe(409);
      expect(await evidenceOf()).toBeNull();
      expect(fake.calls).toHaveLength(0);

      // Control: evidence large enough is accepted, so the 409 was about size.
      const large = await retry(bill.evidenceIds[1]!);
      expect(large.status).toBe(200);
      expect(await evidenceOf()).toBe(bill.evidenceIds[1]);
    });

    it("MF-13 the payout holds instead of refunding more than the fund's evidence", async () => {
      // Two intents, each with one 20k evidence. Fund U is unmapped on intent 0
      // (the auto-mapping would pick its single evidence); fund M is already
      // mapped to intent 1's evidence. Both are 30k: bigger than the evidence.
      const bill = await seedBill({
        total: 10_000,
        evidences: [20_000, 20_000],
        funds: [],
      });
      const seedFund = async (
        intentIndex: number,
        evidenceId: string | null,
      ) => {
        const fundId = randomUUID();
        const refundId = randomUUID();
        const intentId = bill.intentIds[intentIndex]!;
        await owner.query(
          `INSERT INTO payment_unallocated_funds (id, tenant_id, outlet_id, payment_intent_id, evidence_id, amount_idr, reason)
           VALUES ($1, $2, $3, $4, $5, 30000, 'overpayment')`,
          [fundId, tenantId, outletA, intentId, evidenceId],
        );
        await owner.query(
          `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
                                        requested_by, approved_by, decided_at, payout_attempts, updated_at, unallocated_fund_id)
           VALUES ($1, $2, $3, $4, 30000, 'Kembalikan kelebihan bayar', 'approved', $5, $6, now(), 0, now() - interval '2 hours', $7)`,
          [refundId, tenantId, outletA, intentId, userId, financeSupId, fundId],
        );
        return { fundId, refundId };
      };
      const unmapped = await seedFund(0, null);
      const mapped = await seedFund(1, bill.evidenceIds[1]!);

      await sweepApprovedRefundPayouts(tenantWide, new Date(), 100);

      expect(fake.calls).toHaveLength(0);
      const { rows } = await owner.query<{
        id: string;
        status: string;
        last_payout_error: string | null;
      }>(
        "SELECT id, status, last_payout_error FROM payment_refunds WHERE id = ANY($1::uuid[]) ORDER BY id",
        [[unmapped.refundId, mapped.refundId]],
      );
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.status).toBe("approved");
        expect(row.last_payout_error).toBe("EVIDENCE_MAPPING_REQUIRED");
      }
      // The auto-mapping did not bind the too-small evidence to fund U.
      const { rows: funds } = await owner.query<{ evidence_id: string | null }>(
        "SELECT evidence_id FROM payment_unallocated_funds WHERE id = $1",
        [unmapped.fundId],
      );
      expect(funds[0]!.evidence_id).toBeNull();
    });
  });
});
