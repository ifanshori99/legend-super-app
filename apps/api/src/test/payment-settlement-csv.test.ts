// C4b (legend-osqou.8): Duitku settlement CSV import and the second factor on
// both settlement imports. CTO decisions (brief 1272-c4b):
//  - POST /api/payments/admin/reconciliation/settlements/csv reads Legend's
//    own template (`legend_template_v1`: reference, amount_idr, fee_idr). The
//    server reads every amount and computes the totals; the body carries none.
//  - outlet, permission and second factor are checked BEFORE the file is read
//    (a caller who may not import never gets row errors), as in X2.
//  - the JSON import (POST .../settlements) also refuses MFA_REQUIRED without
//    a verified second factor on the session.
//  - a file with unreadable lines is refused whole (422 with rowErrors: line
//    number and reason code, never the content); nothing is stored.
//
// Business days are in 2019, which no other settlement test uses.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers";

const app = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendAccessFixtures.outletIds.bandung;
const outletB = cafeLegendAccessFixtures.outletIds.bandung2;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const IMPORT = "/api/payments/admin/reconciliation/settlements";
const CSV = `${IMPORT}/csv`;
const PREFIX = `CSV-${randomBytes(3).toString("hex")}`;
const HEADER = "reference,amount_idr,fee_idr";

const otherTenant = randomUUID();
const otherBrand = randomUUID();
const otherLegal = randomUUID();
const otherOutlet = randomUUID();
const userIds: string[] = [];
const intentIds: string[] = [];
const linkIds: string[] = [];
let finance: ReturnType<typeof agent>;
let ownerNoMfa: ReturnType<typeof agent>;
let scopedB: ReturnType<typeof agent>;
let warehouse: ReturnType<typeof agent>;
let dayCounter = 0;

async function asTenant<T>(
  tenant: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant],
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

async function member(
  template: string,
  scope: { type: "tenant" } | { type: "outlet"; id: string },
  mfa = true,
) {
  const client = agent(app);
  const email = await signUp(client, `Settlement csv ${template}`);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  userIds.push(userId);
  if (mfa) await verifySessionMfa(email);
  const role = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
    [tenantId, template],
  );
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [
      tenantId,
      userId,
      role.rows[0]!.id,
      scope.type,
      scope.type === "outlet" ? scope.id : null,
    ],
  );
  return client;
}

function nextDay(): string {
  dayCounter += 1;
  return new Date(Date.UTC(2019, 0, 1 + dayCounter * 2))
    .toISOString()
    .slice(0, 10);
}

async function seedIntent(o: {
  providerRef: string;
  amountIdr: number;
  day: string;
}): Promise<string> {
  const linkId = randomUUID();
  const id = randomUUID();
  await asTenant(tenantId, async (c) => {
    await c.query(
      `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 'seed')`,
      [
        linkId,
        tenantId,
        outletA,
        randomBytes(32).toString("hex"),
        `CSVL-${linkId.slice(0, 8)}`,
        o.amountIdr,
      ],
    );
    await c.query(
      `INSERT INTO payment_intents
         (id, tenant_id, outlet_id, payment_link_id, method, provider, provider_ref, amount_idr,
          idempotency_key, status, paid_at, instructions, expires_at)
       VALUES ($1, $2, $3, $4, 'qris', 'duitku', $5, $6, $7, 'paid', $8::timestamptz,
               '{"method":"qris","qrPayload":"test","issuer":null}', now())`,
      [
        id,
        tenantId,
        outletA,
        linkId,
        o.providerRef,
        o.amountIdr,
        `csv-${id}`,
        `${o.day} 12:00:00+07`,
      ],
    );
  });
  intentIds.push(id);
  linkIds.push(linkId);
  return id;
}

function csvBody(o: {
  day: string;
  csv: string;
  outletId?: string;
  reference?: string;
}) {
  return {
    outletId: o.outletId ?? outletA,
    provider: "duitku",
    format: "legend_template_v1",
    reference: o.reference ?? `${PREFIX}-${randomBytes(4).toString("hex")}`,
    periodStart: o.day,
    periodEnd: o.day,
    fileName: "duitku-settlement.csv",
    csv: o.csv,
  };
}

const postCsv = (
  client: ReturnType<typeof agent>,
  body: object,
  key = `csv-${randomUUID()}`,
) => client.post(CSV).set(originHeader).set("Idempotency-Key", key).send(body);

