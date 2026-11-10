// Open-item list behind the aging report (`GET /api/accounting/open-items`,
// bead legend-3wyz; PRD v1.7 §3.19 "Utang & Piutang"; TEN-01/03). Rows are
// seeded straight into accounting_open_items (the writers have their own
// tests in accounting-ap-fa.test.ts), then read through the service and the
// real Express app. Every test owns a fresh legal entity.

import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { outletIdSchema, type ScopedTenantContext } from "@starter/shared/core";
import { createApp } from "../app";
import { listOpenItems } from "../services/accounting-open-items.service";
import { agent, signUp } from "./helpers";

const app = createApp();
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendPlatformFixtures.outlets[0].id;
const outletB = cafeLegendPlatformFixtures.outlets[1].id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const createdUserIds: string[] = [];
const otherTenantIds: string[] = [];
const unique = () => randomBytes(4).toString("hex");

function scope(
  outlets?: string[],
  tenant: string = tenantId,
): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenant,
      brandId: null,
      source: "session",
    }),
    outlets
      ? {
          kind: "outlets",
          outletIds: outlets.map((id) => outletIdSchema.parse(id)),
        }
      : { kind: "tenant" },
  );
}

async function createEntity(
  name: string,
  tenant: string = tenantId,
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO legal_entities (tenant_id, name) VALUES ($1, $2) RETURNING id",
    [tenant, `${name} ${unique()}`],
  );
  return rows[0]!.id;
}

type Seed = {
  entity: string;
  kind?: "payable" | "receivable";
  outletId?: string | null;
  counterpartyId?: string;
  counterpartyName?: string;
  documentNumber: string;
  documentDate?: string;
  dueOn: string;
  originalIdr: number;
  /** [settledOn, amount] payments recorded against the item. */
  payments?: [string, number][];
  id?: string;
  tenant?: string;
};

async function seed(input: Seed): Promise<string> {
  const id = input.id ?? randomUUID();
  const kind = input.kind ?? "payable";
  const tenant = input.tenant ?? tenantId;
  const settled = (input.payments ?? []).reduce(
    (sum, [, amount]) => sum + amount,
    0,
  );
  await owner.query(
    `INSERT INTO accounting_open_items
       (tenant_id, kind, id, legal_entity_id, outlet_id, counterparty_type, counterparty_id,
        counterparty_name, document_number, document_date, due_on, original_idr, settled_idr)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      tenant,
      kind,
      id,
      input.entity,
      input.outletId === undefined ? outletA : input.outletId,
      kind === "payable" ? "supplier" : "corporate_account",
      input.counterpartyId ?? randomUUID(),
      input.counterpartyName ?? "CV Kopi",
      input.documentNumber,
      input.documentDate ?? "2026-01-01",
      input.dueOn,
      input.originalIdr,
      settled,
    ],
  );
  for (const [settledOn, amount] of input.payments ?? [])
    await owner.query(
      `INSERT INTO accounting_open_item_settlements
         (tenant_id, kind, open_item_id, method, settled_on, amount_idr)
       VALUES ($1, $2, $3, 'payment', $4, $5)`,
      [tenant, kind, id, settledOn, amount],
    );
  return id;
}

const base = (entity: string, extra: object = {}) => ({
  legalEntityId: entity,
  kind: "payable" as const,
  limit: 25,
  ...extra,
});

async function financeClient() {
  const client = agent(app);
  await signUp(client, "Finance open items");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUserIds.push(userId);
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'finance'",
    [tenantId],
  );
  if (!rows[0]) throw new Error("No finance role template");
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', now() - interval '1 minute', $2)`,
    [tenantId, userId, rows[0].id],
  );
  return client;
}

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterAll(async () => {
  if (otherTenantIds.length > 0) {
    for (const table of [
      "accounting_open_item_settlements",
      "accounting_open_items",
      "legal_entities",
    ])
      await owner.query(
        `DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`,
        [otherTenantIds],
      );
    await owner.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [
      otherTenantIds,
    ]);
  }
  if (createdUserIds.length > 0) {
    await owner.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [tenantId, createdUserIds],
    );
    await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [
      createdUserIds,
    ]);
  }
  await owner.end();
});

