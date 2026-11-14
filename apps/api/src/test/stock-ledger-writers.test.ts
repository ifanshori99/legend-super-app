// Guard for the stock_ledger writers (bead legend-bsw9).
//
// stock_ledger.posting_seq is GENERATED ALWAYS AS IDENTITY: the database
// stamps the insertion order and rebuildStockBalances folds by it. That only
// holds while every writer lets the identity fill the column. This file
// (1) pins the set of non-test writers with a static scan, and (2) proves on
// the disposable database that a backdated edge replication still gets a
// strictly increasing posting_seq, that a rebuild equals the live balance, and
// that an explicit posting_seq is refused.
import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createUlid,
  outletIdSchema,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { EventEnvelope } from "@starter/shared/events";
import { inventoryEvents } from "@starter/shared/inventory";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { resetEdgeApplierRegistryForTests } from "../edge/applier-registry.ts";
import type { EdgeApplyMeta } from "../edge/ports.ts";
import {
  applyEdgeStockMoved,
  registerStockMovedEdgeApplier,
} from "../edge/stock-moved-applier.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  authenticateEdgeCredential,
  registerEdgeNode,
  type AuthenticatedEdgeNode,
} from "../services/edge-node.service.ts";
import { rebuildStockBalances } from "../services/inventory.service.ts";

// ------------------------------------------------------------ static guard

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const scanRoots = [
  "apps/api/src",
  "apps/api/scripts",
  "apps/api/drizzle",
  "scripts",
  "packages",
];
const skippedDirs = new Set([
  "node_modules",
  "dist",
  ".next",
  ".turbo",
  "coverage",
  "test",
  "tests",
  "__tests__",
]);
/** The one file that may write stock_ledger. */
const allowedWriter = "apps/api/src/services/inventory.service.ts";
const allowedWriterInserts = 2;
/** Migrations up to this number are history and may copy ledger rows. */
const lastHistoricalMigration = 186;

function isSourceFile(path: string): boolean {
  if (!/\.(ts|mjs|sql)$/.test(path)) return false;
  if (/\.test\.(ts|mjs)$/.test(path)) return false;
  const migration = /apps\/api\/drizzle\/(\d{4})_[^/]*\.sql$/.exec(path);
  if (migration && Number(migration[1]) <= lastHistoricalMigration)
    return false;
  return true;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skippedDirs.has(entry.name)) sourceFiles(join(dir, entry.name), out);
    } else if (isSourceFile(relative(repoRoot, join(dir, entry.name))))
      out.push(join(dir, entry.name));
  }
  return out;
}

/** Text of every `.values(...)` call, found by matching parentheses. */
function valuesCalls(text: string): string[] {
  const calls: string[] = [];
  const opener = /\.values\(/g;
  for (let match = opener.exec(text); match; match = opener.exec(text)) {
    let depth = 1;
    let index = opener.lastIndex;
    while (depth > 0 && index < text.length) {
      const char = text[index++];
      if (char === "(") depth++;
      else if (char === ")") depth--;
    }
    calls.push(text.slice(opener.lastIndex, index));
  }
  return calls;
}

const drizzleInsert = /\.insert\(\s*(?:\w+\.)?stockLedger\s*\)/g;
const sqlInsert =
  /INSERT\s+INTO\s+(?:"?public"?\.)?"?stock_ledger"?(?![\w"])/gi;
const postingSeqName = /postingSeq|posting_seq/;

const explanation =
  "stock_ledger.posting_seq is GENERATED ALWAYS AS IDENTITY and records the " +
  "insertion order that rebuildStockBalances folds by (legend-bsw9). A new " +
  "stock_ledger writer must let the identity fill posting_seq: never set " +
  "it, never use OVERRIDING SYSTEM VALUE, and add the writer here only after " +
  "review.";

describe("legend-bsw9 stock_ledger writers (static guard)", () => {
  const files = scanRoots
    .flatMap((root) => sourceFiles(join(repoRoot, root)))
    .map((file) => ({
      path: relative(repoRoot, file),
      text: readFileSync(file, "utf8"),
    }));

  it("scans the source tree", () => {
    expect(files.map((file) => file.path)).toContain(allowedWriter);
  });

  it("only inventory.service.ts inserts into stock_ledger", () => {
    const writers = files
      .map((file) => ({
        path: file.path,
        inserts:
          (file.text.match(drizzleInsert)?.length ?? 0) +
          (file.text.match(sqlInsert)?.length ?? 0),
      }))
      .filter((file) => file.inserts > 0);
    expect(writers, `Unexpected stock_ledger writer. ${explanation}`).toEqual([
      { path: allowedWriter, inserts: allowedWriterInserts },
    ]);
  });

  it("no source sets posting_seq or overrides the identity", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (/OVERRIDING\s+(?:SYSTEM|USER)\s+VALUE/i.test(file.text))
        offenders.push(`${file.path}: OVERRIDING ... VALUE`);
      if (valuesCalls(file.text).some((call) => postingSeqName.test(call)))
        offenders.push(`${file.path}: posting_seq inside .values(...)`);
      for (const match of file.text.matchAll(
        /INSERT\s+INTO\s+(?:"?public"?\.)?"?stock_ledger"?\s*\(([^)]*)\)/gi,
      ))
        if (postingSeqName.test(match[1]!))
          offenders.push(`${file.path}: posting_seq in INSERT column list`);
    }
    expect(offenders, explanation).toEqual([]);
  });
});

