// Owner override of the 24-hour catalog sales hold, service level (bead
// legend-10nex, founder Q57: "override tercatat: siapa, kapan, sampai kapan").
// Written from the design contract (edge/catalog-override.ts), not from the
// implementation:
//   grantCatalogOverride(deps, { edgeNodeId, userId, minutes, reason, now })
//   loadActiveCatalogOverride(deps, { edgeNodeId, now })
//   closeCatalogOverrides(deps, { edgeNodeId, now, reason })
//   setCatalogOverrideListener(fn | null)
// Table `edge_catalog_sale_overrides`: edge_node_id, granted_by, granted_at,
// until_at, reason, superseded_at, closed_at, closed_reason.
//
// Assumptions (the contract is silent):
//  - `deps` is `{ database, context, outletId }` (outlet scoped context), built in ONE place
//    (`newNode` below) so a different shape is a one-line change.
//  - The edge node id is a free uuid (no foreign key is promised); rows are
//    read back through the owner pool, which bypasses row level security.
//  - The returned override carries { id, grantedBy, grantedAt, untilAt, reason }.
//  - An override is active while now < untilAt (checked at untilAt -/+ 1 ms,
//    the exact boundary is not asserted).
//  - Validation failures reject (any error) and write no row.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { outletIdSchema, tenantIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { db } from "../db/index.ts";
import { registerEdgeNode } from "../services/edge-node.service.ts";
import { seededOutletA, seededTenantId } from "./floor-test-helpers.ts";
import {
  closeCatalogOverrides,
  grantCatalogOverride,
  isCatalogOverrideClockReady,
  loadActiveCatalogOverride,
  setCatalogOverrideClock,
  setCatalogOverrideListener,
} from "../edge/catalog-override.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const MIN = 60_000;
const HOUR_MS = 60 * MIN;
const T0 = new Date("2026-11-11T03:00:00.000Z");
const ownerUserId = randomUUID();
const nodes: string[] = [];
// The service is tenant and outlet scoped (found out from the first run: the
// table is keyed like the other edge tables). Each test node therefore gets its
// own cloned outlet and a registered edge node (one active node per role per
// outlet), and `deps` carry the outlet scoped tenant context.
const depsByNode = new Map<string, never>();
const depsOf = (edgeNodeId: string): never => depsByNode.get(edgeNodeId)!;
const outletIds: string[] = [];

