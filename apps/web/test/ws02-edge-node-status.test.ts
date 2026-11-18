// legend-n5u8w (S5 of docs/design/edge-status-cloud.md, section 3.4 and tests
// T26-T28): the back-office "Status edge" screen reads the cloud list
// GET /api/edge-node-status instead of the mock-only fixture.
//
// Assumptions (the design names no function):
//   - The adapter is `mapEdgeNodeStatusList(list: EdgeNodeStatusList)` exported
//     from `@/features/ws02-edge/types` (pure, no runtime imports), returning
//     `EdgeNodesOverview` with `receiptRunAlerts: EdgeReceiptRunAlert[]`.
//   - The shared DTO schema is importable from `@starter/shared/edge/node-status`
//     (S1 file `packages/shared/src/edge/node-status.ts` plus a package export).
//   - `fetchEdgeNodes()` (api.ts) calls the endpoint through `apiFetch` and
//     maps the answer with the adapter; outside mock mode it no longer throws
//     CONTRACT_PENDING.
//   - Only `receipt_run_alert` becomes a banner; `device_registry_hard_stale`
//     is returned but not shown yet (design 3.4, legend-qhymx).
import { randomUUID } from "node:crypto";
import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { Server } from "lucide-react";
import { createTranslator, messagesId } from "@starter/shared/i18n";
import { edgeNodeStatusListSchema } from "@starter/shared/edge/node-status";

const state = vi.hoisted(() => {
  // Vite normally injects this compile-time flag; the unit-test runner does
  // not load vite.config.ts. Hoisted so it is set before the real client
  // module (loaded by the apiFetch mock below) reads it.
  vi.stubGlobal("__WEB_DEV_SERVER__", false);
  return {
    overview: null as unknown,
    apiAnswer: null as unknown,
    apiCalls: [] as unknown[][],
  };
});

// API_MOCK is a build-time flag; T28 needs it off (a real deployment).
vi.mock("@/lib/api/mock-flag", () => ({ API_MOCK: false }));
vi.mock("@/lib/api/mock-flag.ts", () => ({ API_MOCK: false }));

vi.mock("@/lib/api/client", async (original) => {
  const real = await original<typeof import("@/lib/api/client")>();
  return {
    ...real,
    apiFetch: async (...args: unknown[]) => {
      state.apiCalls.push(args);
      return state.apiAnswer;
    },
  };
});

// The page renders router links; a plain anchor needs no router context.
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  Link: ({ to, children, ...rest }: { to: string; children?: ReactNode }) =>
    createElement("a", { href: to, ...rest }, children),
}));

vi.mock("@/features/ws02-edge/hooks", async (original) => {
  const real = await original<typeof import("@/features/ws02-edge/hooks")>();
  return {
    ...real,
    useEdgeNodes: () => ({
      data: state.overview,
      dataUpdatedAt: Date.parse("2026-11-18T03:00:00.000Z"),
      isPending: false,
      isError: false,
      error: null,
      refetch: async () => ({ isSuccess: true, data: state.overview }),
    }),
  };
});

import nav from "@/features/ws02-edge/nav";
import { fetchEdgeNodes } from "@/features/ws02-edge/api";
import { EdgeNodesPage } from "@/features/ws02-edge/components/edge-nodes-page";
import { mapEdgeNodeStatusList } from "@/features/ws02-edge/types";
import { buildAreaNav } from "@/lib/areas/nav";
import type { AreaAccess } from "@/lib/areas/access";

const t = createTranslator(messagesId);

const outletJakarta = randomUUID();
const outletBandung = randomUUID();
const nodeA = randomUUID();
const nodeB = randomUUID();
const nodeC = randomUUID();
const nodeD = randomUUID();

const NOW = "2026-11-18T03:00:00.000Z";
const HEARTBEAT = "2026-11-18T02:59:30.000Z";
const RAISED = "2026-11-18T01:00:00.000Z";
const SEEN = "2026-11-18T02:30:00.000Z";

