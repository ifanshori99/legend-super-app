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
import { CATALOG_SYNC_STREAMS } from "@starter/shared/edge";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { parseEdgeRuntimeConfig } from "../edge/config.ts";
import { startEdgeMasterSyncLoop } from "../edge/master-sync.ts";
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
/** Waits for the first full catalog round (a boot tick, if any, may add more). */
const reported = () =>
  onError.mock.calls
    .map(([e]) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)))
    .join(" | ");
const firstRound = async (spy: FetchMock) => {
  await vi.waitFor(() =>
    expect(
      catalogStreams(spy).length,
      `onError saw: ${reported()}`,
    ).toBeGreaterThanOrEqual(CATALOG_SYNC_STREAMS.length),
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
    // Stations first, inventory items second (the design's order).
    expect(catalogStreams(spy).slice(0, 2)).toEqual([
      "stations",
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
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
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
    });
    const mastersBefore = callsTo(spy, MASTERS_PATH).length;
    const catalogBefore = callsTo(spy, CATALOG_PATH).length;
    await tick();
    await vi.waitFor(() => {
      expect(callsTo(spy, MASTERS_PATH).length).toBeGreaterThan(mastersBefore);
      expect(callsTo(spy, CATALOG_PATH).length).toBeGreaterThan(catalogBefore);
    });
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
    });
    const before = callsTo(spy, CATALOG_PATH).length;
    await tick();
    await vi.waitFor(() =>
      expect(callsTo(spy, CATALOG_PATH).length).toBeGreaterThan(before),
    );
  });

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
