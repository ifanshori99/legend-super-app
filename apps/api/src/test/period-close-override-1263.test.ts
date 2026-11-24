// Card 1263 (founder no. 19): a period may be closed over incomplete production
// batches with a written reason, the override permission and a verified second
// factor. Everything else of the close still refuses, and a late batch never
// posts into the closed period. Requests go through createApp() on the
// disposable test database.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  decimal4,
  isoDateTimeSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@starter/shared/events";
import { ROLE_TEMPLATES } from "@starter/shared/access";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { recordStockMovement } from "../services/inventory.service.ts";
import {
  deliverInventoryGlEvent,
  type InventoryGlResult,
} from "../services/inventory-gl-consumer.ts";
import { originHeader, verifySessionMfa } from "./helpers.ts";
import {
  appPool,
  brandId,
  closeKit,
  owner,
  scopeOf,
  short,
  signedIn,
  tenantId,
  type Session,
} from "./helpers/cash-bank-world.ts";

const app = createApp();
const at = (iso: string) => isoDateTimeSchema.parse(iso);
const NOW = new Date();
const BEFORE = "2026-10-01T05:00:00.000Z";
const DAY = "2026-10-15T05:00:00.000Z";
const REASON = "Data bahan batch dapur belum lengkap, disusulkan bulan depan.";

const context = (): ScopedTenantContext => scopeOf();
let uomId: string;
let finance: Session;
let financeNoMfa: Session;
let cashier: Session;
let closerOnly: Session;

type Role =
  | "cogs"
  | "inventory"
  | "inventory_semi_finished"
  | "waste_expense"
  | "inventory_adjustment"
  | "inventory_price_variance";
type GlWorld = {
  entity: string;
  outletId: string;
  locationId: string;
  accounts: Record<Role, string>;
};

async function makeWorld(): Promise<GlWorld> {
  const entity = randomUUID();
  const outletId = randomUUID();
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, $3, false)",
    [entity, tenantId, `Entity Reval ${short()}`],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, business_day_cutoff, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet Reval', 'Jl. Reval', 'Asia/Jakarta', $6, '{}', 'active')`,
    [
      outletId,
      tenantId,
      brandId,
      entity,
      `RV-${short()}`.toUpperCase(),
      "04:00",
    ],
  );
  const chart: [Role, string, string, string, string][] = [
    ["inventory", "1301", "Persediaan Bahan Baku", "asset", "current_asset"],
    [
      "inventory_semi_finished",
      "1302",
      "Persediaan Barang Setengah Jadi",
      "asset",
      "current_asset",
    ],
    ["cogs", "5101", "HPP Makanan dan Minuman", "expense", "cogs"],
    ["waste_expense", "5102", "Waste dan Spoilage", "expense", "cogs"],
    ["inventory_adjustment", "5103", "Selisih Stok Opname", "expense", "cogs"],
    [
      "inventory_price_variance",
      "5106",
      "Selisih Harga Persediaan",
      "expense",
      "cogs",
    ],
  ];
  const accounts = {} as Record<Role, string>;
  for (const [role, code, name, type, group] of chart) {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [tenantId, entity, code, name, type, group],
    );
    accounts[role] = rows[0]!.id;
    await owner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, $3, $4)`,
      [tenantId, entity, role, accounts[role]],
    );
  }
  for (const period of ["2026-09", "2026-10", "2026-11"])
    await owner.query(
      `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
       VALUES ($1, $2, $3) ON CONFLICT (tenant_id, legal_entity_id, period) DO NOTHING`,
      [tenantId, entity, period],
    );
  const { rows } = await owner.query<{ id: string }>(
    "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'warehouse') RETURNING id",
    [tenantId, outletId, `Gudang Reval ${short()}`],
  );
  return { entity, outletId, locationId: rows[0]!.id, accounts };
}

async function insertItem(
  name: string,
  type: "raw_material" | "semi_finished" = "raw_material",
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO inventory_items (tenant_id, name, category, type, base_uom_id, is_perishable)
     VALUES ($1, $2, 'Bahan Baku', $4, $3, true) RETURNING id`,
    [tenantId, `${name} ${short()}`, uomId, type],
  );
  return rows[0]!.id;
}

async function receive(
  world: GlWorld,
  itemId: string,
  quantity: string,
  occurredAt: string,
): Promise<void> {
  await recordStockMovement(context(), {
    outletId: world.outletId,
    locationId: world.locationId,
    inventoryItemId: itemId,
    movementType: "receipt",
    quantity: decimal4(quantity),
    unitCostIdr: decimal4("100"),
    sourceType: "goods_receipt",
    sourceId: randomUUID(),
    occurredAt: at(occurredAt),
    actor: { type: "system" },
  });
}

