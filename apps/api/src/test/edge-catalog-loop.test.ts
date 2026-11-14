// Catalog pull wired into the edge master-sync loop (bead legend-24318;
// design docs/briefs/24318-design.md "Wiring (24318)"). Written from the design
// and from how the existing loop tests (edge-master-sync.test.ts) drive the
// loop, not from the implementation.
//
// The cloud is a mocked `fetch` (the loop talks to the cloud over HTTP);
// timers are faked so the 60 s interval elapses at once. Database I/O stays real.
//
// Assumptions (the design is silent), each easy to change:
//  - `startEdgeMasterSyncLoop({ config, intervalMs, onError })`: every error of
//    a tick is handed to `onError(error)`; the design says "tiap error masuk
//    onError". The option is passed through a cast, so a different name only
//    fails the assertions about errors, not the build.
//  - A tick first syncs the masters, then pulls the catalog; neither failure
//    cancels the other. The catalog is requested per stream, in the order of
//    CATALOG_SYNC_STREAMS (stations first).
//  - Catalog requests are `GET <cloud>/api/edge-sync/catalog?stream=...` with
//    the node credential as bearer token.
//  - Whether a tick also runs once right after boot is NOT asserted (the design
//    leaves it open); the tests count calls only after advancing the interval.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { outletIdSchema, type ScopedTenantContext } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  CATALOG_PROTOCOL_VERSION,
  CATALOG_SYNC_STREAMS,
} from "@starter/shared/edge";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { parseEdgeRuntimeConfig } from "../edge/config.ts";
import {
  EdgeCatalogSyncError,
  startEdgeMasterSyncLoop,
} from "../edge/master-sync.ts";
import {
  CRITICAL_CATALOG_STREAMS,
  createCatalogFreshness,
} from "../edge/catalog-freshness.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { registerEdgeNode } from "../services/edge-node.service.ts";
import { cloneMainOutlet } from "./helpers/edge-database.ts";

const CLOUD_LINK_URL = "wss://cloud.loop.test/api/edge-link";
const MASTERS_PATH = "/api/edge-sync/bootstrap/masters";
const CATALOG_PATH = "/api/edge-sync/catalog";
const INTERVAL = 60_000;

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const actor = randomUUID();
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

let outletId = "";
let credential = "";
let edgeNodeId = "";

const scope = (): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
  );

function loopConfig() {
  const parsed = parseEdgeRuntimeConfig({
    EDGE_MODE: "true",
    EDGE_CLOUD_URL: CLOUD_LINK_URL,
    EDGE_NODE_CREDENTIAL: credential,
    EDGE_NODE_ROLE: "primary",
  });
  if (!parsed.ok) throw new Error(parsed.problems.join(", "));
  return parsed.config;
}

type FetchMock = MockInstance<typeof fetch>;
type Answer = (url: URL) => Promise<Response> | Response;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const urlOf = (input: unknown) =>
  new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : (input as Request).url,
  );
const emptyPage = (stream: string) => ({
  protocolVersion: CATALOG_PROTOCOL_VERSION,
  stream,
  records: [],
  nextCursor: null,
  hasMore: false,
});

/** A cloud that answers the masters and catalog endpoints; anything else fails. */
function spyCloud(answers: { masters: Answer; catalog: Answer }): FetchMock {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input: unknown) => {
      const url = urlOf(input);
      if (url.pathname.endsWith(MASTERS_PATH)) return answers.masters(url);
      if (url.pathname.endsWith(CATALOG_PATH)) return answers.catalog(url);
      throw new Error(`unexpected fetch ${url.pathname}`);
    });
}
const callsTo = (spy: FetchMock, path: string) =>
  spy.mock.calls.filter(([input]) => urlOf(input).pathname.endsWith(path));
const catalogStreams = (spy: FetchMock) =>
  callsTo(spy, CATALOG_PATH).map(([input]) =>
    urlOf(input).searchParams.get("stream"),
  );
/** Number of catalog rounds started: calls to the first pull stream. */
const catalogRounds = (spy: FetchMock) =>
  catalogStreams(spy).filter((s) => s === CATALOG_SYNC_STREAMS[0]).length;