// ----------------------------------------------------------------- DB tests

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const appPool = new Pool({
  connectionString: process.env.APP_DATABASE_URL,
  max: 2,
});
const actor = randomUUID();
const tenantId = randomUUID();
const outletA = randomUUID();
let locationA: string;
let itemId: string;
let node: AuthenticatedEdgeNode;

const tenantScope = (): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );

async function createFixture() {
  const brand = randomUUID();
  const entity = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Tenant Penulis Buku Stok', plan, 'active', deployment_mode, feature_flags, limits, $3
       FROM tenants WHERE id = $4`,
    [
      tenantId,
      `penulis-stok-${randomBytes(4).toString("hex")}`,
      actor,
      cafeLegendPlatformFixtures.tenant.id,
    ],
  );
  await owner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand')`,
    [brand, tenantId, `penulis-stok-${randomBytes(3).toString("hex")}`],
  );
  await owner.query(
    `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Uji', false)`,
    [entity, tenantId],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours, status)
     VALUES ($1, $2, $3, $4, 'PNS-01', 'PNS-01', 'Jl. Uji', '{}', 'active')`,
    [outletA, tenantId, brand, entity],
  );
  const uom = await owner.query<{ id: string }>(
    "INSERT INTO uoms (tenant_id, code, name) VALUES ($1, 'gr', 'gram') RETURNING id",
    [tenantId],
  );
  itemId = (
    await owner.query<{ id: string }>(
      `INSERT INTO inventory_items (tenant_id, name, category, type, base_uom_id, is_perishable)
       VALUES ($1, 'Kopi Bubuk', 'Bahan Baku', 'raw_material', $2, false) RETURNING id`,
      [tenantId, uom.rows[0]!.id],
    )
  ).rows[0]!.id;
  locationA = (
    await owner.query<{ id: string }>(
      "INSERT INTO stock_locations (tenant_id, outlet_id, name, type) VALUES ($1, $2, 'Gudang', 'warehouse') RETURNING id",
      [tenantId, outletA],
    )
  ).rows[0]!.id;
  // rebuildStockBalances needs inventory.cost.view: copy the owner template.
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Penulis Buku Stok', $2)`,
    [actor, `${actor}@example.com`],
  );
  const role = await owner.query<{ id: string }>(
    `INSERT INTO roles (tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     SELECT $1, name, is_template, template_key, permissions, mfa_required, allowed_scope_types
       FROM roles WHERE tenant_id = $2 AND template_key = 'owner'
     RETURNING id`,
    [tenantId, cafeLegendPlatformFixtures.tenant.id],
  );
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenantId, actor, role.rows[0]!.id],
  );
}

let clock = Date.parse("2026-11-09T08:00:00.000Z");
/** An edge `stock.moved` with an explicit occurredAt (default: now + 1 s). */
function stockMoved(args: {
  quantity: string;
  unitCostIdr: string;
  occurredAtMs?: number;
}): EventEnvelope {
  clock += 1_000;
  const ledgerEntryId = createUlid(clock);
  const occurredAt = new Date(args.occurredAtMs ?? clock).toISOString();
  return inventoryEvents["stock.moved"].envelopeSchema.parse({
    id: createUlid(clock),
    tenantId,
    outletId: outletA,
    name: "stock.moved",
    version: 1,
    aggregateType: "stock",
    aggregateId: ledgerEntryId,
    sequence: 1,
    occurredAt,
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `stock.moved:${ledgerEntryId}`,
    payloadSchemaRef: "stock.moved.v1",
    payload: {
      ledgerEntryId,
      inventoryItemId: itemId,
      locationId: locationA,
      movementType: "sale",
      quantity: args.quantity,
      unitCostIdr: args.unitCostIdr,
      batchId: null,
      sourceType: "order",
      sourceId: createUlid(clock),
      occurredAt,
    },
  }) as EventEnvelope;
}

