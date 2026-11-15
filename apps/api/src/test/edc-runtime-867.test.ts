// EDC agent lifecycle on an edge node (bead legend-kwy6d, sub-brief 867): only
// an enabled, provisioned primary starts it; a failed start never takes the
// edge down; stop releases the outlet.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cafeLegendFixtures } from "@starter/shared/core";
import {
  getEdgeRuntimeState,
  setEdgeRuntimeStateForTests,
  type EdgeRuntimeState,
} from "../edge/runtime.ts";
import type { EdcAgent } from "../edge/edc/agent.ts";
import {
  EDC_SALE_TIMEOUT_MS,
  edgeShutdownForceMs,
  getEdgeEdcAgent,
  startEdgeEdcAgent,
} from "../edge/edc/runtime.ts";
import { edgeNodeContext } from "../services/edge-node.service.ts";

const initial = getEdgeRuntimeState();
const { tenant, outlets } = cafeLegendFixtures;

const cloud: EdgeRuntimeState = { ...initial, edgeMode: false, identity: null };
const provisioned: EdgeRuntimeState = {
  ...cloud,
  edgeMode: true,
  identity: {
    context: edgeNodeContext({ tenantId: tenant.id, outletId: outlets[0].id }),
    scope: {
      tenantId: tenant.id,
      outletId: outlets[0].id,
      edgeNodeId: "00000000-0000-4000-8000-0000000002a1",
    },
  },
};

function fakeAgent(startError?: Error) {
  const start = vi.fn(async () => {
    if (startError) throw startError;
  });
  const stop = vi.fn(async () => {});
  return { agent: { start, stop } as unknown as EdcAgent, start, stop };
}

type Hooks = { onOutletLost: () => void };

afterEach(() => {
  setEdgeRuntimeStateForTests(initial);
});

