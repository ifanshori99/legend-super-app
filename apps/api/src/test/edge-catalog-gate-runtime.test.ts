// Edge catalog gate wiring (bead legend-10nex, founder Q57): trusted clock +
// persisted gate state + sales-gate provider + owner override cache, with the
// real database for `edge_catalog_gate_state`. Written from the design
// (edge/catalog-gate.ts startCatalogGate), proving the founder rules end to
// end without the network:
//  - a new edge counts from its first boot (trackingStartedAt, persisted once);
//  - >24h without sync holds sales, exactly 24h does not;
//  - the wall clock moved back (running, or across a restart through the
//    persisted high water) cannot evade the hold;
//  - an owner override ends at untilAt by the trusted clock, and a successful
//    sync of all critical streams closes it (SYNC_OK);
//  - a cloud (non-edge) process is never gated.
//
// Assumptions:
//  - Wall and monotonic sources are injected through `wall` / `mono`;
//    `persistMs` is made huge so only explicit `tick()` / `stop()` persist.
//  - The override service is replaced by an in-memory stub implementing
//    `CatalogGateOverrides`; the real one is covered in
//    edge-catalog-override-service.test.ts.
//  - After `stop()` the provider is removed (edge mode then fails closed).
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
import { CATALOG_TAX_STREAMS, isCatalogTaxStream } from "@starter/shared/edge";
import { db } from "../db/index.ts";
import {
  saveCatalogGateState,
  startCatalogGate,
  type CatalogGateHandle,
  type CatalogGateOverride,
  type CatalogGateOverrides,
} from "../edge/catalog-gate.ts";
import { CRITICAL_CATALOG_STREAMS } from "../edge/catalog-freshness.ts";
import type { TrustedClock } from "../edge/trusted-clock.ts";
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
const outletIds: string[] = [];

type Rig = {
  context: ReturnType<typeof establishScopedTenantContext>;
  scope: { tenantId: string; outletId: string; edgeNodeId: string };
};