describe("legend-3wyz open-item list (§3.19 Utang & Piutang)", () => {
  it("lists one row per document with the amounts, oldest due date first, fully paid items left out", async () => {
    const entity = await createEntity("OI list");
    await seed({
      entity,
      documentNumber: "INV-LATE",
      dueOn: "2026-10-30",
      originalIdr: 3_000_000,
    });
    await seed({
      entity,
      documentNumber: "INV-OLD",
      dueOn: "2026-07-01",
      originalIdr: 5_000_000,
      payments: [["2026-08-01", 2_000_000]],
    });
    await seed({
      entity,
      documentNumber: "INV-PAID",
      dueOn: "2026-06-01",
      originalIdr: 1_000_000,
      payments: [["2026-06-15", 1_000_000]],
    });
    await seed({
      entity,
      kind: "receivable",
      documentNumber: "AR-1",
      dueOn: "2026-05-01",
      originalIdr: 9_000_000,
    });

    const page = await listOpenItems(scope(), base(entity));
    expect(page.data.map((row) => row.documentNumber)).toEqual([
      "INV-OLD",
      "INV-LATE",
    ]);
    expect(page.data[0]).toMatchObject({
      documentNumber: "INV-OLD",
      documentDate: "2026-01-01",
      dueOn: "2026-07-01",
      originalIdr: 5_000_000,
      settledIdr: 2_000_000,
      outstandingIdr: 3_000_000,
      counterpartyName: "CV Kopi",
      outletId: outletA,
    });
    expect(page.data[0]).not.toHaveProperty("tenantId");
    expect(page.meta.nextCursor).toBeNull();

    const receivables = await listOpenItems(
      scope(),
      base(entity, { kind: "receivable" }),
    );
    expect(receivables.data.map((row) => row.documentNumber)).toEqual(["AR-1"]);
  });

  it("asOf replays the past: later documents drop out and later payments do not count yet", async () => {
    const entity = await createEntity("OI asof");
    await seed({
      entity,
      documentNumber: "INV-A",
      documentDate: "2026-06-01",
      dueOn: "2026-07-01",
      originalIdr: 1_000_000,
      payments: [["2026-09-01", 1_000_000]],
    });
    await seed({
      entity,
      documentNumber: "INV-B",
      documentDate: "2026-10-01",
      dueOn: "2026-10-31",
      originalIdr: 2_000_000,
    });

    const past = await listOpenItems(
      scope(),
      base(entity, { asOf: "2026-08-01" }),
    );
    expect(
      past.data.map((row) => [row.documentNumber, row.outstandingIdr]),
    ).toEqual([["INV-A", 1_000_000]]);
    const now = await listOpenItems(scope(), base(entity));
    expect(now.data.map((row) => row.documentNumber)).toEqual(["INV-B"]);
  });

  it("pages with an opaque cursor in (dueOn, id) order, ties included, with no repeat or gap", async () => {
    const entity = await createEntity("OI cursor");
    const ids = [
      "00000000-0000-4000-8000-000000000003",
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ];
    await seed({
      entity,
      id: ids[0],
      documentNumber: "D-3",
      dueOn: "2026-09-01",
      originalIdr: 100,
    });
    await seed({
      entity,
      id: ids[1],
      documentNumber: "D-1",
      dueOn: "2026-09-01",
      originalIdr: 100,
    });
    await seed({
      entity,
      id: ids[2],
      documentNumber: "D-2",
      dueOn: "2026-09-01",
      originalIdr: 100,
    });
    await seed({
      entity,
      documentNumber: "D-4",
      dueOn: "2026-09-02",
      originalIdr: 100,
    });
    await seed({
      entity,
      documentNumber: "D-5",
      dueOn: "2026-09-03",
      originalIdr: 100,
    });

    const first = await listOpenItems(scope(), base(entity, { limit: 2 }));
    expect(first.data.map((row) => row.documentNumber)).toEqual(["D-1", "D-2"]);
    expect(first.meta.nextCursor).not.toBeNull();
    const second = await listOpenItems(
      scope(),
      base(entity, { limit: 2, cursor: first.meta.nextCursor! }),
    );
    expect(second.data.map((row) => row.documentNumber)).toEqual([
      "D-3",
      "D-4",
    ]);
    const third = await listOpenItems(
      scope(),
      base(entity, { limit: 2, cursor: second.meta.nextCursor! }),
    );
    expect(third.data.map((row) => row.documentNumber)).toEqual(["D-5"]);
    expect(third.meta.nextCursor).toBeNull();

    await expect(
      listOpenItems(scope(), base(entity, { cursor: "not-a-cursor!" })),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("filters by counterparty", async () => {
    const entity = await createEntity("OI counterparty");
    const supplier = randomUUID();
    await seed({
      entity,
      counterpartyId: supplier,
      counterpartyName: "PT Susu",
      documentNumber: "S-1",
      dueOn: "2026-09-01",
      originalIdr: 100,
    });
    await seed({
      entity,
      counterpartyId: supplier,
      counterpartyName: "PT Susu",
      documentNumber: "S-2",
      dueOn: "2026-09-02",
      originalIdr: 100,
    });
    await seed({
      entity,
      documentNumber: "K-1",
      dueOn: "2026-09-01",
      originalIdr: 100,
    });

    const page = await listOpenItems(
      scope(),
      base(entity, { counterpartyId: supplier }),
    );
    expect(page.data.map((row) => row.documentNumber)).toEqual(["S-1", "S-2"]);
  });

  it("TEN-03 an outlet-scoped caller never sees items outside its outlets; outside outlet filter is refused", async () => {
    const entity = await createEntity("OI outlet");
    await seed({
      entity,
      outletId: outletA,
      documentNumber: "A-1",
      dueOn: "2026-09-01",
      originalIdr: 100,
    });
    await seed({
      entity,
      outletId: outletB,
      documentNumber: "B-1",
      dueOn: "2026-09-02",
      originalIdr: 100,
    });
    await seed({
      entity,
      outletId: null,
      documentNumber: "E-1",
      dueOn: "2026-09-03",
      originalIdr: 100,
    });

    const onlyA = await listOpenItems(scope([outletA]), base(entity));
    expect(onlyA.data.map((row) => row.documentNumber)).toEqual(["A-1"]);
    await expect(
      listOpenItems(scope([outletA]), base(entity, { outletId: outletB })),
    ).rejects.toMatchObject({ code: "OUTLET_OUT_OF_SCOPE" });
    const tenantWide = await listOpenItems(scope(), base(entity));
    expect(tenantWide.data.map((row) => row.documentNumber)).toEqual([
      "A-1",
      "B-1",
      "E-1",
    ]);
    const filtered = await listOpenItems(
      scope(),
      base(entity, { outletId: outletB }),
    );
    expect(filtered.data.map((row) => row.documentNumber)).toEqual(["B-1"]);
  });

  it("TEN-01 another tenant's entity is not found and its items never leak over HTTP", async () => {
    const otherTenant = randomUUID();
    otherTenantIds.push(otherTenant);
    await owner.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       SELECT $1, $2, 'Open items other tenant', plan, status, deployment_mode, feature_flags, limits, created_by
         FROM tenants WHERE id = $3`,
      [otherTenant, `oi-${unique()}`, tenantId],
    );
    const otherEntity = await createEntity("Other", otherTenant);
    await seed({
      entity: otherEntity,
      tenant: otherTenant,
      outletId: null,
      documentNumber: "X-1",
      dueOn: "2026-09-01",
      originalIdr: 100,
    });
    const entity = await createEntity("OI tenant");
    await seed({
      entity,
      documentNumber: "MINE-1",
      dueOn: "2026-09-01",
      originalIdr: 100,
    });

    await expect(
      listOpenItems(scope(), base(otherEntity)),
    ).rejects.toMatchObject({ status: 404 });

    const client = await financeClient();
    const foreign = await client.get(
      `/api/accounting/open-items?legalEntityId=${otherEntity}&kind=payable`,
    );
    expect(foreign.status).toBe(404);
    const mine = await client.get(
      `/api/accounting/open-items?legalEntityId=${entity}&kind=payable&limit=10`,
    );
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(
      mine.body.data.map(
        (row: { documentNumber: string }) => row.documentNumber,
      ),
    ).toEqual(["MINE-1"]);
    expect(mine.body.meta).toEqual({ limit: 10, nextCursor: null });

    const anonymous = await agent(app).get(
      `/api/accounting/open-items?legalEntityId=${entity}&kind=payable`,
    );
    expect(anonymous.status).toBe(401);
  });
});