/** One `production_out` row valued at the moving average; returns its id. */
async function drawMaterial(
  world: GlWorld,
  itemId: string,
  quantity: string,
  productionId: string,
  occurredAt: string,
): Promise<string> {
  const entry = await recordStockMovement(context(), {
    outletId: world.outletId,
    locationId: world.locationId,
    inventoryItemId: itemId,
    movementType: "production_out",
    quantity: decimal4(`-${quantity}`),
    sourceType: "production_order",
    sourceId: productionId,
    occurredAt: at(occurredAt),
    actor: { type: "system" },
  });
  return entry.id;
}

async function eventOf(ledgerEntryId: string): Promise<EventEnvelope> {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = 'stock.moved'
        AND event->'payload'->>'ledgerEntryId' = $2`,
    [tenantId, ledgerEntryId],
  );
  expect(rows).toHaveLength(1);
  return eventEnvelopeSchema.parse(rows[0]!.event);
}

async function deliverRow(ledgerEntryId: string): Promise<InventoryGlResult> {
  const event = await eventOf(ledgerEntryId);
  return withTenant(db, context(), (tx) =>
    deliverInventoryGlEvent(context(), event, tx, NOW),
  );
}

/** The `production_in` row of the output at `unitCost`; returns its id. */
async function putAwayOutput(
  world: GlWorld,
  itemId: string,
  quantity: string,
  unitCost: string,
  productionId: string,
  occurredAt: string,
): Promise<string> {
  const entry = await recordStockMovement(context(), {
    outletId: world.outletId,
    locationId: world.locationId,
    inventoryItemId: itemId,
    movementType: "production_in",
    quantity: decimal4(quantity),
    unitCostIdr: decimal4(unitCost),
    sourceType: "production_order",
    sourceId: productionId,
    occurredAt: at(occurredAt),
    actor: { type: "system" },
  });
  return entry.id;
}

async function periodOf(world: GlWorld, period: string) {
  const { rows } = await owner.query<{ id: string; version: number }>(
    "SELECT id, version FROM fiscal_periods WHERE tenant_id = $1 AND legal_entity_id = $2 AND period = $3",
    [tenantId, world.entity, period],
  );
  return rows[0]!;
}

async function verifyMfa(who: Session) {
  const { rows } = await owner.query<{ email: string }>(
    'SELECT email FROM "user" WHERE id = $1',
    [who.userId],
  );
  await verifySessionMfa(rows[0]!.email);
}

/** A custom role with exactly these permissions, for one new MFA-verified user. */
async function customRoleUser(permissions: string[]): Promise<Session> {
  const who = await signedIn(app, `PCO ${short()}`, []);
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO roles (tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, false, $3::jsonb, '["tenant"]'::jsonb) RETURNING id`,
    [tenantId, `PCO ${short()}`, JSON.stringify(permissions)],
  );
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 hour', $2)`,
    [tenantId, who.userId, rows[0]!.id],
  );
  await verifyMfa(who);
  return who;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  const uom = await owner.query<{ id: string }>(
    "INSERT INTO uoms (tenant_id, code, name) VALUES ($1, $2, 'g') RETURNING id",
    [tenantId, `g${short()}`],
  );
  uomId = uom.rows[0]!.id;
  finance = await signedIn(app, "PCO finance", [
    { role: "finance", outletId: null },
  ]);
  await verifyMfa(finance);
  financeNoMfa = await signedIn(app, "PCO finance no mfa", [
    { role: "finance", outletId: null },
  ]);
  cashier = await signedIn(app, "PCO cashier", [
    { role: "cashier", outletId: null },
  ]);
  await verifyMfa(cashier);
  closerOnly = await customRoleUser([
    "accounting.journal.view",
    "accounting.period.close",
  ]);
});

afterAll(async () => {
  await closeKit();
});

const PERIODS = "/api/accounting/fiscal-periods";
const close = (who: Session, id: string, version = 1) =>
  who.client
    .post(`${PERIODS}/${id}/close`)
    .set(originHeader)
    .send({ expectedVersion: version, idempotencyKey: `pco-${randomUUID()}` });
const blockers = (who: Session, id: string) =>
  who.client.get(`${PERIODS}/${id}/close-blockers`).set(originHeader);
