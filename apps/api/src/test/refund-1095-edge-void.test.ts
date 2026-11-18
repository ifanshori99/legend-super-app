// legend-1095 card B, edge side (legend-aja6g, 1042 F3 / W3b): an edge `order.voided`
// is REFUSED when the order already has an ORD-09 recovery refund (a payment_refunds row
// with order_issue_id set and status other than `failed`; pending / manual-queued counts,
// Q45). The refusal follows the existing void_refused pattern: no pos_order_voids row, the
// ingest ledger stays `ingested` with reason `void_refused:ord09_refund_exists`, the
// event stays parked, a replay never throws and never applies the void.
//
// Written from docs/briefs/sub-1095.md and the 1042 / 771dl fixtures, never from the
// implementation.
//
// Assumptions (also reported):
// - The reason is matched as /(^|:)ord09_refund_exists$/ (the 771dl tests match their
//   void_refused reasons the same way, with or without the `void_refused:` prefix).
// - The ORD-09 refund is seeded straight into the tables (order_issues with a
//   manual_refund resolution and an approval request, plus a payment_intents and a
//   payment_refunds row bound to the issue): the real consumer routes edge (POS) orders
//   to the cashier, so it never files one for them. Foreign keys are skipped for the seed
//   only (session_replication_role = replica), as 1042 does for its manual-refund seed.
// - Race: the ORD-09 writer is a seed that takes the `orders` row lock, refuses when a void
//   exists, else inserts the refund (the shape the brief demands of the real writer).
//   Exactly one lane may end up recorded. The ledger is read after both settle.
// - Other outlet is not covered (an edge node is bound to one outlet); other tenant is.
//
// Run: LEGEND_TEST_FILES="src/test/refund-1095-edge-void.test.ts" heavy pnpm test
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createUlid,
  tenantIdSchema,
  ulidToUuid,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { seedTenantRoleTemplates } from "../services/access.service.ts";
import { agent, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";
import {
  EDGE_PAID,
  edgeKit,
  registerEdgeAppliers,
  registerNode,
  resetEdge,
} from "./refund-1095-edge-helpers.ts";

vi.setConfig({ testTimeout: 120_000 });

const short = () => randomUUID().slice(0, 6);

type Site = {
  tenant: IsolatedTenant;
  kit: ReturnType<typeof edgeKit>;
};
let site: Site;
let siteB: Site;

async function asOwnerTenant<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
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
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function makeSite(app: ReturnType<typeof createApp>): Promise<Site> {
  const tenant = await createIsolatedTenant(`ev-${short()}`);
  const context = establishTenantContext({
    tenantId: tenantIdSchema.parse(tenant.tenantId),
    brandId: null,
    source: "session",
  });
  await withTenant(
    db,
    establishScopedTenantContext(context, { kind: "tenant" }),
    (tx) => seedTenantRoleTemplates(tx, tenant.tenantId),
  );
  const { rows: roleRows } = await owner.query<{ id: string }>(
    "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'owner'",
    [tenant.tenantId],
  );
  const ownerRoleId = roleRows[0]!.id;
  const member = async (label: string) => {
    const client = agent(app);
    await signUp(client, label);
    const session = await client.get("/api/auth/get-session");
    const userId = session.body.user.id as string;
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
      [tenant.tenantId, userId, ownerRoleId],
    );
    return userId;
  };
  const requestedBy = await member(`Kasir Edge ${short()}`);
  const approvedBy = await member(`Supervisor Edge ${short()}`);

  const category = randomUUID();
  await owner.query(
    "INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order) VALUES ($1, $2, $3, 'Edge Void', 0)",
    [category, tenant.tenantId, tenant.brandId],
  );
  const menuItemId = randomUUID();
  await owner.query(
    `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
     VALUES ($1, $2, $3, $4, 'Latte', true, $5)`,
    [menuItemId, tenant.tenantId, tenant.brandId, category, randomUUID()],
  );
  const node = await registerNode(tenant);
  return {
    tenant,
    kit: edgeKit(tenant, node, { requestedBy, approvedBy, menuItemId }),
  };
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  const app = createApp();
  site = await makeSite(app);
  siteB = await makeSite(app);
});

beforeEach(() => {
  registerEdgeAppliers();
});

afterAll(() => {
  resetEdge();
});

type Order = { ulid: string; uuid: string };

/** An order ingested from the site's edge node, as a completed cloud order. */
async function edgeSale(s: Site = site): Promise<Order> {
  const ulid = createUlid();
  await s.kit.deliver([s.kit.paidEvent(ulid)]);
  expect(await s.kit.ingestOf(ulid)).toMatchObject({ state: "ingested" });
  return { ulid, uuid: ulidToUuid(ulid) };
}

type Ord09Status = "pending" | "approved" | "completed" | "failed";

/**
 * An ORD-09 refund written straight into the tables (see the file header). Returns the
 * issue id.
 */
