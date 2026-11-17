import assert from "node:assert/strict";
import { after, test } from "node:test";
import { componentHarness } from "./844-component-harness.mjs";

const harness = componentHarness((specifier, parent) => {
  if (specifier === "@/components/shells/operations-screen")
    return "export const useOperationsScreen = () => {};";
  if (specifier === "../hooks.ts" && parent.includes("ws04-kitchen-config"))
    return "export const useMenuStations = () => ({data: []}); export const useOrderIssues = () => ({data: {data: globalThis.__844Data.issues, meta: {nextCursor: null}}});";
  if (specifier === "@tanstack/react-router")
    return 'export const useRouteContext = () => ({access: {stations: ["bar", "kitchen"]}});';
  if (specifier === "@tanstack/react-query")
    return "export const useQueries = () => []; export const useQueryClient = () => ({invalidateQueries: () => Promise.resolve()});";
  if (specifier === "../hooks.ts" && parent.includes("ws04-kds"))
    return `export const useStations = () => ({data: [{stationId: "bar", isActive: true, displayOrder: 0}, {stationId: "kitchen", isActive: true, displayOrder: 1}]});
      export const useStationLabels = () => ({data: [{stationId: "bar", name: "Bar kopi"}, {stationId: "kitchen", name: "Dapur panas"}]});
      export const useStationSummary = () => ({data: {stations: [{stationId: "bar", openTickets: 7}, {stationId: "kitchen", openTickets: 3}]}});
      export const useBoard = () => ({isPending: true}); export const useKdsActions = () => ({}); export const useKdsHeartbeat = () => {}; export const useScannerStatus = () => ({});`;
  if (specifier === "../queries.ts" && parent.includes("ws04-kds"))
    return "export const boardQuery = () => ({}); export const kdsKeys = {board: () => [], stationSummary: () => []};";
  // The page opens the realtime feed (legend-t0m89); no socket in this render.
  if (specifier === "../api.ts" && parent.includes("ws04-kds"))
    return "export const fetchStationSnapshot = async () => ({sequence: 0});";
  if (specifier === "../use-kds-realtime.ts")
    return 'export const useKdsRealtime = () => ({status: "stopped", resume() {}, reconnect() {}});';
  if (specifier === "./scanner-panel.tsx")
    return "export const ScannerPanel = () => null;";
});
after(() => harness.close());
const { RemakeCompPage } =
  await import("../apps/web/src/features/ws04-kitchen-config/components/remake-comp-page.tsx");
const { KdsPage } =
  await import("../apps/web/src/features/ws04-kds/components/kds-page.tsx");

test("xz3ll remake log renders names in desktop table and phone card markup", () => {
  const html = harness.render(
    RemakeCompPage,
    {},
    {
      issues: [
        {
          id: "issue",
          orderId: "internal-order-id",
          orderLabel: "A-0472",
          itemName: "Cappuccino spesial",
          employeeId: "internal-employee-id",
          employeeName: "Rani Pembuat",
          approvedBy: "internal-approver-id",
          approvedByName: "Budi Penyetuju",
          createdAt: "2026-11-15T01:00:00Z",
          type: "remake",
          reason: "quality",
          reasonNote: "Kurang hangat",
          stationId: null,
          resolution: null,
          costIdr: 12000,
        },
      ],
    },
  );
  for (const name of [
    "A-0472",
    "Cappuccino spesial",
    "Rani Pembuat",
    "Budi Penyetuju",
  ])
    assert.equal(
      html.split(name).length - 1,
      2,
      `${name} appears in both desktop table and phone card`,
    );
  assert.doesNotMatch(
    html,
    /internal-order-id|internal-employee-id|internal-approver-id/,
  );
});

test("xz3ll station tabs show summary counts before any board poll resolves", () => {
  const html = harness.render(KdsPage);
  assert.match(html, /Bar kopi 7/);
  assert.match(html, /Dapur panas 3/);
});
