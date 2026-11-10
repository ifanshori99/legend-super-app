// Print Agent lifecycle (beads legend-46p, legend-2lp.1; PRD v1.7 §3 F5,
// EDG-05): the agent runs only on a provisioned edge node, never on the
// cloud, and stops cleanly on shutdown.
import { afterEach, describe, expect, it } from "vitest";
import { cafeLegendFixtures } from "@starter/shared/core";
import {
  getEdgeRuntimeState,
  setEdgeRuntimeStateForTests,
  type EdgeRuntimeState,
} from "../edge/runtime.ts";
import {
  getEdgePrintAgent,
  startEdgePrintAgent,
} from "../edge/print/runtime.ts";
import { edgeNodeContext } from "../services/edge-node.service.ts";

const initial = getEdgeRuntimeState();
const { tenant, outlets } = cafeLegendFixtures;

const cloud: EdgeRuntimeState = { ...initial, edgeMode: false, identity: null };

afterEach(() => {
  setEdgeRuntimeStateForTests(initial);
});

describe("edge print agent lifecycle (legend-2lp.1)", () => {
  it("does not start on the cloud", async () => {
    setEdgeRuntimeStateForTests(cloud);
    const handle = startEdgePrintAgent();
    expect(getEdgePrintAgent()).toBeNull();
    await handle.stop();
    expect(getEdgePrintAgent()).toBeNull();
  });

  it("does not start on an edge node without an identity", async () => {
    setEdgeRuntimeStateForTests({ ...cloud, edgeMode: true });
    const handle = startEdgePrintAgent();
    expect(getEdgePrintAgent()).toBeNull();
    await handle.stop();
  });

  it("starts once on a provisioned edge node and stops on shutdown", async () => {
    const tenantId = tenant.id;
    const outletId = outlets[0].id;
    setEdgeRuntimeStateForTests({
      ...cloud,
      edgeMode: true,
      identity: {
        context: edgeNodeContext({ tenantId, outletId }),
        scope: {
          tenantId,
          outletId,
          edgeNodeId: "00000000-0000-4000-8000-0000000002a1",
        },
      },
    });
    const handle = startEdgePrintAgent();
    const agent = getEdgePrintAgent();
    expect(agent).not.toBeNull();
    // A second start is a no-op and keeps the running agent.
    const again = startEdgePrintAgent();
    expect(getEdgePrintAgent()).toBe(agent);
    await again.stop();
    expect(getEdgePrintAgent()).toBe(agent);
    await handle.stop();
    expect(getEdgePrintAgent()).toBeNull();
  });
});