async function settlementsBy(reference: string) {
  const { rows } = await asTenant(tenantId, (c) =>
    c.query(
      `SELECT id, provider, gross_idr, fee_idr, net_idr, line_count
         FROM payment_settlements WHERE tenant_id = $1 AND reference = $2`,
      [tenantId, reference],
    ),
  );
  return rows.map((r) => ({
    id: r.id as string,
    provider: r.provider as string,
    gross_idr: Number(r.gross_idr),
    fee_idr: Number(r.fee_idr),
    net_idr: Number(r.net_idr),
    line_count: Number(r.line_count),
  }));
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  finance = await member("finance", { type: "tenant" });
  ownerNoMfa = await member("owner", { type: "tenant" }, false);
  scopedB = await member("owner", { type: "outlet", id: outletB });
  warehouse = await member("warehouse", { type: "outlet", id: outletA });
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Settlement csv other tenant', 'lengkap', 'active', 'shared', '{"modules":[],"integrationProviders":[]}', $3, $4)`,
    [
      otherTenant,
      `setl-csv-${otherTenant}`,
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
    "INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours) VALUES ($1, $2, $3, $4, 'OTHERC', 'Other', 'Other', '{}')",
    [otherOutlet, otherTenant, otherBrand, otherLegal],
  );
});

