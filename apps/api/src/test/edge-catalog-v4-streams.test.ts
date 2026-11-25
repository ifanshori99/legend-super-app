// Catalog stream v4 (legend-osqou.22, brief 1269 E1): the config an edge needs
// while the cloud is away. The main test database is the CLOUD, a second one is
// the EDGE. Money proof: the edge charges exactly the cloud's tax, and without
// the tax streams it sells nothing.
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  decodeCursor,
  outletIdSchema,
  tenantIdSchema,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  CATALOG_DOCUMENT_FIELDS,
  CATALOG_DOCUMENT_STREAMS,
  CATALOG_LINK_STREAMS,
  CATALOG_PROTOCOL_VERSION,
  catalogRecordUpdatedPayloadSchema,
  catalogSyncQuerySchema,
  type CatalogDocumentStream,
} from "@starter/shared/edge";
import { calculateTax, type TaxCalculationInput } from "@starter/shared/tax";
import { getTableColumns } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { pullCatalog } from "../edge/catalog-puller.ts";
import { sweepCatalogPublisher } from "../services/edge-master-data-publisher.ts";
import { CATALOG_DOCUMENTS } from "../services/edge-catalog-documents.ts";
import { listCatalogRecordsSince } from "../services/edge-catalog-sync.ts";
import { registerEdgeNode } from "../services/edge-node.service.ts";
import { loadTaxConfig } from "../services/qr-order-pricing.ts";
import { settleCloud } from "./helpers/catalog-cloud.ts";
import {
  createEdgeDatabase,
  type EdgeDatabase,
} from "./helpers/edge-database.ts";
import {
  createIsolatedTenant,
  fixtures,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

type Rec = Record<string, unknown>;

let tenant: IsolatedTenant;
let outletB = "";
let nodeId = "";
let edge: EdgeDatabase;
let categoryId = "";
let itemId = "";
let stationId = "";

const scope = (source: "session" | "device") =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source,
    }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(tenant.outletId)] },
  );

const page = (
  stream: string,
  since?: string,
  limit = 100,
  protocolVersion: number | undefined = CATALOG_PROTOCOL_VERSION,
) =>
  listCatalogRecordsSince(db, {
    tenantId: tenantIdSchema.parse(tenant.tenantId),
    outletId: outletIdSchema.parse(tenant.outletId),
    query: catalogSyncQuerySchema.parse({
      stream,
      limit,
      protocolVersion,
      ...(since === undefined ? {} : { since }),
    }),
  });

async function pull(
  streams: readonly CatalogDocumentStream[] = CATALOG_DOCUMENT_STREAMS,
  limit = 100,
  expectClean = true,
) {
  await settleCloud(owner);
  const result = await pullCatalog({
    database: edge.database,
    context: scope("device"),
    edgeNodeId: nodeId,
    streams,
    fetchPage: (stream, since) => page(stream, since ?? undefined, limit),
  });
  if (expectClean)
    for (const stream of streams)
      expect(result.streams[stream]?.error, stream).toBeUndefined();
  return result;
}

async function insert(pool: Pool, table: string, row: Rec) {
  const keys = Object.keys(row);
  await pool.query(
    `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")})`,
    keys.map((key) =>
      row[key] !== null &&
      typeof row[key] === "object" &&
      !(row[key] instanceof Date) &&
      key !== "supported_methods"
        ? JSON.stringify(row[key])
        : row[key],
    ),
  );
  return row as Rec & { id: string };
}