/** Waits for the first full catalog round (a boot tick, if any, may add more). */
const reported = () =>
  onError.mock.calls
    .map(([e]) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)))
    .join(" | ");
/** Loaded full-suite runs starve the 1 s vi.waitFor default. */
const WAIT = { timeout: 10_000 } as const;
const firstRound = async (spy: FetchMock) => {
  await vi.waitFor(
    () =>
      expect(
        catalogStreams(spy).length,
        `onError saw: ${reported()}`,
      ).toBeGreaterThanOrEqual(CATALOG_SYNC_STREAMS.length),
    WAIT,
  );
  return catalogStreams(spy).slice(0, CATALOG_SYNC_STREAMS.length);
};

const headerOf = (init: RequestInit | undefined, name: string) => {
  const headers = init?.headers;
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  if (Array.isArray(headers))
    return headers.find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
  return (
    Object.entries(headers as Record<string, string>).find(
      ([k]) => k.toLowerCase() === name.toLowerCase(),
    )?.[1] ?? null
  );
};

const mastersFail = () => json({ error: { code: "INTERNAL" } }, 500);
const catalogEmpty: Answer = (url) =>
  json(emptyPage(url.searchParams.get("stream") ?? ""));

type Loop = { stop: () => Promise<void> | void };
let loop: Loop | null = null;
const onError = vi.fn();
const startLoop = (): Loop => {
  loop = startEdgeMasterSyncLoop({
    config: loopConfig(),
    intervalMs: INTERVAL,
    onError,
  } as unknown as Parameters<typeof startEdgeMasterSyncLoop>[0]) as Loop;
  return loop;
};
const tick = () => vi.advanceTimersByTimeAsync(INTERVAL);

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  outletId = await cloneMainOutlet(
    owner,
    cafeLegendAccessFixtures.outletIds.bandung,
    "Outlet uji loop katalog",
  );
  const registered = await registerEdgeNode(scope(), actor, {
    outletId,
    role: "primary",
    label: "Mini PC uji loop katalog",
  });
  credential = registered.credential;
  edgeNodeId = registered.edgeNode.id;
}, 120_000);

beforeEach(() => {
  onError.mockReset();
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
});

