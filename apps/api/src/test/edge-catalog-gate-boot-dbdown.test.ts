// Edge boot with a dead local database (bead legend-10nex round 2, design
// section J). A local database that is down at boot must not stall the edge
// runtime: startCatalogGate returns its handle at once with sales held
// (GATE_UNAVAILABLE), retries the load in the background and, once it works,
// switches to the normal gate. Written from the design, not the implementation.
//
// Assumptions:
//  - "Database down" is a Proxy over the real `db` whose `transaction` (the
//    entry point of the tenant-scoped reads and writes) either never settles
//    ("hang") or rejects ("fail"); switching to "ok" is the database coming up.
//  - persistMs is small (100 ms) so the background retry happens quickly; the
//    tests poll the gate state with vi.waitFor (a state, not a fixed sleep).
//  - The wall clock is injected and static; the monotonic clock follows it.
//  - Message check is on the stable part "database lokal edge belum bisa dibaca".
import { randomUUID } from "node:crypto";
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
import { CATALOG_TAX_STREAMS } from "@starter/shared/edge";
import { db } from "../db/index.ts";
import {
  saveCatalogGateState,
  startCatalogGate,
  type CatalogGateHandle,
  type CatalogGateOverrides,
} from "../edge/catalog-gate.ts";
import { CRITICAL_CATALOG_STREAMS } from "../edge/catalog-freshness.ts";
import {
  assertCatalogSalesAllowed,
  getSalesGateState,
  installSalesGateProvider,
  setSalesGateEdgeModeForTests,
} from "../edge/sales-gate.ts";
import { registerEdgeNode } from "../services/edge-node.service.ts";
import { owner, seededOutletA, seededTenantId } from "./floor-test-helpers.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = new Date("2026-11-11T03:00:00.000Z");
const STREAMS = [...CRITICAL_CATALOG_STREAMS] as string[];
const handles: CatalogGateHandle[] = [];

type Rig = {
  context: ReturnType<typeof establishScopedTenantContext>;
  scope: { tenantId: string; outletId: string; edgeNodeId: string };
};