async function newEdge(): Promise<Rig> {
  const outletId = randomUUID();
  outletIds.push(outletId);
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet uji gerbang', address, timezone, opening_hours, status
       FROM outlets WHERE id = $3`,
    [outletId, `GT${outletId.slice(0, 8)}`.toUpperCase(), seededOutletA],
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
    { outletId, role: "standby", label: "Mini PC uji gerbang" } as never,
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

/** Wall and monotonic clocks that the test drives. */
function clocks(wallStart: Date) {
  let wall = wallStart.getTime();
  let mono = 10_000;
  return {
    wall: () => new Date(wall),
    mono: () => mono,
    tick: (ms: number) => {
      wall += ms;
      mono += ms;
    },
    setWall: (date: Date) => {
      wall = date.getTime();
    },
  };
}

function overrideStub(initial: CatalogGateOverride | null = null) {
  let current = initial;
  const close = vi.fn(async (...args: [Date, "SYNC_OK", string?]) => {
    void args;
    current = null;
  });
  const stub: CatalogGateOverrides = {
    load: async () => current,
    close,
  };
  return {
    stub,
    close,
    set: (next: CatalogGateOverride | null) => (current = next),
  };
}

async function start(
  rig: Rig,
  clock: ReturnType<typeof clocks>,
  options: {
    overrides?: CatalogGateOverrides;
    seed?: Date | null; // last success of every critical stream
    tax?: Date | null; // the tax streams (default T0: never synced holds at once)
    database?: typeof db;
  } = {},
): Promise<CatalogGateHandle> {
  const handle = await startCatalogGate({
    context: rig.context,
    scope: rig.scope,
    overrides: options.overrides ?? overrideStub().stub,
    seed: async (freshness) => {
      const tax =
        options.tax === undefined ? (options.seed ?? T0) : options.tax;
      for (const name of STREAMS) {
        const at = isCatalogTaxStream(name) ? tax : options.seed;
        if (at) freshness.seedLastSuccess(name, at);
      }
    },
    database: options.database,
    persistMs: 24 * HOUR, // only explicit tick() / stop() persist
    wall: clock.wall,
    mono: clock.mono,
  });
  handles.push(handle);
  setSalesGateEdgeModeForTests(() => true);
  return handle;
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

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterEach(async () => {
  while (handles.length) await handles.pop()!.stop();
  setSalesGateEdgeModeForTests(null);
});

afterAll(async () => {
  await owner.end();
});

describe("legend-osqou.22 no tax rules on the edge, no sale", () => {
  it.each([
    ["never pulled", null],
    ["pulled for a part only (epoch checkpoint)", new Date(0)],
  ])("is held from the first second: %s", async (_label, tax) => {
    const rig = await newEdge();
    await start(rig, clocks(T0), { seed: T0, tax });
    expect(getSalesGateState()).toMatchObject({
      blocked: true,
      stale24h: false,
      reason: "TAX_NOT_SYNCED",
    });
    expect(() => assertCatalogSalesAllowed()).toThrow(/pajak/i);
  });

  it("no owner override lifts it, one missing stream is enough, a whole pull does", async () => {
    const rig = await newEdge();
    const clock = clocks(T0);
    const stubbed = overrideStub();
    const gate = await start(rig, clock, {
      overrides: stubbed.stub,
      seed: T0,
      tax: null,
    });
    gate.applyOverrideChange({
      id: randomUUID(),
      grantedBy: randomUUID(),
      grantedAt: T0,
      untilAt: new Date(T0.getTime() + 4 * HOUR),
      reason: "Internet toko mati",
    });
    expect(getSalesGateState()).toMatchObject({
      blocked: true,
      reason: "TAX_NOT_SYNCED",
    });
    await gate.tick();
    expect(stubbed.close).not.toHaveBeenCalled();

    const [last, ...rest] = CATALOG_TAX_STREAMS;
    for (const name of rest) gate.freshness.recordSuccess(name);
    expect(getSalesGateState().blocked).toBe(true);
    gate.freshness.recordSuccess(last!);
    expect(getSalesGateState()).toMatchObject({ blocked: false, reason: null });
    expect(() => assertCatalogSalesAllowed()).not.toThrow();
  });

  it("the cloud sells without any of this", async () => {
    const rig = await newEdge();
    await start(rig, clocks(T0), { seed: T0, tax: null });
    setSalesGateEdgeModeForTests(() => false);
    expect(() => assertCatalogSalesAllowed()).not.toThrow();
  });

  it("tax rules older than 24 hours hold sales like stale prices", async () => {
    const rig = await newEdge();
    const clock = clocks(T0);
    const gate = await start(rig, clock, { seed: T0 });
    clock.tick(DAY + 1);
    for (const name of STREAMS)
      if (name !== "tax_rules") gate.freshness.recordSuccess(name);
    expect(getSalesGateState()).toMatchObject({
      blocked: true,
      reason: "CATALOG_STALE_24H",
      staleStreams: ["tax_rules"],
    });
  });
});

describe("legend-10nex a new edge counts from its first boot", () => {
  it("is not held at boot, persists trackingStartedAt once, and is held after 24 hours", async () => {
    const rig = await newEdge();
    const clock = clocks(T0);
    await start(rig, clock);
    expect(getSalesGateState().blocked).toBe(false);
    expect((await gateRow(rig.scope.edgeNodeId))?.tracking_started_at).toEqual(
      T0,
    );

    clock.tick(DAY); // exactly 24 hours since tracking started
    expect(getSalesGateState().blocked).toBe(false);
    clock.tick(1);
    const state = getSalesGateState();
    expect(state).toMatchObject({
      blocked: true,
      stale24h: true,
      reason: "CATALOG_STALE_24H",
    });
    expect(state.staleStreams.sort()).toEqual([...STREAMS].sort());
    expect(state.staleSince).toEqual(T0);
  });

  it("a restart does not reset the 24 hours of a never-synced edge", async () => {
    const rig = await newEdge();
    const first = clocks(T0);
    const gate = await start(rig, first);
    first.tick(20 * HOUR);
    await gate.stop();

    // New process 5 hours later; nothing ever synced.
    const second = clocks(new Date(T0.getTime() + 25 * HOUR));
    await start(rig, second);
    expect((await gateRow(rig.scope.edgeNodeId))?.tracking_started_at).toEqual(
      T0,
    );
    expect(getSalesGateState().blocked).toBe(true);
  });
});

describe("legend-10nex a wall clock moved back cannot evade the hold", () => {
  it("while running", async () => {
    const rig = await newEdge();
    const clock = clocks(T0);
    await start(rig, clock, { seed: T0 });
    clock.tick(DAY + HOUR);
    expect(getSalesGateState().blocked).toBe(true);
    clock.setWall(new Date(T0.getTime() + MIN)); // date set back to just after the sync
    expect(getSalesGateState().blocked).toBe(true);
  });

  it("across a restart, through the persisted high water", async () => {
    const rig = await newEdge();
    const first = clocks(T0);
    const gate = await start(rig, first, { seed: T0 });
    first.tick(DAY + HOUR);
    await gate.tick(); // persists the high water
    await gate.stop();
    const stored = await gateRow(rig.scope.edgeNodeId);
    expect(stored!.clock_high_water_at.getTime()).toBeGreaterThanOrEqual(
      T0.getTime() + DAY + HOUR,
    );

    // Rebooted with the device date back at the time of the last sync.
    const second = clocks(new Date(T0.getTime() + MIN));
    await start(rig, second, { seed: T0 });
    expect(getSalesGateState().blocked).toBe(true);
  });

  it("the stored high water never moves back", async () => {
    const rig = await newEdge();
    const first = clocks(T0);
    const gate = await start(rig, first);
    first.tick(5 * HOUR);
    await gate.tick();
    const high = (await gateRow(rig.scope.edgeNodeId))!.clock_high_water_at;
    first.setWall(new Date(T0.getTime() - 100 * HOUR));
    await gate.tick();
    expect(
      (await gateRow(rig.scope.edgeNodeId))!.clock_high_water_at.getTime(),
    ).toBeGreaterThanOrEqual(high.getTime());
  });
});

describe("legend-10nex owner override and its end", () => {
  const override = (untilAt: Date): CatalogGateOverride => ({
    id: randomUUID(),
    grantedBy: randomUUID(),
    grantedAt: T0,
    untilAt,
    reason: "Internet toko mati",
  });

  it("allows sales until untilAt by the trusted clock, then holds again", async () => {
    const rig = await newEdge();
    const clock = clocks(T0);
    const stubbed = overrideStub();
    const gate = await start(rig, clock, {
      overrides: stubbed.stub,
      seed: T0,
    });
    clock.tick(DAY + HOUR);
    expect(getSalesGateState().blocked).toBe(true);

    const until = new Date(clock.wall().getTime() + 4 * HOUR);
    gate.applyOverrideChange(override(until)); // what a committed grant does
    let state = getSalesGateState();
    expect(state).toMatchObject({ blocked: false, stale24h: true });
    expect(state.override?.untilAt).toEqual(until);

    // The device date is pushed back to stretch the override: no effect.
    clock.tick(3 * HOUR);
    clock.setWall(new Date(T0.getTime()));
    expect(getSalesGateState().blocked).toBe(false);
    clock.tick(HOUR + MIN); // real time is now past untilAt
    state = getSalesGateState();
    expect(state.blocked).toBe(true);
    expect(state.override).toBeNull();
  });

  it("an override that survived a restart is loaded at boot", async () => {
    const rig = await newEdge();
    const clock = clocks(new Date(T0.getTime() + DAY + HOUR));
    const stubbed = overrideStub(
      override(new Date(T0.getTime() + DAY + 5 * HOUR)),
    );
    await start(rig, clock, { overrides: stubbed.stub, seed: T0 });
    expect(getSalesGateState()).toMatchObject({
      blocked: false,
      stale24h: true,
    });
  });

  it("a successful sync of all critical streams closes the override (SYNC_OK)", async () => {
    const rig = await newEdge();
    const clock = clocks(T0);
    const stubbed = overrideStub();
    const gate = await start(rig, clock, {
      overrides: stubbed.stub,
      seed: T0,
    });
    clock.tick(DAY + HOUR);
    gate.applyOverrideChange(
      override(new Date(clock.wall().getTime() + 4 * HOUR)),
    );
    stubbed.set(override(new Date(clock.wall().getTime() + 4 * HOUR)));

    // Still stale: the tick must not close it.
    await gate.tick();
    expect(stubbed.close).not.toHaveBeenCalled();

    // One stream fresh is not enough.
    gate.freshness.recordSuccess(STREAMS[0]!);
    await gate.tick();
    expect(stubbed.close).not.toHaveBeenCalled();

    for (const name of STREAMS) gate.freshness.recordSuccess(name);
    await gate.tick();
    expect(stubbed.close).toHaveBeenCalledTimes(1);
    expect(stubbed.close.mock.calls[0]![1]).toBe("SYNC_OK");
    const state = getSalesGateState();
    expect(state).toMatchObject({ blocked: false, stale24h: false });
    expect(state.override).toBeNull();
  });
});

describe("legend-10nex stopping and cloud processes", () => {
  it("after stop the edge fails closed", async () => {
    const rig = await newEdge();
    const gate = await start(rig, clocks(T0), { seed: T0 });
    expect(getSalesGateState().blocked).toBe(false);
    await gate.stop();
    expect(getSalesGateState()).toMatchObject({
      blocked: true,
      reason: "GATE_UNAVAILABLE",
    });
  });

  it("a cloud process is never held, however stale the tracker", async () => {
    const rig = await newEdge();
    const clock = clocks(T0);
    await start(rig, clock, { seed: T0 });
    clock.tick(5 * DAY);
    setSalesGateEdgeModeForTests(() => false);
    expect(getSalesGateState().blocked).toBe(false);
  });
});

describe("legend-10nex persisted gate state is monotonic and fails closed", () => {
  it("saveCatalogGateState never lowers the high water and never moves trackingStartedAt", async () => {
    const rig = await newEdge();
    const high = new Date(T0.getTime() + 10 * HOUR);
    await saveCatalogGateState(rig.context, rig.scope, {
      trackingStartedAt: T0,
      clockHighWaterAt: high,
    });
    // A later save with an older high water (a clock that was set back) and a
    // different tracking start.
    await saveCatalogGateState(rig.context, rig.scope, {
      trackingStartedAt: new Date(T0.getTime() + 5 * HOUR),
      clockHighWaterAt: new Date(T0.getTime() + HOUR),
    });
    const row = await gateRow(rig.scope.edgeNodeId);
    expect(row?.clock_high_water_at).toEqual(high);
    expect(row?.tracking_started_at).toEqual(T0);

    // And a higher one still moves it forward.
    const higher = new Date(T0.getTime() + 20 * HOUR);
    await saveCatalogGateState(rig.context, rig.scope, {
      trackingStartedAt: T0,
      clockHighWaterAt: higher,
    });
    expect((await gateRow(rig.scope.edgeNodeId))?.clock_high_water_at).toEqual(
      higher,
    );
  });

  it("a failed load of the stored state at boot never opens the gate (no trackingStartedAt reset to now)", async () => {
    const rig = await newEdge();
    const first = clocks(T0);
    const gate = await start(rig, first);
    await gate.stop();
    expect((await gateRow(rig.scope.edgeNodeId))?.tracking_started_at).toEqual(
      T0,
    );

    // Reboot 30 hours later; the very first database call (the load) fails.
    let calls = 0;
    const flaky = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "transaction")
          return (...args: unknown[]) =>
            calls++ === 0
              ? Promise.reject(new Error("database unavailable"))
              : (target.transaction as (...a: unknown[]) => unknown)(...args);
        return Reflect.get(target, property, receiver);
      },
    }) as typeof db;
    installSalesGateProvider(null);
    setSalesGateEdgeModeForTests(() => true);
    const second = clocks(new Date(T0.getTime() + 30 * HOUR));
    // Either startup refuses (no provider is installed, so the edge fails
    // closed) or it starts held; it must NOT start as a brand new edge.
    await start(rig, second, { database: flaky }).catch(() => undefined);
    expect(getSalesGateState().blocked).toBe(true);
    expect((await gateRow(rig.scope.edgeNodeId))?.tracking_started_at).toEqual(
      T0,
    );
  });
});

describe("legend-10nex a grant made while a sync close is in flight is not dropped", () => {
  it("tick closes the override it observed, not the one granted during the await", async () => {
    const rig = await newEdge();
    const clock = clocks(T0);
    const old: CatalogGateOverride = {
      id: randomUUID(),
      grantedBy: randomUUID(),
      grantedAt: T0,
      untilAt: new Date(T0.getTime() + 6 * HOUR),
      reason: "Lama",
    };
    const fresh: CatalogGateOverride = {
      id: randomUUID(),
      grantedBy: randomUUID(),
      // Not after the trusted now (T0): the gate ignores a grant dated in its future.
      grantedAt: T0,
      untilAt: new Date(T0.getTime() + 8 * HOUR),
      reason: "Baru",
    };
    let release: () => void = () => undefined;
    const closing = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => undefined;
    const closeStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const close = vi.fn(async () => {
      started();
      await closing;
    });
    const overrides: CatalogGateOverrides = {
      load: async () => old,
      close: close as unknown as CatalogGateOverrides["close"],
    };
    const gate = await start(rig, clock, { overrides, seed: T0 });
    // Everything is fresh, so the tick ends the episode of the old override.
    expect(getSalesGateState().override?.id).toBe(old.id);

    const ticking = gate.tick();
    await closeStarted;
    gate.applyOverrideChange(fresh); // the owner grants again meanwhile
    release();
    await ticking;

    expect(close).toHaveBeenCalledTimes(1);
    // The close was asked for the override that was observed.
    expect(JSON.stringify(close.mock.calls[0])).toContain(old.id);
    expect(getSalesGateState().override?.id).toBe(fresh.id);
  });
});

// F1 (architect): the gate provider re-checks a cached override against the
// trusted clock. A grant dated after the trusted now, or one that runs more
// than 24 hours past it, can only come from a skewed clock or a planted row.
describe("legend-10nex the gate ignores overrides that cannot be real", () => {
  const stale = async () => {
    const rig = await newEdge();
    const clock = clocks(T0);
    const stubbed = overrideStub();
    const gate = await start(rig, clock, { overrides: stubbed.stub, seed: T0 });
    clock.tick(DAY + HOUR); // over 24 hours without a sync
    expect(getSalesGateState().blocked).toBe(true);
    return { gate, clock, stubbed };
  };
  const make = (grantedAt: Date, untilAt: Date): CatalogGateOverride => ({
    id: randomUUID(),
    grantedBy: randomUUID(),
    grantedAt,
    untilAt,
    reason: "Uji",
  });

  it("an override granted in the future of the trusted now does not unblock sales", async () => {
    const { gate, clock } = await stale();
    const now = clock.wall().getTime();
    gate.applyOverrideChange(
      make(new Date(now + 2 * HOUR), new Date(now + 6 * HOUR)),
    );
    expect(getSalesGateState()).toMatchObject({
      blocked: true,
      override: null,
    });
  });

  it("an override that ends more than 24 hours after the trusted now does not unblock sales", async () => {
    const { gate, clock } = await stale();
    const now = clock.wall().getTime();
    gate.applyOverrideChange(
      make(new Date(now - HOUR), new Date(now + 25 * HOUR)),
    );
    expect(getSalesGateState()).toMatchObject({
      blocked: true,
      override: null,
    });
  });

  it("control: a valid override unblocks", async () => {
    const { gate, clock } = await stale();
    const now = clock.wall().getTime();
    gate.applyOverrideChange(
      make(new Date(now - MIN), new Date(now + 4 * HOUR)),
    );
    expect(getSalesGateState().blocked).toBe(false);
  });

  it("the same checks apply to an override loaded at boot", async () => {
    const rig = await newEdge();
    const clock = clocks(new Date(T0.getTime() + DAY + HOUR));
    const now = clock.wall().getTime();
    const planted = overrideStub(
      make(new Date(now + HOUR), new Date(now + 5 * HOUR)),
    );
    await start(rig, clock, { overrides: planted.stub, seed: T0 });
    expect(getSalesGateState().blocked).toBe(true);
  });
});

// F3 (architect): a clock set back across a restart holds sales with reason
// CLOCK_REGRESSED (not the 24-hour reason), unless a valid override exists.
describe("legend-10nex a regressed device clock holds sales", () => {
  const storeHighWater = async (rig: Rig, at: Date) =>
    saveCatalogGateState(rig.context, rig.scope, {
      trackingStartedAt: T0,
      clockHighWaterAt: at,
    });

  it("blocks with CLOCK_REGRESSED, and clears once the wall clock is correct again", async () => {
    const rig = await newEdge();
    await storeHighWater(rig, new Date(T0.getTime() + DAY));
    const clock = clocks(T0); // the device date is one day behind what was stored
    // Everything was synced "just now" in trusted time.
    await start(rig, clock, { seed: new Date(T0.getTime() + DAY) });
    expect(getSalesGateState()).toMatchObject({
      blocked: true,
      reason: "CLOCK_REGRESSED",
    });

    clock.setWall(new Date(T0.getTime() + DAY + HOUR)); // date corrected
    const state = getSalesGateState();
    expect(state.blocked).toBe(false);
    expect(state.reason).toBeNull();
  });

  it("a valid owner override lets sales through while the clock is regressed", async () => {
    const rig = await newEdge();
    await storeHighWater(rig, new Date(T0.getTime() + DAY));
    const clock = clocks(T0);
    const trustedNow = T0.getTime() + DAY;
    const stubbed = overrideStub({
      id: randomUUID(),
      grantedBy: randomUUID(),
      grantedAt: new Date(trustedNow - MIN),
      untilAt: new Date(trustedNow + 4 * HOUR),
      reason: "Jam perangkat salah",
    });
    await start(rig, clock, {
      overrides: stubbed.stub,
      seed: new Date(trustedNow),
    });
    const state = getSalesGateState();
    expect(state.blocked).toBe(false);
    expect(state.override).not.toBeNull();
  });

  it("tolerates a wall clock less than 5 minutes behind the stored high water", async () => {
    const rig = await newEdge();
    await storeHighWater(rig, new Date(T0.getTime() + 4 * MIN));
    await start(rig, clocks(T0), { seed: new Date(T0.getTime() + 4 * MIN) });
    expect(getSalesGateState()).toMatchObject({ blocked: false, reason: null });
  });

  // Founder Q2 (2026-11-12): A6 stays as is. A clock set back more than 5
  // minutes holds sales (CLOCK_REGRESSED) and tells the owner, with no
  // override. Locks the boundary just above the tolerance.
  it("holds sales with CLOCK_REGRESSED and raises an owner alarm when the clock is 6 minutes behind", async () => {
    const rig = await newEdge();
    const highWater = new Date(T0.getTime() + 6 * MIN);
    await storeHighWater(rig, highWater);
    const clock = clocks(T0);
    const alarms: string[] = [];
    const handle = await startCatalogGate({
      context: rig.context,
      scope: rig.scope,
      overrides: overrideStub().stub,
      onOwnerAlarm: (alarm) => {
        for (const entry of alarm.streams) alarms.push(entry.reason);
      },
      seed: async (freshness) => {
        for (const name of STREAMS) freshness.seedLastSuccess(name, highWater);
        freshness.snapshot();
      },
      persistMs: 24 * HOUR,
      wall: clock.wall,
      mono: clock.mono,
    });
    handles.push(handle);
    setSalesGateEdgeModeForTests(() => true);

    expect(getSalesGateState()).toMatchObject({
      blocked: true,
      reason: "CLOCK_REGRESSED",
      override: null,
    });
    expect(alarms.length).toBeGreaterThan(0);
    expect(alarms).toContain("CLOCK_ELAPSED_UNPROVEN");
  });
});

// 533c P1 (founder Q2, money: no sale while the device clock is wrong): the
// wall clock set back WHILE running holds sales with CLOCK_REGRESSED, tells the
// owner (CLOCK_ELAPSED_UNPROVEN alarm), calls onClockRegressed once per episode,
// still honours a valid owner override, and recovers when the clock is fixed.
// Assumption: the alarm reaches onOwnerAlarm after the next explicit tick().
describe("533c a wall clock set back while running holds sales", () => {
  async function startLive(
    rig: Rig,
    clock: ReturnType<typeof clocks>,
    overrides: CatalogGateOverrides = overrideStub().stub,
  ) {
    const alarms: string[] = [];
    const onClockRegressed = vi.fn();
    const handle = await startCatalogGate({
      context: rig.context,
      scope: rig.scope,
      overrides,
      onOwnerAlarm: (alarm) => {
        for (const entry of alarm.streams) alarms.push(entry.reason);
      },
      onClockRegressed,
      seed: async (freshness) => {
        for (const name of STREAMS) freshness.seedLastSuccess(name, T0);
      },
      persistMs: 24 * HOUR,
      wall: clock.wall,
      mono: clock.mono,
    });
    handles.push(handle);
    setSalesGateEdgeModeForTests(() => true);
    return { handle, alarms, onClockRegressed };
  }

  it("blocks with CLOCK_REGRESSED, alarms the owner, reports once, and recovers when the wall catches up", async () => {
    const rig = await newEdge();
    const clock = clocks(T0);
    const { handle, alarms, onClockRegressed } = await startLive(rig, clock);
    expect(getSalesGateState().blocked).toBe(false);
    expect(onClockRegressed).not.toHaveBeenCalled();

    clock.tick(1000);
    clock.setWall(new Date(T0.getTime() - HOUR)); // cashier sets the date back 1 h
    expect(getSalesGateState()).toMatchObject({
      blocked: true,
      reason: "CLOCK_REGRESSED",
      override: null,
    });
    await handle.tick();
    expect(alarms).toContain("CLOCK_ELAPSED_UNPROVEN");

    // Same episode: more reads and ticks do not report again.
    clock.tick(MIN);
    expect(getSalesGateState().reason).toBe("CLOCK_REGRESSED");
    await handle.tick();
    expect(onClockRegressed).toHaveBeenCalledTimes(1);

    // The device date is corrected: sales resume.
    clock.setWall(new Date(T0.getTime() + HOUR));
    const state = getSalesGateState();
    expect(state.blocked).toBe(false);
    expect(state.reason).toBeNull();
  });

  it("a valid owner override still lets sales through", async () => {
    const rig = await newEdge();
    const clock = clocks(T0);
    const stubbed = overrideStub({
      id: randomUUID(),
      grantedBy: randomUUID(),
      grantedAt: new Date(T0.getTime() - MIN),
      untilAt: new Date(T0.getTime() + 4 * HOUR),
      reason: "Jam perangkat salah",
    });
    await startLive(rig, clock, stubbed.stub);
    clock.tick(1000);
    clock.setWall(new Date(T0.getTime() - HOUR));
    const state = getSalesGateState();
    expect(state.blocked).toBe(false);
    expect(state.override).not.toBeNull();
  });

  it("does not hold sales for drift under 5 minutes or a forward jump", async () => {
    const rig = await newEdge();
    const clock = clocks(T0);
    const { handle, alarms, onClockRegressed } = await startLive(rig, clock);
    clock.tick(1000);
    clock.setWall(new Date(T0.getTime() + 1000 - 4 * MIN));
    await handle.tick();
    expect(getSalesGateState()).toMatchObject({ blocked: false, reason: null });
    clock.setWall(new Date(T0.getTime() + 2 * HOUR));
    await handle.tick();
    expect(getSalesGateState().reason).not.toBe("CLOCK_REGRESSED");
    expect(onClockRegressed).not.toHaveBeenCalled();
    expect(alarms).not.toContain("CLOCK_ELAPSED_UNPROVEN");
  });
});

// F4 (architect): a grant committed after the boot load but before the listener
// is registered must not be lost; the startup reload picks it up.
// Assumption: `refreshOverride()` is that reload (the runtime calls it after
// registering the listener); the call order inside runtime.ts itself needs the
// whole boot and is not unit tested here.
describe("legend-10nex a grant made during startup is visible after the reload", () => {
  it("shows an override committed after the boot load once refreshOverride runs", async () => {
    const rig = await newEdge();
    const clock = clocks(T0);
    const stubbed = overrideStub(null); // nothing at boot
    const gate = await start(rig, clock, { overrides: stubbed.stub, seed: T0 });
    clock.tick(DAY + HOUR);
    expect(getSalesGateState().blocked).toBe(true);

    const now = clock.wall().getTime();
    stubbed.set({
      id: randomUUID(),
      grantedBy: randomUUID(),
      grantedAt: new Date(now - MIN),
      untilAt: new Date(now + 4 * HOUR),
      reason: "Saat startup",
    }); // committed, the listener was not registered yet
    await gate.refreshOverride();
    expect(getSalesGateState()).toMatchObject({ blocked: false });
    expect(getSalesGateState().override?.reason).toBe("Saat startup");
  });
});

describe("521 override reloads cannot replace a newer committed decision", () => {
  const makeOverride = (reason: string): CatalogGateOverride => ({
    id: randomUUID(),
    grantedBy: randomUUID(),
    grantedAt: T0,
    untilAt: new Date(T0.getTime() + 4 * HOUR),
    reason,
  });

  it("an older reload returning null cannot remove a grant committed during its await", async () => {
    const rig = await newEdge();
    const clock = clocks(T0);
    let release: (value: CatalogGateOverride | null) => void = () => undefined;
    let boot = true;
    const overrides: CatalogGateOverrides = {
      load: async () => {
        if (boot) {
          boot = false;
          return null;
        }
        return new Promise<CatalogGateOverride | null>((resolve) => {
          release = resolve;
        });
      },
      close: async () => undefined,
    };
    const gate = await start(rig, clock, { overrides, seed: T0 });
    const reload = gate.refreshOverride();
    const granted = makeOverride("Grant terbaru");
    await gate.applyOverrideChange(granted);
    release(null);
    await reload;
    expect(getSalesGateState().override?.id).toBe(granted.id);
  });

  it("an older reload returning an override cannot restore a subsequently closed override", async () => {
    const rig = await newEdge();
    const clock = clocks(T0);
    const old = makeOverride("Lama");
    let release: (value: CatalogGateOverride | null) => void = () => undefined;
    let boot = true;
    const overrides: CatalogGateOverrides = {
      load: async () => {
        if (boot) {
          boot = false;
          return old;
        }
        return new Promise<CatalogGateOverride | null>((resolve) => {
          release = resolve;
        });
      },
      close: async () => undefined,
    };
    const gate = await start(rig, clock, { overrides, seed: T0 });
    const reload = gate.refreshOverride();
    await gate.applyOverrideChange(null);
    release(old);
    await reload;
    expect(getSalesGateState().override).toBeNull();
  });

  it("two reloads resolved out of order keep the most recently started reload", async () => {
    const rig = await newEdge();
    const clock = clocks(T0);
    const releases: ((value: CatalogGateOverride | null) => void)[] = [];
    let boot = true;
    const overrides: CatalogGateOverrides = {
      load: async () => {
        if (boot) {
          boot = false;
          return null;
        }
        return new Promise<CatalogGateOverride | null>((resolve) => {
          releases.push(resolve);
        });
      },
      close: async () => undefined,
    };
    const gate = await start(rig, clock, { overrides, seed: T0 });
    const older = gate.refreshOverride();
    const newer = gate.refreshOverride();
    const granted = makeOverride("Reload terbaru");
    releases[1]!(granted);
    await newer;
    releases[0]!(null);
    await older;
    expect(getSalesGateState().override?.id).toBe(granted.id);
  });
});

describe("521 a healthy catalog does not close an override while the clock is regressed", () => {
  it("keeps the episode until both the critical streams and device clock have recovered", async () => {
    const rig = await newEdge();
    const high = new Date(T0.getTime() + DAY);
    await saveCatalogGateState(rig.context, rig.scope, {
      trackingStartedAt: T0,
      clockHighWaterAt: high,
    });
    const clock = clocks(T0);
    const granted: CatalogGateOverride = {
      id: randomUUID(),
      grantedBy: randomUUID(),
      grantedAt: high,
      untilAt: new Date(high.getTime() + 4 * HOUR),
      reason: "Jam perangkat salah",
    };
    const stubbed = overrideStub(granted);
    const gate = await start(rig, clock, {
      overrides: stubbed.stub,
      seed: high,
    });
    // Live success proves the catalog recovered despite the regressed clock;
    // seeded checkpoints alone cannot prove the powered-off interval.
    for (const stream of STREAMS) gate.freshness.recordSuccess(stream);
    expect(gate.clock.regressed()).toBe(true);
    expect(getSalesGateState().blocked).toBe(false);
    await gate.tick();
    expect(stubbed.close).not.toHaveBeenCalled();
    expect(getSalesGateState().override?.id).toBe(granted.id);

    clock.setWall(high);
    expect(gate.clock.regressed()).toBe(false);
    await gate.tick();
    expect(stubbed.close).toHaveBeenCalledTimes(1);
    expect(stubbed.close.mock.calls[0]![1]).toBe("SYNC_OK");
    expect(getSalesGateState().override).toBeNull();
    expect(getSalesGateState().blocked).toBe(false);
  });
});

describe("521 an override episode closes only after the catalog recovers", () => {
  const makeOverride = (): CatalogGateOverride => ({
    id: randomUUID(),
    grantedBy: randomUUID(),
    grantedAt: T0,
    untilAt: new Date(T0.getTime() + 4 * HOUR),
    reason: "Pemulihan katalog",
  });

  it("does not close on a reachable catalog failure younger than 24 hours", async () => {
    const rig = await newEdge();
    const clock = clocks(T0);
    const granted = makeOverride();
    const stubbed = overrideStub(granted);
    const gate = await start(rig, clock, { overrides: stubbed.stub, seed: T0 });
    gate.freshness.recordFailure(STREAMS[0]!, {
      reason: "HTTP_500",
      cloudReachable: true,
    });
    expect(gate.freshness.snapshot()).toMatchObject({
      stale: true,
      salesGate: { stale24h: false },
    });
    await gate.tick();
    expect(stubbed.close).not.toHaveBeenCalled();
    expect(getSalesGateState().override?.id).toBe(granted.id);
    gate.freshness.recordSuccess(STREAMS[0]!);
    await gate.tick();
    expect(stubbed.close).toHaveBeenCalledTimes(1);
  });

  it("does not close on seeded checkpoints with unproven offline age", async () => {
    const rig = await newEdge();
    await saveCatalogGateState(rig.context, rig.scope, {
      trackingStartedAt: T0,
      clockHighWaterAt: T0,
    });
    const granted = makeOverride();
    const stubbed = overrideStub(granted);
    const gate = await start(rig, clocks(T0), {
      overrides: stubbed.stub,
      seed: T0,
    });
    expect(gate.clock.elapsedTimeUnproven()).toBe(true);
    expect(gate.freshness.snapshot()).toMatchObject({
      stale: true,
      salesGate: { stale24h: false },
    });
    await gate.tick();
    expect(stubbed.close).not.toHaveBeenCalled();
    expect(getSalesGateState().override?.id).toBe(granted.id);
    for (const stream of STREAMS) gate.freshness.recordSuccess(stream);
    await gate.tick();
    expect(stubbed.close).toHaveBeenCalledTimes(1);
    expect(getSalesGateState().override).toBeNull();
  });
});

describe("521 a reload of the same override during its committed close cannot resurrect it", () => {
  it("drops the closed cached override even when a concurrent reload observed the same id", async () => {
    const rig = await newEdge();
    const clock = clocks(T0);
    const granted: CatalogGateOverride = {
      id: randomUUID(),
      grantedBy: randomUUID(),
      grantedAt: T0,
      untilAt: new Date(T0.getTime() + 4 * HOUR),
      reason: "Katalog pulih",
    };
    let begin: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      begin = resolve;
    });
    let release: () => void = () => undefined;
    const closing = new Promise<void>((resolve) => {
      release = resolve;
    });
    const overrides: CatalogGateOverrides = {
      load: async () => granted,
      close: async () => {
        begin();
        await closing;
      },
    };
    const gate = await start(rig, clock, { overrides, seed: T0 });
    const ticking = gate.tick();
    await started;
    // This SELECT sees the pre-commit row; closing still owns the same id.
    await gate.refreshOverride();
    expect(getSalesGateState().override?.id).toBe(granted.id);
    release();
    await ticking;
    expect(getSalesGateState().override).toBeNull();
  });
});

// 533b: the runtime stamps the owner alarm queue with the trusted clock, but
// that clock only exists inside startCatalogGate. The boot alarm
// (CLOCK_ELAPSED_UNPROVEN) fires while the gate is still being built, so the
// gate must hand the clock out through `onClock` before any freshness or alarm
// callback (seed, onOwnerAlarm) can run. Otherwise a dead RTC (1970) stamps the
// queued alarm with a raw wall time and it ages out.
// Assumption: the function in the brief ("createCatalogGate") is
// `startCatalogGate` in this codebase; the new option is
// `onClock?: (clock: TrustedClock) => void`.
describe("533b the boot owner alarm sees the trusted clock", () => {
  it("passes the clock via onClock before seed and the first alarm, already pinned to the high water", async () => {
    const rig = await newEdge();
    const first = clocks(T0);
    const gate = await start(rig, first);
    first.tick(30 * DAY);
    await gate.tick(); // persists the high water about T0 + 30 days
    await gate.stop();
    const highWater = (await gateRow(rig.scope.edgeNodeId))!
      .clock_high_water_at;
    expect(highWater.getTime()).toBeGreaterThanOrEqual(T0.getTime() + 30 * DAY);

    // Reboot with a dead RTC: the wall clock reads 1970.
    const deadRtc = clocks(new Date(0));
    const events: string[] = [];
    let passed = null as TrustedClock | null;
    let nowWhenPassed: number | null = null;
    let alarmStampedAt: number | null = null;
    const alarms: string[] = [];

    const booted = await startCatalogGate({
      context: rig.context,
      scope: rig.scope,
      overrides: overrideStub().stub,
      onClock: (clock) => {
        events.push("onClock");
        passed = clock;
        nowWhenPassed = clock.now().getTime();
      },
      onOwnerAlarm: (alarm) => {
        events.push("alarm");
        // What the runtime does: stamp the queue entry with the clock it got.
        alarmStampedAt = passed ? passed.now().getTime() : null;
        for (const entry of alarm.streams) alarms.push(entry.reason);
      },
      seed: async (freshness) => {
        events.push("seed");
        for (const name of STREAMS) freshness.seedLastSuccess(name, T0);
        freshness.snapshot(); // observes the unproven time: the boot alarm
      },
      persistMs: 24 * HOUR,
      wall: deadRtc.wall,
      mono: deadRtc.mono,
    });
    handles.push(booted);
    setSalesGateEdgeModeForTests(() => true);
    booted.freshness.snapshot(); // make sure the alarm path ran

    // The clock is handed out first, before seed and before any alarm.
    expect(events[0]).toBe("onClock");
    expect(events.filter((event) => event === "onClock")).toHaveLength(1);
    expect(events.indexOf("onClock")).toBeLessThan(events.indexOf("seed"));
    expect(events).toContain("alarm");
    expect(events.indexOf("onClock")).toBeLessThan(events.indexOf("alarm"));
    expect(alarms).toContain("CLOCK_ELAPSED_UNPROVEN");

    // It is the gate's own clock, already pinned to the high water (not 1970).
    expect(passed).toBe(booted.clock);
    expect(nowWhenPassed).toBe(highWater.getTime());
    expect(alarmStampedAt).toBe(highWater.getTime());
    expect(deadRtc.wall().getTime()).toBe(0);
  });
});