const own = (outletId: string | null = tenant.outletId) => ({
  id: randomUUID(),
  tenant_id: tenant.tenantId,
  outlet_id: outletId,
});
const published = {
  status: "published",
  published_at: new Date("2026-11-02T00:00:00Z"),
  published_by: randomUUID(),
};
const taxRule = (over: Rec = {}) => ({
  ...own(null),
  code: "PBJT-FNB",
  name: "PBJT",
  tax_type: "pbjt",
  rate_bp: 1000,
  region_code: null,
  channels: [],
  applies_to: { itemClasses: ["food_beverage"], categoryIds: [], itemIds: [] },
  price_includes_tax: false,
  include_service_in_base: true,
  is_active: true,
  version: 1,
  effective_from: "2026-11-01",
  ...published,
  ...over,
});
const serviceRule = (over: Rec = {}) => ({
  ...own(null),
  code: "SC-DINE",
  name: "Layanan",
  rate_bp: 500,
  zone_id: null,
  order_types: [],
  item_classes: ["food_beverage"],
  is_active: true,
  version: 1,
  effective_from: "2026-11-01",
  ...published,
  ...over,
});
const settings = (over: Rec = {}) => ({
  ...own(null),
  calculation_order: "discount_service_tax",
  prices_include_tax: false,
  service_rounding_mode: "half_up",
  tax_rounding_mode: "half_up",
  inclusive_base_rounding_mode: "half_up",
  bill_rounding: { incrementIdr: 100, mode: "half_up" },
  package_allocation: "fixed_bp",
  version: 1,
  effective_from: "2026-11-01",
  ...published,
  ...over,
});
const zone = (over: Rec = {}) => ({
  ...own(),
  name: `Zona ${randomUUID().slice(0, 8)}`,
  payment_mode: "open_bill",
  service_charge_bp: 700,
  minimum_spend_idr: 50000,
  hours: [{ daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "08:00", end: "22:00" }],
  ...over,
});
const table = (zoneId: string, over: Rec = {}) => ({
  ...own(),
  zone_id: zoneId,
  code: `T-${randomUUID().slice(0, 8).toUpperCase()}`,
  capacity: 4,
  type: "regular",
  layout: { x: 1, y: 2, width: 3, height: 4, rotation: 90, shape: "rect" },
  ...over,
});
const terminal = (over: Rec = {}) => ({
  ...own(),
  bank_code: "bca",
  terminal_id: randomUUID().slice(0, 12),
  merchant_id: "M-1",
  model: "Ingenico",
  connection: "lan",
  ip_address: "10.0.0.9",
  supported_methods: ["card", "qris"],
  status: "active",
  ...over,
});

const edgeRow = async (name: string, id: string) =>
  (await edge.rows(`SELECT * FROM ${name} WHERE id = $1`, [id]))[0];

const CLEAR = [
  "item_availability",
  "kitchen_menu_loads",
  "kitchen_capacity_rules",
  "approval_policies",
  "pos_approval_policies",
  "payment_cashier_defaults",
  "payment_edc_terminals",
  "tables",
  "floor_zones",
  "tax_settings",
  "service_charge_rules",
  "tax_rules",
  "edge_catalog_tombstones",
];

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  tenant = await createIsolatedTenant(`v4-${randomUUID().slice(0, 6)}`);
  outletB = randomUUID();
  await insert(owner, "outlets", {
    id: outletB,
    tenant_id: tenant.tenantId,
    brand_id: tenant.brandId,
    legal_entity_id: tenant.legalEntityId,
    code: "V4-B",
    name: "Outlet B",
    address: "Jl. Uji",
    timezone: "Asia/Jakarta",
    opening_hours: fixtures.outlets[0].openingHours,
    status: "active",
  });
  const registered = await registerEdgeNode(scope("session"), randomUUID(), {
    outletId: tenant.outletId,
    role: "standby",
    label: "Edge v4",
  } as never);
  nodeId = registered.edgeNode.id;
  edge = await createEdgeDatabase({
    tenantId: tenant.tenantId,
    outletId: tenant.outletId,
  });
  const node = await owner.query(
    "SELECT row_to_json(t) AS row FROM edge_nodes t WHERE id = $1",
    [nodeId],
  );
  await edge.owner.query(
    "INSERT INTO edge_nodes SELECT * FROM json_populate_record(NULL::edge_nodes, $1::json)",
    [JSON.stringify(node.rows[0].row)],
  );
  categoryId = randomUUID();
  itemId = randomUUID();
  stationId = randomUUID();
  // Their own streams bring these; here both sides simply have them.
  for (const pool of [owner, edge.owner]) {
    await insert(pool, "stations", {
      id: stationId,
      tenant_id: tenant.tenantId,
      outlet_id: tenant.outletId,
      name: "Dapur",
      type: "hot_kitchen",
    });
    await insert(pool, "menu_categories", {
      id: categoryId,
      tenant_id: tenant.tenantId,
      brand_id: tenant.brandId,
      name: "Makanan",
    });
    await insert(pool, "menu_items", {
      id: itemId,
      tenant_id: tenant.tenantId,
      brand_id: tenant.brandId,
      category_id: categoryId,
      name: "Nasi",
      type: "single",
    });
  }
}, 240_000);

