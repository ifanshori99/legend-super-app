// legend-09sxa / brief 533 B1 (architect 531 P1 access): the promotions and
// vouchers streams reach every edge outlet, so they must never carry a promo
// or voucher code, or a hash of one (an offline dictionary attack on a code
// hash would let an edge operator forge codes). Written from the brief and the
// shared contract (`packages/shared/src/edge/catalog-sync.ts`), not from the
// implementation.
//
// Names this test EXPECTS (chosen by the brief, change here if the engineer
// picks another):
//  - promotions stream record: no `codeHash` key; a promotion that has a code
//    carries `codeRef`, a 64-char lowercase hex string that is NOT the code
//    hash (irreversible replacement, e.g. sha256 of the promotion id); a
//    promotion without a code carries `codeRef: null`.
//  - vouchers stream record: no `codeHash` key and no `code` key.
//  - the shared page schema (`catalogSyncPageSchema`) accepts those records.
//  - the edge never stores the real hash: not in promotions, not in the
//    edge_voucher_catalog jsonb payload.
//  - the edge still refuses any voucher code at quote time (Q66), with the
//    "online / cloud" message the existing tests already match.
//
// Assumption: the promotions table column holding a promotion's code digest
// is `code_hash` (the DTO field is `codeHash`).
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { outletIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  CATALOG_PROTOCOL_VERSION,
  catalogSyncPageSchema,
  catalogSyncQuerySchema,
} from "@starter/shared/edge";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { pullCatalog } from "../edge/catalog-puller.ts";
import {
  promosEnabled,
  setPromoGateEdgeModeForTests,
} from "../edge/promo-gate.ts";
import {
  startPromoGate,
  type PromoGateHandle,
} from "../edge/promo-gate-runtime.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { listCatalogRecordsSince } from "../services/edge-catalog-sync.ts";
import { registerEdgeNode } from "../services/edge-node.service.ts";
import { orderPromoPort } from "../services/order-promo.ts";
import { settleCloud } from "./helpers/catalog-cloud.ts";
import {
  cloneMainOutlet,
  createEdgeDatabase,
  type EdgeDatabase,
} from "./helpers/edge-database.ts";

type Stream = "promotions" | "vouchers";
type Rec = Record<string, unknown>;

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const actor = randomUUID();
const codedPromoId = randomUUID();
const plainPromoId = randomUUID();
const voucherId = randomUUID();
const itemId = randomUUID();
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const PROMO_CODE = `PROMO${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
const VOUCHER_CODE = `VCH${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
const PROMO_HASH = sha(PROMO_CODE);
const VOUCHER_HASH = sha(VOUCHER_CODE);
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const q = (text: string, params: unknown[] = []) => owner.query(text, params);
let outletId = "";
let edge: EdgeDatabase;
let nodeId = "";
let gate: PromoGateHandle | undefined;

const scope = (source: "session" | "device") =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
  );

async function seedPromotion(id: string, codeHash: string | null) {
  await q(
    `INSERT INTO promotions
       (id, tenant_id, name, description, status, code_hash, voucher_required,
        starts_at, ends_at, conditions, benefit, stack_group, stackable, priority)
     VALUES ($1,$2,$3,'','active',$4,$5,'2026-01-01T00:00:00Z','2099-01-01T00:00:00Z',$6,$7,$8,false,0)`,
    [
      id,
      tenantId,
      `Secret promo ${id.slice(0, 8)}`,
      codeHash,
      codeHash !== null,
      JSON.stringify([
        { kind: "item_quantity", menuItemIds: [itemId], minQuantity: 1 },
      ]),
      JSON.stringify({ kind: "nominal_off", amountIdr: 7_777 }),
      `k${id.slice(0, 8)}`,
    ],
  );
}