async function newEdge(): Promise<Rig> {
  const outletId = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet uji db mati', address, timezone, opening_hours, status
       FROM outlets WHERE id = $3`,
    [outletId, `DB${outletId.slice(0, 8)}`.toUpperCase(), seededOutletA],
  );
  const base = (source: "session" | "device") =>
    establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(seededTenantId),
        brandId: null,
        source,
      }),
      { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
    );
  const registered = await registerEdgeNode(
    base("session"),
    randomUUID() as never,
    { outletId, role: "standby", label: "Mini PC uji db mati" } as never,
  );
  return {
    context: base("device"),
    scope: {
      tenantId: seededTenantId,
      outletId,
      edgeNodeId: registered.edgeNode.id as string,
    },
  };
}

/** A database that can be broken and repaired while the gate is running. */
function switchableDb(initial: "hang" | "fail" | "ok") {
  let mode = initial;
  const proxy = new Proxy(db, {
    get(target, property, receiver) {
      if (property === "transaction")
        return (...args: unknown[]) => {
          if (mode === "hang") return new Promise(() => undefined);
          if (mode === "fail")
            return Promise.reject(new Error("database unavailable"));
          return (target.transaction as (...a: unknown[]) => unknown)(...args);
        };
      return Reflect.get(target, property, receiver);
    },
  }) as typeof db;
  return {
    database: proxy,
    set: (next: "hang" | "fail" | "ok") => {
      mode = next;
    },
  };
}

const noOverrides: CatalogGateOverrides = {
  load: async () => null,
  close: async () => undefined,
};

async function boot(
  rig: Rig,
  database: typeof db,
  wallStart: Date,
  seedAt: Date | null = null,
) {
  const wall = wallStart.getTime();
  setSalesGateEdgeModeForTests(() => true);
  const started = Date.now();
  const handle = await Promise.race([
    startCatalogGate({
      context: rig.context,
      scope: rig.scope,
      overrides: noOverrides,
      seed: async (freshness) => {
        if (seedAt)
          for (const name of STREAMS) freshness.seedLastSuccess(name, seedAt);
      },
      database,
      persistMs: 100,
      bootWaitMs: 50,
      wall: () => new Date(wall),
      mono: () => 10_000 + (wall - wallStart.getTime()),
    }),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("startCatalogGate hung with the database down")),
        2_000,
      ),
    ),
  ]);
  handles.push(handle);
  return { handle, elapsedMs: Date.now() - started };
}

const gateRow = async (edgeNodeId: string) =>
  (
    await owner.query<{
      tracking_started_at: Date;
      clock_high_water_at: Date;
    }>(
      "SELECT tracking_started_at, clock_high_water_at FROM edge_catalog_gate_state WHERE edge_node_id = $1",
      [edgeNodeId],
    )
  ).rows[0];

const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterEach(async () => {
  while (handles.length) await handles.pop()!.stop();
  installSalesGateProvider(null);
  setSalesGateEdgeModeForTests(null);
});

afterAll(async () => {
  await owner.end();
});

describe("legend-10nex boot with the local database down does not hang", () => {
  it.each(["hang", "fail"] as const)(
    "(%s) returns the handle promptly, sales are held as GATE_UNAVAILABLE with a clear message",
    async (mode) => {
      const rig = await newEdge();
      const dbSwitch = switchableDb(mode);
      const { elapsedMs } = await boot(rig, dbSwitch.database, T0);
      expect(elapsedMs).toBeLessThan(1_500);

      expect(getSalesGateState()).toMatchObject({
        blocked: true,
        reason: "GATE_UNAVAILABLE",
        override: null,
      });
      let thrown: unknown;
      try {
        assertCatalogSalesAllowed();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code: "CATALOG_STALE_BLOCKED" });
      expect((thrown as Error).message).toContain(
        "database lokal edge belum bisa dibaca",
      );
    },
  );

  it("stays held while the database stays down (it does not open on its own)", async () => {
    const rig = await newEdge();
    const dbSwitch = switchableDb("fail");
    await boot(rig, dbSwitch.database, T0, T0);
    await settle(500); // several retries
    expect(getSalesGateState()).toMatchObject({
      blocked: true,
      reason: "GATE_UNAVAILABLE",
    });
  });

  it("stop() ends the background retry", async () => {
    const rig = await newEdge();
    const dbSwitch = switchableDb("fail");
    const { handle } = await boot(rig, dbSwitch.database, T0);
    await handle.stop();
    handles.pop();
    dbSwitch.set("ok");
    await settle(400);
    // The stopped gate must not have recovered and opened by itself.
    expect(getSalesGateState().blocked).toBe(true);
    expect(await gateRow(rig.scope.edgeNodeId)).toBeUndefined();
  });
});

describe("legend-10nex the gate recovers when the local database comes back", () => {
  it("switches to the normal gate: not held when every stream is fresh", async () => {
    const rig = await newEdge();
    await saveCatalogGateState(rig.context, rig.scope, {
      trackingStartedAt: T0,
      clockHighWaterAt: T0,
    });
    const dbSwitch = switchableDb("fail");
    const wall = new Date(T0.getTime() + HOUR);
    await boot(rig, dbSwitch.database, wall, wall);
    expect(getSalesGateState().reason).toBe("GATE_UNAVAILABLE");

    dbSwitch.set("ok");
    await vi.waitFor(
      () => {
        const state = getSalesGateState();
        expect(state.reason).not.toBe("GATE_UNAVAILABLE");
        expect(state.blocked).toBe(false);
      },
      { timeout: 3_000, interval: 50 },
    );
    expect(() => assertCatalogSalesAllowed()).not.toThrow();
  });

  it("a persisted high water in the future holds sales as CLOCK_REGRESSED after adoption", async () => {
    const rig = await newEdge();
    await saveCatalogGateState(rig.context, rig.scope, {
      trackingStartedAt: T0,
      clockHighWaterAt: new Date(T0.getTime() + DAY),
    });
    const dbSwitch = switchableDb("hang");
    // Device date is a day behind what was stored; everything synced "just now"
    // in trusted time.
    await boot(rig, dbSwitch.database, T0, new Date(T0.getTime() + DAY));
    expect(getSalesGateState().reason).toBe("GATE_UNAVAILABLE");

    dbSwitch.set("ok");
    await vi.waitFor(
      () =>
        expect(getSalesGateState()).toMatchObject({
          blocked: true,
          reason: "CLOCK_REGRESSED",
        }),
      { timeout: 3_000, interval: 50 },
    );
    // The stored high water was not lowered by the provisional clock.
    expect(
      (await gateRow(rig.scope.edgeNodeId))!.clock_high_water_at.getTime(),
    ).toBeGreaterThanOrEqual(T0.getTime() + DAY);
  });

  it("keeps the earlier persisted trackingStartedAt: not overwritten, and a never-synced edge is still held after 24 h", async () => {
    const rig = await newEdge();
    const earlier = new Date(T0.getTime() - 30 * HOUR);
    await saveCatalogGateState(rig.context, rig.scope, {
      trackingStartedAt: earlier,
      clockHighWaterAt: earlier,
    });
    const dbSwitch = switchableDb("fail");
    await boot(rig, dbSwitch.database, T0); // nothing seeded: never synced

    // While the database is down nothing provisional is written to the row.
    await settle(400);
    expect((await gateRow(rig.scope.edgeNodeId))?.tracking_started_at).toEqual(
      earlier,
    );

    dbSwitch.set("ok");
    await vi.waitFor(
      () =>
        expect(getSalesGateState()).toMatchObject({
          blocked: true,
          stale24h: true,
          reason: "TAX_NOT_SYNCED", // never synced: no tax either (osqou.22)
        }),
      { timeout: 3_000, interval: 50 },
    );
    // Counted from the stored start (30 h ago), not from this boot.
    expect(getSalesGateState().staleSince).toEqual(earlier);
    expect((await gateRow(rig.scope.edgeNodeId))?.tracking_started_at).toEqual(
      earlier,
    );
  });

  it("a brand new edge (no saved row) opens once the database is back and tax is synced, and counts from the first load", async () => {
    const rig = await newEdge();
    const dbSwitch = switchableDb("fail");
    const { handle } = await boot(rig, dbSwitch.database, T0);
    expect(getSalesGateState().reason).toBe("GATE_UNAVAILABLE");
    dbSwitch.set("ok");
    await vi.waitFor(
      () =>
        expect(getSalesGateState()).toMatchObject({
          blocked: true,
          stale24h: false,
          reason: "TAX_NOT_SYNCED",
        }),
      { timeout: 3_000, interval: 50 },
    );
    for (const name of CATALOG_TAX_STREAMS)
      handle.freshness.recordSuccess(name);
    await vi.waitFor(() => expect(getSalesGateState().blocked).toBe(false), {
      timeout: 3_000,
      interval: 50,
    });
    expect(getSalesGateState().reason).toBeNull();
  });
});
