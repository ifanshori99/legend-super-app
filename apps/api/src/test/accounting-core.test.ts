// Accounting core HTTP + service tests (bead legend-kwxj; PRD v1.7 §3.19,
// §6 F; ACC-01, ACC-02, TEN-01, TEN-03). Runs the real Express app, Better
// Auth and PostgreSQL against the disposable test database.
//
// Every test owns a fresh legal entity, so charts, periods and journals from
// one test never leak into another (journal rows are append-only by design and
// stay in the disposable database until the run ends).

import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  businessDateSchema,
  idr,
  outletIdSchema,
  userIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  accountIdSchema,
  type JournalLineInput,
} from "@starter/shared/accounting";
import { createApp } from "../app";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import {
  getJournal as getJournalService,
  listJournals as listJournalsService,
  postJournalFromRuleInTransaction,
  postJournalInTransaction,
} from "../services/accounting-journal.service";
import { agent, originHeader, signUp } from "./helpers";

const app = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletId = cafeLegendPlatformFixtures.outlets[0].id;
const secondOutletId = cafeLegendPlatformFixtures.outlets[1].id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const createdUserIds: string[] = [];
const otherTenantIds: string[] = [];
const unique = () => randomBytes(4).toString("hex");

function scopedContext(tenant = tenantId): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenant,
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

/** A caller whose role only reaches the listed outlets (TEN-03). */
function outletScopedContext(...outlets: string[]): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId,
      brandId: null,
      source: "session",
    }),
    {
      kind: "outlets",
      outletIds: outlets.map((id) => outletIdSchema.parse(id)),
    },
  );
}

async function createEntity(name: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO legal_entities (tenant_id, name) VALUES ($1, $2) RETURNING id`,
    [tenantId, `${name} ${unique()}`],
  );
  return rows[0]!.id;
}

async function signedIn(name = "Accounting user") {
  const client = agent(app);
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUserIds.push(userId);
  return { client, userId };
}

async function financeUser() {
  const { client, userId } = await signedIn("Finance");
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'finance'",
    [tenantId],
  );
  if (!rows[0]) throw new Error("No finance role template");
  await owner.query(
    // Backdate one minute: the container clock can drift from Node's clock.
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', now() - interval '1 minute', $2)`,
    [tenantId, userId, rows[0].id],
  );
  return { client, userId };
}

async function createAccountApi(
  client: Awaited<ReturnType<typeof financeUser>>["client"],
  legalEntityId: string,
  input: {
    code: string;
    name: string;
    type: string;
    reportGroup: string;
    parentId?: string | null;
  },
) {
  const response = await client
    .post(`/api/accounting/legal-entities/${legalEntityId}/accounts`)
    .set(originHeader)
    .send({ parentId: null, ...input });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data as { id: string; code: string };
}

function line(
  accountId: string,
  debitIdr: number,
  creditIdr: number,
  outlet: string | null = outletId,
): JournalLineInput {
  return {
    accountId: accountIdSchema.parse(accountId),
    debitIdr: idr(debitIdr),
    creditIdr: idr(creditIdr),
    outletId: outlet === null ? null : outletIdSchema.parse(outlet),
    costCenter: null,
  };
}

async function post(
  legalEntityId: string,
  lines: JournalLineInput[],
  input: {
    entryDate?: string;
    idempotencyKey?: string;
    userId: string;
    sourceId?: string;
    description?: string;
  },
) {
  const context = scopedContext();
  const userId = userIdSchema.parse(input.userId);
  return withTenant(db, context, (tx) =>
    postJournalInTransaction(tx, context, {
      legalEntityId,
      outletId,
      entryDate: businessDateSchema.parse(input.entryDate ?? "2026-11-02"),
      sourceType: "sale",
      sourceId: input.sourceId ?? randomUUID(),
      description: input.description ?? "Penjualan tunai (ACC-01 test)",
      lines,
      postedBy: userId,
      idempotencyKey: input.idempotencyKey ?? `sale-${randomUUID()}`,
    }),
  );
}

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterAll(async () => {
  if (otherTenantIds.length > 0) {
    await owner.query(
      "DELETE FROM chart_of_accounts WHERE tenant_id = ANY($1::uuid[])",
      [otherTenantIds],
    );
    await owner.query(
      "DELETE FROM legal_entities WHERE tenant_id = ANY($1::uuid[])",
      [otherTenantIds],
    );
    await owner.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [
      otherTenantIds,
    ]);
  }
  if (createdUserIds.length > 0)
    await owner.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [tenantId, createdUserIds],
    );
  if (createdUserIds.length > 0)
    await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
      createdUserIds,
    ]);
  await owner.end();
});

