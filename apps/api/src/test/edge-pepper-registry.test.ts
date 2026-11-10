// Staff pin pepper derivation on the cloud and the edge registry (beads
// legend-ideif, legend-jmsdx; PRD v1.7 §3 F6, EDG-02, TEN-02). An edge node
// never holds the root STAFF_PIN_PEPPER: it only holds the peppers the cloud
// derived for its own outlet (version >= 2; version 1 is per tenant, cloud
// only). Pure functions and in-memory state: no database.
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
  currentVersion = 2,
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
const bindingFor = (tenantId: string, outletId: string): StaffPinBinding => ({
  tenantId,
  outletId,
  userId: randomUUID(),
});

describe("legend-jmsdx cloud pepper derivation", () => {
  it("is deterministic and differs per outlet and per tenant (version 2+)", async () => {
    const { pepper } = await load();
    const t1 = randomUUID();
    const t2 = randomUUID();
    const a = randomUUID();
    const b = randomUUID();
    expect(
      pepper.staffPinPepper(t1, a, 2).equals(pepper.staffPinPepper(t1, a, 2)),
    ).toBe(true);
    expect(pepper.staffPinPepper(t1, a, 2)).toHaveLength(32);
    expect(
      pepper.staffPinPepper(t1, a, 2).equals(pepper.staffPinPepper(t1, b, 2)),
    ).toBe(false);
    expect(
      pepper.staffPinPepper(t1, a, 2).equals(pepper.staffPinPepper(t2, a, 2)),
    ).toBe(false);
  });

  it("derives version 1 per tenant (same for every outlet), different from version 2", async () => {
    const { pepper } = await load();
    const t = randomUUID();
    const a = randomUUID();
    const b = randomUUID();
    expect(
      pepper.staffPinPepper(t, a, 1).equals(pepper.staffPinPepper(t, b, 1)),
    ).toBe(true);
    expect(
      pepper.staffPinPepper(t, a, 1).equals(pepper.staffPinPepper(t, a, 2)),
    ).toBe(false);
  });

  it("treats ids case-insensitively", async () => {
    const { pepper } = await load();
    const t = randomUUID();
    const a = randomUUID();
    expect(
      pepper
        .staffPinPepper(t.toUpperCase(), a.toUpperCase(), 2)
        .equals(pepper.staffPinPepper(t, a, 2)),
    ).toBe(true);
  });

  it("refuses a version above the current one", async () => {
    const { pepper } = await load(2);
    const t = randomUUID();
    const o = randomUUID();
    expect(() => pepper.staffPinPepper(t, o, 3)).toThrow(RangeError);
    expect(pepper.staffPinPepperOrNull(t, o, 3)).toBeNull();
  });

  it("hands an edge only its outlet's peppers it lacks, never version 1", async () => {
    const { pepper } = await load(3);
    const t = randomUUID();
    const o = randomUUID();
    const p = (version: number) => ({
      version,
      pepper: pepper.staffPinPepper(t, o, version).toString("base64"),
    });
    // Used versions of the outlet's rows + the current one.
    expect(pepper.staffPinPeppersForEdge(t, o, [], [1, 2])).toEqual([
      p(2),
      p(3),
    ]);
    expect(pepper.staffPinPeppersForEdge(t, o, [2], [1, 2])).toEqual([p(3)]);
    expect(pepper.staffPinPeppersForEdge(t, o, [2, 3], [2])).toEqual([]);
    // Only the current one when no row uses an older version.
    expect(pepper.staffPinPeppersForEdge(t, o, [], [])).toEqual([p(3)]);
    // A used version above the current one is never sent.
    expect(pepper.staffPinPeppersForEdge(t, o, [], [2, 9])).toEqual([
      p(2),
      p(3),
    ]);
  });

  it("sends nothing when the current version is 1 (old dev data)", async () => {
    const { pepper } = await load(1);
    expect(
      pepper.staffPinPeppersForEdge(randomUUID(), randomUUID(), [], [1]),
    ).toEqual([]);
  });

  it("keeps older versions usable after a rotation to version 4", async () => {
    const { pepper } = await load(4);
    const t = randomUUID();
    const o = randomUUID();
    expect(pepper.currentStaffPinPepperVersion()).toBe(4);
    for (const version of [1, 2, 3, 4])
      expect(pepper.staffPinPepper(t, o, version)).toHaveLength(32);
    expect(() => pepper.staffPinPepper(t, o, 5)).toThrow(RangeError);
    expect(
      pepper.staffPinPepper(t, o, 2).equals(pepper.staffPinPepper(t, o, 3)),
    ).toBe(false);
  });
});

