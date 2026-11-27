// 1272 K2 (legend-osqou.57; design duitku-fee-passthrough §2, §3, §6): a
// Duitku settlement line is matched against what the gateway charged the guest
// (`charged_idr` = bill + guest service fee), never the bill alone. A line fee
// above the guest fee collected opens a visible `guest_fee_shortfall` case for
// the supervisor (the outlet got less than the bill) and, while that case is
// open, the channel's guest fee rate is locked (the channel is hidden, never a
// silent fee 0). The settlement journal books the shortfall into
// gateway_fee_expense; the customer deposit stays the bill. An intent without a
// fee reconciles exactly as before.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  buildJournalLinesFromRule,
  defaultPostingRules,
  resolvePostingRule,
  type PostingAccountRole,
} from "@starter/shared/accounting";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { tenantIdSchema } from "@starter/shared/core";
import { createApp } from "../app";
import {
  lockedGuestFeeChannels,
  withoutLockedGuestFees,
} from "../services/payment-guest-fee-lock";
import { guestFeeRatesOf } from "../services/payment-guest-fee";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers";

const app = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendAccessFixtures.outletIds.bandung;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const IMPORT = "/api/payments/admin/reconciliation/settlements";
const uid = () => randomBytes(4).toString("hex");
const REF_PREFIX = "K2FEE-";

const BILL = 144_375;
const GUEST_FEE = 2_456;
const CHARGED = BILL + GUEST_FEE;

const userIds: string[] = [];
const intentIds: string[] = [];
const linkIds: string[] = [];
let manager: ReturnType<typeof agent>;
let dayCounter = 0;

async function asTenant<T>(run: (client: PoolClient) => Promise<T>) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Each scenario its own business day, so "missing" scans never overlap. */
function nextDay(): string {
  dayCounter += 1;
  return new Date(Date.UTC(2019, 5, 1 + dayCounter)).toISOString().slice(0, 10);
}

async function seedIntent(o: {
  providerRef: string;
  day: string;
  provider?: "duitku" | "doit";
  method?: "va" | "qris" | "card";
  channelCode?: string | null;
  guestFeeIdr?: number;
}): Promise<string> {
  const linkId = randomUUID();
  const id = randomUUID();
  const method = o.method ?? "va";
  await asTenant(async (c) => {
    await c.query(
      `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 'seed')`,
      [
        linkId,
        tenantId,
        outletA,
        randomBytes(32).toString("hex"),
        `K2-${linkId.slice(0, 8)}`,
        BILL,
      ],
    );
    await c.query(
      `INSERT INTO payment_intents
         (id, tenant_id, outlet_id, payment_link_id, method, provider, provider_ref, amount_idr,
          guest_fee_idr, channel_code, idempotency_key, status, paid_at, instructions, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'paid', $12::timestamptz,
               '{"method":"qris","qrPayload":"test","issuer":null}', now())`,
      [
        id,
        tenantId,
        outletA,
        linkId,
        method,
        o.provider ?? "duitku",
        o.providerRef,
        BILL,
        o.guestFeeIdr ?? 0,
        o.channelCode === undefined ? "BC" : o.channelCode,
        `k2-${id}`,
        `${o.day} 12:00:00+07`,
      ],
    );
  });
  intentIds.push(id);
  linkIds.push(linkId);
  return id;
}

type Line = { reference: string; amountIdr: number; feeIdr: number };

async function importReport(
  day: string,
  lines: Line[],
  provider: "duitku" | "doit" = "duitku",
) {
  const gross = lines.reduce((s, l) => s + l.amountIdr, 0);
  const fee = lines.reduce((s, l) => s + l.feeIdr, 0);
  const reference = `${REF_PREFIX}${uid()}`;
  const response = await manager
    .post(IMPORT)
    .set(originHeader)
    .set("Idempotency-Key", `k2-${randomUUID()}`)
    .send({
      outletId: outletA,
      source: "gateway",
      provider,
      reference,
      periodStart: day,
      periodEnd: day,
      grossIdr: gross,
      feeIdr: fee,
      netIdr: gross - fee,
      lines,
    });
  expect([200, 201], JSON.stringify(response.body)).toContain(response.status);
  return response.body.data as {
    id: string;
    matchedLines: number;
    mismatchLines: number;
    unmatchedLines: number;
    casesCreated: number;
  };
}