function dto(
  nodes: Array<{
    id: string;
    label: string;
    outletId: string;
    outletName: string;
    role?: "primary" | "standby";
    version?: string | null;
    link: "connected" | "disconnected";
    lastHeartbeatAt: string | null;
    alerts?: Array<{
      kind: "device_registry_hard_stale" | "receipt_run_alert";
      raisedAt: string;
      lastSeenAt: string;
    }>;
  }>,
) {
  return edgeNodeStatusListSchema.parse({
    data: nodes.map((node) => ({
      id: node.id,
      label: node.label,
      role: node.role ?? "primary",
      outlet: { id: node.outletId, name: node.outletName },
      version: node.version === undefined ? "1.4.2" : node.version,
      link: node.link,
      lastHeartbeatAt: node.lastHeartbeatAt,
      alerts: node.alerts ?? [],
    })),
    meta: { generatedAt: NOW, truncated: false },
  });
}

const receiptAlert = {
  kind: "receipt_run_alert",
  raisedAt: RAISED,
  lastSeenAt: SEEN,
} as const;

function countOf(html: string, text: string): number {
  return html.split(text).length - 1;
}

beforeEach(() => {
  state.overview = null;
  state.apiAnswer = null;
  state.apiCalls = [];
});

describe("ph62j T26: adapter maps the cloud DTO to the view model", () => {
  test("name, outlet, link and time come from label, outlet.name, link, lastHeartbeatAt", () => {
    const overview = mapEdgeNodeStatusList(
      dto([
        {
          id: nodeA,
          label: "edge-jakarta-01",
          outletId: outletJakarta,
          outletName: "Jakarta Pusat",
          link: "connected",
          lastHeartbeatAt: HEARTBEAT,
        },
        {
          id: nodeB,
          label: "edge-bandung-01",
          outletId: outletBandung,
          outletName: "Bandung Dago",
          role: "standby",
          version: null,
          link: "disconnected",
          lastHeartbeatAt: null,
        },
      ]),
    );

    expect(overview.nodes).toEqual([
      {
        id: nodeA,
        name: "edge-jakarta-01",
        outletName: "Jakarta Pusat",
        link: "connected",
        lastUpdatedAt: HEARTBEAT,
      },
      {
        id: nodeB,
        name: "edge-bandung-01",
        outletName: "Bandung Dago",
        link: "disconnected",
        lastUpdatedAt: null,
      },
    ]);
    expect(overview.receiptRunAlerts).toEqual([]);
  });

  test("a receipt_run_alert becomes a banner with node label and lastSeenAt", () => {
    const overview = mapEdgeNodeStatusList(
      dto([
        {
          id: nodeA,
          label: "edge-jakarta-01",
          outletId: outletJakarta,
          outletName: "Jakarta Pusat",
          link: "connected",
          lastHeartbeatAt: HEARTBEAT,
          alerts: [receiptAlert],
        },
      ]),
    );
    expect(overview.receiptRunAlerts).toEqual([
      { nodeName: "edge-jakarta-01", alertAt: SEEN },
    ]);
  });

  test("device_registry_hard_stale is not shown as a banner yet", () => {
    const overview = mapEdgeNodeStatusList(
      dto([
        {
          id: nodeA,
          label: "edge-jakarta-01",
          outletId: outletJakarta,
          outletName: "Jakarta Pusat",
          link: "connected",
          lastHeartbeatAt: HEARTBEAT,
          alerts: [
            {
              kind: "device_registry_hard_stale",
              raisedAt: RAISED,
              lastSeenAt: SEEN,
            },
          ],
        },
      ]),
    );
    expect(overview.receiptRunAlerts).toEqual([]);
    expect(overview.nodes).toHaveLength(1);
  });

  test("an empty list gives no nodes and no banners", () => {
    const overview = mapEdgeNodeStatusList(dto([]));
    expect(overview).toEqual({ nodes: [], receiptRunAlerts: [] });
  });

  test("fetchEdgeNodes reads the cloud endpoint and maps it outside mock mode", async () => {
    state.apiAnswer = dto([
      {
        id: nodeA,
        label: "edge-jakarta-01",
        outletId: outletJakarta,
        outletName: "Jakarta Pusat",
        link: "connected",
        lastHeartbeatAt: HEARTBEAT,
        alerts: [receiptAlert],
      },
    ]);

    const overview = await fetchEdgeNodes();

    expect(state.apiCalls).toHaveLength(1);
    expect(String(state.apiCalls[0]?.[0])).toContain("/api/edge-node-status");
    expect(overview.nodes.map((node) => node.name)).toEqual([
      "edge-jakarta-01",
    ]);
    expect(overview.receiptRunAlerts).toEqual([
      { nodeName: "edge-jakarta-01", alertAt: SEEN },
    ]);
  });
});