const override = (
  who: Session,
  id: string,
  body: Record<string, unknown> = {},
) =>
  who.client
    .post(`${PERIODS}/${id}/close-override`)
    .set(originHeader)
    .send({
      expectedVersion: 1,
      idempotencyKey: `pco-${randomUUID()}`,
      reason: REASON,
      ...body,
    });

async function statusOf(periodId: string): Promise<string> {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM fiscal_periods WHERE id = $1",
    [periodId],
  );
  return rows[0]!.status;
}

async function overrideAudits(periodId: string) {
  const { rows } = await owner.query<{
    event: {
      actorId: string;
      reason: string;
      createdAt: string;
      maskedChanges: { after: unknown };
    };
  }>(
    `SELECT event FROM audit_logs
      WHERE tenant_id = $1 AND event->>'objectId' = $2
        AND event->>'action' = 'accounting.period.close_overridden'`,
    [tenantId, periodId],
  );
  return rows.map((row) => row.event);
}

/** Entity with September closed and one October batch parked PRODUCTION_INCOMPLETE. */
async function parkedWorld() {
  const world = await makeWorld();
  const raw = await insertItem("Tepung");
  const out = await insertItem("Adonan", "semi_finished");
  await receive(world, raw, "1000", BEFORE);
  const productionId = randomUUID();
  const draw = await drawMaterial(world, raw, "500", productionId, DAY);
  expect(await deliverRow(draw)).toEqual({
    status: "blocked",
    code: "PRODUCTION_INCOMPLETE",
  });
  const september = await periodOf(world, "2026-09");
  expect((await close(finance, september.id)).status).toBe(200);
  const october = await periodOf(world, "2026-10");
  return { world, raw, out, productionId, october };
}

