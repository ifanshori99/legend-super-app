// Staff pin pepper derivation on the cloud and the edge registry (bead
// legend-ideif; PRD v1.7 §3 F6, EDG-02, TEN-02). An edge node never holds the
// root STAFF_PIN_PEPPER: it only holds the peppers the cloud derived for its
// own tenant. Pure functions and in-memory state: no database.
//
// Each case loads a fresh module graph so the cloud derivation cache, the
// registry state and the mocked current version never leak between cases.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StaffPinBinding } from "../services/device-pin-hash";
import { hashStaffPin, verifyStaffPinHash } from "../services/device-pin-hash";

type Pepper = typeof import("../services/device-pin-pepper");
type Registry = typeof import("../edge/staff-pin-pepper-registry");

let loaded: Registry | null = null;

/** Fresh modules; `currentVersion` mocks STAFF_PIN_PEPPER_CURRENT_VERSION. */
async function load(
  currentVersion = 1,
): Promise<{ pepper: Pepper; registry: Registry }> {
  vi.resetModules();
  // A plain stand-in: the real module parses process.env at import time.
  vi.doMock("../config/env", () => ({
    env: {
      EDGE_MODE: false,
      isProduction: false,
      STAFF_PIN_PEPPER: undefined,
      STAFF_PIN_PEPPER_CURRENT_VERSION: currentVersion,
    },
  }));
  const pepper = await import("../services/device-pin-pepper");
  const registry = await import("../edge/staff-pin-pepper-registry");
  loaded = registry;
  return { pepper, registry };
}

afterEach(() => {
  loaded?.resetEdgeStaffPinPeppers();
  loaded = null;
  vi.doUnmock("../config/env");
});

const PIN = "582914";
const bindingFor = (tenantId: string): StaffPinBinding => ({
  tenantId,
  outletId: randomUUID(),
  userId: randomUUID(),
});

describe("legend-ideif cloud pepper derivation", () => {
  it("is deterministic and differs per tenant", async () => {
    const { pepper } = await load();
    const a = randomUUID();
    const b = randomUUID();
    expect(
      pepper.staffPinPepper(a, 1).equals(pepper.staffPinPepper(a, 1)),
    ).toBe(true);
    expect(pepper.staffPinPepper(a, 1)).toHaveLength(32);
    expect(
      pepper.staffPinPepper(a, 1).equals(pepper.staffPinPepper(b, 1)),
    ).toBe(false);
  });

  it("refuses a version above the current one", async () => {
    const { pepper } = await load(1);
    expect(() => pepper.staffPinPepper(randomUUID(), 2)).toThrow(RangeError);
    expect(pepper.staffPinPepperOrNull(randomUUID(), 2)).toBeNull();
  });

  it("hands an edge only its own tenant's peppers above what it holds", async () => {
    const { pepper } = await load(1);
    const a = randomUUID();
    expect(pepper.staffPinPeppersForEdge(a, 0)).toEqual([
      { version: 1, pepper: pepper.staffPinPepper(a, 1).toString("base64") },
    ]);
    expect(pepper.staffPinPeppersForEdge(a, 1)).toEqual([]);
  });

  it("keeps older versions usable after a rotation to version 3", async () => {
    const { pepper } = await load(3);
    const a = randomUUID();
    expect(pepper.currentStaffPinPepperVersion()).toBe(3);
    for (const version of [1, 2, 3])
      expect(pepper.staffPinPepper(a, version)).toHaveLength(32);
    expect(() => pepper.staffPinPepper(a, 4)).toThrow(RangeError);
    expect(pepper.staffPinPeppersForEdge(a, 1).map((p) => p.version)).toEqual([
      2, 3,
    ]);
    expect(pepper.staffPinPeppersForEdge(a, 0).map((p) => p.version)).toEqual([
      1, 2, 3,
    ]);
    expect(
      pepper.staffPinPepper(a, 1).equals(pepper.staffPinPepper(a, 2)),
    ).toBe(false);
  });
});