const meta = (): EdgeApplyMeta => ({
  edgeNodeId: node.scope.edgeNodeId,
  direction: "edge_to_cloud",
  kind: "transaction_event",
  context: node.context,
});

async function postingSeqOf(event: EventEnvelope): Promise<number> {
  const { rows } = await owner.query<{ posting_seq: string }>(
    "SELECT posting_seq::text FROM stock_ledger WHERE tenant_id = $1 AND id = $2::uuid",
    [tenantId, ulidToUuid(event.aggregateId)],
  );
  return Number(rows[0]!.posting_seq);
}

async function liveBalance() {
  const { rows } = await owner.query<{
    quantity: string;
    avg_cost_idr: string;
  }>(
    "SELECT quantity::text, avg_cost_idr::text FROM stock_balances WHERE tenant_id = $1 AND location_id = $2 AND inventory_item_id = $3",
    [tenantId, locationA, itemId],
  );
  return rows[0];
}

const ledgerInsert = `INSERT INTO stock_ledger (id, tenant_id, outlet_id, location_id, inventory_item_id, movement_type,
     quantity, unit_cost_idr, batch_id, source_type, source_id, occurred_at, posting_seq)
   VALUES ($1::uuid, $2, $3, $4, $5, 'sale', -1, 1000, NULL, 'order', $6::uuid, now(), 999999999)`;

function ledgerInsertArgs() {
  return [randomUUID(), tenantId, outletA, locationA, itemId, randomUUID()];
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  await createFixture();
  const registered = await registerEdgeNode(
    establishScopedTenantContext(
      establishTenantContext({ tenantId, brandId: null, source: "session" }),
      { kind: "outlets", outletIds: [outletIdSchema.parse(outletA)] },
    ),
    actor,
    { outletId: outletA, role: "primary", label: "Utama Penulis" },
  );
  const authenticated = await authenticateEdgeCredential(registered.credential);
  if (!authenticated) throw new Error("Edge node did not authenticate");
  node = authenticated;
});

beforeEach(() => {
  resetEdgeApplierRegistryForTests();
  registerStockMovedEdgeApplier();
});

afterAll(async () => {
  resetEdgeApplierRegistryForTests();
  setAuditWriter(null);
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    for (const table of [
      "domain_event_outbox",
      "stock_balances",
      "stock_ledger",
      "stock_locations",
      "inventory_items",
      "uoms",
      "edge_link_slots",
      "edge_inbound_events",
      "edge_received_events",
      "edge_sync_conflicts",
      "edge_outbound_queue",
      "sync_cursors",
      "edge_nodes",
      "audit_logs",
      "role_assignments",
      "roles",
      "outlets",
      "legal_entities",
      "brands",
    ])
      await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [
        tenantId,
      ]);
    await client.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
    await client.query(`DELETE FROM "user" WHERE id = $1`, [actor]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await owner.end();
    await appPool.end();
  }
});

describe("legend-bsw9 stock_ledger posting_seq (database)", () => {
  it("a backdated edge replication still gets a later posting_seq, and a rebuild matches live", async () => {
    const first = stockMoved({ quantity: "-2.0000", unitCostIdr: "1000.0000" });
    // Applied second, but occurred an hour before the first.
    const backdated = stockMoved({
      quantity: "-3.0000",
      unitCostIdr: "2500.0000",
      occurredAtMs: clock - 3_600_000,
    });
    expect(Date.parse(backdated.occurredAt)).toBeLessThan(
      Date.parse(first.occurredAt),
    );
    for (const event of [first, backdated])
      await withTenant(db, node.context, (tx) =>
        applyEdgeStockMoved(tx, event, meta()),
      );

    expect(await postingSeqOf(backdated)).toBeGreaterThan(
      await postingSeqOf(first),
    );

    const live = await liveBalance();
    expect(live?.quantity).toBe("-5.0000");
    await rebuildStockBalances(tenantScope(), actor, outletA);
    expect(await liveBalance()).toEqual(live);
  });

  it("the owner cannot set posting_seq (GENERATED ALWAYS)", async () => {
    await expect(
      owner.query(ledgerInsert, ledgerInsertArgs()),
    ).rejects.toMatchObject({ code: "428C9" });
  });

  it("legend_app cannot set posting_seq (GENERATED ALWAYS)", async () => {
    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE legend_app");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenantId],
      );
      await expect(
        client.query(ledgerInsert, ledgerInsertArgs()),
      ).rejects.toMatchObject({ code: "428C9" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