afterAll(async () => {
  const quiet = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch {
      // a missing table must not hide the real (fail-first) test failures
    }
  };
  await quiet(() =>
    asTenant(tenantId, async (c) => {
      const mine = `SELECT id FROM payment_settlements WHERE tenant_id = $1 AND reference LIKE $2`;
      await c.query(
        `DELETE FROM payment_reconciliation_cases WHERE tenant_id = $1 AND settlement_id IN (${mine})`,
        [tenantId, `${PREFIX}-%`],
      );
      await c.query(
        `DELETE FROM payment_settlement_lines WHERE tenant_id = $1 AND settlement_id IN (${mine})`,
        [tenantId, `${PREFIX}-%`],
      );
      await c.query(
        "DELETE FROM payment_settlements WHERE tenant_id = $1 AND reference LIKE $2",
        [tenantId, `${PREFIX}-%`],
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
    owner.query("DELETE FROM outlets WHERE id = $1", [otherOutlet]),
  );
  await quiet(() =>
    owner.query("DELETE FROM legal_entities WHERE id = $1", [otherLegal]),
  );
  await quiet(() =>
    owner.query("DELETE FROM brands WHERE id = $1", [otherBrand]),
  );
  await quiet(() =>
    owner.query("DELETE FROM tenants WHERE id = $1", [otherTenant]),
  );
  await quiet(() =>
    owner.query(
      "DELETE FROM role_assignments WHERE user_id = ANY($1::text[])",
      [userIds],
    ),
  );
  await owner.end();
});

describe("C4b legend-osqou.8 second factor on settlement imports", () => {
  it("the JSON import refuses MFA_REQUIRED without a verified second factor", async () => {
    const day = nextDay();
    const reference = `${PREFIX}-json-${randomBytes(3).toString("hex")}`;
    const response = await ownerNoMfa
      .post(IMPORT)
      .set(originHeader)
      .set("Idempotency-Key", `json-${randomUUID()}`)
      .send({
        outletId: outletA,
        source: "gateway",
        provider: "duitku",
        reference,
        periodStart: day,
        periodEnd: day,
        grossIdr: 10_000,
        feeIdr: 100,
        netIdr: 9_900,
        lines: [
          { reference: `R-${reference}`, amountIdr: 10_000, feeIdr: 100 },
        ],
      });
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body.error?.code).toBe("MFA_REQUIRED");
    expect(await settlementsBy(reference)).toEqual([]);
  });

  it("the CSV import checks outlet, permission and second factor before reading the file", async () => {
    const day = nextDay();
    // Unreadable on purpose: no caller below may learn that.
    const unreadable = `${HEADER}\nR-1,55.000,0\n`;
    const noMfaBody = csvBody({ day, csv: unreadable });
    const noMfa = await postCsv(ownerNoMfa, noMfaBody);
    expect(noMfa.status, JSON.stringify(noMfa.body)).toBe(403);
    expect(noMfa.body.error?.code).toBe("MFA_REQUIRED");
    expect(noMfa.body.error?.rowErrors).toBeUndefined();
    const byWarehouse = await postCsv(
      warehouse,
      csvBody({ day, csv: unreadable }),
    );
    expect(byWarehouse.status, JSON.stringify(byWarehouse.body)).toBe(403);
    expect(byWarehouse.body.error?.rowErrors).toBeUndefined();
    const otherOutletOfTenant = await postCsv(
      scopedB,
      csvBody({ day, csv: unreadable }),
    );
    expect([403, 404]).toContain(otherOutletOfTenant.status);
    expect(otherOutletOfTenant.body.error?.rowErrors).toBeUndefined();
    const foreign = await postCsv(
      finance,
      csvBody({ day, csv: unreadable, outletId: otherOutlet }),
    );
    expect([403, 404]).toContain(foreign.status);
    expect(foreign.body.error?.rowErrors).toBeUndefined();
    expect(await settlementsBy(noMfaBody.reference)).toEqual([]);
  });

  it("TEN-02 needs a session and a trusted origin", async () => {
    const body = csvBody({ day: nextDay(), csv: `${HEADER}\nR-1,1000,0\n` });
    const anonymous = await agent(app)
      .post(CSV)
      .set(originHeader)
      .set("Idempotency-Key", `anon-${randomUUID()}`)
      .send(body);
    expect(anonymous.status).toBe(401);
    const noOrigin = await finance
      .post(CSV)
      .set("Idempotency-Key", `origin-${randomUUID()}`)
      .send(body);
    expect(noOrigin.status).toBe(403);
  });
});

describe("C4b legend-osqou.8 Duitku settlement CSV (legend_template_v1)", () => {
  it("matches the file to Duitku payments with every amount read and summed by the server", async () => {
    const day = nextDay();
    const tag = randomBytes(3).toString("hex");
    await seedIntent({ providerRef: `DK-${tag}-1`, amountIdr: 55_000, day });
    await seedIntent({ providerRef: `DK-${tag}-2`, amountIdr: 30_000, day });
    // Booked but missing from the report: one "missing" case.
    await seedIntent({ providerRef: `DK-${tag}-4`, amountIdr: 12_000, day });
    // Columns in another order, quoted cell, blank line and CRLF are fine.
    const csv = [
      "fee_idr,Reference,amount_idr",
      `385,DK-${tag}-1,55000`,
      `210,"DK-${tag}-2",31000`,
      "",
      `100,DK-${tag}-3,9000`,
    ].join("\r\n");
    const body = csvBody({ day, csv });
    const response = await postCsv(finance, body);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data).toMatchObject({
      outletId: outletA,
      source: "gateway",
      provider: "duitku",
      reference: body.reference,
      periodStart: day,
      periodEnd: day,
      grossIdr: 95_000,
      feeIdr: 695,
      netIdr: 94_305,
      lineCount: 3,
      matchedLines: 1,
      mismatchLines: 1,
      unmatchedLines: 1,
      casesCreated: 3,
      replayed: false,
    });
    expect(await settlementsBy(body.reference)).toEqual([
      {
        id: response.body.data.id,
        provider: "duitku",
        gross_idr: 95_000,
        fee_idr: 695,
        net_idr: 94_305,
        line_count: 3,
      },
    ]);

    // The same file again (new key): the first result, nothing written twice.
    const again = await postCsv(finance, body);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.data).toMatchObject({
      id: response.body.data.id,
      replayed: true,
      casesCreated: 3,
    });
    expect(await settlementsBy(body.reference)).toHaveLength(1);
  });

  it("refuses the whole file with the line number and reason of every unreadable line", async () => {
    const day = nextDay();
    const csv = [
      HEADER,
      "R-ok,10000,100",
      "R-sep,55.000,0",
      "R-fee,1000,1500",
      "R-ok,2000,0",
      ",3000,0",
      "R-neg,-5,0",
      "R-cols,1000",
    ].join("\n");
    const body = csvBody({ day, csv });
    const response = await postCsv(finance, body);
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.error?.rowErrors).toEqual([
      { row: 3, reason: "amount" },
      { row: 4, reason: "fee" },
      { row: 5, reason: "duplicate" },
      { row: 6, reason: "reference" },
      { row: 7, reason: "amount" },
      { row: 8, reason: "columns" },
    ]);
    expect(await settlementsBy(body.reference)).toEqual([]);
  });

  it("refuses a header that is not exactly the template, and an empty file", async () => {
    const day = nextDay();
    for (const csv of [
      "reference,amount_idr\nR-1,1000\n",
      "reference,amount_idr,fee_idr,card_number\nR-1,1000,0,4111\n",
      "reference,amount,fee\nR-1,1000,0\n",
      "reference,amount_idr,fee_idr,fee_idr\nR-1,1000,0,0\n",
      `${HEADER}\n\n`,
    ]) {
      const body = csvBody({ day, csv });
      const response = await postCsv(finance, body);
      expect(response.status, csv).toBe(422);
      expect(response.body.error?.code).toBe("VALIDATION_ERROR");
      expect(response.body.error?.rowErrors, csv).toBeUndefined();
      expect(await settlementsBy(body.reference)).toEqual([]);
    }
  });

  it("never accepts totals or an unknown format from the browser", async () => {
    const day = nextDay();
    const csv = `${HEADER}\nR-1,1000,0\n`;
    const withTotals = await postCsv(finance, {
      ...csvBody({ day, csv }),
      grossIdr: 1_000,
    });
    expect(withTotals.status).toBe(422);
    const unknown = await postCsv(finance, {
      ...csvBody({ day, csv }),
      format: "duitku_native",
    });
    expect(unknown.status).toBe(422);
    const notDuitku = await postCsv(finance, {
      ...csvBody({ day, csv }),
      provider: "doit",
    });
    expect(notDuitku.status).toBe(422);
  });
});
