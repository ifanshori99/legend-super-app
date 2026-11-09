// Wi-Fi controller simulator (bead legend-hsk): the contract a real adapter must
// meet, plus the probes the agent tests use. Pure, no database.
import { describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  outletIdSchema,
  tenantIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { WifiRequest } from "@starter/shared/adapters";
import { WifiProviderError } from "@starter/shared/edge";
import { createDefaultWifiProvider } from "../edge/wifi/registry.ts";
import { WifiControllerSimulator } from "../edge/wifi/simulator.ts";

const tenantA = tenantIdSchema.parse("00000000-0000-4000-8000-0000000000a1");
const tenantB = tenantIdSchema.parse("00000000-0000-4000-8000-0000000000b1");
const outletA1 = outletIdSchema.parse("00000000-0000-4000-8000-0000000000a2");
const outletA2 = outletIdSchema.parse("00000000-0000-4000-8000-0000000000a3");
const outletB1 = outletIdSchema.parse("00000000-0000-4000-8000-0000000000b2");

const ctx = (
  tenantId: typeof tenantA,
  outletIds: (typeof outletA1)[],
): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "outlets", outletIds },
  );
const ctxA = ctx(tenantA, [outletA1]);
const ctxB = ctx(tenantB, [outletB1]);

const T0 = new Date("2026-11-09T08:00:00.000Z");
function clock() {
  let now = T0.getTime();
  return {
    now: () => new Date(now),
    advance: (seconds: number) => {
      now += seconds * 1000;
    },
  };
}
function setup() {
  const c = clock();
  return { c, sim: new WifiControllerSimulator({ now: c.now }) };
}

const MAC = "aa:bb:cc:dd:ee:01";
const request = (over: Partial<WifiRequest> = {}): WifiRequest => ({
  tenantId: tenantA,
  outletId: outletA1,
  reference: "grant-1",
  deviceId: MAC,
  durationSeconds: 600,
  bandwidthKbps: 10_000,
  walledGarden: ["pay.doit.id"],
  ...over,
});
const access = (sim: WifiControllerSimulator, deviceId = MAC) =>
  sim.deviceAccess(tenantA, outletA1, deviceId);
const ref = (reference: string) => ({
  tenantId: tenantA,
  outletId: outletA1,
  reference,
});