afterEach(async () => {
  await loop?.stop();
  loop = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(async () => {
  setAuditWriter(null);
  try {
    await owner.query(
      "DELETE FROM edge_pull_checkpoints WHERE outlet_id = $1",
      [outletId],
    );
    await owner.query("DELETE FROM edge_nodes WHERE id = $1", [edgeNodeId]);
    await owner.query("DELETE FROM outlets WHERE id = $1", [outletId]);
  } catch {
    // Best effort: private outlet.
  }
  await owner.end();
});

describe("24318 the master-sync loop pulls the catalog", () => {
  it("521 persists the trusted sync time so a wall rollback cannot make a successful catalog stale again after restart", async () => {
    // The high water was accepted with the wall two days ahead; the wall
    // has since returned to its current value while trusted time stays ahead.
    const trustedAt = new Date(new Date().getTime() + 48 * 60 * 60_000);
    const freshness = createCatalogFreshness({
      clock: { now: () => trustedAt },
    });
    const spy = spyCloud({ masters: mastersFail, catalog: catalogEmpty });
    const config = loopConfig();
    if (!config.edgeMode) throw new Error("Expected an edge runtime config");
    loop = startEdgeMasterSyncLoop({
      config,
      intervalMs: INTERVAL,
      onError,
      catalog: { freshness },
      catalogOnStart: true,
    });
    await firstRound(spy);
    await vi.waitFor(() => {
      for (const stream of CRITICAL_CATALOG_STREAMS)
        expect(
          freshness.snapshot().streams[stream]?.lastSuccessAt,
        ).not.toBeNull();
    }, WAIT);
    await loop.stop();
    loop = null;

    const stored = await owner.query<{ stream: string; last_success_at: Date }>(
      "SELECT stream, last_success_at FROM edge_pull_checkpoints WHERE edge_node_id = $1",
      [edgeNodeId],
    );
    for (const stream of CRITICAL_CATALOG_STREAMS) {
      const checkpoint = stored.rows.find(
        (row) => row.stream === `catalog:${stream}`,
      );
      expect(checkpoint?.last_success_at).toEqual(trustedAt);
      expect(freshness.snapshot().streams[stream]?.lastSuccessAt).toEqual(
        trustedAt,
      );
    }
  });

  it("every tick syncs the masters first and then asks the cloud for every catalog stream in pull order, authenticated with the node credential", async () => {
    const spy = spyCloud({
      masters: () => {
        throw new TypeError("fetch failed");
      },
      catalog: catalogEmpty,
    });
    startLoop();
    await tick();
    expect(await firstRound(spy)).toEqual([...CATALOG_SYNC_STREAMS]);
    // Stations first, printers second, inventory items third (the order of
    // CATALOG_SYNC_STREAMS).
    expect(catalogStreams(spy).slice(0, 3)).toEqual([
      "stations",
      "printers",
      "inventory_items",
    ]);
    // Masters before catalog: the uoms must arrive before inventory items.
    const order = spy.mock.calls.map(([input]) => urlOf(input).pathname);
    expect(order.findIndex((p) => p.endsWith(MASTERS_PATH))).toBeLessThan(
      order.findIndex((p) => p.endsWith(CATALOG_PATH)),
    );
    for (const [input, init] of callsTo(spy, CATALOG_PATH).slice(
      0,
      CATALOG_SYNC_STREAMS.length,
    )) {
      expect(urlOf(input).searchParams.get("since")).toBeNull();
      expect((init?.method ?? "GET").toUpperCase()).toBe("GET");
      expect(headerOf(init, "authorization")).toBe(`Bearer ${credential}`);
    }
  });

  it("a failing masters call does not stop the catalog pull, and the error is reported", async () => {
    const spy = spyCloud({ masters: mastersFail, catalog: catalogEmpty });
    startLoop();
    await tick();
    expect(await firstRound(spy)).toEqual([...CATALOG_SYNC_STREAMS]);
    expect(callsTo(spy, MASTERS_PATH).length).toBeGreaterThanOrEqual(1);
    await vi.waitFor(() => expect(onError).toHaveBeenCalled(), WAIT);
  });

  it("a failing catalog call does not stop the masters sync, is reported, and the loop keeps ticking", async () => {
    const spy = spyCloud({
      masters: mastersFail,
      catalog: () => json({ error: { code: "INTERNAL" } }, 500),
    });
    startLoop();
    await tick();
    await vi.waitFor(() => {
      expect(callsTo(spy, MASTERS_PATH).length).toBeGreaterThanOrEqual(1);
      expect(callsTo(spy, CATALOG_PATH).length).toBeGreaterThanOrEqual(1);
      expect(onError).toHaveBeenCalled();
    }, WAIT);
    // HTTP calls start before the pull finishes. Wait for its complete error
    // round so the next interval is not skipped while this run is in flight.
    await vi.waitFor(
      () =>
        expect(
          onError.mock.calls.flatMap(([error]) =>
            error instanceof EdgeCatalogSyncError ? [error.stream] : [],
          ),
        ).toEqual([...CATALOG_SYNC_STREAMS]),
      WAIT,
    );
    const mastersBefore = callsTo(spy, MASTERS_PATH).length;
    const catalogBefore = callsTo(spy, CATALOG_PATH).length;
    // The loop skips an interval while a round is still in flight, so a single
    // tick can be lost under load. Re-tick inside the retry until it lands.
    await vi.waitFor(async () => {
      await tick();
      expect(callsTo(spy, MASTERS_PATH).length).toBeGreaterThan(mastersBefore);
      expect(callsTo(spy, CATALOG_PATH).length).toBeGreaterThan(catalogBefore);
    }, WAIT);
  });

  it("a thrown network error on the catalog is reported through onError and never crashes the loop", async () => {
    const spy = spyCloud({
      masters: mastersFail,
      catalog: () => {
        throw new TypeError("fetch failed");
      },
    });
    startLoop();
    await tick();
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalled();
      expect(callsTo(spy, CATALOG_PATH).length).toBeGreaterThanOrEqual(1);
    }, WAIT);
    // Catalog calls start before the pull finishes. Wait for its complete
    // error round (every stream reported) so the next interval is not skipped
    // while this run is still in flight.
    await vi.waitFor(
      () =>
        expect(
          onError.mock.calls.flatMap(([error]) =>
            error instanceof EdgeCatalogSyncError ? [error.stream] : [],
          ),
        ).toEqual([...CATALOG_SYNC_STREAMS]),
      WAIT,
    );
    // Count ROUNDS (calls to the first stream), not total calls: leftover calls
    // of round 1 must not make this pass. A tick is skipped while a round is in
    // flight, so re-tick inside the retry until round 2 starts.
    await vi.waitFor(async () => {
      await tick();
      expect(catalogRounds(spy)).toBeGreaterThanOrEqual(2);
    }, WAIT);
  }, 30_000);

  it("after stop() no further masters or catalog request is made", async () => {
    const spy = spyCloud({ masters: mastersFail, catalog: catalogEmpty });
    const running = startLoop();
    await tick();
    await firstRound(spy);
    await running.stop();
    loop = null;
    const total = spy.mock.calls.length;
    await tick();
    await tick();
    expect(spy.mock.calls.length).toBe(total);
  });
});