type CaseRow = {
  kind: string;
  reference: string;
  expected_idr: string;
  received_idr: string;
  variance_idr: string;
  status: string;
  settlement_line_id: string | null;
};

async function casesOf(settlementId: string): Promise<CaseRow[]> {
  return asTenant(async (c) => {
    const { rows } = await c.query<CaseRow>(
      `SELECT kind, reference, expected_idr::text, received_idr::text, variance_idr::text, status, settlement_line_id
         FROM payment_reconciliation_cases
        WHERE tenant_id = $1 AND settlement_id = $2
        ORDER BY kind, reference`,
      [tenantId, settlementId],
    );
    return rows;
  });
}

async function linesOf(settlementId: string) {
  return asTenant(async (c) => {
    const { rows } = await c.query<{
      reference: string;
      match_status: string;
      expected_idr: string | null;
    }>(
      `SELECT reference, match_status, expected_idr::text
         FROM payment_settlement_lines
        WHERE tenant_id = $1 AND settlement_id = $2 ORDER BY reference`,
      [tenantId, settlementId],
    );
    return rows;
  });
}

const contextOf = () =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  manager = agent(app);
  const email = await signUp(manager, "Settlement K2");
  const session = await manager.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  userIds.push(userId);
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
});

afterAll(async () => {
  const quiet = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch {
      // cleanup never hides the real test failure
    }
  };
  await quiet(() =>
    asTenant(async (c) => {
      const reports = `SELECT id FROM payment_settlements WHERE tenant_id = $1 AND reference LIKE '${REF_PREFIX}%'`;
      await c.query(
        `DELETE FROM payment_reconciliation_cases WHERE tenant_id = $1 AND settlement_id IN (${reports})`,
        [tenantId],
      );
      await c.query(
        `DELETE FROM payment_settlement_lines WHERE tenant_id = $1 AND settlement_id IN (${reports})`,
        [tenantId],
      );
      await c.query(
        `DELETE FROM payment_settlements WHERE tenant_id = $1 AND reference LIKE '${REF_PREFIX}%'`,
        [tenantId],
      );
      await c.query("DELETE FROM payment_intents WHERE id = ANY($1::uuid[])", [
        intentIds,
      ]);
      await c.query("DELETE FROM payment_links WHERE id = ANY($1::uuid[])", [
        linkIds,
      ]);
    }),
  );
  await quiet(() =>
    owner.query(
      "DELETE FROM role_assignments WHERE user_id = ANY($1::text[])",
      [userIds],
    ),
  );
  await owner.end();
});