async function all(stream: Stream): Promise<Rec[]> {
  const records: Rec[] = [];
  let since: string | undefined;
  for (let count = 0; count < 1000; count += 1) {
    const next = (await listCatalogRecordsSince(db, {
      tenantId: tenantId as never,
      outletId: outletId as never,
      query: catalogSyncQuerySchema.parse({
        stream,
        protocolVersion: CATALOG_PROTOCOL_VERSION,
        limit: 100,
        ...(since ? { since } : {}),
      }),
    })) as unknown as {
      records: Rec[];
      nextCursor: string | null;
      hasMore: boolean;
    };
    expect(catalogSyncPageSchema.safeParse({ ...next, stream }).success).toBe(
      true,
    );
    records.push(...next.records);
    if (!next.hasMore) return records;
    since = next.nextCursor!;
  }
  throw new Error("Catalog did not finish paging");
}

/** Every object key at any depth. */
function keysDeep(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysDeep);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, inner]) => [
    key,
    ...keysDeep(inner),
  ]);
}

function pull(streams: Stream[] = ["promotions", "vouchers"]) {
  return pullCatalog({
    database: edge.database as typeof db,
    context: scope("device"),
    edgeNodeId: nodeId,
    streams: streams as never,
    fetchPage: async (stream: string, since: string | null) => {
      const records = await all(stream as Stream);
      // One page is enough here: the helper above already walked every page.
      void since;
      return {
        protocolVersion: CATALOG_PROTOCOL_VERSION,
        stream,
        records,
        nextCursor: null,
        hasMore: false,
      };
    },
  });
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires disposable test database");
  setAuditWriter(coreAuditWriter);
  outletId = await cloneMainOutlet(
    owner,
    cafeLegendAccessFixtures.outletIds.bandung,
    "Outlet rahasia kode promosi",
  );
  await seedPromotion(codedPromoId, PROMO_HASH);
  await seedPromotion(plainPromoId, null);
  await q(
    `INSERT INTO vouchers
       (id, tenant_id, promotion_id, code_hash, source, value_idr, valid_from, valid_until)
     VALUES ($1,$2,$3,$4,'manual',7777,'2026-01-01T00:00:00Z','2099-01-01T00:00:00Z')`,
    [voucherId, tenantId, codedPromoId, VOUCHER_HASH],
  );
  const registered = await registerEdgeNode(scope("session"), actor, {
    outletId,
    role: "standby",
    label: "Edge secrets",
  });
  nodeId = registered.edgeNode.id;
  edge = await createEdgeDatabase({ tenantId, outletId });
  const node = await q(
    "SELECT row_to_json(t) AS row FROM edge_nodes t WHERE id = $1",
    [nodeId],
  );
  await edge.owner.query(
    "INSERT INTO edge_nodes SELECT * FROM json_populate_record(NULL::edge_nodes, $1::json)",
    [JSON.stringify(node.rows[0].row)],
  );
}, 240_000);

beforeEach(async () => {
  const client = await edge.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query("DELETE FROM promotion_outlets");
    await client.query("DELETE FROM vouchers");
    await client.query("DELETE FROM edge_voucher_catalog");
    await client.query("DELETE FROM promotions");
    await client.query("DELETE FROM promo_settings");
    await client.query("DELETE FROM edge_pull_checkpoints");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await settleCloud(owner);
});

afterEach(() => {
  gate?.stop();
  gate = undefined;
  setPromoGateEdgeModeForTests(null);
});

afterAll(async () => {
  setAuditWriter(null);
  await edge?.cleanup();
  try {
    await q("DELETE FROM vouchers WHERE id = $1", [voucherId]);
    await q("DELETE FROM promotions WHERE id = ANY($1::uuid[])", [
      [codedPromoId, plainPromoId],
    ]);
  } finally {
    await owner.end();
  }
});