describe("ph62j T27: one banner per alerting node", () => {
  function renderWith(
    nodes: Parameters<typeof dto>[0],
  ): ReturnType<typeof renderToString> {
    state.overview = mapEdgeNodeStatusList(dto(nodes));
    return renderToString(createElement(EdgeNodesPage));
  }

  const base = {
    outletId: outletJakarta,
    outletName: "Jakarta Pusat",
    link: "connected",
    lastHeartbeatAt: HEARTBEAT,
  } as const;

  test("two alerting nodes show two banners naming each node", () => {
    const html = renderWith([
      { ...base, id: nodeA, label: "edge-jakarta-01", alerts: [receiptAlert] },
      { ...base, id: nodeB, label: "edge-jakarta-02", alerts: [receiptAlert] },
      { ...base, id: nodeC, label: "edge-jakarta-03" },
    ]);
    expect(countOf(html, t("edge.receiptRun.title"))).toBe(2);
    expect(countOf(html, 'role="alert"')).toBe(2);
    for (const name of ["edge-jakarta-01", "edge-jakarta-02"])
      expect(html).toContain(name);
    // All three nodes stay listed.
    expect(html).toContain("edge-jakarta-03");
  });

  test("one alerting node shows one banner", () => {
    const html = renderWith([
      { ...base, id: nodeA, label: "edge-jakarta-01", alerts: [receiptAlert] },
      { ...base, id: nodeD, label: "edge-jakarta-04" },
    ]);
    expect(countOf(html, t("edge.receiptRun.title"))).toBe(1);
  });

  test("no alerting node shows no banner but still lists the nodes", () => {
    const html = renderWith([{ ...base, id: nodeA, label: "edge-jakarta-01" }]);
    expect(html).not.toContain(t("edge.receiptRun.title"));
    expect(html).not.toContain('role="alert"');
    expect(html).toContain("edge-jakarta-01");
    expect(html).toContain(t("edgeNodes.linkConnected"));
  });

  test("a disconnected node shows the disconnected status", () => {
    const html = renderWith([
      {
        ...base,
        id: nodeB,
        label: "edge-bandung-01",
        outletName: "Bandung Dago",
        link: "disconnected",
        lastHeartbeatAt: null,
      },
    ]);
    expect(html).toContain(t("edgeNodes.linkDisconnected"));
    expect(html).toContain("Bandung Dago");
  });

  test("no node at all shows the empty state, not a banner", () => {
    const html = renderWith([]);
    expect(html).toContain(t("edgeNodes.emptyTitle"));
    expect(html).not.toContain(t("edge.receiptRun.title"));
  });
});

describe("ph62j T28: Status edge menu item outside mock mode", () => {
  const holder: AreaAccess = {
    authenticated: true,
    permissions: ["report.operational.view"],
    mfaRequired: false,
    mfaVerified: true,
    stations: [],
    outlets: [],
  };

  function items(access: AreaAccess) {
    return buildAreaNav({
      area: "kelola",
      entries: nav,
      indexIcon: Server,
      access,
      pathname: "/kelola",
      t,
    });
  }

  test("a user with report.operational.view sees the item", () => {
    const item = items(holder).find((i) => i.href === "/kelola/status-edge");
    expect(item?.label).toBe(t("edgeNodes.nav"));
  });

  test("a user without the permission does not see it", () => {
    const none: AreaAccess = { ...holder, permissions: [] };
    expect(items(none).some((i) => i.href === "/kelola/status-edge")).toBe(
      false,
    );
  });
});