describe("Duitku settlement matches the charged amount (bill + guest fee)", () => {
  it("a line at bill + fee with a fee within the guest fee matches: no case, expected is the charged amount", async () => {
    const day = nextDay();
    const ref = `DK-${uid()}`;
    await seedIntent({ providerRef: ref, day, guestFeeIdr: GUEST_FEE });
    const report = await importReport(day, [
      { reference: ref, amountIdr: CHARGED, feeIdr: GUEST_FEE },
    ]);
    expect(report).toMatchObject({ matchedLines: 1, casesCreated: 0 });
    expect(await linesOf(report.id)).toEqual([
      { reference: ref, match_status: "matched", expected_idr: `${CHARGED}` },
    ]);
    expect(await casesOf(report.id)).toEqual([]);
  });

  it("a line at the bill alone (fee missing) is a mismatch: expected charged, variance minus the fee", async () => {
    const day = nextDay();
    const ref = `DK-${uid()}`;
    await seedIntent({ providerRef: ref, day, guestFeeIdr: GUEST_FEE });
    const report = await importReport(day, [
      { reference: ref, amountIdr: BILL, feeIdr: 2_000 },
    ]);
    expect(report).toMatchObject({ mismatchLines: 1, casesCreated: 1 });
    expect(await casesOf(report.id)).toMatchObject([
      {
        kind: "amount",
        expected_idr: `${CHARGED}`,
        received_idr: `${BILL}`,
        variance_idr: `${-GUEST_FEE}`,
      },
    ]);
  });

  it("a fee intent the report does not list is missing at its charged amount", async () => {
    const day = nextDay();
    const listed = `DK-${uid()}`;
    const absent = `DK-${uid()}`;
    await seedIntent({ providerRef: listed, day, guestFeeIdr: GUEST_FEE });
    await seedIntent({ providerRef: absent, day, guestFeeIdr: GUEST_FEE });
    const report = await importReport(day, [
      { reference: listed, amountIdr: CHARGED, feeIdr: GUEST_FEE },
    ]);
    expect(await casesOf(report.id)).toMatchObject([
      {
        kind: "amount",
        reference: absent,
        expected_idr: `${CHARGED}`,
        received_idr: "0",
        variance_idr: `${-CHARGED}`,
        settlement_line_id: null,
      },
    ]);
  });
});

describe("guest_fee_shortfall: the gateway took more than the guest fee", () => {
  it("opens one visible case on the matched line: expected the bill, received charged - fee", async () => {
    const day = nextDay();
    const ref = `DK-${uid()}`;
    const mdr = GUEST_FEE + 144;
    await seedIntent({ providerRef: ref, day, guestFeeIdr: GUEST_FEE });
    const report = await importReport(day, [
      { reference: ref, amountIdr: CHARGED, feeIdr: mdr },
    ]);
    expect(report).toMatchObject({ matchedLines: 1, casesCreated: 1 });
    expect((await linesOf(report.id))[0]?.match_status).toBe("matched");
    const [kase, ...rest] = await casesOf(report.id);
    expect(rest).toEqual([]);
    expect(kase).toMatchObject({
      kind: "guest_fee_shortfall",
      reference: ref,
      status: "open",
      expected_idr: `${BILL}`,
      received_idr: `${CHARGED - mdr}`,
      variance_idr: "-144",
    });
    expect(kase?.settlement_line_id).not.toBeNull();
  });

  it("a line fee equal to or below the guest fee opens nothing", async () => {
    const day = nextDay();
    const exact = `DK-${uid()}`;
    const below = `DK-${uid()}`;
    await seedIntent({ providerRef: exact, day, guestFeeIdr: GUEST_FEE });
    await seedIntent({ providerRef: below, day, guestFeeIdr: GUEST_FEE });
    const report = await importReport(day, [
      { reference: exact, amountIdr: CHARGED, feeIdr: GUEST_FEE },
      { reference: below, amountIdr: CHARGED, feeIdr: GUEST_FEE - 1 },
    ]);
    expect(report).toMatchObject({ matchedLines: 2, casesCreated: 0 });
  });

  it("a mismatched fee line gets both cases: the amount and the shortfall", async () => {
    const day = nextDay();
    const ref = `DK-${uid()}`;
    await seedIntent({ providerRef: ref, day, guestFeeIdr: GUEST_FEE });
    const report = await importReport(day, [
      { reference: ref, amountIdr: CHARGED - 100, feeIdr: GUEST_FEE + 50 },
    ]);
    expect(await casesOf(report.id)).toMatchObject([
      { kind: "amount", variance_idr: "-100" },
      {
        kind: "guest_fee_shortfall",
        expected_idr: `${CHARGED - 100 - GUEST_FEE}`,
        received_idr: `${CHARGED - 100 - GUEST_FEE - 50}`,
        variance_idr: "-50",
      },
    ]);
  });
});