describe("legend-kwxj accounting core", () => {
  it("ACC-01 posts a balanced journal, emits journal.posted and refuses edits at the database", async () => {
    const { client, userId } = await financeUser();
    const entity = await createEntity("ACC-01 entity");
    const cash = await createAccountApi(client, entity, {
      code: "1101",
      name: "Kas Outlet",
      type: "asset",
      reportGroup: "cash_and_equivalents",
    });
    const revenue = await createAccountApi(client, entity, {
      code: "4101",
      name: "Penjualan",
      type: "revenue",
      reportGroup: "revenue",
    });
    const entry = await post(
      entity,
      [line(cash.id, 150_000, 0), line(revenue.id, 0, 150_000)],
      { userId },
    );
    expect(entry.lines).toHaveLength(2);
    expect(entry.lines[0]?.debitIdr).toBe(150_000);
    expect(entry.lines[1]?.creditIdr).toBe(150_000);

    const detail = await client.get(`/api/accounting/journals/${entry.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.reversedBy).toBeNull();
    expect(detail.body.data.entry.id).toBe(entry.id);

    const outbox = await owner.query(
      `SELECT event FROM domain_event_outbox
        WHERE tenant_id = $1 AND event->>'name' = 'journal.posted'
          AND event->'payload'->>'journalEntryId' = $2`,
      [tenantId, entry.id],
    );
    expect(outbox.rowCount).toBe(1);
    expect(outbox.rows[0].event.payload.totalIdr).toBe(150_000);

    await expect(
      owner.query(
        "UPDATE journal_entries SET description = 'x' WHERE id = $1",
        [entry.id],
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      owner.query("DELETE FROM journal_entries WHERE id = $1", [entry.id]),
    ).rejects.toThrow(/append-only/);
    await expect(
      owner.query(
        "UPDATE journal_lines SET debit_idr = 1 WHERE entry_id = $1",
        [entry.id],
      ),
    ).rejects.toThrow(/append-only/);
  });

  it("ACC-01 refuses an unbalanced journal and a line with both sides", async () => {
    const { client, userId } = await financeUser();
    const entity = await createEntity("ACC-01 invalid entity");
    const cash = await createAccountApi(client, entity, {
      code: "1101",
      name: "Kas Outlet",
      type: "asset",
      reportGroup: "cash_and_equivalents",
    });
    const revenue = await createAccountApi(client, entity, {
      code: "4101",
      name: "Penjualan",
      type: "revenue",
      reportGroup: "revenue",
    });
    await expect(
      post(entity, [line(cash.id, 100_000, 0), line(revenue.id, 0, 90_000)], {
        userId,
      }),
    ).rejects.toMatchObject({ code: "JOURNAL_UNBALANCED" });
    await expect(
      post(
        entity,
        [line(cash.id, 100_000, 100_000), line(revenue.id, 0, 100_000)],
        { userId },
      ),
    ).rejects.toMatchObject({ name: "ZodError" });
  });

  it("ACC-01 reverses once with mirrored lines, audits it and never reverses a reversal", async () => {
    const { client, userId } = await financeUser();
    const entity = await createEntity("ACC-01 reversal entity");
    const cash = await createAccountApi(client, entity, {
      code: "1101",
      name: "Kas Outlet",
      type: "asset",
      reportGroup: "cash_and_equivalents",
    });
    const revenue = await createAccountApi(client, entity, {
      code: "4101",
      name: "Penjualan",
      type: "revenue",
      reportGroup: "revenue",
    });
    const entry = await post(
      entity,
      [line(cash.id, 75_000, 0), line(revenue.id, 0, 75_000)],
      { userId },
    );
    const first = await client
      .post(`/api/accounting/journals/${entry.id}/reversal`)
      .set(originHeader)
      .send({
        entryDate: "2026-11-03",
        reason: "Salah input penjualan",
        idempotencyKey: `reversal-${unique()}`,
      });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.data.reversalOf).toBe(entry.id);
    expect(first.body.data.sourceType).toBe("reversal");
    expect(
      first.body.data.lines.map(
        (row: { debitIdr: number; creditIdr: number }) => [
          row.debitIdr,
          row.creditIdr,
        ],
      ),
    ).toEqual([
      [0, 75_000],
      [75_000, 0],
    ]);

    const audits = await owner.query(
      `SELECT event FROM audit_logs
        WHERE tenant_id = $1 AND event->>'action' = 'accounting.journal.reversed'
          AND event->>'objectId' = $2`,
      [tenantId, entry.id],
    );
    expect(audits.rowCount).toBe(1);

    const second = await client
      .post(`/api/accounting/journals/${entry.id}/reversal`)
      .set(originHeader)
      .send({
        entryDate: "2026-11-03",
        reason: "Koreksi kedua",
        idempotencyKey: `reversal-${unique()}`,
      });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("JOURNAL_ALREADY_REVERSED");

    const ofReversal = await client
      .post(`/api/accounting/journals/${first.body.data.id}/reversal`)
      .set(originHeader)
      .send({
        entryDate: "2026-11-04",
        reason: "Membalik jurnal pembalik",
        idempotencyKey: `reversal-${unique()}`,
      });
    expect(ofReversal.status).toBe(409);
    expect(ofReversal.body.error.code).toBe("JOURNAL_NOT_REVERSIBLE");
  });

  it("ACC-01 posting is idempotent per idempotency key", async () => {
    const { client, userId } = await financeUser();
    const entity = await createEntity("ACC-01 idempotency entity");
    const cash = await createAccountApi(client, entity, {
      code: "1101",
      name: "Kas Outlet",
      type: "asset",
      reportGroup: "cash_and_equivalents",
    });
    const revenue = await createAccountApi(client, entity, {
      code: "4101",
      name: "Penjualan",
      type: "revenue",
      reportGroup: "revenue",
    });
    const key = `sale-${unique()}`;
    const sourceId = randomUUID();
    const lines = [line(cash.id, 42_000, 0), line(revenue.id, 0, 42_000)];
    const first = await post(entity, lines, {
      userId,
      idempotencyKey: key,
      sourceId,
    });
    const second = await post(entity, lines, {
      userId,
      idempotencyKey: key,
      sourceId,
    });
    expect(second.id).toBe(first.id);
    const { rows } = await owner.query<{ count: string }>(
      "SELECT count(*) FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2",
      [tenantId, entity],
    );
    expect(Number(rows[0]?.count)).toBe(1);
  });

  it("ACC-02 rejects a posting into a closed period and a stale expected version", async () => {
    const { client, userId } = await financeUser();
    const entity = await createEntity("ACC-02 entity");
    const cash = await createAccountApi(client, entity, {
      code: "1101",
      name: "Kas Outlet",
      type: "asset",
      reportGroup: "cash_and_equivalents",
    });
    const revenue = await createAccountApi(client, entity, {
      code: "4101",
      name: "Penjualan",
      type: "revenue",
      reportGroup: "revenue",
    });
    await post(
      entity,
      [line(cash.id, 10_000, 0), line(revenue.id, 0, 10_000)],
      { userId, entryDate: "2026-01-05" },
    );
    await owner.query(
      `UPDATE fiscal_periods SET status = 'closed', closed_by = $3, closed_at = now(), version = version + 1
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND period = '2026-01'`,
      [tenantId, entity, userId],
    );
    await expect(
      post(entity, [line(cash.id, 5_000, 0), line(revenue.id, 0, 5_000)], {
        userId,
        entryDate: "2026-01-20",
      }),
    ).rejects.toMatchObject({ code: "PERIOD_CLOSED" });

    await owner.query(
      `UPDATE fiscal_periods
          SET status = 'open', closed_by = NULL, closed_at = NULL, version = version + 1
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND period = '2026-01'`,
      [tenantId, entity],
    );
    const context = scopedContext();
    await expect(
      withTenant(db, context, (tx) =>
        postJournalInTransaction(tx, context, {
          legalEntityId: entity,
          outletId,
          entryDate: "2026-01-21",
          sourceType: "sale",
          sourceId: randomUUID(),
          description: "Stale period version",
          lines: [line(cash.id, 5_000, 0), line(revenue.id, 0, 5_000)],
          postedBy: userIdSchema.parse(userId),
          idempotencyKey: `sale-${unique()}`,
          expectedPeriodVersion: 1,
        }),
      ),
    ).rejects.toMatchObject({ code: "PERIOD_CHANGED" });
  });

  it("ACC-01 chart and mapping rules: unique codes, same-type parent, postable leaves, valid roles", async () => {
    const { client, userId } = await financeUser();
    const entity = await createEntity("ACC-01 chart entity");
    const header = await createAccountApi(client, entity, {
      code: "1100",
      name: "Kas dan Setara Kas",
      type: "asset",
      reportGroup: "cash_and_equivalents",
    });
    const cash = await createAccountApi(client, entity, {
      code: "1101",
      name: "Kas Outlet",
      type: "asset",
      reportGroup: "cash_and_equivalents",
      parentId: header.id,
    });
    const revenue = await createAccountApi(client, entity, {
      code: "4101",
      name: "Penjualan",
      type: "revenue",
      reportGroup: "revenue",
    });

    const duplicate = await client
      .post(`/api/accounting/legal-entities/${entity}/accounts`)
      .set(originHeader)
      .send({
        code: "1101",
        name: "Kas duplikat",
        type: "asset",
        reportGroup: "cash_and_equivalents",
        parentId: null,
      });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe("ACCOUNT_CODE_TAKEN");

    const wrongTypeParent = await client
      .post(`/api/accounting/legal-entities/${entity}/accounts`)
      .set(originHeader)
      .send({
        code: "4102",
        name: "Pendapatan fasilitas",
        type: "revenue",
        reportGroup: "revenue",
        parentId: header.id,
      });
    expect(wrongTypeParent.status).toBe(422);

    const mapping = await client
      .put(`/api/accounting/legal-entities/${entity}/account-mappings`)
      .set(originHeader)
      .send({
        mappings: [
          { role: "cash_on_hand", accountId: cash.id },
          { role: "sales_revenue", accountId: revenue.id },
        ],
      });
    expect(mapping.status, JSON.stringify(mapping.body)).toBe(200);
    expect(mapping.body.data).toHaveLength(2);

    const wrongRole = await client
      .put(`/api/accounting/legal-entities/${entity}/account-mappings`)
      .set(originHeader)
      .send({ mappings: [{ role: "cash_on_hand", accountId: revenue.id }] });
    expect(wrongRole.status).toBe(422);

    await expect(
      post(entity, [line(header.id, 1_000, 0), line(revenue.id, 0, 1_000)], {
        userId,
      }),
    ).rejects.toMatchObject({ code: "ACCOUNT_NOT_POSTABLE" });

    const deactivate = await client
      .patch(`/api/accounting/accounts/${cash.id}`)
      .set(originHeader)
      .send({ isActive: false });
    expect(deactivate.status).toBe(200);
    await expect(
      post(entity, [line(cash.id, 1_000, 0), line(revenue.id, 0, 1_000)], {
        userId,
      }),
    ).rejects.toMatchObject({ code: "ACCOUNT_INACTIVE" });
  });

  it("ACC-01 posts a sales journal through the catalogued posting rule", async () => {
    const { client, userId } = await financeUser();
    const entity = await createEntity("ACC-01 rule entity");
    const cash = await createAccountApi(client, entity, {
      code: "1101",
      name: "Kas Outlet",
      type: "asset",
      reportGroup: "cash_and_equivalents",
    });
    const revenue = await createAccountApi(client, entity, {
      code: "4101",
      name: "Penjualan",
      type: "revenue",
      reportGroup: "revenue",
    });
    const mapping = await client
      .put(`/api/accounting/legal-entities/${entity}/account-mappings`)
      .set(originHeader)
      .send({
        mappings: [
          { role: "cash_on_hand", accountId: cash.id },
          { role: "sales_revenue", accountId: revenue.id },
        ],
      });
    expect(mapping.status).toBe(200);

    const context = scopedContext();
    const orderId = randomUUID();
    const entry = await withTenant(db, context, (tx) =>
      postJournalFromRuleInTransaction(tx, context, {
        eventName: "order.paid",
        // The order.paid rule contract (auto-journals, legend-9pz9) carries
        // every money bucket, including the intent-backed gateway tenders and
        // the reservation deposit applied (both customer_deposit).
        amounts: {
          paidCashIdr: 88_000,
          paidGatewayIntentIdr: 0,
          paidDepositIdr: 0,
          paidGatewayIdr: 0,
          paidEdcIdr: 0,
          paidPointsIdr: 0,
          discountIdr: 0,
          grossSalesIdr: 88_000,
          serviceChargeIdr: 0,
          pbjtIdr: 0,
          roundingIdr: 0,
        },
        legalEntityId: entity,
        outletId,
        entryDate: "2026-11-02",
        sourceId: orderId,
        postedBy: userIdSchema.parse(userId),
        idempotencyKey: `order.paid:${orderId}`,
      }),
    );
    expect(entry.sourceType).toBe("sale");
    expect(entry.sourceId).toBe(orderId);
    expect(entry.lines).toHaveLength(2);
    expect(entry.lines[0]?.accountId).toBe(cash.id);
    expect(entry.lines[1]?.accountId).toBe(revenue.id);

    // The amount set is exact: a caller still on the pre-deposit key set is
    // refused, never posted with the missing buckets read as zero.
    await expect(
      withTenant(db, context, (tx) =>
        postJournalFromRuleInTransaction(tx, context, {
          eventName: "order.paid",
          amounts: {
            paidCashIdr: 88_000,
            paidGatewayIdr: 0,
            paidEdcIdr: 0,
            paidPointsIdr: 0,
            discountIdr: 0,
            grossSalesIdr: 88_000,
            serviceChargeIdr: 0,
            pbjtIdr: 0,
            roundingIdr: 0,
          },
          legalEntityId: entity,
          outletId,
          entryDate: "2026-11-02",
          sourceId: randomUUID(),
          postedBy: userIdSchema.parse(userId),
          idempotencyKey: `order.paid:${randomUUID()}`,
        }),
      ),
    ).rejects.toMatchObject({ code: "POSTING_AMOUNTS_MISMATCH" });
  });

  it("TEN-03 requires authentication and accounting.journal.view; TEN-02 keeps tenant from the session", async () => {
    const anonymous = agent(app);
    const denied = await anonymous.get(
      `/api/accounting/legal-entities/${cafeLegendPlatformFixtures.legalEntity.id}/accounts`,
    );
    expect(denied.status).toBe(401);

    const { client } = await signedIn("No accounting role");
    const forbidden = await client.get(
      `/api/accounting/legal-entities/${cafeLegendPlatformFixtures.legalEntity.id}/accounts`,
    );
    expect(forbidden.status).toBe(403);

    const finance = await financeUser();
    const allowed = await finance.client.get(
      `/api/accounting/legal-entities/${cafeLegendPlatformFixtures.legalEntity.id}/accounts`,
    );
    expect(allowed.status).toBe(200);
    expect(Array.isArray(allowed.body.data)).toBe(true);
  });

  it("TEN-01 cross-tenant rows are invisible and a foreign legal entity is not found", async () => {
    const otherTenant = randomUUID();
    const otherEntity = randomUUID();
    const otherAccount = randomUUID();
    otherTenantIds.push(otherTenant);
    // Copy a valid plan/limits row: platform tests parse every tenant through
    // tenantSchema, so a minimal tenant would break an unrelated suite.
    await owner.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       SELECT $1, $2, 'Accounting other tenant', plan, status, deployment_mode, feature_flags, limits, created_by
         FROM tenants WHERE id = $3`,
      [otherTenant, `acc-${unique()}`, tenantId],
    );
    await owner.query(
      "INSERT INTO legal_entities (id, tenant_id, name) VALUES ($1, $2, 'Other entity')",
      [otherEntity, otherTenant],
    );
    await owner.query(
      `INSERT INTO chart_of_accounts (id, tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $2, $3, '1101', 'Kas Lain', 'asset', 'cash_and_equivalents')`,
      [otherAccount, otherTenant, otherEntity],
    );
    const { client } = await financeUser();
    const foreign = await client.get(
      `/api/accounting/legal-entities/${otherEntity}/accounts`,
    );
    expect(foreign.status).toBe(404);

    const appPool = new Pool({
      connectionString: process.env.APP_DATABASE_URL,
      max: 1,
    });
    try {
      await appPool.query("BEGIN");
      await appPool.query("SET LOCAL ROLE legend_app");
      await appPool.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenantId],
      );
      const { rows } = await appPool.query(
        "SELECT id FROM chart_of_accounts WHERE id = $1",
        [otherAccount],
      );
      expect(rows).toEqual([]);
      await appPool.query("ROLLBACK");
    } finally {
      await appPool.end();
    }
  });

  it("lists journals newest first with filters and a keyset cursor", async () => {
    const { client, userId } = await financeUser();
    const entity = await createEntity("ACC-01 list entity");
    const cash = await createAccountApi(client, entity, {
      code: "1101",
      name: "Kas Outlet",
      type: "asset",
      reportGroup: "cash_and_equivalents",
    });
    const revenue = await createAccountApi(client, entity, {
      code: "4101",
      name: "Penjualan",
      type: "revenue",
      reportGroup: "revenue",
    });
    await post(
      entity,
      [line(cash.id, 11_000, 0), line(revenue.id, 0, 11_000)],
      { userId, entryDate: "2026-10-10" },
    );
    await post(
      entity,
      [line(cash.id, 22_000, 0), line(revenue.id, 0, 22_000)],
      { userId, entryDate: "2026-10-11" },
    );
    const first = await client.get(
      `/api/accounting/journals?legalEntityId=${entity}&from=2026-10-01&to=2026-10-31&limit=1`,
    );
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.data).toHaveLength(1);
    expect(first.body.data[0].entryDate).toBe("2026-10-11");
    expect(first.body.data[0].totalIdr).toBe(22_000);
    expect(first.body.meta.nextCursor).toBeTruthy();
    const second = await client.get(
      `/api/accounting/journals?legalEntityId=${entity}&from=2026-10-01&to=2026-10-31&limit=1&cursor=${first.body.meta.nextCursor}`,
    );
    expect(second.status).toBe(200);
    expect(second.body.data).toHaveLength(1);
    expect(second.body.data[0].entryDate).toBe("2026-10-10");

    const byAccount = await client.get(
      `/api/accounting/journals?legalEntityId=${entity}&from=2026-10-01&to=2026-10-31&accountId=${revenue.id}`,
    );
    expect(byAccount.status).toBe(200);
    expect(byAccount.body.data).toHaveLength(2);

    const periods = await client.get(
      `/api/accounting/legal-entities/${entity}/fiscal-periods`,
    );
    expect(periods.status).toBe(200);
    expect(
      periods.body.data.map((row: { period: string }) => row.period),
    ).toEqual(["2026-10"]);
  });

  it("pre-review HIGH disclosure scope: a single-outlet reader never sees a multi-outlet journal (TEN-03)", async () => {
    const { client, userId } = await financeUser();
    const entity = await createEntity("disclosure scope entity");
    const cash = await createAccountApi(client, entity, {
      code: "1101",
      name: "Kas Outlet",
      type: "asset",
      reportGroup: "cash_and_equivalents",
    });
    const revenue = await createAccountApi(client, entity, {
      code: "4101",
      name: "Penjualan",
      type: "revenue",
      reportGroup: "revenue",
    });
    // Header outlet 1, but the revenue is split across outlet 1 and outlet 2.
    const mixed = await post(
      entity,
      [
        line(cash.id, 60_000, 0, outletId),
        line(revenue.id, 0, 40_000, outletId),
        line(revenue.id, 0, 20_000, secondOutletId),
      ],
      { userId },
    );
    const own = await post(
      entity,
      [line(cash.id, 15_000, 0), line(revenue.id, 0, 15_000)],
      { userId },
    );
    const query = {
      legalEntityId: entity,
      from: businessDateSchema.parse("2026-11-01"),
      to: businessDateSchema.parse("2026-11-30"),
      limit: 20,
    };

    const tenantPage = await listJournalsService(scopedContext(), query);
    expect(tenantPage.data.map((row) => row.id).sort()).toEqual(
      [mixed.id, own.id].sort(),
    );

    // Outlet 1 only sees the entry that is entirely its own; the mixed entry is
    // hidden instead of being disclosed with outlet 2's line.
    const firstOutletPage = await listJournalsService(
      outletScopedContext(outletId),
      query,
    );
    expect(firstOutletPage.data.map((row) => row.id)).toEqual([own.id]);

    const filtered = await listJournalsService(outletScopedContext(outletId), {
      ...query,
      outletId,
    });
    expect(filtered.data.map((row) => row.id)).toEqual([own.id]);

    const secondOutletPage = await listJournalsService(
      outletScopedContext(secondOutletId),
      query,
    );
    expect(secondOutletPage.data).toEqual([]);

    await expect(
      getJournalService(outletScopedContext(outletId), mixed.id),
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    const ownDetail = await getJournalService(
      outletScopedContext(outletId),
      own.id,
    );
    expect(ownDetail.entry.lines).toHaveLength(2);
  });

  it("pre-review HIGH idempotency: one key cannot replay a different payload (IDEMPOTENCY_KEY_REUSED)", async () => {
    const { client, userId } = await financeUser();
    const entity = await createEntity("idempotency fingerprint entity");
    const cash = await createAccountApi(client, entity, {
      code: "1101",
      name: "Kas Outlet",
      type: "asset",
      reportGroup: "cash_and_equivalents",
    });
    const revenue = await createAccountApi(client, entity, {
      code: "4101",
      name: "Penjualan",
      type: "revenue",
      reportGroup: "revenue",
    });
    const key = `sale-${unique()}`;
    const sourceId = randomUUID();
    const lines = [line(cash.id, 42_000, 0), line(revenue.id, 0, 42_000)];
    const first = await post(entity, lines, {
      userId,
      idempotencyKey: key,
      sourceId,
    });
    const replay = await post(entity, lines, {
      userId,
      idempotencyKey: key,
      sourceId,
    });
    expect(replay.id).toBe(first.id);

    await expect(
      post(entity, [line(cash.id, 43_000, 0), line(revenue.id, 0, 43_000)], {
        userId,
        idempotencyKey: key,
        sourceId,
      }),
    ).rejects.toMatchObject({
      name: "CoreError",
      code: "IDEMPOTENCY_KEY_REUSED",
      status: 409,
    });
    await expect(
      post(entity, lines, {
        userId,
        idempotencyKey: key,
        sourceId,
        description: "Penjualan lain",
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });

    const stored = await owner.query<{ request_fingerprint: string }>(
      "SELECT request_fingerprint FROM journal_entries WHERE id = $1",
      [first.id],
    );
    expect(stored.rows[0]?.request_fingerprint).toMatch(/^[0-9a-f]{64}$/);

    const reversalKey = `reversal-${unique()}`;
    const payload = {
      entryDate: "2026-11-03",
      reason: "Salah input penjualan",
      idempotencyKey: reversalKey,
    };
    const reversal = await client
      .post(`/api/accounting/journals/${first.id}/reversal`)
      .set(originHeader)
      .send(payload);
    expect(reversal.status, JSON.stringify(reversal.body)).toBe(201);
    const replayed = await client
      .post(`/api/accounting/journals/${first.id}/reversal`)
      .set(originHeader)
      .send(payload);
    expect(replayed.status, JSON.stringify(replayed.body)).toBe(201);
    expect(replayed.body.data.id).toBe(reversal.body.data.id);

    const reused = await client
      .post(`/api/accounting/journals/${first.id}/reversal`)
      .set(originHeader)
      .send({ ...payload, reason: "Koreksi lain" });
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("pre-review HIGH trusted context: forged contexts are refused at direct transaction boundaries", async () => {
    // A plain object (JSON round-trip, spread copy, client input) never carries
    // server provenance, so a service boundary must fail closed before it reads
    // or writes a row (TEN-02).
    const forged = Object.freeze({
      tenant: { tenantId, brandId: null, source: "session" },
      outletScope: { kind: "tenant", tenantId },
    }) as unknown as ScopedTenantContext;
    await expect(
      postJournalInTransaction(
        null as unknown as never,
        forged,
        null as unknown as never,
      ),
    ).rejects.toThrow(/Untrusted tenant context/);
    await expect(
      listJournalsService(forged, {
        legalEntityId: cafeLegendPlatformFixtures.legalEntity.id,
        from: businessDateSchema.parse("2026-11-01"),
        to: businessDateSchema.parse("2026-11-30"),
        limit: 10,
      }),
    ).rejects.toThrow(/Untrusted tenant context/);
  });
});