describe("card 1263: close a period over incomplete production batches", () => {
  it("[1263-ROLES] only owner and finance templates hold the override", () => {
    const holders = ROLE_TEMPLATES.filter((role) =>
      (role.permissions as readonly string[]).includes(
        "accounting.period.close_override",
      ),
    )
      .map((role) => role.key)
      .sort();
    expect(holders).toEqual(["finance", "owner"]);
  });

  it("[1263-MIGRATION] 0523 grants only the stored owner and finance templates, once", async () => {
    const sqlText = readFileSync(
      new URL(
        "../../drizzle/0523_period_close_override_grants.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const code = "accounting.period.close_override";
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE roles SET permissions = permissions - $2 WHERE tenant_id = $1",
        [tenantId, code],
      );
      const { rows: custom } = await client.query<{ id: string }>(
        `INSERT INTO roles (tenant_id, name, is_template, permissions, allowed_scope_types)
         VALUES ($1, $2, false, '["accounting.period.close"]'::jsonb, '["tenant"]'::jsonb) RETURNING id`,
        [tenantId, `PCO ${short()}`],
      );
      await client.query(sqlText);
      await client.query(sqlText);
      const { rows } = await client.query<{ key: string; n: number }>(
        `SELECT template_key AS key,
                (SELECT count(*)::int FROM jsonb_array_elements_text(permissions) c WHERE c = $2) AS n
           FROM roles WHERE tenant_id = $1 AND permissions ? $2 ORDER BY template_key`,
        [tenantId, code],
      );
      expect(rows).toEqual([
        { key: "finance", n: 1 },
        { key: "owner", n: 1 },
      ]);
      const { rows: kept } = await client.query<{ permissions: string[] }>(
        "SELECT permissions FROM roles WHERE id = $1",
        [custom[0]!.id],
      );
      expect(kept[0]!.permissions).toEqual(["accounting.period.close"]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("[1263-OK] closes with the acknowledged list, writes the audit row and replays once", async () => {
    const { world, productionId, october } = await parkedWorld();
    const refused = await close(finance, october.id);
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe("PERIOD_INVENTORY_GL_BLOCKED");
    const list = await blockers(finance, october.id);
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual({
      count: 1,
      overridable: true,
      sources: [
        {
          sourceType: "production_order",
          sourceId: productionId,
          errorCode: "PRODUCTION_INCOMPLETE",
          outletName: "Outlet Reval",
          businessDate: "2026-10-15",
          itemName: null,
        },
      ],
    });

    const body = {
      sourceIds: [productionId],
      idempotencyKey: `pco-${randomUUID()}`,
    };
    const done = await override(finance, october.id, body);
    expect(done.status).toBe(200);
    expect(done.body.data).toMatchObject({
      id: october.id,
      legalEntityId: world.entity,
      status: "closed",
      version: 2,
    });
    const audits = await overrideAudits(october.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorId: finance.userId,
      reason: REASON,
      maskedChanges: {
        after: {
          version: 2,
          count: 1,
          sources: [
            {
              sourceType: "production_order",
              sourceId: productionId,
              errorCode: "PRODUCTION_INCOMPLETE",
            },
          ],
        },
      },
    });
    expect(Date.parse(audits[0]!.createdAt)).toBeGreaterThan(0);

    // Replay of the same request: same answer, one snapshot, one audit row.
    const again = await override(finance, october.id, body);
    expect(again.status).toBe(200);
    expect(again.body.data.version).toBe(2);
    expect(await overrideAudits(october.id)).toHaveLength(1);
    const { rows } = await owner.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM fiscal_period_snapshots WHERE fiscal_period_id = $1",
      [october.id],
    );
    expect(rows[0]!.n).toBe(1);

    // Same key, another reason or list: refused, never a silent success.
    const other = await override(finance, october.id, {
      ...body,
      reason: "Alasan lain yang tidak pernah tercatat di audit.",
    });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    // Another key on the closed period: refused.
    const closedAgain = await override(finance, october.id, {
      sourceIds: [productionId],
      expectedVersion: 2,
    });
    expect(closedAgain.status).toBe(409);
    expect(await overrideAudits(october.id)).toHaveLength(1);
  });

  it("[1263-AUDIT] the audit row cannot be changed or deleted by the app role", async () => {
    const { productionId, october } = await parkedWorld();
    expect(
      (await override(finance, october.id, { sourceIds: [productionId] }))
        .status,
    ).toBe(200);
    for (const statement of [
      "UPDATE audit_logs SET event = event WHERE tenant_id = $1",
      "DELETE FROM audit_logs WHERE tenant_id = $1",
    ])
      await expect(appPool.query(statement, [tenantId])).rejects.toMatchObject({
        code: "42501",
      });
  });

  it("[1263-LATE] a batch completed after the override posts into the next open period", async () => {
    const { world, out, productionId, october } = await parkedWorld();
    expect(
      (await override(finance, october.id, { sourceIds: [productionId] }))
        .status,
    ).toBe(200);
    // 500 g at Rp100 = Rp50.000 of material; 35.000 g at 1.4286 = Rp50.001.
    const output = await putAwayOutput(
      world,
      out,
      "35000",
      "1.4286",
      productionId,
      DAY,
    );
    const posted = await deliverRow(output);
    expect(posted.status).toBe("posted");
    const { rows } = await owner.query<{
      entry_date: string;
      late: string;
      period: string;
      status: string;
      n: number;
    }>(
      `SELECT e.entry_date::text, e.late_adjustment_from::text AS late, p.period, p.status,
              (SELECT count(*)::int FROM journal_lines l WHERE l.entry_id = e.id) AS n
         FROM journal_entries e
         JOIN fiscal_periods p ON p.id = e.fiscal_period_id
        WHERE e.tenant_id = $1 AND e.legal_entity_id = $2`,
      [tenantId, world.entity],
    );
    expect(rows).toEqual([
      {
        entry_date: "2026-11-01",
        late: "2026-10-15",
        period: "2026-11",
        status: "open",
        n: 2,
      },
    ]);
    expect(await statusOf(october.id)).toBe("closed");
    const { rows: parked } = await owner.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM inventory_gl_blocked WHERE tenant_id = $1 AND source_id = $2",
      [tenantId, productionId],
    );
    expect(parked[0]!.n).toBe(0);
    // Delivered again: nothing is booked twice.
    expect((await deliverRow(output)).status).toBe("already_posted");
  });

  it("[1263-CODE] another error code among the sources still refuses with 422", async () => {
    const { world, raw, productionId, october } = await parkedWorld();
    await owner.query(
      `INSERT INTO inventory_gl_blocked
         (tenant_id, source_type, source_id, outlet_id, error_code, first_failed_at, last_failed_at)
       VALUES ($1, 'waste', $2, $3, 'ACCOUNT_MAPPING_MISSING', now(), now())`,
      [tenantId, raw, world.outletId],
    );
    const list = await blockers(finance, october.id);
    expect(list.body.data).toMatchObject({ count: 2, overridable: false });
    for (const sourceIds of [[productionId], [productionId, raw]]) {
      const res = await override(finance, october.id, { sourceIds });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe("PERIOD_INVENTORY_GL_BLOCKED");
    }
    expect(await statusOf(october.id)).toBe("open");
    expect(await overrideAudits(october.id)).toHaveLength(0);
  });

  it("[1263-TYPE] PRODUCTION_INCOMPLETE on a source that is not a batch still refuses", async () => {
    const { world, raw, productionId, october } = await parkedWorld();
    await owner.query(
      `INSERT INTO inventory_gl_blocked
         (tenant_id, source_type, source_id, outlet_id, error_code, first_failed_at, last_failed_at)
       VALUES ($1, 'waste', $2, $3, 'PRODUCTION_INCOMPLETE', now(), now())`,
      [tenantId, raw, world.outletId],
    );
    const res = await override(finance, october.id, {
      sourceIds: [productionId, raw],
    });
    expect(res.status).toBe(422);
    expect(await statusOf(october.id)).toBe("open");
  });

  it("[1263-STALE] a list that is not exactly the blocked one answers 409", async () => {
    const { world, raw, productionId, october } = await parkedWorld();
    const second = randomUUID();
    const draw = await drawMaterial(world, raw, "100", second, DAY);
    expect((await deliverRow(draw)).status).toBe("blocked");
    for (const sourceIds of [
      [productionId],
      [randomUUID()],
      [productionId, second, randomUUID()],
      [productionId, randomUUID()],
    ]) {
      const res = await override(finance, october.id, { sourceIds });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("PERIOD_OVERRIDE_SOURCES_CHANGED");
    }
    expect(await statusOf(october.id)).toBe("open");
    expect(await overrideAudits(october.id)).toHaveLength(0);
    // Order does not matter; the exact set closes.
    expect(
      (
        await override(finance, october.id, {
          sourceIds: [second, productionId],
        })
      ).status,
    ).toBe(200);
  });

  it("[1263-EMPTY] nothing blocked (any more) answers 409 and leaves the period open", async () => {
    const { world, out, productionId, october } = await parkedWorld();
    const output = await putAwayOutput(
      world,
      out,
      "35000",
      "1.4286",
      productionId,
      DAY,
    );
    expect((await deliverRow(output)).status).toBe("posted");
    const res = await override(finance, october.id, {
      sourceIds: [productionId],
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PERIOD_OVERRIDE_SOURCES_CHANGED");
    expect(await statusOf(october.id)).toBe("open");
  });

  it("[1263-ORDER] the other close rules stay: a later month, a stale version", async () => {
    const { world, productionId, october } = await parkedWorld();
    const stale = await override(finance, october.id, {
      sourceIds: [productionId],
      expectedVersion: 7,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("PERIOD_CHANGED");
    const november = await periodOf(world, "2026-11");
    const early = await override(finance, november.id, {
      sourceIds: [productionId],
    });
    expect([409, 422]).toContain(early.status);
    expect(await statusOf(november.id)).toBe("open");
    expect(await statusOf(october.id)).toBe("open");
  });

  it("[1263-ACCESS] 403 without the permission, with only one of the two, or without MFA", async () => {
    const { productionId, october } = await parkedWorld();
    const overrideOnly = await customRoleUser([
      "accounting.journal.view",
      "accounting.period.close_override",
    ]);
    for (const who of [cashier, closerOnly, overrideOnly]) {
      const res = await override(who, october.id, {
        sourceIds: [productionId],
      });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("PERMISSION_DENIED");
    }
    const noMfa = await override(financeNoMfa, october.id, {
      sourceIds: [productionId],
    });
    expect(noMfa.status).toBe(403);
    expect(noMfa.body.error.code).toBe("MFA_REQUIRED");
    expect((await blockers(cashier, october.id)).status).toBe(403);
    expect(await statusOf(october.id)).toBe("open");
    expect(await overrideAudits(october.id)).toHaveLength(0);
  });

  it("[1263-404] an unknown period answers 404", async () => {
    const res = await override(finance, randomUUID(), {
      sourceIds: [randomUUID()],
    });
    expect(res.status).toBe(404);
  });

  it("[1263-REASON] a missing, short, blank or oversized reason and a bad list answer 400", async () => {
    const { productionId, october } = await parkedWorld();
    for (const body of [
      { reason: "", sourceIds: [productionId] },
      { reason: undefined, sourceIds: [productionId] },
      { reason: "terlalu pendek", sourceIds: [productionId] },
      { reason: `${" ".repeat(30)}pendek`, sourceIds: [productionId] },
      { reason: "a".repeat(1001), sourceIds: [productionId] },
      { sourceIds: [] },
      { sourceIds: [productionId, productionId] },
      { sourceIds: [productionId], extra: true },
    ]) {
      const res = await override(finance, october.id, body);
      expect([400, 422]).toContain(res.status);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    }
    expect(await statusOf(october.id)).toBe("open");
  });
});