describe("533 B1 promo and voucher streams carry no code or code hash", () => {
  it("the promotions stream has no codeHash or code key and no code digest anywhere in its payload", async () => {
    const records = await all("promotions");
    expect(records.some((record) => record.id === codedPromoId)).toBe(true);
    for (const record of records) {
      const keys = keysDeep(record);
      expect(keys).not.toContain("codeHash");
      expect(keys).not.toContain("code");
    }
    const text = JSON.stringify(records);
    expect(text).not.toContain(PROMO_HASH);
    expect(text).not.toContain(VOUCHER_HASH);
    expect(text).not.toContain(PROMO_CODE);
  });

  it("the vouchers stream has no codeHash or code key and no code digest anywhere in its payload", async () => {
    const records = await all("vouchers");
    expect(records.some((record) => record.id === voucherId)).toBe(true);
    for (const record of records) {
      const keys = keysDeep(record);
      expect(keys).not.toContain("codeHash");
      expect(keys).not.toContain("code");
    }
    const text = JSON.stringify(records);
    expect(text).not.toContain(VOUCHER_HASH);
    expect(text).not.toContain(VOUCHER_CODE);
  });

  it("a promotion with a code carries an irreversible codeRef (not the hash); one without carries null", async () => {
    const records = await all("promotions");
    const coded = records.find((record) => record.id === codedPromoId)!;
    const plain = records.find((record) => record.id === plainPromoId)!;
    expect(coded.codeRef).toMatch(/^[0-9a-f]{64}$/);
    expect(coded.codeRef).not.toBe(PROMO_HASH);
    expect(plain.codeRef).toBeNull();
    // Deterministic: re-exporting must not churn the replacement value.
    const again = (await all("promotions")).find(
      (record) => record.id === codedPromoId,
    )!;
    expect(again.codeRef).toBe(coded.codeRef);
  });

  it("after a pull the edge database holds no real code hash, in promotions or the voucher catalog", async () => {
    const result = await pull();
    for (const stream of ["promotions", "vouchers"] as const)
      expect(
        result.streams[stream as keyof typeof result.streams]?.error,
      ).toBeUndefined();
    const promos = await edge.rows(
      "SELECT row_to_json(t)::text AS doc FROM promotions t WHERE id = ANY($1::uuid[])",
      [[codedPromoId, plainPromoId]],
    );
    expect(promos).toHaveLength(2);
    for (const row of promos) {
      expect(String(row.doc)).not.toContain(PROMO_HASH);
      expect(String(row.doc)).not.toContain(VOUCHER_HASH);
    }
    const catalog = await edge.rows(
      "SELECT payload::text AS doc, payload ? 'codeHash' AS has_hash, payload ? 'code' AS has_code FROM edge_voucher_catalog WHERE id = $1",
      [voucherId],
    );
    expect(catalog).toHaveLength(1);
    expect(catalog[0]?.has_hash).toBe(false);
    expect(catalog[0]?.has_code).toBe(false);
    expect(String(catalog[0]?.doc)).not.toContain(VOUCHER_HASH);
    expect(await edge.rows("SELECT id FROM vouchers")).toEqual([]);
  });

  it("the edge still refuses every voucher or promo code, including the cloud code, the synced ref and a random string", async () => {
    await pull();
    const codedRef = (await all("promotions")).find(
      (record) => record.id === codedPromoId,
    )!.codeRef as string;
    // Open the freshness gate first (fresh, complete pull) so the refusal comes
    // from the edge code rule (EDGE_PROMO_CODE_ONLINE_MESSAGE), not from a
    // closed 24 h gate.
    setPromoGateEdgeModeForTests(() => true);
    gate = startPromoGate({
      context: scope("device"),
      edgeNodeId: nodeId,
      database: edge.database as typeof db,
      clock: { now: () => new Date(), elapsedTimeUnproven: () => false },
    });
    await gate.refresh();
    expect(promosEnabled()).toBe(true);
    for (const code of [PROMO_CODE, VOUCHER_CODE, codedRef, "ANYTHING123"]) {
      await expect(
        withTenant(edge.database, scope("device"), (tx) =>
          orderPromoPort.quote(tx, scope("device"), {
            outletId: outletIdSchema.parse(outletId),
            channel: "dine_in",
            lines: [
              {
                menuItemId: itemId as never,
                quantity: 1,
                unitPriceIdr: 10_000 as never,
                lineTotalIdr: 10_000 as never,
              },
            ],
            customer: null,
            voucherCode: code,
            at: new Date(),
          }),
        ),
      ).rejects.toThrow(/online|cloud/i);
    }
  });
});
