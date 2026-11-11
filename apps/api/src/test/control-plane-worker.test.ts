// legend-488 items 4 and 9, worker side. No database; never touches the
// sentinel stream, so it cannot race control-plane-events.test.ts.
//
// Assumptions:
// - createRelayRuntime gets a new optional `controlPlaneRelay: () => Promise<unknown>`,
//   run once per sweep iteration BEFORE the tenant loop, isolated by its own
//   try/catch, and never given a tenant id (per-tenant sweeps never see the
//   sentinel).
// - worker-main.ts has top-level side effects, so its wiring is read as source
//   (same approach as edge-worker-refund-gate.test.ts). The patterns are loose
//   on purpose: they pin identifiers named in the design, not formatting.
// - Not covered, no seam without reading implementation: tenant provisioning
//   refusing id === CONTROL_PLANE_TENANT_ID (createTenant takes no id).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  CONTROL_PLANE_DESTINATION,
  CONTROL_PLANE_PACKAGE_DESTINATION,
  CONTROL_PLANE_RELAYED_DESTINATIONS,
  CONTROL_PLANE_TENANT_ID,
  eventFixture,
  isControlPlaneDestination,
} from "@starter/shared/events";
import { describe, expect, it, vi } from "vitest";
import { createRelayRuntime } from "../worker/relay";
import { createBuiltinWorkerTransport } from "../worker/transport.ts";

describe("shared control-plane constants", () => {
  it("names the sentinel tenant, both destinations and the destination predicate", () => {
    expect(CONTROL_PLANE_TENANT_ID).toBe(
      "00000000-0000-4000-8000-000000000000",
    );
    expect(CONTROL_PLANE_DESTINATION).toBe("control-plane");
    expect(CONTROL_PLANE_PACKAGE_DESTINATION).toBe("control-plane-package");
    expect(isControlPlaneDestination("control-plane")).toBe(true);
    expect(isControlPlaneDestination("control-plane-package")).toBe(true);
    expect(isControlPlaneDestination("cloud-sync")).toBe(false);
    expect(isControlPlaneDestination("identity")).toBe(false);
    // The relay allowlist is the routed destination only; the parked one is
    // never claimed.
    expect([...CONTROL_PLANE_RELAYED_DESTINATIONS]).toEqual([
      CONTROL_PLANE_DESTINATION,
    ]);
  });
});

describe("builtin transport on the cloud (legend-488 item 9)", () => {
  const transport = createBuiltinWorkerTransport({
    database: {} as never,
    env: {},
  });
  const context = establishScopedTenantContext(
    establishTenantContext({
      tenantId: randomUUID(),
      brandId: null,
      source: "job",
    }),
    { kind: "tenant" },
  );
  const route = { destination: "cloud-sync", direction: null, peerId: null };
  const send = (name: string) =>
    transport.deliverEvent(
      context,
      { ...eventFixture, name, outletId: null } as never,
      "key",
      {} as never,
      route,
    );

  it("refuses tenant lifecycle events on cloud-sync instead of silently acking them", async () => {
    await expect(send("tenant.status_changed")).rejects.toThrow();
    await expect(send("tenant.package_changed")).rejects.toThrow();
  });

  it("still accepts an ordinary event on cloud-sync as a local sink", async () => {
    await expect(send("order.paid")).resolves.toBeUndefined();
  });
});

describe("relay runtime control-plane sweep (legend-488 item 4)", () => {
  function harness(overrides: { controlPlaneRelay?: () => Promise<unknown> }) {
    const order: string[] = [];
    let scheduled: (() => Promise<void>) | undefined;
    const resolveContext = vi.fn(async (id: string) => {
      order.push(`resolve:${id}`);
      return `trusted-${id}`;
    });
    const relay = vi.fn(async (context: string) => {
      order.push(`relay:${context}`);
    });
    const runtime = createRelayRuntime({
      scheduler: {
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
        schedule: vi.fn(async (fn: () => Promise<void>) => {
          scheduled = fn;
        }),
      },
      listener: { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) },
      listActiveTenantIds: async () => ["a", "b"],
      resolveContext,
      relay,
      controlPlaneRelay: overrides.controlPlaneRelay,
    } as never);
    return { runtime, order, resolveContext, relay, run: () => scheduled!() };
  }

  it("runs the control-plane relay once per sweep, before the tenants, and never resolves the sentinel as a tenant", async () => {
    const controlPlaneRelay = vi.fn(async () => {});
    const h = harness({ controlPlaneRelay });
    await h.runtime.start();
    expect(controlPlaneRelay).toHaveBeenCalledTimes(1);
    expect(h.order).toEqual([
      "resolve:a",
      "relay:trusted-a",
      "resolve:b",
      "relay:trusted-b",
    ]);
    // The control relay was the first thing in the sweep: check call order.
    expect(controlPlaneRelay.mock.invocationCallOrder[0]).toBeLessThan(
      h.resolveContext.mock.invocationCallOrder[0]!,
    );
    await h.run();
    expect(controlPlaneRelay).toHaveBeenCalledTimes(2);
    expect(h.resolveContext).not.toHaveBeenCalledWith(CONTROL_PLANE_TENANT_ID);
    expect(h.relay.mock.calls.flat()).not.toContain(
      `trusted-${CONTROL_PLANE_TENANT_ID}`,
    );
    await h.runtime.stop();
  });

  it("a failing control-plane relay does not stop the per-tenant sweeps", async () => {
    const h = harness({
      controlPlaneRelay: async () => {
        throw new Error("control plane down");
      },
    });
    await h.runtime.start();
    expect(h.relay.mock.calls.map(([ctx]) => ctx)).toEqual([
      "trusted-a",
      "trusted-b",
    ]);
    await h.runtime.stop();
  });
});

describe("worker-main wiring (legend-488 items 4 and 9)", () => {
  const source = readFileSync(
    new URL("../worker-main.ts", import.meta.url),
    "utf8",
  );

  it("wires the control-plane relay with a control-plane-only destination allowlist", () => {
    expect(source).toMatch(/controlPlaneRelay/);
    expect(source).toMatch(
      /destinations:\s*(CONTROL_PLANE_RELAYED_DESTINATIONS|\[\s*(CONTROL_PLANE_DESTINATION|"control-plane")\s*\])/,
    );
  });

  it("delivers control-plane rows only through deliverControlPlaneEvent, from one call site", () => {
    expect(source.match(/deliverControlPlaneEvent\(/g)).toHaveLength(1);
  });

  it("checks the sentinel against the control-plane route in both directions and keeps the registry for real tenants", () => {
    expect(source).toMatch(/CONTROL_PLANE_TENANT_ID/);
    expect(source).toMatch(
      /isControlPlaneDestination|CONTROL_PLANE_DESTINATION/,
    );
  });
});
