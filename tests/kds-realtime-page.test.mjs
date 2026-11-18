// KDS board realtime wiring (bead legend-t0m89, item 1 and 2). Static render of
// KdsPage through the 844 component harness: the realtime hook, the hooks
// module and react-query are stubs, so this proves what a cashier sees in the
// connection chip and how socket events reach the board query. i18n is the
// harness stub (`key {}`), so texts are asserted by catalog key; the catalog
// strings themselves are pinned in the last test.
// Assumption: the 2s board polling stays (queries.ts); not covered here
// because queries.ts cannot load without the API client in this harness.
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { componentHarness } from "./844-component-harness.mjs";

const harness = componentHarness((specifier, parent) => {
  if (specifier === "@/components/shells/operations-screen")
    return "export const useOperationsScreen = () => {};";
  if (!parent?.includes("ws04-kds")) return undefined;
  if (specifier === "@tanstack/react-router")
    return 'export const useRouteContext = () => ({access: {stations: ["kitchen"]}});';
  if (specifier === "@tanstack/react-query")
    return `export const useQueryClient = () => ({
      invalidateQueries: (filter) => { globalThis.__kdsInvalidated.push(filter.queryKey); return Promise.resolve(); },
    });`;
  if (specifier === "../hooks.ts")
    return `export const useStations = () => ({data: [{stationId: "kitchen", isActive: true, displayOrder: 0}]});
      export const useStationLabels = () => ({data: [{stationId: "kitchen", name: "Dapur panas"}]});
      export const useStationSummary = () => ({data: {stations: [{stationId: "kitchen", openTickets: 0}]}});
      export const useBoard = () => ({isPending: false, isError: false, data: {generatedAt: "2026-11-17T01:00:00Z", allDay: {rows: []}, tickets: []}});
      export const useKdsActions = () => ({isPending: false, isError: false, mutate() {}});
      export const useKdsHeartbeat = () => {};
      export const useScannerStatus = () => ({data: {status: "unknown"}});`;
  // Same key shapes as queries.ts (kdsKeys.board / kdsKeys.stationSummary).
  if (specifier === "../queries.ts")
    return `export const kdsKeys = {
      board: (outletId, stationId) => ["kds", outletId, "board", stationId],
      stationSummary: (outletId) => ["kds", outletId, "station-summary"],
    };`;
  if (specifier === "../api.ts")
    return "export const fetchStationSnapshot = async () => ({sequence: globalThis.__844Data.snapshotSequence});";
  if (specifier === "../use-kds-realtime.ts")
    return `export const useKdsRealtime = (options) => {
      globalThis.__kdsRealtime.options = options;
      return {
        status: globalThis.__844Data.status,
        resume: (after) => globalThis.__kdsRealtime.resumed.push(after),
        reconnect: () => { globalThis.__kdsRealtime.reconnects += 1; },
      };
    };`;
  if (specifier === "./scanner-panel.tsx")
    return "export const ScannerPanel = () => null;";
  return undefined;
});
after(() => {
  harness.close();
  delete globalThis.__kdsInvalidated;
  delete globalThis.__kdsRealtime;
});
const { KdsPage } =
  await import("../apps/web/src/features/ws04-kds/components/kds-page.tsx");

function render(status, extra = {}) {
  globalThis.__kdsInvalidated = [];
  globalThis.__kdsRealtime = { options: null, resumed: [], reconnects: 0 };
  return harness.render(KdsPage, {}, { status, ...extra });
}

describe("connection chip", () => {
  test("open: shows Tersambung as a polite status, without a reconnect button", () => {
    const html = render("open");
    assert.match(html, /role="status"/);
    assert.match(html, /aria-live="polite"/);
    assert.match(html, /kds\.realtime\.open/);
    assert.doesNotMatch(html, /kds\.realtime\.reconnect/);
    assert.doesNotMatch(html, /kds\.realtime\.denied/);
  });

  for (const status of ["connecting", "reconnecting"]) {
    test(`${status}: shows the reconnecting text, no reconnect button`, () => {
      const html = render(status);
      assert.match(html, /role="status"/);
      assert.match(html, /kds\.realtime\.connecting/);
      assert.doesNotMatch(html, /kds\.realtime\.reconnect/);
      assert.doesNotMatch(html, /kds\.realtime\.open/);
    });
  }

  test("denied: explains the cashier session ended and offers a reconnect button", () => {
    const html = render("denied");
    assert.match(html, /role="status"/);
    assert.match(html, /kds\.realtime\.denied/);
    assert.match(html, /kds\.realtime\.reconnect/);
    assert.doesNotMatch(html, /kds\.realtime\.open/);
  });

  test("denied: the button calls the hook's reconnect", () => {
    render("denied");
    const events = globalThis.__844Events;
    assert.ok(events.length > 0, "a button is rendered");
    assert.equal(globalThis.__kdsRealtime.reconnects, 0);
    // The chip is the first thing in the board, so its button is the first one.
    events[0].onClick();
    assert.equal(globalThis.__kdsRealtime.reconnects, 1);
  });

  test("stopped (also mock mode, which opens no socket): empty live region, no chip", () => {
    const html = render("stopped");
    assert.match(html, /data-slot="kds-realtime-status"[^>]*><\/div>/);
    assert.doesNotMatch(html, /kds\.realtime\./);
  });

  test("the board still renders next to the chip (polling fallback untouched)", () => {
    const html = render("denied");
    assert.match(html, /kds\.queue/);
    assert.match(html, /kds\.tickets/);
  });
});

describe("realtime to board wiring", () => {
  test("opens the feed of the selected outlet and station", () => {
    render("open");
    const { options } = globalThis.__kdsRealtime;
    assert.equal(options.outletId, "outlet");
    assert.equal(options.stationId, "kitchen");
    assert.ok(options.after === null || Number.isInteger(options.after));
  });

  test("a ticket frame invalidates the station's board query", () => {
    render("open");
    globalThis.__kdsRealtime.options.onTicket({ sequence: 6, ticket: {} });
    assert.deepEqual(
      globalThis.__kdsInvalidated.find((key) => key.includes("board")),
      ["kds", "outlet", "board", "kitchen"],
    );
  });

  test("a resync refetches the board, then resumes from the snapshot sequence", async () => {
    render("open", { runEffects: true, snapshotSequence: 77 });
    globalThis.__kdsRealtime.options.onResync();
    for (
      let i = 0;
      i < 50 && globalThis.__kdsRealtime.resumed.length === 0;
      i += 1
    )
      await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(globalThis.__kdsRealtime.resumed, [77]);
    assert.ok(
      globalThis.__kdsInvalidated.some(
        (key) => key.includes("board") && key.includes("kitchen"),
      ),
    );
  });
});

describe("copy", () => {
  test("the chip texts live in the kds catalog, in plain Indonesian", async () => {
    const { kdsMessages } =
      await import("../packages/shared/src/i18n/messages/kds.ts");
    assert.deepEqual(kdsMessages.realtime, {
      open: "Tersambung",
      connecting: "Menyambung ulang...",
      denied:
        "Terputus: sesi kasir berakhir. Masukkan PIN kasir lalu sambung ulang.",
      reconnect: "Sambung ulang",
    });
  });
});