describe("a fee above the line amount is refused, never skipped", () => {
  it("422 SETTLEMENT_FEE_EXCEEDS_AMOUNT naming the line; nothing is recorded", async () => {
    const day = nextDay();
    const ref = `DK-${uid()}`;
    await seedIntent({ providerRef: ref, day, guestFeeIdr: GUEST_FEE });
    const reference = `${REF_PREFIX}${uid()}`;
    const response = await manager
      .post(IMPORT)
      .set(originHeader)
      .set("Idempotency-Key", `k2-${randomUUID()}`)
      .send({
        outletId: outletA,
        source: "gateway",
        provider: "duitku",
        reference,
        periodStart: day,
        periodEnd: day,
        grossIdr: 103_000,
        feeIdr: 3_500,
        netIdr: 99_500,
        // The filler keeps the report net non-negative (schema rule).
        lines: [
          { reference: ref, amountIdr: 3_000, feeIdr: 3_500 },
          { reference: `ZZ-${uid()}`, amountIdr: 100_000, feeIdr: 0 },
        ],
      });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.error.code).toBe("SETTLEMENT_FEE_EXCEEDS_AMOUNT");
    expect(response.body.error.message).toContain(ref);
    const stored = await asTenant((c) =>
      c.query("SELECT 1 FROM payment_settlements WHERE reference = $1", [
        reference,
      ]),
    );
    expect(stored.rowCount).toBe(0);
  });
});

describe("an intent without a guest fee reconciles exactly as before", () => {
  it.each([
    { provider: "duitku" as const, method: "qris" as const },
    { provider: "doit" as const, method: "qris" as const },
  ])(
    "$provider $method: matched on the bill, its MDR never opens a shortfall",
    async ({ provider, method }) => {
      const day = nextDay();
      const ref = `NF-${uid()}`;
      const absent = `NF-${uid()}`;
      await seedIntent({
        providerRef: ref,
        day,
        provider,
        method,
        channelCode: null,
      });
      await seedIntent({
        providerRef: absent,
        day,
        provider,
        method,
        channelCode: null,
      });
      const report = await importReport(
        day,
        [{ reference: ref, amountIdr: BILL, feeIdr: 1_011 }],
        provider,
      );
      expect(report).toMatchObject({ matchedLines: 1, casesCreated: 1 });
      expect(await linesOf(report.id)).toEqual([
        { reference: ref, match_status: "matched", expected_idr: `${BILL}` },
      ]);
      expect(await casesOf(report.id)).toMatchObject([
        {
          kind: "amount",
          reference: absent,
          expected_idr: `${BILL}`,
          variance_idr: `${-BILL}`,
        },
      ]);
    },
  );
});