async function newNode(): Promise<string> {
  const outletId = randomUUID();
  outletIds.push(outletId);
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet uji override', address, timezone, opening_hours, status
       FROM outlets WHERE id = $3`,
    [outletId, `OV${outletId.slice(0, 8)}`.toUpperCase(), seededOutletA],
  );
  const context = establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(seededTenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
  );
  const registered = await registerEdgeNode(
    context,
    ownerUserId as never,
    {
      outletId,
      role: "standby",
      label: "Mini PC uji override",
    } as never,
  );
  const id = registered.edgeNode.id as string;
  depsByNode.set(id, { database: db, context, outletId } as never);
  nodes.push(id);
  return id;
}

type Row = {
  granted_by: string;
  granted_at: Date;
  until_at: Date;
  reason: string;
  superseded_at: Date | null;
  closed_at: Date | null;
  closed_reason: string | null;
};

async function rows(edgeNodeId: string): Promise<Row[]> {
  const { rows: found } = await owner.query<Row>(
    `SELECT granted_by, granted_at, until_at, reason, superseded_at, closed_at, closed_reason
       FROM edge_catalog_sale_overrides WHERE edge_node_id = $1 ORDER BY granted_at, id`,
    [edgeNodeId],
  );
  return found;
}

const grant = (
  edgeNodeId: string,
  input: { minutes?: number; reason?: string; now?: Date } = {},
) =>
  grantCatalogOverride(depsOf(edgeNodeId), {
    edgeNodeId,
    userId: ownerUserId,
    minutes: input.minutes ?? 240,
    reason: input.reason ?? "Internet toko mati sejak pagi",
    now: input.now ?? T0,
  });

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  // The runtime installs the trusted clock at boot; a grant is refused (503
  // EDGE_CLOCK_NOT_READY) before. Every test passes its own `now` explicitly.
  setCatalogOverrideClock(() => T0);
  await owner.query(
    `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, 'Owner Override', $2, true)`,
    [ownerUserId, `ovr-${randomBytes(4).toString("hex")}@example.test`],
  );
});

afterEach(() => {
  setCatalogOverrideListener(null);
});

afterAll(async () => {
  setCatalogOverrideClock(null);
  try {
    await owner.query(
      "DELETE FROM edge_catalog_sale_overrides WHERE edge_node_id = ANY($1::uuid[])",
      [nodes],
    );
  } finally {
    await owner.end();
  }
});

describe("legend-10nex override records who, when, until and why", () => {
  it("stores the owner, the grant time, the end time and the reason", async () => {
    const node = await newNode();
    const granted = await grant(node, {
      minutes: 240,
      reason: "Internet mati",
    });
    expect(granted).toMatchObject({
      grantedBy: ownerUserId,
      reason: "Internet mati",
    });
    expect(new Date(granted.grantedAt)).toEqual(T0);
    expect(new Date(granted.untilAt)).toEqual(
      new Date(T0.getTime() + 240 * MIN),
    );

    const stored = await rows(node);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      granted_by: ownerUserId,
      reason: "Internet mati",
      superseded_at: null,
      closed_at: null,
      closed_reason: null,
    });
    expect(stored[0]!.granted_at).toEqual(T0);
    expect(stored[0]!.until_at).toEqual(new Date(T0.getTime() + 240 * MIN));
  });

  it("trims the reason", async () => {
    const node = await newNode();
    await grant(node, { reason: "   Internet mati   " });
    expect((await rows(node))[0]!.reason).toBe("Internet mati");
  });

  it("is loaded as the active override and reports the same facts", async () => {
    const node = await newNode();
    await grant(node, { minutes: 60, reason: "Listrik padam" });
    const active = await loadActiveCatalogOverride(depsOf(node), {
      edgeNodeId: node,
      now: new Date(T0.getTime() + 10 * MIN),
    });
    expect(active).toMatchObject({
      grantedBy: ownerUserId,
      reason: "Listrik padam",
    });
    expect(new Date(active!.untilAt)).toEqual(
      new Date(T0.getTime() + 60 * MIN),
    );
  });

  it("belongs to one edge node only", async () => {
    const node = await newNode();
    const other = await newNode();
    await grant(node);
    expect(
      await loadActiveCatalogOverride(depsOf(other), {
        edgeNodeId: other,
        now: T0,
      }),
    ).toBeNull();
  });
});

describe("legend-10nex override expires by itself", () => {
  it("is active just before untilAt and gone just after", async () => {
    const node = await newNode();
    await grant(node, { minutes: 30 });
    const until = T0.getTime() + 30 * MIN;
    expect(
      await loadActiveCatalogOverride(depsOf(node), {
        edgeNodeId: node,
        now: new Date(until - 1),
      }),
    ).not.toBeNull();
    expect(
      await loadActiveCatalogOverride(depsOf(node), {
        edgeNodeId: node,
        now: new Date(until + 1),
      }),
    ).toBeNull();
  });

  it("an expired override is never revived by a later read", async () => {
    const node = await newNode();
    await grant(node, { minutes: 1 });
    const late = new Date(T0.getTime() + 10 * MIN);
    expect(
      await loadActiveCatalogOverride(depsOf(node), {
        edgeNodeId: node,
        now: late,
      }),
    ).toBeNull();
    expect(
      await loadActiveCatalogOverride(depsOf(node), {
        edgeNodeId: node,
        now: late,
      }),
    ).toBeNull();
  });
});

describe("legend-10nex override duration is capped at 24 hours", () => {
  it.each([1, 1440])("accepts %i minutes", async (minutes) => {
    const node = await newNode();
    const granted = await grant(node, { minutes });
    expect(new Date(granted.untilAt)).toEqual(
      new Date(T0.getTime() + minutes * MIN),
    );
  });

  it.each([0, -5, 1441, 100_000, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses %s minutes and writes nothing",
    async (minutes) => {
      const node = await newNode();
      await expect(grant(node, { minutes })).rejects.toThrow();
      expect(await rows(node)).toHaveLength(0);
    },
  );
});

describe("legend-10nex override needs a real reason", () => {
  it.each(["", "   ", "ab", "x".repeat(501)])(
    "refuses a bad reason (case %#) and writes nothing",
    async (reason) => {
      const node = await newNode();
      await expect(grant(node, { reason })).rejects.toThrow();
      expect(await rows(node)).toHaveLength(0);
    },
  );

  it("accepts the shortest and the longest allowed reason", async () => {
    const node = await newNode();
    await grant(node, { reason: "abc" });
    await grant(node, {
      reason: "y".repeat(500),
      now: new Date(T0.getTime() + MIN),
    });
    expect(await rows(node)).toHaveLength(2);
  });
});

describe("legend-10nex granting again replaces the active override", () => {
  it("marks the old row superseded, keeps it, and only the new one is active", async () => {
    const node = await newNode();
    await grant(node, { minutes: 60, reason: "Pertama" });
    const second = await grant(node, {
      minutes: 120,
      reason: "Kedua",
      now: new Date(T0.getTime() + 10 * MIN),
    });

    const stored = await rows(node);
    expect(stored).toHaveLength(2);
    expect(stored[0]!.reason).toBe("Pertama");
    expect(stored[0]!.superseded_at).not.toBeNull();
    expect(stored[1]!.reason).toBe("Kedua");
    expect(stored[1]!.superseded_at).toBeNull();

    const active = await loadActiveCatalogOverride(depsOf(node), {
      edgeNodeId: node,
      now: new Date(T0.getTime() + 20 * MIN),
    });
    expect(active?.reason).toBe("Kedua");
    expect(active?.id).toBe(second.id);
  });

  it("a shorter replacement ends the hold sooner (the old end time no longer applies)", async () => {
    const node = await newNode();
    await grant(node, { minutes: 600, reason: "Panjang" });
    await grant(node, {
      minutes: 30,
      reason: "Pendek",
      now: new Date(T0.getTime() + MIN),
    });
    expect(
      await loadActiveCatalogOverride(depsOf(node), {
        edgeNodeId: node,
        now: new Date(T0.getTime() + 60 * MIN),
      }),
    ).toBeNull();
  });
});

describe("legend-10nex a successful sync closes the override", () => {
  it("closes the active override with the reason SYNC_OK and keeps the row", async () => {
    const node = await newNode();
    await grant(node, { minutes: 600 });
    const syncAt = new Date(T0.getTime() + 5 * MIN);
    await closeCatalogOverrides(depsOf(node), {
      edgeNodeId: node,
      now: syncAt,
      reason: "SYNC_OK",
    });

    expect(
      await loadActiveCatalogOverride(depsOf(node), {
        edgeNodeId: node,
        now: new Date(T0.getTime() + 6 * MIN),
      }),
    ).toBeNull();
    const stored = await rows(node);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.closed_at).toEqual(syncAt);
    expect(stored[0]!.closed_reason).toBe("SYNC_OK");
  });

  it("closing when nothing is active is harmless", async () => {
    const node = await newNode();
    await expect(
      closeCatalogOverrides(depsOf(node), {
        edgeNodeId: node,
        now: T0,
        reason: "SYNC_OK",
      }),
    ).resolves.not.toThrow();
    expect(await rows(node)).toHaveLength(0);
  });

  it("closes only this edge node", async () => {
    const node = await newNode();
    const other = await newNode();
    await grant(node);
    await grant(other);
    await closeCatalogOverrides(depsOf(node), {
      edgeNodeId: node,
      now: T0,
      reason: "SYNC_OK",
    });
    expect(
      await loadActiveCatalogOverride(depsOf(other), {
        edgeNodeId: other,
        now: new Date(T0.getTime() + MIN),
      }),
    ).not.toBeNull();
  });

  it("a new episode after closing needs a new grant", async () => {
    const node = await newNode();
    await grant(node, { minutes: 600 });
    await closeCatalogOverrides(depsOf(node), {
      edgeNodeId: node,
      now: T0,
      reason: "SYNC_OK",
    });
    await grant(node, { minutes: 30, now: new Date(T0.getTime() + HOUR_MS) });
    const stored = await rows(node);
    expect(stored).toHaveLength(2);
    expect(stored[1]!.closed_at).toBeNull();
    expect(stored[1]!.superseded_at).toBeNull();
  });
});

describe("legend-10nex the gate hears about every change at once", () => {
  it("calls the listener after a grant and after a close", async () => {
    const listener = vi.fn();
    setCatalogOverrideListener(listener);
    const node = await newNode();
    await grant(node);
    expect(listener).toHaveBeenCalledTimes(1);
    await closeCatalogOverrides(depsOf(node), {
      edgeNodeId: node,
      now: T0,
      reason: "SYNC_OK",
    });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("does not call the listener for a refused grant", async () => {
    const listener = vi.fn();
    setCatalogOverrideListener(listener);
    await expect(grant(await newNode(), { minutes: 5000 })).rejects.toThrow();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("legend-10nex two concurrent grants leave exactly one active row", () => {
  it("has a partial unique index on the edge node for rows neither superseded nor closed", async () => {
    const { rows: indexes } = await owner.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'edge_catalog_sale_overrides'`,
    );
    const unique = indexes.find(
      (row) =>
        /unique/i.test(row.indexdef) &&
        /edge_node_id/.test(row.indexdef) &&
        /where/i.test(row.indexdef) &&
        /superseded_at IS NULL/i.test(row.indexdef) &&
        /closed_at IS NULL/i.test(row.indexdef),
    );
    expect(unique, JSON.stringify(indexes)).toBeDefined();
  });

  it.each([2, 5])(
    "%i grants at once: one active row, the rest superseded",
    async (count) => {
      const node = await newNode();
      const results = await Promise.allSettled(
        Array.from({ length: count }, (_, index) =>
          grant(node, {
            minutes: 60,
            reason: `Serentak ${index}`,
            now: new Date(T0.getTime() + index * 1000),
          }),
        ),
      );
      // A loser may be refused or retried by the service; at least one grant wins.
      expect(results.some((result) => result.status === "fulfilled")).toBe(
        true,
      );

      const stored = await rows(node);
      expect(
        stored.filter(
          (row) => row.superseded_at === null && row.closed_at === null,
        ),
      ).toHaveLength(1);
      expect(
        await loadActiveCatalogOverride(depsOf(node), {
          edgeNodeId: node,
          now: new Date(T0.getTime() + 30 * MIN),
        }),
      ).not.toBeNull();
    },
  );
});