beforeEach(async () => {
  for (const pool of [owner, edge.owner]) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      for (const name of CLEAR)
        await client.query(`DELETE FROM ${name} WHERE tenant_id = $1`, [
          tenant.tenantId,
        ]);
      if (pool !== owner)
        await client.query("DELETE FROM edge_pull_checkpoints");
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  }
});

afterAll(async () => {
  await edge?.cleanup();
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

describe("tax: edge = cloud to the rupiah", () => {
  const bill = (database: typeof db) =>
    withTenant(database, scope("device"), async (tx) => {
      const config = await loadTaxConfig(tx, scope("device"), tenant.outletId);
      return calculateTax(
        {
          outletId: tenant.outletId,
          businessDate: "2026-11-25",
          channel: "dine_in",
          zoneId: null,
          regionCode: null,
          lines: [33_333, 17_777, 999].map((grossIdr, index) => ({
            lineId: `l${index}`,
            itemId,
            categoryId,
            itemClass: "food_beverage",
            grossIdr,
            discountIdr: index === 0 ? 1_111 : 0,
            components: [],
          })),
          orderDiscountIdr: 777,
        } as unknown as TaxCalculationInput,
        {
          taxRules: config.taxRules,
          serviceChargeRules: config.serviceChargeRules,
          settings: config.settings,
        },
      );
    });

  it("charges the cloud's tax, service and rounding, before and after a new version", async () => {
    const old = await insert(owner, "tax_rules", taxRule());
    await insert(
      owner,
      "tax_rules",
      taxRule({
        version: 2,
        rate_bp: 4000,
        status: "draft",
        published_at: null,
        published_by: null,
      }),
    );
    // Another outlet's override never reaches this edge.
    const foreign = await insert(
      owner,
      "tax_rules",
      taxRule({ outlet_id: outletB, rate_bp: 9000 }),
    );
    await insert(owner, "service_charge_rules", serviceRule());
    await insert(owner, "tax_settings", settings());
    await pull();
    const before = await bill(db);
    expect(before.taxIdr).toBeGreaterThan(0);
    expect(before.serviceChargeIdr).toBeGreaterThan(0);
    expect(await bill(edge.database)).toEqual(before);
    expect(await edgeRow("tax_rules", foreign.id)).toBeUndefined();

    await owner.query(
      "UPDATE tax_rules SET status = 'archived', published_at = NULL, published_by = NULL WHERE id = $1",
      [old.id],
    );
    await insert(owner, "tax_rules", taxRule({ version: 3, rate_bp: 1100 }));
    await insert(
      owner,
      "service_charge_rules",
      serviceRule({ outlet_id: tenant.outletId, rate_bp: 750 }),
    );
    await pull();
    const after = await bill(db);
    expect(after.taxIdr).not.toBe(before.taxIdr);
    expect(await bill(edge.database)).toEqual(after);
  });

  it("an older copy never replaces a newer rule; a lost version gives up its number", async () => {
    const rule = await insert(owner, "tax_rules", taxRule());
    await pull(["tax_rules"]);
    const old = await page("tax_rules");
    await owner.query("UPDATE tax_rules SET rate_bp = 1200 WHERE id = $1", [
      rule.id,
    ]);
    await pull(["tax_rules"]);
    await pullCatalog({
      database: edge.database,
      context: scope("device"),
      edgeNodeId: nodeId,
      streams: ["tax_rules"],
      fetchPage: () => Promise.resolve({ ...old, hasMore: false }),
    });
    expect(await edgeRow("tax_rules", rule.id)).toMatchObject({
      rate_bp: 1200,
    });

    // A restored cloud issues version 1 again under another id.
    await edge.owner.query("UPDATE tax_rules SET sync_txid = 0");
    await owner.query("DELETE FROM tax_rules WHERE id = $1", [rule.id]);
    const again = await insert(owner, "tax_rules", taxRule({ rate_bp: 900 }));
    await edge.owner.query(
      "UPDATE edge_pull_checkpoints SET watermark = NULL WHERE stream = 'catalog:tax_rules'",
    );
    await pull(["tax_rules"]);
    expect(await edgeRow("tax_rules", again.id)).toMatchObject({
      version: 1,
      status: "published",
    });
    expect(await edgeRow("tax_rules", rule.id)).toMatchObject({
      status: "archived",
      published_at: null,
    });
  });

  it("half a tax stream is not a success: the checkpoint stays at the epoch", async () => {
    await insert(owner, "tax_rules", taxRule());
    await insert(owner, "tax_rules", taxRule({ version: 2, rate_bp: 1100 }));
    await settleCloud(owner);
    let calls = 0;
    const result = await pullCatalog({
      database: edge.database,
      context: scope("device"),
      edgeNodeId: nodeId,
      streams: ["tax_rules"],
      fetchPage: (stream, since) => {
        calls += 1;
        if (calls > 1) return Promise.reject(new Error("offline"));
        return page(stream, since ?? undefined, 1);
      },
    });
    expect(result.streams.tax_rules?.lastSuccessAt).toBeNull();
    const [row] = await edge.rows(
      "SELECT last_success_at FROM edge_pull_checkpoints WHERE stream = 'catalog:tax_rules'",
    );
    expect((row!.last_success_at as Date).getTime()).toBe(0);
    await pull(["tax_rules"], 1);
    const [done] = await edge.rows(
      "SELECT last_success_at FROM edge_pull_checkpoints WHERE stream = 'catalog:tax_rules'",
    );
    expect((done!.last_success_at as Date).getTime()).toBeGreaterThan(0);
  });

  it("a page with another outlet's rule is refused whole", async () => {
    await insert(owner, "tax_rules", taxRule());
    await settleCloud(owner);
    const good = await page("tax_rules");
    const result = await pullCatalog({
      database: edge.database,
      context: scope("device"),
      edgeNodeId: nodeId,
      streams: ["tax_rules"],
      fetchPage: () =>
        Promise.resolve({
          ...good,
          records: good.records.map((r) => ({ ...r, outletId: outletB })),
        }),
    });
    expect(result.streams.tax_rules?.error).toBeDefined();
    expect(await edge.rows("SELECT id FROM tax_rules")).toEqual([]);
  });
});

describe("floor: cloud decides the plan, the edge owns the state", () => {
  it("a seated table keeps its state, its stamp and no QR credential", async () => {
    const z = await insert(owner, "floor_zones", zone());
    const t = await insert(
      owner,
      "tables",
      table(z.id, { qr_token_hash: "a".repeat(64), qr_token_sealed: "sealed" }),
    );
    await pull();
    expect(await edgeRow("tables", t.id)).toMatchObject({
      status: "available",
      qr_token_hash: null,
      qr_token_sealed: null,
      zone_id: z.id,
    });
    const stamp = (await edgeRow("tables", t.id))!.sync_txid;
    await edge.owner.query(
      "UPDATE tables SET status = 'occupied', updated_at = now() WHERE id = $1",
      [t.id],
    );
    expect((await edgeRow("tables", t.id))!.sync_txid).toBe(stamp);

    // A guest sitting down in the cloud is no new version either.
    const cloudStamp = async () =>
      (await owner.query("SELECT sync_txid FROM tables WHERE id = $1", [t.id]))
        .rows[0].sync_txid as string;
    const first = await cloudStamp();
    await owner.query("UPDATE tables SET status = 'occupied' WHERE id = $1", [
      t.id,
    ]);
    expect(await cloudStamp()).toBe(first);

    await owner.query("UPDATE tables SET capacity = 6 WHERE id = $1", [t.id]);
    await pull();
    expect(await edgeRow("tables", t.id)).toMatchObject({
      capacity: 6,
      status: "occupied",
    });
    await owner.query("UPDATE tables SET status = 'inactive' WHERE id = $1", [
      t.id,
    ]);
    await pull();
    expect(await edgeRow("tables", t.id)).toMatchObject({ status: "inactive" });
    await owner.query("UPDATE tables SET status = 'available' WHERE id = $1", [
      t.id,
    ]);
    await pull();
    expect(await edgeRow("tables", t.id)).toMatchObject({
      status: "available",
    });
  });

  it("a deleted table and zone go; a zone still used stays inactive; nothing comes back", async () => {
    const z = await insert(owner, "floor_zones", zone());
    const gone = await insert(owner, "floor_zones", zone());
    const t = await insert(owner, "tables", table(z.id));
    await pull();
    const stale = await page("floor_zones");
    // Only on this edge: a table the cloud never had keeps its zone in use.
    await insert(edge.owner, "tables", table(z.id));
    await owner.query("DELETE FROM tables WHERE id = $1", [t.id]);
    await owner.query("DELETE FROM floor_zones WHERE id = ANY($1)", [
      [z.id, gone.id],
    ]);
    await pull();
    expect(await edgeRow("tables", t.id)).toBeUndefined();
    expect(await edgeRow("floor_zones", gone.id)).toBeUndefined();
    expect(await edgeRow("floor_zones", z.id)).toMatchObject({
      status: "inactive",
    });
    await pullCatalog({
      database: edge.database,
      context: scope("device"),
      edgeNodeId: nodeId,
      streams: ["floor_zones"],
      fetchPage: () => Promise.resolve({ ...stale, hasMore: false }),
    });
    expect(await edgeRow("floor_zones", gone.id)).toBeUndefined();
    expect(await edgeRow("floor_zones", z.id)).toMatchObject({
      status: "inactive",
    });
  });

  it("two zones that swap names both arrive", async () => {
    const a = await insert(owner, "floor_zones", zone({ name: "A" }));
    const b = await insert(owner, "floor_zones", zone({ name: "B" }));
    await pull();
    await owner.query("UPDATE floor_zones SET name = 'tmp' WHERE id = $1", [
      a.id,
    ]);
    await owner.query("UPDATE floor_zones SET name = 'A' WHERE id = $1", [
      b.id,
    ]);
    await owner.query("UPDATE floor_zones SET name = 'B' WHERE id = $1", [
      a.id,
    ]);
    await pull();
    expect(await edgeRow("floor_zones", a.id)).toMatchObject({
      name: "B",
      status: "active",
    });
    expect(await edgeRow("floor_zones", b.id)).toMatchObject({
      name: "A",
      status: "active",
    });
  });
});

describe("EDC, approval, kitchen, availability", () => {
  it("B-E1: terminals and cashier defaults arrive, another outlet's do not, a cleared default goes", async () => {
    const mine = await insert(owner, "payment_edc_terminals", terminal());
    const other = await insert(
      owner,
      "payment_edc_terminals",
      terminal({ outlet_id: outletB }),
    );
    const preset = await insert(owner, "payment_cashier_defaults", {
      ...own(),
      cashier_id: randomUUID(),
      terminal_id: mine.id,
      default_method: "edc_card",
    });
    await pull();
    expect(await edgeRow("payment_edc_terminals", mine.id)).toMatchObject({
      ip_address: "10.0.0.9",
      supported_methods: ["card", "qris"],
      status: "active",
    });
    expect(await edgeRow("payment_edc_terminals", other.id)).toBeUndefined();
    expect(await edgeRow("payment_cashier_defaults", preset.id)).toMatchObject({
      terminal_id: mine.id,
    });
    await owner.query(
      "UPDATE payment_edc_terminals SET status = 'inactive' WHERE id = $1",
      [mine.id],
    );
    await owner.query("DELETE FROM payment_cashier_defaults WHERE id = $1", [
      preset.id,
    ]);
    await pull();
    expect(await edgeRow("payment_edc_terminals", mine.id)).toMatchObject({
      status: "inactive",
    });
    expect(
      await edgeRow("payment_cashier_defaults", preset.id),
    ).toBeUndefined();
  });

  it("a tier of an unknown approver role stays in force, held by nobody; the matrix is replaced", async () => {
    const policy = (over: Rec = {}) => ({
      id: randomUUID(),
      tenant_id: tenant.tenantId,
      action_type: "cash_shift_close",
      threshold_idr: 100_000,
      approver_role_id: tenant.roleId,
      levels: 1,
      ...over,
    });
    await edge.owner.query("DELETE FROM roles WHERE id = $1", [tenant.roleId]);
    const first = await insert(owner, "approval_policies", policy());
    await insert(owner, "pos_approval_policies", {
      ...own(null),
      discount_threshold_bp: 1500,
    });
    await pull();
    expect(await edgeRow("approval_policies", first.id)).toBeDefined();
    expect(await edgeRow("roles", tenant.roleId)).toMatchObject({
      name: `~detached-${tenant.roleId}`,
      permissions: [],
      template_key: null,
    });
    expect(
      await edge.rows(
        "SELECT discount_threshold_bp FROM pos_approval_policies",
      ),
    ).toEqual([{ discount_threshold_bp: 1500 }]);
    const next = policy();
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM approval_policies WHERE tenant_id = $1", [
        tenant.tenantId,
      ]);
      await client.query(
        `INSERT INTO approval_policies (id, tenant_id, action_type, threshold_idr, approver_role_id, levels) VALUES ($1, $2, $3, $4, $5, $6)`,
        Object.values(next),
      );
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    await pull();
    expect(await edgeRow("approval_policies", first.id)).toBeUndefined();
    expect(await edgeRow("approval_policies", next.id)).toBeDefined();
  });

  it("kitchen rules, menu loads and sold-out state follow the cloud", async () => {
    const rule = await insert(owner, "kitchen_capacity_rules", {
      ...own(),
      station_id: stationId,
      window_minutes: 15,
      capacity_points: 40,
      near_capacity_bp: 8000,
      schedule: [{ daysOfWeek: [1], start: "10:00", end: "12:00" }],
      channel_priority: ["dine_in"],
    });
    const load = await insert(owner, "kitchen_menu_loads", {
      ...own(),
      menu_item_id: itemId,
      load_points: 3,
      prep_seconds: 120,
    });
    const until = new Date(Date.now() + 3_600_000);
    const availability = await insert(owner, "item_availability", {
      ...own(),
      menu_item_id: itemId,
      status: "sold_out",
      sold_out_until: until,
      source: "staff",
    });
    await pull();
    expect(await edgeRow("kitchen_capacity_rules", rule.id)).toMatchObject({
      capacity_points: 40,
      channel_priority: ["dine_in"],
    });
    expect(await edgeRow("kitchen_menu_loads", load.id)).toMatchObject({
      load_points: 3,
    });
    expect(await edgeRow("item_availability", availability.id)).toMatchObject({
      status: "sold_out",
      sold_out_until: until,
    });

    // The expiry sweep on the edge keeps the cloud's stamp.
    const stamp = (await edgeRow("item_availability", availability.id))!
      .sync_txid;
    const client = await edge.owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('legend.skip_sync_txid', 'on', true)",
      );
      await client.query(
        "UPDATE item_availability SET sold_out_until = now() - interval '1 second' WHERE id = $1",
        [availability.id],
      );
      await client.query("COMMIT");
      await client.query(
        "UPDATE item_availability SET status = 'available', sold_out_until = NULL, source = NULL WHERE id = $1",
        [availability.id],
      );
    } finally {
      client.release();
    }
    expect(
      (await edgeRow("item_availability", availability.id))!.sync_txid,
    ).toBe(stamp);

    await owner.query("DELETE FROM kitchen_capacity_rules WHERE id = $1", [
      rule.id,
    ]);
    await owner.query("DELETE FROM kitchen_menu_loads WHERE id = $1", [
      load.id,
    ]);
    await owner.query(
      "UPDATE item_availability SET deleted_at = now() WHERE id = $1",
      [availability.id],
    );
    await pull();
    expect(await edgeRow("kitchen_capacity_rules", rule.id)).toBeUndefined();
    expect(await edgeRow("kitchen_menu_loads", load.id)).toBeUndefined();
    expect(
      (await edgeRow("item_availability", availability.id))!.deleted_at,
    ).not.toBeNull();
  });
});