describe("an open shortfall locks the channel's guest fee rate", () => {
  it("lists the channel while a shortfall case is open or waits for approval, not once resolved", async () => {
    const day = nextDay();
    const ref = `LK-${uid()}`;
    const code = `Z${uid().slice(0, 1).toUpperCase()}`;
    await seedIntent({
      providerRef: ref,
      day,
      guestFeeIdr: GUEST_FEE,
      channelCode: code,
    });
    expect((await lockedGuestFeeChannels(contextOf())).has(code)).toBe(false);
    const report = await importReport(day, [
      { reference: ref, amountIdr: CHARGED, feeIdr: GUEST_FEE + 1 },
    ]);
    expect((await lockedGuestFeeChannels(contextOf())).has(code)).toBe(true);
    const setStatus = (status: string) =>
      asTenant((c) =>
        c.query(
          "UPDATE payment_reconciliation_cases SET status = $3 WHERE tenant_id = $1 AND settlement_id = $2",
          [tenantId, report.id, status],
        ),
      );
    await setStatus("pending_approval");
    expect((await lockedGuestFeeChannels(contextOf())).has(code)).toBe(true);
    await setStatus("resolved");
    expect((await lockedGuestFeeChannels(contextOf())).has(code)).toBe(false);
  });

  it("the lock is tenant wide: a context of another outlet sees the shortfall of outlet A", async () => {
    const day = nextDay();
    const ref = `LB-${uid()}`;
    const code = `Y${uid().slice(0, 1).toUpperCase()}`;
    await seedIntent({
      providerRef: ref,
      day,
      guestFeeIdr: GUEST_FEE,
      channelCode: code,
    });
    const report = await importReport(day, [
      { reference: ref, amountIdr: CHARGED, feeIdr: GUEST_FEE + 1 },
    ]);
    const outletBContext = establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(tenantId),
        brandId: null,
        source: "session",
      }),
      {
        kind: "outlets",
        outletIds: [cafeLegendAccessFixtures.outletIds.bandung2],
      },
    );
    expect((await lockedGuestFeeChannels(outletBContext)).has(code)).toBe(true);
    await asTenant((c) =>
      c.query(
        "UPDATE payment_reconciliation_cases SET status = 'resolved' WHERE tenant_id = $1 AND settlement_id = $2",
        [tenantId, report.id],
      ),
    );
  });

  it("a locked card intent locks the card code VC", async () => {
    const day = nextDay();
    const ref = `LC-${uid()}`;
    await seedIntent({
      providerRef: ref,
      day,
      method: "card",
      channelCode: null,
      guestFeeIdr: GUEST_FEE,
    });
    const report = await importReport(day, [
      { reference: ref, amountIdr: CHARGED, feeIdr: GUEST_FEE + 1 },
    ]);
    expect((await lockedGuestFeeChannels(contextOf())).has("VC")).toBe(true);
    await asTenant((c) =>
      c.query(
        "UPDATE payment_reconciliation_cases SET status = 'resolved' WHERE tenant_id = $1 AND settlement_id = $2",
        [tenantId, report.id],
      ),
    );
  });

  it("a locked code loses its rate (hidden), the other codes keep theirs", () => {
    const config = {
      maxFeeBps_va: 0,
      maxFeeFlatIdr_va: 5_000,
      guestFees: {
        BC: { bps: 0, flatIdr: 4_000 },
        M2: { bps: 0, flatIdr: 4_000 },
      },
    };
    const stripped = withoutLockedGuestFees(config, new Set(["BC"]));
    expect([...guestFeeRatesOf(stripped).keys()]).toEqual(["M2"]);
    expect([...guestFeeRatesOf(config).keys()]).toEqual(["BC", "M2"]);
    expect(withoutLockedGuestFees(config, new Set())).toBe(config);
  });
});

describe("journal: the shortfall lands in gateway_fee_expense, the deposit stays the bill", () => {
  const roles: PostingAccountRole[] = [
    "bank",
    "gateway_clearing",
    "customer_deposit",
    "gateway_fee_expense",
  ];
  const accounts = new Map(
    roles.map((role, index) => [
      role,
      `0b1f2c3d-0000-4000-8000-00000000b00${index}` as never,
    ]),
  );
  const book = (event: string, amounts: Record<string, number>) =>
    buildJournalLinesFromRule(
      resolvePostingRule(defaultPostingRules, { eventName: event }),
      amounts,
      accounts,
      { outletId: null },
    ).map((line) => ({
      role: roles.find((role) => accounts.get(role) === line.accountId)!,
      net: line.debitIdr - line.creditIdr,
    }));

  it("payment.paid then settlement.reconciled: clearing nets 0, fee expense = MDR - guest fee", () => {
    const mdr = GUEST_FEE + 144;
    const all = [
      ...book("payment.paid", {
        receivedIdr: CHARGED,
        depositIdr: BILL,
        guestFeeIdr: GUEST_FEE,
      }),
      ...book("settlement.reconciled", {
        grossIdr: CHARGED,
        feeIdr: mdr,
        netSettledIdr: CHARGED - mdr,
      }),
    ];
    const net = (role: PostingAccountRole) =>
      all.filter((l) => l.role === role).reduce((s, l) => s + l.net, 0);
    expect(all.reduce((s, l) => s + l.net, 0)).toBe(0);
    expect(net("gateway_clearing")).toBe(0);
    expect(net("customer_deposit")).toBe(-BILL);
    expect(net("gateway_fee_expense")).toBe(144);
    expect(net("bank")).toBe(CHARGED - mdr);
  });
});