async function insertOrd09(
  client: PoolClient,
  s: Site,
  order: Order,
  status: Ord09Status,
): Promise<string> {
  const { tenantId, outletId } = s.tenant;
  const { rows } = await client.query<{ id: string }>(
    "SELECT id FROM order_items WHERE tenant_id = $1 AND order_id = $2 LIMIT 1",
    [tenantId, order.uuid],
  );
  const itemId = rows[0]!.id;
  const issueId = randomUUID();
  const intentId = randomUUID();
  await client.query("SET LOCAL session_replication_role = replica");
  await client.query(
    `INSERT INTO order_issues (id, tenant_id, outlet_id, order_id, order_item_id, type, reason,
       reason_note, reported_by, resolution, approved_by, cost_idr, status,
       idempotency_key, resolved_at, refund_rejected_at, approval_request_id)
     VALUES ($1, $2, $3, $4, $5, 'unfulfillable', 'out_of_stock',
       'Item habis, refund pemulihan disetujui', $6, 'manual_refund', $7, 0, 'resolved',
       $8, now(), NULL, $9)`,
    [
      issueId,
      tenantId,
      outletId,
      order.uuid,
      itemId,
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ],
  );
  await client.query(
    `INSERT INTO payment_intents
       (id, tenant_id, outlet_id, payment_link_id, order_id, method, provider, amount_idr,
        idempotency_key, status, instructions, paid_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'qris', 'fake', $6, $7, 'paid', '{}'::jsonb, now(),
        now() + interval '1 day')`,
    [
      intentId,
      tenantId,
      outletId,
      randomUUID(),
      order.uuid,
      EDGE_PAID,
      `k1095-${randomUUID()}`,
    ],
  );
  await client.query(
    `INSERT INTO payment_refunds
       (id, tenant_id, outlet_id, payment_intent_id, order_issue_id, amount_idr,
        reason, status, requested_by, failure_reason)
     VALUES ($1, $2, $3, $4, $5, $6, 'Refund item gagal (ORD-09)', $7, 'system:recovery', $8)`,
    [
      randomUUID(),
      tenantId,
      outletId,
      intentId,
      issueId,
      20_000,
      status,
      status === "failed" ? "cap_exceeded" : null,
    ],
  );
  return issueId;
}

function seedOrd09(
  order: Order,
  status: Ord09Status = "pending",
  s: Site = site,
): Promise<string> {
  return asOwnerTenant(s.tenant.tenantId, (client) =>
    insertOrd09(client, s, order, status),
  );
}

/** Race writer: lock the order row, refuse (null) when a void exists, else file ORD-09. */
function seedOrd09UnlessVoided(order: Order): Promise<string | null> {
  return asOwnerTenant(site.tenant.tenantId, async (client) => {
    await client.query(
      "SELECT 1 FROM orders WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
      [site.tenant.tenantId, order.uuid],
    );
    const { rows } = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pos_order_voids WHERE tenant_id = $1 AND order_id = $2",
      [site.tenant.tenantId, order.uuid],
    );
    if (rows[0]!.n > 0) return null;
    return insertOrd09(client, site, order, "pending");
  });
}