describe("legend-jmsdx edge registry", () => {
  it("serves only the installed outlet and versions", async () => {
    const { pepper, registry } = await load(3);
    const t = randomUUID();
    const a = randomUUID();
    const b = randomUUID();
    const cloudA = pepper.staffPinPepper(t, a, 2);
    const cloudB = pepper.staffPinPepper(t, b, 2);
    registry.installEdgeStaffPinPeppers(t, a, [{ version: 2, pepper: cloudA }]);

    expect(pepper.staffPinPepper(t, a, 2).equals(cloudA)).toBe(true);
    // Another outlet of the same tenant, another tenant, another version, and
    // version 1 (never delivered to an edge).
    expect(() => pepper.staffPinPepper(t, b, 2)).toThrow(RangeError);
    expect(() => pepper.staffPinPepper(randomUUID(), a, 2)).toThrow(RangeError);
    expect(() => pepper.staffPinPepper(t, a, 3)).toThrow(RangeError);
    expect(() => pepper.staffPinPepper(t, a, 1)).toThrow(RangeError);
    expect(pepper.staffPinPepperOrNull(t, b, 2)).toBeNull();
    expect(pepper.staffPinPepperOrNull(t, a, 1)).toBeNull();
    expect(pepper.staffPinPepperOrNull(t, a, 2)?.equals(cloudA)).toBe(true);
    // Message reads "An edge node cannot derive staff pin peppers."
    expect(() => pepper.staffPinPeppersForEdge(t, a, [], [])).toThrow(
      /edge node cannot derive/,
    );
    expect(pepper.currentStaffPinPepperVersion()).toBe(2);
    // Nothing the registry exports yields another outlet's pepper.
    for (const version of [0, 1, 2, 3])
      expect(registry.edgeStaffPinPepper(t, b, version)).toBeNull();
    expect(registry.edgeStaffPinPepper(t, a, 2)?.equals(cloudB)).toBe(false);
  });

  it("reports version 0 when activated but empty, and fails closed", async () => {
    const { pepper, registry } = await load();
    const t = randomUUID();
    const o = randomUUID();
    registry.activateEdgePepperRegistry(t, o);
    expect(registry.isEdgePepperRegistryActive()).toBe(true);
    expect(pepper.currentStaffPinPepperVersion()).toBe(0);
    expect(() => pepper.staffPinPepper(t, o, 2)).toThrow(RangeError);
    expect(pepper.staffPinPepperOrNull(t, o, 2)).toBeNull();
    expect(registry.edgeStaffPinPepperVersionsHeld()).toEqual([]);
  });

  it("refuses a second tenant or a second outlet on the same box", async () => {
    const { registry } = await load();
    const t = randomUUID();
    registry.activateEdgePepperRegistry(t, randomUUID());
    expect(() =>
      registry.activateEdgePepperRegistry(randomUUID(), randomUUID()),
    ).toThrow(RangeError);
    expect(() => registry.activateEdgePepperRegistry(t, randomUUID())).toThrow(
      RangeError,
    );
  });

  it("refuses to hold version 1 or an invalid version", async () => {
    const { registry } = await load();
    const t = randomUUID();
    const o = randomUUID();
    for (const version of [1, 0, -1, 2.5])
      expect(() =>
        registry.installEdgeStaffPinPeppers(t, o, [
          { version, pepper: Buffer.alloc(32, 1) },
        ]),
      ).toThrow(RangeError);
  });

  it("verifies a pin with the delivered pepper, not with another outlet's", async () => {
    const { pepper, registry } = await load();
    const t = randomUUID();
    const a = randomUUID();
    const b = randomUUID();
    const cloudA = pepper.staffPinPepper(t, a, 2);
    const cloudB = pepper.staffPinPepper(t, b, 2);
    registry.installEdgeStaffPinPeppers(t, a, [{ version: 2, pepper: cloudA }]);
    const binding = bindingFor(t, a);
    const stored = await hashStaffPin({
      pepper: pepper.staffPinPepper(t, a),
      binding,
      pin: PIN,
    });
    expect(
      await verifyStaffPinHash({ pepper: cloudA, binding, pin: PIN, stored }),
    ).toBe(true);
    expect(
      await verifyStaffPinHash({ pepper: cloudB, binding, pin: PIN, stored }),
    ).toBe(false);
  });

  it("verifies old and new hashes after a rotation delivered later", async () => {
    const { pepper, registry } = await load(3);
    const t = randomUUID();
    const o = randomUUID();
    const v2 = pepper.staffPinPepper(t, o, 2);
    const v3 = pepper.staffPinPepper(t, o, 3);
    const binding = bindingFor(t, o);
    const oldHash = await hashStaffPin({ pepper: v2, binding, pin: PIN });
    const newHash = await hashStaffPin({ pepper: v3, binding, pin: PIN });

    registry.installEdgeStaffPinPeppers(t, o, [{ version: 2, pepper: v2 }]);
    expect(registry.edgeStaffPinPepperLatest()).toBe(2);
    registry.installEdgeStaffPinPeppers(t, o, [{ version: 3, pepper: v3 }]);
    expect(registry.edgeStaffPinPepperLatest()).toBe(3);
    expect(pepper.currentStaffPinPepperVersion()).toBe(3);

    expect(
      await verifyStaffPinHash({
        pepper: pepper.staffPinPepper(t, o, 2),
        binding,
        pin: PIN,
        stored: oldHash,
      }),
    ).toBe(true);
    expect(
      await verifyStaffPinHash({
        pepper: pepper.staffPinPepper(t, o, 3),
        binding,
        pin: PIN,
        stored: newHash,
      }),
    ).toBe(true);
  });

  it("reports as 'have' every version held, ascending (a gap is not hidden)", async () => {
    const { registry } = await load();
    const t = randomUUID();
    const o = randomUUID();
    const pepper = (n: number) => Buffer.alloc(32, n);
    expect(registry.edgeStaffPinPepperVersionsHeld()).toEqual([]);
    registry.installEdgeStaffPinPeppers(t, o, [
      { version: 4, pepper: pepper(4) },
      { version: 2, pepper: pepper(2) },
    ]);
    expect(registry.edgeStaffPinPepperLatest()).toBe(4);
    expect(registry.edgeStaffPinPepperVersionsHeld()).toEqual([2, 4]);
    registry.installEdgeStaffPinPeppers(t, o, [
      { version: 3, pepper: pepper(3) },
    ]);
    expect(registry.edgeStaffPinPepperVersionsHeld()).toEqual([2, 3, 4]);
  });
});
