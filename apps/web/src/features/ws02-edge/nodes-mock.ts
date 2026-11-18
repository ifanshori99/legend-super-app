// Mock for the back-office edge node list (VITE_API_MOCK=true). Not a shared
// endpoint, so it is called from api.ts instead of registerMock. It honours
// the shared scenario (`?mock=empty|error|offline|slow`, lib/mock/control.ts)
// and `?demo=`:
//   normal  node connected, no alert    kosong  no node registered
//   gagal   the read fails              memuat  the read never finishes
//   terputus  two nodes with no link: one with an old status, one with none
// Without `?demo=` the screen shows the mockup's alert state.
import { ApiError, NETWORK_ERROR_MESSAGE } from "@/lib/api/errors";
import { getLatencyMs, getScenario } from "@/lib/mock/control";
import type { EdgeNodesOverview } from "./types.ts";

function demoSeed(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return new URLSearchParams(window.location.search).get("demo");
  } catch {
    return null;
  }
}

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function wait(ms: number): Promise<void> {
  return ms > 0
    ? new Promise((resolve) => setTimeout(resolve, ms))
    : Promise.resolve();
}

export async function mockEdgeNodes(): Promise<EdgeNodesOverview> {
  const scenario = getScenario();
  const seed = demoSeed();
  await wait(getLatencyMs());
  if (scenario === "offline")
    throw new ApiError(0, "NETWORK_ERROR", NETWORK_ERROR_MESSAGE);
  if (scenario === "error" || seed === "gagal")
    throw new ApiError(500, "INTERNAL", "Status edge tidak dapat dimuat.");
  if (seed === "memuat") return new Promise(() => {});
  if (scenario === "empty" || seed === "kosong")
    return { nodes: [], receiptRunAlerts: [] };
  if (seed === "terputus")
    return {
      nodes: [
        {
          id: "01ARZ3NDEKTSV4RRFFQ69G5FC1",
          name: "edge-jakarta-01",
          outletName: "Jakarta Pusat",
          link: "disconnected",
          lastUpdatedAt: isoAgo(3 * 60 * 60_000),
        },
        {
          id: "01ARZ3NDEKTSV4RRFFQ69G5FC2",
          name: "edge-bandung-01",
          outletName: "Bandung Dago",
          link: "disconnected",
          lastUpdatedAt: null,
        },
      ],
      receiptRunAlerts: [],
    };
  const updatedAt = isoAgo(60_000);
  return {
    nodes: [
      {
        id: "01ARZ3NDEKTSV4RRFFQ69G5FC1",
        name: "edge-jakarta-01",
        outletName: "Jakarta Pusat",
        link: "connected",
        lastUpdatedAt: updatedAt,
      },
    ],
    receiptRunAlerts:
      seed === "normal"
        ? []
        : [{ nodeName: "edge-jakarta-01", alertAt: updatedAt }],
  };
}