// legend-dciax: a new edge against an older cloud that does not send
// `syncTxid` must refuse cleanly (clear message through onError), not fail on a
// parse. master-sync forwards only the error code (CATALOG_CLOUD_OUTDATED); the stream's
// checkpoint is not stored; the loop keeps ticking.
describe("dciax the loop refuses a cloud that does not send syncTxid", () => {
  const stationWithoutTxid = () => ({
    id: randomUUID(),
    tenantId,
    outletId,
    name: "Bar tanpa txid",
    type: "coffee_bar",
    printerDeviceId: null,
    targetSeconds: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
  });
  const oldCloud: Answer = (url) => {
    const stream = url.searchParams.get("stream") ?? "";
    return stream === "stations"
      ? json({
          protocolVersion: CATALOG_PROTOCOL_VERSION,
          stream,
          records: [stationWithoutTxid()],
          nextCursor: null,
          hasMore: false,
        })
      : json(emptyPage(stream));
  };

  it("reports the CATALOG_CLOUD_OUTDATED code (not a ZodError), stores no checkpoint, and keeps ticking", async () => {
    // Earlier tests of this file pulled empty pages for the same edge node and
    // so left a stations checkpoint row behind: start from none.
    await owner.query(
      "DELETE FROM edge_pull_checkpoints WHERE edge_node_id = $1 AND stream = 'catalog:stations'",
      [edgeNodeId],
    );
    const spy = spyCloud({ masters: mastersFail, catalog: oldCloud });
    startLoop();
    await tick();
    // master-sync forwards only the error CODE to onError, not the message.
    await vi.waitFor(
      () =>
        expect(
          onError.mock.calls.some(([e]) =>
            /CATALOG_CLOUD_OUTDATED/.test(
              e instanceof Error ? e.message : String(e),
            ),
          ),
          `onError saw: ${reported()}`,
        ).toBe(true),
      WAIT,
    );
    const texts = onError.mock.calls
      .map(([e]) =>
        e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      )
      .filter((t) => /CATALOG_CLOUD_OUTDATED/.test(t));
    for (const text of texts)
      expect(text).not.toMatch(/ZodError|invalid_type|Invalid input/);
    const stored = await owner.query(
      "SELECT 1 FROM edge_pull_checkpoints WHERE edge_node_id = $1 AND stream = 'catalog:stations'",
      [edgeNodeId],
    );
    expect(stored.rowCount).toBe(0);

    // Count ROUNDS (calls to the first stream), not total calls, and re-tick
    // inside the retry: an interval that fires while round 1 is still in
    // flight is skipped by the loop.
    await vi.waitFor(async () => {
      await tick();
      expect(catalogRounds(spy)).toBeGreaterThanOrEqual(2);
    }, WAIT);
  });
});