describe("legend-10nex the trusted clock gates the override service", () => {
  afterEach(() => {
    setCatalogOverrideClock(() => T0); // back to the suite's installed clock
  });

  it("is not ready until the runtime installs the trusted clock", () => {
    setCatalogOverrideClock(null);
    expect(isCatalogOverrideClockReady()).toBe(false);
    setCatalogOverrideClock(() => new Date());
    expect(isCatalogOverrideClockReady()).toBe(true);
    setCatalogOverrideClock(null);
    expect(isCatalogOverrideClockReady()).toBe(false);
  });
});

describe("legend-10nex rows that cannot be real are ignored (planted or clock-skewed)", () => {
  async function plant(
    node: string,
    row: { grantedAt: Date; untilAt: Date; reason: string },
  ) {
    const { context, outletId } = depsOf(node) as unknown as {
      context: { tenant: { tenantId: string } };
      outletId: string;
    };
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [context.tenant.tenantId],
      );
      await client.query(
        `INSERT INTO edge_catalog_sale_overrides
           (id, tenant_id, outlet_id, edge_node_id, granted_by, granted_at, until_at, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          randomUUID(),
          context.tenant.tenantId,
          outletId,
          node,
          ownerUserId,
          row.grantedAt,
          row.untilAt,
          row.reason,
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  const load = (node: string, now: Date) =>
    loadActiveCatalogOverride(depsOf(node), { edgeNodeId: node, now });

  it("control: a normal row is returned", async () => {
    const node = await newNode();
    await plant(node, {
      grantedAt: new Date(T0.getTime() - MIN),
      untilAt: new Date(T0.getTime() + 4 * HOUR_MS),
      reason: "Normal",
    });
    expect((await load(node, T0))?.reason).toBe("Normal");
  });

  it("a row granted in the future of the trusted now is ignored", async () => {
    const node = await newNode();
    await plant(node, {
      grantedAt: new Date(T0.getTime() + HOUR_MS),
      untilAt: new Date(T0.getTime() + 3 * HOUR_MS),
      reason: "Dari masa depan",
    });
    expect(await load(node, T0)).toBeNull();
    // Once the trusted clock really reaches the grant time it is a real row.
    expect(
      (await load(node, new Date(T0.getTime() + 2 * HOUR_MS)))?.reason,
    ).toBe("Dari masa depan");
  });

  it("a window longer than 24 hours cannot even be stored (database check)", async () => {
    // So "ends more than 24 hours after the trusted now" can only be reached
    // through a future grantedAt, which the previous test covers.
    const node = await newNode();
    await expect(
      plant(node, {
        grantedAt: new Date(T0.getTime() - HOUR_MS),
        untilAt: new Date(T0.getTime() + 25 * HOUR_MS),
        reason: "Terlalu panjang",
      }),
    ).rejects.toThrow(/window_check/);
  });

  it("a row ending exactly 24 hours after the trusted now is still accepted", async () => {
    const node = await newNode();
    await plant(node, {
      grantedAt: T0,
      untilAt: new Date(T0.getTime() + 24 * HOUR_MS),
      reason: "Tepat 24 jam",
    });
    expect((await load(node, T0))?.reason).toBe("Tepat 24 jam");
  });
});