describe("an older edge keeps working with a newer cloud", () => {
  it("a v3 edge is answered v3 and v4 streams never become link events", async () => {
    expect((await page("stations", undefined, 100, 3)).protocolVersion).toBe(3);
    await insert(owner, "tax_rules", taxRule());
    await settleCloud(owner);
    await sweepCatalogPublisher(db);
    const { rows } = await owner.query(
      "SELECT DISTINCT stream FROM edge_catalog_publisher_cursors WHERE tenant_id = $1",
      [tenant.tenantId],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const { stream } of rows)
      expect(CATALOG_LINK_STREAMS).toContain(stream);
    for (const stream of CATALOG_DOCUMENT_STREAMS)
      expect(
        catalogRecordUpdatedPayloadSchema.safeParse({ stream, record: {} })
          .success,
      ).toBe(false);
  });

  it("paging by one record loses and repeats nothing, deletions included", async () => {
    const zones = [];
    for (let i = 0; i < 4; i += 1)
      zones.push(await insert(owner, "floor_zones", zone()));
    await owner.query("DELETE FROM floor_zones WHERE id = $1", [zones[1]!.id]);
    await settleCloud(owner);
    const seen: string[] = [];
    let since: string | undefined;
    for (;;) {
      const next = await page("floor_zones", since, 1);
      seen.push(...next.records.map((r) => (r as { id: string }).id));
      if (!next.hasMore) break;
      since = next.nextCursor!;
      expect(decodeCursor(since)[0]).toBe("cat2");
    }
    expect([...seen].sort()).toEqual(zones.map((z) => z.id).sort());
  });

  it("every column of a v4 table either travels or is listed as staying home", () => {
    const home: Partial<Record<CatalogDocumentStream, string[]>> = {
      tables: ["qrTokenHash", "qrTokenSealed", "status"],
    };
    for (const stream of CATALOG_DOCUMENT_STREAMS) {
      const columns = Object.keys(
        getTableColumns(CATALOG_DOCUMENTS[stream].table as PgTable),
      ).filter((name) => name !== "syncTxid");
      expect(
        columns
          .filter((name) => !CATALOG_DOCUMENT_FIELDS[stream].includes(name))
          .sort(),
        stream,
      ).toEqual((home[stream] ?? []).sort());
    }
  });
});