describe("legend-ideif edge registry", () => {
  it("serves only the installed tenant and versions", async () => {
    const { pepper, registry } = await load(1);
    const a = randomUUID();
    const b = randomUUID();
    const cloudA = pepper.staffPinPepper(a, 1);
    const cloudB = pepper.staffPinPepper(b, 1);
    registry.installEdgeStaffPinPeppers(a, [{ version: 1, pepper: cloudA }]);

    expect(pepper.staffPinPepper(a, 1).equals(cloudA)).toBe(true);
    expect(() => pepper.staffPinPepper(b, 1)).toThrow(RangeError);
    expect(() => pepper.staffPinPepper(a, 2)).toThrow(RangeError);
    expect(pepper.staffPinPepperOrNull(b, 1)).toBeNull();
    expect(pepper.staffPinPepperOrNull(a, 2)).toBeNull();
    expect(pepper.staffPinPepperOrNull(a, 1)?.equals(cloudA)).toBe(true);
    // Message reads "An edge node cannot derive staff pin peppers."
    expect(() => pepper.staffPinPeppersForEdge(a, 0)).toThrow(
      /edge node cannot derive/,
    );
    expect(pepper.currentStaffPinPepperVersion()).toBe(1);
    // Nothing the registry exports yields another tenant's pepper.
    for (const version of [0, 1, 2, 3])
      expect(registry.edgeStaffPinPepper(b, version)).toBeNull();
    expect(registry.edgeStaffPinPepper(a, 1)?.equals(cloudB)).toBe(false);
  });

  it("reports version 0 when activated but empty, and fails closed", async () => {
    const { pepper, registry } = await load(1);
    const a = randomUUID();
    registry.activateEdgePepperRegistry(a);
    expect(registry.isEdgePepperRegistryActive()).toBe(true);
    expect(pepper.currentStaffPinPepperVersion()).toBe(0);
    expect(() => pepper.staffPinPepper(a, 1)).toThrow(RangeError);
    expect(pepper.staffPinPepperOrNull(a, 1)).toBeNull();
  });

  it("refuses a second tenant on the same box", async () => {
    const { registry } = await load(1);
    registry.activateEdgePepperRegistry(randomUUID());
    expect(() => registry.activateEdgePepperRegistry(randomUUID())).toThrow(
      RangeError,
    );
  });

  it("verifies a pin with the delivered pepper, not with another tenant's", async () => {
    const { pepper, registry } = await load(1);
    const a = randomUUID();
    const b = randomUUID();
    const cloudA = pepper.staffPinPepper(a, 1);
    const cloudB = pepper.staffPinPepper(b, 1);
    registry.installEdgeStaffPinPeppers(a, [{ version: 1, pepper: cloudA }]);
    const binding = bindingFor(a);
    const stored = await hashStaffPin({
      pepper: pepper.staffPinPepper(a),
      binding,
      pin: PIN,
    });
    expect(
      await verifyStaffPinHash({
        pepper: cloudA,
        binding,
        pin: PIN,
        stored,
      }),
    ).toBe(true);
    expect(
      await verifyStaffPinHash({
        pepper: cloudB,
        binding,
        pin: PIN,
        stored,
      }),
    ).toBe(false);
  });

  it("verifies old and new hashes after a rotation delivered later", async () => {
    const { pepper, registry } = await load(2);
    const a = randomUUID();
    const v1 = pepper.staffPinPepper(a, 1);
    const v2 = pepper.staffPinPepper(a, 2);
    const binding = bindingFor(a);
    const oldHash = await hashStaffPin({ pepper: v1, binding, pin: PIN });
    const newHash = await hashStaffPin({ pepper: v2, binding, pin: PIN });

    registry.installEdgeStaffPinPeppers(a, [{ version: 1, pepper: v1 }]);
    expect(registry.edgeStaffPinPepperLatest()).toBe(1);
    registry.installEdgeStaffPinPeppers(a, [{ version: 2, pepper: v2 }]);
    expect(registry.edgeStaffPinPepperLatest()).toBe(2);
    expect(pepper.currentStaffPinPepperVersion()).toBe(2);

    expect(
      await verifyStaffPinHash({
        pepper: pepper.staffPinPepper(a, 1),
        binding,
        pin: PIN,
        stored: oldHash,
      }),
    ).toBe(true);
    expect(
      await verifyStaffPinHash({
        pepper: pepper.staffPinPepper(a, 2),
        binding,
        pin: PIN,
        stored: newHash,
      }),
    ).toBe(true);
  });

  it("reports as 'have' only the contiguous run from version 1 (a missing lower version is refetched)", async () => {
    const { registry } = await load();
    const tenant = randomUUID();
    const pepper = (n: number) => Buffer.alloc(32, n);
    expect(registry.edgeStaffPinPepperContiguous()).toBe(0);
    registry.installEdgeStaffPinPeppers(tenant, [
      { version: 2, pepper: pepper(2) },
    ]);
    expect(registry.edgeStaffPinPepperLatest()).toBe(2);
    expect(registry.edgeStaffPinPepperContiguous()).toBe(0);
    registry.installEdgeStaffPinPeppers(tenant, [
      { version: 1, pepper: pepper(1) },
    ]);
    expect(registry.edgeStaffPinPepperContiguous()).toBe(2);
  });
});