async function liveOrd09(order: Order, s: Site = site): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM payment_refunds r
       JOIN order_issues i ON i.tenant_id = r.tenant_id AND i.id = r.order_issue_id
      WHERE r.tenant_id = $1 AND i.order_id = $2 AND r.status <> 'failed'`,
    [s.tenant.tenantId, order.uuid],
  );
  return rows[0]!.n;
}

const REFUSED = {
  state: "ingested",
  reason: expect.stringMatching(/(^|:)ord09_refund_exists$/),
};

describe("legend-aja6g edge void with an ORD-09 refund already there", () => {
  it("control: a lone edge void of an ingested sale is recorded", async () => {
    const order = await edgeSale();
    await site.kit.deliver([site.kit.voidEvent(order.ulid)]);
    expect(await site.kit.voidRows(order.ulid)).toBe(1);
    expect(await site.kit.ingestOf(order.ulid)).toMatchObject({
      state: "voided",
    });
  });

  it.each(["pending", "approved", "completed"] as const)(
    "a %s ORD-09 refund: the edge void is refused, writes no void row, ledger stays ingested",
    async (status) => {
      const order = await edgeSale();
      await seedOrd09(order, status);
      await site.kit.deliver([site.kit.voidEvent(order.ulid)]).catch(() => undefined);

      expect(await site.kit.voidRows(order.ulid)).toBe(0);
      expect(await site.kit.ingestOf(order.ulid)).toMatchObject(REFUSED);
      expect(await liveOrd09(order)).toBe(1);
      // the refused event stays parked next to the order (void_refused pattern)
      expect(await site.kit.parkedVoids(order.ulid)).toBe(1);
    },
  );

  it("a FAILED ORD-09 refund frees the lane: the edge void is recorded", async () => {
    const order = await edgeSale();
    await seedOrd09(order, "failed");
    await site.kit.deliver([site.kit.voidEvent(order.ulid)]);
    expect(await site.kit.voidRows(order.ulid)).toBe(1);
    expect(await site.kit.ingestOf(order.ulid)).toMatchObject({
      state: "voided",
    });
  });

  it("isolation: ORD-09 on order X does not block the edge void of order Y (same outlet)", async () => {
    const x = await edgeSale();
    const y = await edgeSale();
    await seedOrd09(x);
    await site.kit.deliver([site.kit.voidEvent(y.ulid)]);
    await site.kit.deliver([site.kit.voidEvent(x.ulid)]).catch(() => undefined);

    expect(await site.kit.voidRows(y.ulid)).toBe(1);
    expect(await site.kit.ingestOf(y.ulid)).toMatchObject({ state: "voided" });
    expect(await site.kit.voidRows(x.ulid)).toBe(0);
    expect(await site.kit.ingestOf(x.ulid)).toMatchObject(REFUSED);
  });

  it("isolation: another tenant's ORD-09 refund neither blocks nor is touched by our void", async () => {
    const ours = await edgeSale();
    const theirs = await edgeSale(siteB);
    await seedOrd09(theirs, "pending", siteB);

    await site.kit.deliver([site.kit.voidEvent(ours.ulid)]);
    await siteB.kit
      .deliver([siteB.kit.voidEvent(theirs.ulid)])
      .catch(() => undefined);

    expect(await site.kit.voidRows(ours.ulid)).toBe(1);
    expect(await siteB.kit.voidRows(theirs.ulid)).toBe(0);
    expect(await siteB.kit.ingestOf(theirs.ulid)).toMatchObject(REFUSED);
    expect(await liveOrd09(theirs, siteB)).toBe(1);
  });
});

describe("legend-aja6g edge void replay with an ORD-09 refund", () => {
  it("a void refused for ORD-09 stays refused on replay: no throw, no void row, one ORD-09 refund", async () => {
    const order = await edgeSale();
    await seedOrd09(order);
    const event = site.kit.voidEvent(order.ulid);

    await site.kit.deliver([event]).catch(() => undefined);
    await expect(site.kit.deliver([event])).resolves.toBeUndefined();
    await expect(site.kit.deliver([event, event])).resolves.toBeUndefined();

    expect(await site.kit.voidRows(order.ulid)).toBe(0);
    expect(await site.kit.ingestOf(order.ulid)).toMatchObject(REFUSED);
    expect(await liveOrd09(order)).toBe(1);
  });

  it("a different, later void event of the same sale is refused while ORD-09 is live", async () => {
    const order = await edgeSale();
    await seedOrd09(order);
    await site.kit.deliver([site.kit.voidEvent(order.ulid, 2)]).catch(() => undefined);
    await site.kit.deliver([site.kit.voidEvent(order.ulid, 3)]).catch(() => undefined);

    expect(await site.kit.voidRows(order.ulid)).toBe(0);
    expect(await liveOrd09(order)).toBe(1);
  });

  it("an applied void replayed stays one void row, and the ORD-09 writer (void exists) is refused after it", async () => {
    const order = await edgeSale();
    const event = site.kit.voidEvent(order.ulid);
    await site.kit.deliver([event]);
    await site.kit.deliver([event]);
    expect(await site.kit.voidRows(order.ulid)).toBe(1);

    expect(await seedOrd09UnlessVoided(order)).toBeNull();
    expect(await liveOrd09(order)).toBe(0);
    expect(await site.kit.voidRows(order.ulid)).toBe(1);
  });
});

describe("legend-aja6g edge void racing the ORD-09 writer: exactly one lane wins", () => {
  it("in parallel the order ends voided OR refunded, never both", async () => {
    for (let round = 0; round < 3; round += 1) {
      const order = await edgeSale();
      const [, filed] = await Promise.all([
        site.kit.deliver([site.kit.voidEvent(order.ulid)]).catch(() => undefined),
        seedOrd09UnlessVoided(order),
      ]);

      const voided = await site.kit.voidRows(order.ulid);
      const refunds = await liveOrd09(order);
      expect(voided + refunds, `round ${round}: exactly one lane`).toBe(1);
      expect(filed !== null ? 1 : 0).toBe(refunds);
      expect(voided * EDGE_PAID + refunds * 20_000).toBeLessThanOrEqual(
        EDGE_PAID,
      );
      if (refunds === 1)
        expect(await site.kit.ingestOf(order.ulid)).toMatchObject(REFUSED);
      else
        expect(await site.kit.ingestOf(order.ulid)).toMatchObject({
          state: "voided",
        });
    }
  });

  it("a void racing an ORD-09 refund that already exists loses, every time", async () => {
    for (let round = 0; round < 2; round += 1) {
      const order = await edgeSale();
      await seedOrd09(order);
      await Promise.all([
        site.kit.deliver([site.kit.voidEvent(order.ulid)]).catch(() => undefined),
        site.kit.deliver([site.kit.voidEvent(order.ulid, 3)]).catch(() => undefined),
      ]);
      expect(await site.kit.voidRows(order.ulid)).toBe(0);
      expect(await liveOrd09(order)).toBe(1);
    }
  });
});