describe("WifiControllerSimulator authorize", () => {
  it("authorizes a device and reports it online with the granted rate", async () => {
    const { sim } = setup();
    expect(access(sim)).toEqual({ state: "blocked" });
    expect(await sim.authorize(ctxA, request())).toEqual({
      reference: "grant-1",
      authorized: true,
    });
    expect(access(sim)).toEqual({
      state: "online",
      bandwidthKbps: 10_000,
      reference: "grant-1",
      expiresAt: new Date(T0.getTime() + 600_000),
    });
  });

  it("replays the same request without applying it again", async () => {
    const { sim, c } = setup();
    await sim.authorize(ctxA, request());
    c.advance(100);
    expect(await sim.authorize(ctxA, request())).toEqual({
      reference: "grant-1",
      authorized: true,
    });
    // The expiry did not move: a replay is not a renewal.
    expect(access(sim)).toMatchObject({
      expiresAt: new Date(T0.getTime() + 600_000),
    });
    expect(sim.requests).toHaveLength(1);
  });

  it("fails IDEMPOTENCY_KEY_REUSED for the same reference with another request", async () => {
    const { sim } = setup();
    await sim.authorize(ctxA, request());
    await expect(
      sim.authorize(ctxA, request({ bandwidthKbps: 1_000 })),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("never authorizes a revoked reference again", async () => {
    const { sim } = setup();
    await sim.authorize(ctxA, request());
    await sim.revoke(ctxA, ref("grant-1"));
    expect(access(sim)).toEqual({ state: "blocked" });
    expect(await sim.authorize(ctxA, request())).toEqual({
      reference: "grant-1",
      authorized: false,
    });
    expect(access(sim)).toEqual({ state: "blocked" });
  });

  it("refuses a context of another tenant and an outlet out of scope", async () => {
    const { sim } = setup();
    await expect(sim.authorize(ctxB, request())).rejects.toThrow(
      "Tenant mismatch",
    );
    await expect(
      sim.authorize(ctxA, request({ outletId: outletA2 })),
    ).rejects.toMatchObject({ code: "OUTLET_OUT_OF_SCOPE" });
    await expect(sim.revoke(ctxB, ref("grant-1"))).rejects.toThrow(
      "Tenant mismatch",
    );
    await expect(
      sim.revoke(ctxA, { ...ref("grant-1"), outletId: outletA2 }),
    ).rejects.toMatchObject({ code: "OUTLET_OUT_OF_SCOPE" });
    expect(sim.requests).toHaveLength(0);
  });

  it("refuses an untrusted context and a malformed request", async () => {
    const { sim } = setup();
    const forged = {
      tenant: { tenantId: tenantA },
      outletScope: { kind: "tenant", tenantId: tenantA },
    } as unknown as ScopedTenantContext;
    await expect(sim.authorize(forged, request())).rejects.toThrow(TypeError);
    await expect(
      sim.authorize(ctxA, { ...request(), durationSeconds: 0 }),
    ).rejects.toThrow();
  });

  it("keeps tenants and outlets apart", async () => {
    const { sim } = setup();
    const wide = ctx(tenantA, [outletA1, outletA2]);
    await sim.authorize(wide, request());
    await sim.authorize(
      wide,
      request({ outletId: outletA2, bandwidthKbps: 2_000 }),
    );
    expect(access(sim)).toMatchObject({ bandwidthKbps: 10_000 });
    expect(sim.deviceAccess(tenantA, outletA2, MAC)).toMatchObject({
      bandwidthKbps: 2_000,
    });
    expect(sim.deviceAccess(tenantB, outletA1, MAC)).toEqual({
      state: "blocked",
    });
    // Same reference in another tenant is a different grant, not a reuse.
    await sim.authorize(
      ctxB,
      request({ tenantId: tenantB, outletId: outletB1, durationSeconds: 60 }),
    );
    expect(sim.deviceAccess(tenantB, outletB1, MAC).state).toBe("online");
  });
});

describe("supersede and revoke", () => {
  it("replaces a device's grant without a gap", async () => {
    const { sim, c } = setup();
    await sim.authorize(ctxA, request());
    c.advance(300);
    await sim.authorize(
      ctxA,
      request({ reference: "grant-2", bandwidthKbps: 1_000 }),
    );
    expect(access(sim)).toMatchObject({
      bandwidthKbps: 1_000,
      reference: "grant-2",
    });
    // Past the old grant's expiry: still online on the new one, no cut.
    c.advance(400);
    expect(access(sim).state).toBe("online");
    expect(sim.cuts()).toEqual([]);
  });

  it("treats revoke of a superseded reference as a no-op for the device", async () => {
    const { sim } = setup();
    await sim.authorize(ctxA, request());
    await sim.authorize(
      ctxA,
      request({ reference: "grant-2", bandwidthKbps: 1_000 }),
    );
    expect(await sim.revoke(ctxA, ref("grant-1"))).toEqual({
      reference: "grant-1",
      authorized: false,
    });
    expect(access(sim)).toMatchObject({ reference: "grant-2" });
    // The superseded reference still never authorizes again.
    expect(await sim.authorize(ctxA, request())).toMatchObject({
      authorized: false,
    });
    expect(access(sim)).toMatchObject({ reference: "grant-2" });
  });

  it("blocks the device when its current reference is revoked, without a cut", async () => {
    const { sim, c } = setup();
    await sim.authorize(ctxA, request());
    await sim.revoke(ctxA, ref("grant-1"));
    c.advance(10_000);
    expect(access(sim)).toEqual({ state: "blocked" });
    expect(sim.cuts()).toEqual([]);
  });

  it("revoke of an unknown reference is a no-op that refuses a later authorize of it", async () => {
    const { sim } = setup();
    expect(await sim.revoke(ctxA, ref("never-seen"))).toEqual({
      reference: "never-seen",
      authorized: false,
    });
    // A grant that lands after its revoke (authorize still in flight) never
    // authorizes: a revoked reference never authorizes again.
    expect(
      await sim.authorize(ctxA, request({ reference: "never-seen" })),
    ).toEqual({ reference: "never-seen", authorized: false });
    expect(access(sim)).toEqual({ state: "blocked" });
    expect(sim.requests).toEqual([]);
    // Another outlet's reference with the same name is not affected.
    const both = ctx(tenantA, [outletA1, outletA2]);
    expect(
      await sim.authorize(
        both,
        request({ reference: "never-seen", outletId: outletA2 }),
      ),
    ).toEqual({ reference: "never-seen", authorized: true });
  });
});

describe("cuts", () => {
  it("records a lapse of the current grant while the device was never revoked", async () => {
    const { sim, c } = setup();
    await sim.authorize(ctxA, request());
    c.advance(599);
    expect(sim.cuts()).toEqual([]);
    c.advance(120);
    expect(access(sim)).toEqual({ state: "blocked" });
    expect(sim.cuts()).toEqual([
      {
        tenantId: tenantA,
        outletId: outletA1,
        deviceId: MAC,
        reference: "grant-1",
        at: new Date(T0.getTime() + 600_000),
      },
    ]);
    // Recorded once.
    c.advance(1_000);
    expect(sim.cuts()).toHaveLength(1);
  });

  it("records the cut when a late renewal arrives after the lapse", async () => {
    const { sim, c } = setup();
    await sim.authorize(ctxA, request());
    c.advance(700);
    await sim.authorize(ctxA, request({ reference: "grant-2" }));
    expect(sim.cuts()).toHaveLength(1);
    expect(access(sim).state).toBe("online");
  });

  it("does not record a lapse of a superseded grant", async () => {
    const { sim, c } = setup();
    await sim.authorize(ctxA, request({ durationSeconds: 100 }));
    await sim.authorize(ctxA, request({ reference: "grant-2" }));
    c.advance(200);
    expect(sim.cuts()).toEqual([]);
  });
});

describe("pre-auth reach (walled garden)", () => {
  const hosts = ["order.cafe.id", "pay.doit.id", "*.cdn.example.net"];

  it("reaches only allowlisted hosts before authorization", async () => {
    const { sim } = setup();
    await sim.syncWalledGarden(ctxA, [...hosts, "Order.Cafe.ID."]);
    const reach = (host: string, device: string | null = null) =>
      sim.canReach(tenantA, outletA1, device, host);
    expect(reach("order.cafe.id")).toBe(true);
    expect(reach("ORDER.cafe.id")).toBe(true);
    expect(reach("pay.doit.id")).toBe(true);
    expect(reach("img.cdn.example.net")).toBe(true);
    expect(reach("cdn.example.net")).toBe(false);
    expect(reach("example.com")).toBe(false);
    expect(reach("evilpay.doit.id")).toBe(false);
    // Another outlet or tenant has no allowlist.
    expect(sim.canReach(tenantA, outletA2, null, "pay.doit.id")).toBe(false);
    expect(sim.canReach(tenantB, outletB1, null, "pay.doit.id")).toBe(false);
  });

  it("lets an online device reach any host and a blocked one only the garden", async () => {
    const { sim } = setup();
    await sim.syncWalledGarden(ctxA, hosts);
    expect(sim.canReach(tenantA, outletA1, MAC, "example.com")).toBe(false);
    await sim.authorize(ctxA, request());
    expect(sim.canReach(tenantA, outletA1, MAC, "example.com")).toBe(true);
    await sim.revoke(ctxA, ref("grant-1"));
    expect(sim.canReach(tenantA, outletA1, MAC, "example.com")).toBe(false);
    expect(sim.canReach(tenantA, outletA1, MAC, "pay.doit.id")).toBe(true);
  });

  it("refuses an invalid host list and an untrusted context", async () => {
    const { sim } = setup();
    await expect(
      sim.syncWalledGarden(ctxA, ["https://pay.doit.id"]),
    ).rejects.toThrow();
    await expect(
      sim.syncWalledGarden({} as ScopedTenantContext, hosts),
    ).rejects.toThrow(TypeError);
  });
});

describe("scripted faults", () => {
  it("timeout and transport_error throw a WifiProviderError and apply nothing", async () => {
    const { sim } = setup();
    sim.script("authorize", "timeout").script("authorize", "transport_error");
    await expect(sim.authorize(ctxA, request())).rejects.toMatchObject({
      code: "WIFI_PROVIDER_TIMEOUT",
    });
    await expect(sim.authorize(ctxA, request())).rejects.toBeInstanceOf(
      WifiProviderError,
    );
    expect(access(sim)).toEqual({ state: "blocked" });
    // The queue is spent: the next call is ok and the reference is still free.
    expect(await sim.authorize(ctxA, request())).toMatchObject({
      authorized: true,
    });
    expect(sim.calls.authorize).toBe(3);
  });

  it("applied_then_timeout applies the grant and the retry replays it", async () => {
    const { sim } = setup();
    sim.script("authorize", "applied_then_timeout");
    await expect(sim.authorize(ctxA, request())).rejects.toMatchObject({
      code: "WIFI_PROVIDER_TIMEOUT",
    });
    expect(access(sim).state).toBe("online");
    expect(await sim.authorize(ctxA, request())).toEqual({
      reference: "grant-1",
      authorized: true,
    });
    expect(sim.requests).toHaveLength(1);
  });

  it("reject answers authorized false, applies nothing, and keeps an older grant", async () => {
    const { sim } = setup();
    await sim.authorize(ctxA, request());
    sim.script("authorize", "reject");
    expect(
      await sim.authorize(
        ctxA,
        request({ reference: "grant-2", bandwidthKbps: 1_000 }),
      ),
    ).toEqual({ reference: "grant-2", authorized: false });
    expect(access(sim)).toMatchObject({ reference: "grant-1" });
  });

  it("revoke faults: nothing applied, or applied then timeout", async () => {
    const { sim } = setup();
    await sim.authorize(ctxA, request());
    sim.script("revoke", "timeout").script("revoke", "reject");
    await expect(sim.revoke(ctxA, ref("grant-1"))).rejects.toMatchObject({
      code: "WIFI_PROVIDER_TIMEOUT",
    });
    await expect(sim.revoke(ctxA, ref("grant-1"))).rejects.toMatchObject({
      code: "WIFI_PROVIDER_UNAVAILABLE",
    });
    expect(access(sim).state).toBe("online");
    sim.script("revoke", "applied_then_timeout");
    await expect(sim.revoke(ctxA, ref("grant-1"))).rejects.toBeInstanceOf(
      WifiProviderError,
    );
    expect(access(sim)).toEqual({ state: "blocked" });
    expect(sim.calls.revoke).toBe(3);
  });

  it("sync faults leave the old allowlist in place", async () => {
    const { sim } = setup();
    await sim.syncWalledGarden(ctxA, ["pay.doit.id"]);
    sim.script("syncWalledGarden", "timeout");
    await expect(
      sim.syncWalledGarden(ctxA, ["other.cafe.id"]),
    ).rejects.toMatchObject({ code: "WIFI_PROVIDER_TIMEOUT" });
    expect(sim.canReach(tenantA, outletA1, null, "pay.doit.id")).toBe(true);
    expect(sim.canReach(tenantA, outletA1, null, "other.cafe.id")).toBe(false);
    expect(sim.calls.syncWalledGarden).toBe(2);
  });

  it("does not count or consume a script for a refused call", async () => {
    const { sim } = setup();
    sim.script("authorize", "timeout");
    await expect(sim.authorize(ctxB, request())).rejects.toThrow(
      "Tenant mismatch",
    );
    expect(sim.calls.authorize).toBe(0);
    await expect(sim.authorize(ctxA, request())).rejects.toMatchObject({
      code: "WIFI_PROVIDER_TIMEOUT",
    });
  });
});

describe("createDefaultWifiProvider", () => {
  it("gives a simulator in dev and test", () => {
    expect(
      createDefaultWifiProvider({ simulator: true, production: false }),
    ).toBeInstanceOf(WifiControllerSimulator);
  });

  it("throws for a simulator in production", () => {
    expect(() =>
      createDefaultWifiProvider({ simulator: true, production: true }),
    ).toThrow("not allowed in production");
  });

  it("gives null without a simulator until a vendor adapter is registered", () => {
    expect(
      createDefaultWifiProvider({ simulator: false, production: true }),
    ).toBeNull();
    expect(
      createDefaultWifiProvider({ simulator: false, production: false }),
    ).toBeNull();
  });

  it("defaults production from NODE_ENV", () => {
    const previous = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      expect(() => createDefaultWifiProvider({ simulator: true })).toThrow();
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});