describe("edge EDC agent lifecycle (legend-kwy6d)", () => {
  it("does not start when disabled, on the cloud, or without identity", async () => {
    const fake = fakeAgent();
    const createAgent = () => fake.agent;
    setEdgeRuntimeStateForTests(provisioned);
    await (await startEdgeEdcAgent({ enabled: false, createAgent })).stop();
    setEdgeRuntimeStateForTests(cloud);
    await (await startEdgeEdcAgent({ enabled: true, createAgent })).stop();
    setEdgeRuntimeStateForTests({ ...cloud, edgeMode: true });
    await (await startEdgeEdcAgent({ enabled: true, createAgent })).stop();
    expect(fake.start).not.toHaveBeenCalled();
    expect(getEdgeEdcAgent()).toBeNull();
  });

  it("a standby does not start the agent", async () => {
    const fake = fakeAgent();
    setEdgeRuntimeStateForTests(provisioned);
    const handle = await startEdgeEdcAgent({
      enabled: true,
      role: "standby",
      createAgent: () => fake.agent,
    });
    expect(fake.start).not.toHaveBeenCalled();
    expect(getEdgeEdcAgent()).toBeNull();
    await handle.stop();
    expect(fake.stop).not.toHaveBeenCalled();
  });

  it("starts once for its own outlet and stops on shutdown", async () => {
    const fake = fakeAgent();
    setEdgeRuntimeStateForTests(provisioned);
    const handle = await startEdgeEdcAgent({
      enabled: true,
      role: "primary",
      createAgent: () => fake.agent,
    });
    expect(getEdgeEdcAgent()).toBe(fake.agent);
    // The context comes from the node identity, never from a caller.
    expect(fake.start).toHaveBeenCalledExactlyOnceWith(
      provisioned.identity!.context,
    );
    // A second start is a no-op and keeps the running agent.
    const again = await startEdgeEdcAgent({
      enabled: true,
      createAgent: () => fakeAgent().agent,
    });
    await again.stop();
    expect(getEdgeEdcAgent()).toBe(fake.agent);
    expect(fake.stop).not.toHaveBeenCalled();
    await handle.stop();
    expect(fake.stop).toHaveBeenCalledOnce();
    expect(getEdgeEdcAgent()).toBeNull();
  });

  it("a failed start is logged, releases the outlet and does not throw", async () => {
    const fake = fakeAgent(new Error("EDC_AGENT_NOT_READY"));
    setEdgeRuntimeStateForTests(provisioned);
    const handle = await startEdgeEdcAgent({
      enabled: true,
      createAgent: () => fake.agent,
    });
    expect(getEdgeEdcAgent()).toBeNull();
    expect(fake.stop).toHaveBeenCalledOnce();
    await expect(handle.stop()).resolves.toBeUndefined();
    // A failed build (agent factory throws) is contained the same way.
    const broken = await startEdgeEdcAgent({
      enabled: true,
      createAgent: () => {
        throw new Error("bad config");
      },
    });
    await expect(broken.stop()).resolves.toBeUndefined();
    expect(getEdgeEdcAgent()).toBeNull();
  });

  it("a failed start retries with backoff until it succeeds, then stops cleanly", async () => {
    const hooks: Hooks[] = [];
    const agents = [
      fakeAgent(new Error("EDC_AGENT_NOT_READY")),
      fakeAgent(new Error("EDC_AGENT_NOT_READY")),
      fakeAgent(),
    ];
    const createAgent = vi.fn((h: Hooks) => {
      hooks.push(h);
      return agents[createAgent.mock.calls.length - 1]!.agent;
    });
    const delays: number[] = [];
    setEdgeRuntimeStateForTests(provisioned);
    const handle = await startEdgeEdcAgent({
      enabled: true,
      createAgent,
      retryDelayMs: (attempt) => {
        delays.push(attempt);
        return 5;
      },
    });
    expect(getEdgeEdcAgent()).toBeNull();
    await vi.waitFor(() => expect(getEdgeEdcAgent()).toBe(agents[2]!.agent));
    // Each failed attempt released its own partial lock; backoff attempt
    // numbers grow while it keeps failing.
    expect(agents[0]!.stop).toHaveBeenCalledOnce();
    expect(agents[1]!.stop).toHaveBeenCalledOnce();
    expect(delays).toEqual([0, 1]);
    // Same context every time: from the node identity.
    expect(agents[2]!.start).toHaveBeenCalledExactlyOnceWith(
      provisioned.identity!.context,
    );
    await handle.stop();
    expect(agents[2]!.stop).toHaveBeenCalledOnce();
    expect(getEdgeEdcAgent()).toBeNull();
  });

  it("stop() ends the retries: no further start after it", async () => {
    const fake = fakeAgent(new Error("EDC_AGENT_NOT_READY"));
    const createAgent = vi.fn(() => fake.agent);
    setEdgeRuntimeStateForTests(provisioned);
    const handle = await startEdgeEdcAgent({
      enabled: true,
      createAgent,
      retryDelayMs: () => 20,
    });
    expect(createAgent).toHaveBeenCalledTimes(1);
    await handle.stop();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(createAgent).toHaveBeenCalledTimes(1);
    expect(getEdgeEdcAgent()).toBeNull();
    // The module is free again: a new start works.
    const next = fakeAgent();
    const again = await startEdgeEdcAgent({
      enabled: true,
      createAgent: () => next.agent,
    });
    expect(getEdgeEdcAgent()).toBe(next.agent);
    await again.stop();
  });

  it("an outlet lock lost without a sale on the wire starts a fresh agent", async () => {
    const hooks: Hooks[] = [];
    const first = fakeAgent();
    const second = fakeAgent();
    const agents = [first, second];
    setEdgeRuntimeStateForTests(provisioned);
    const handle = await startEdgeEdcAgent({
      enabled: true,
      createAgent: (h) => {
        hooks.push(h);
        return agents[hooks.length - 1]!.agent;
      },
      retryDelayMs: () => 5,
    });
    expect(getEdgeEdcAgent()).toBe(first.agent);
    hooks[0]!.onOutletLost();
    // Unusable agent is dropped at once, never handed to the POS flow.
    expect(getEdgeEdcAgent()).toBeNull();
    await vi.waitFor(() => expect(getEdgeEdcAgent()).toBe(second.agent));
    expect(first.stop).toHaveBeenCalledOnce();
    expect(second.start).toHaveBeenCalledExactlyOnceWith(
      provisioned.identity!.context,
    );
    // A late call from the dropped agent changes nothing.
    hooks[0]!.onOutletLost();
    expect(getEdgeEdcAgent()).toBe(second.agent);
    await handle.stop();
    expect(second.stop).toHaveBeenCalledOnce();
  });

  it("a lock lost while stopping does not restart the agent", async () => {
    const hooks: Hooks[] = [];
    const fake = fakeAgent();
    setEdgeRuntimeStateForTests(provisioned);
    const createAgent = vi.fn((h: Hooks) => {
      hooks.push(h);
      return fake.agent;
    });
    const handle = await startEdgeEdcAgent({
      enabled: true,
      createAgent,
      retryDelayMs: () => 5,
    });
    await handle.stop();
    hooks[0]!.onOutletLost();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(createAgent).toHaveBeenCalledTimes(1);
    expect(getEdgeEdcAgent()).toBeNull();
  });

  it("shutdown waits for a sale on the wire when EDC is on", () => {
    const on = { enabled: true, role: "primary", edgeMode: true } as const;
    // Without EDC (or not the primary edge): the plain 5 s timer.
    expect(edgeShutdownForceMs({ ...on, enabled: false })).toBe(5_000);
    expect(edgeShutdownForceMs({ ...on, role: "standby" })).toBe(5_000);
    expect(edgeShutdownForceMs({ ...on, edgeMode: false })).toBe(5_000);
    // EDC on: sale timeout + 10 s, never shorter than a sale on the wire.
    expect(edgeShutdownForceMs(on)).toBe(EDC_SALE_TIMEOUT_MS + 10_000);
    expect(edgeShutdownForceMs(on)).toBeGreaterThan(EDC_SALE_TIMEOUT_MS);
  });
});
