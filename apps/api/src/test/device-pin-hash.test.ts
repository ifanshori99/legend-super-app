// Staff pin hashing and offline (edge) verification (bead legend-dxb; PRD v1.7
// §3 F6 "Staf — PIN Perangkat", §6 B staff_pins "(T, E)"). Pure functions: no
// database, no environment, so the same checks run on the outlet edge.
import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  STAFF_PIN_HASH_ALGORITHM,
  staffPinEdgeRecordSchema,
  type StaffPinEdgeRecord,
} from "@starter/shared/access/override";
import {
  hashStaffPin,
  STAFF_PIN_KDF,
  verifyStaffPinHash,
  verifyStaffPinOffline,
  type StaffPinBinding,
} from "../services/device-pin-hash";

const PIN = "582914";
const pepper = randomBytes(32);
const binding = (): StaffPinBinding => ({
  tenantId: randomUUID(),
  outletId: randomUUID(),
  userId: randomUUID(),
});

async function edgeRecord(
  owner: StaffPinBinding,
  state: Partial<
    Pick<StaffPinEdgeRecord, "failedAttempts" | "lockedUntil">
  > = {},
): Promise<StaffPinEdgeRecord> {
  const hashed = await hashStaffPin({ pepper, binding: owner, pin: PIN });
  return staffPinEdgeRecordSchema.parse({
    id: randomUUID(),
    ...owner,
    algorithm: STAFF_PIN_HASH_ALGORITHM,
    salt: hashed.salt,
    pinHash: hashed.pinHash,
    params: hashed.params,
    pepperVersion: 1,
    failedAttempts: state.failedAttempts ?? 0,
    lockedUntil: state.lockedUntil ?? null,
    updatedAt: new Date().toISOString(),
    pinGenerationAt: new Date().toISOString(),
  });
}

describe("legend-dxb §3 F6 staff pin hash", () => {
  it("§3 F6 the stored hash is a salted keyed digest, never the pin, and differs per salt", async () => {
    const owner = binding();
    const first = await hashStaffPin({ pepper, binding: owner, pin: PIN });
    const second = await hashStaffPin({ pepper, binding: owner, pin: PIN });
    expect(first.pinHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.pinHash).not.toContain(PIN);
    expect(first.salt).not.toContain(PIN);
    expect(Buffer.from(first.salt, "base64")).toHaveLength(16);
    // Fresh random salt: the same pin never produces the same hash twice.
    expect(first.salt).not.toBe(second.salt);
    expect(first.pinHash).not.toBe(second.pinHash);
    expect(first.params).toEqual(STAFF_PIN_KDF);
    expect(
      await verifyStaffPinHash({
        pepper,
        binding: owner,
        pin: PIN,
        stored: first,
      }),
    ).toBe(true);
    expect(
      await verifyStaffPinHash({
        pepper,
        binding: owner,
        pin: "582915",
        stored: first,
      }),
    ).toBe(false);
  });

  it("§3 F6 a hash is bound to its tenant pepper, outlet and user (copying it elsewhere never verifies)", async () => {
    const owner = binding();
    const stored = await hashStaffPin({ pepper, binding: owner, pin: PIN });
    for (const other of [
      { ...owner, userId: randomUUID() },
      { ...owner, outletId: randomUUID() },
      { ...owner, tenantId: randomUUID() },
    ])
      expect(
        await verifyStaffPinHash({ pepper, binding: other, pin: PIN, stored }),
      ).toBe(false);
    expect(
      await verifyStaffPinHash({
        pepper: randomBytes(32),
        binding: owner,
        pin: PIN,
        stored,
      }),
    ).toBe(false);
  });

  it("§3 F6 malformed input fails closed without echoing the pin", async () => {
    const owner = binding();
    await expect(
      hashStaffPin({ pepper, binding: owner, pin: "12345" }),
    ).rejects.toThrow(/6-digit/);
    await expect(
      hashStaffPin({ pepper: randomBytes(8), binding: owner, pin: PIN }),
    ).rejects.toThrow(/pepper/);
    const stored = await hashStaffPin({ pepper, binding: owner, pin: PIN });
    expect(
      await verifyStaffPinHash({
        pepper,
        binding: owner,
        pin: "58291a",
        stored,
      }),
    ).toBe(false);
  });
});

describe("legend-dxb §3 F6 offline verify on the edge", () => {
  it("§3 F6 five misses lock offline, the lock refuses even the right pin, success resets", async () => {
    const owner = binding();
    let record = await edgeRecord(owner);
    const now = new Date();
    for (let attempt = 1; attempt <= 5; attempt++) {
      const result = await verifyStaffPinOffline({
        record,
        pepper,
        pin: "000111",
        now,
      });
      expect(result.outcome).toBe(attempt < 5 ? "invalid" : "locked");
      expect(result.state.failedAttempts).toBe(attempt);
      record = { ...record, ...result.state };
    }
    expect(record.lockedUntil).not.toBeNull();
    const whileLocked = await verifyStaffPinOffline({
      record,
      pepper,
      pin: PIN,
      now,
    });
    expect(whileLocked.outcome).toBe("locked");
    expect(whileLocked.state).toEqual({
      failedAttempts: 5,
      lockedUntil: record.lockedUntil,
    });

    // A correct pin before the limit resets the counter.
    const partly = await edgeRecord(owner, { failedAttempts: 3 });
    const ok = await verifyStaffPinOffline({
      record: partly,
      pepper,
      pin: PIN,
      now,
    });
    expect(ok).toEqual({
      outcome: "ok",
      state: { failedAttempts: 0, lockedUntil: null },
    });

    // An expired lock starts a fresh count.
    const expired = await edgeRecord(owner, {
      failedAttempts: 5,
      lockedUntil: new Date(now.getTime() - 1_000).toISOString(),
    });
    const fresh = await verifyStaffPinOffline({
      record: expired,
      pepper,
      pin: "000111",
      now,
    });
    expect(fresh).toEqual({
      outcome: "invalid",
      state: { failedAttempts: 1, lockedUntil: null },
    });
  });

  it("§3 F6 the replication record never carries a pin field", async () => {
    const record = await edgeRecord(binding());
    expect(Object.keys(record).sort()).toEqual(
      [
        "algorithm",
        "failedAttempts",
        "id",
        "lockedUntil",
        "outletId",
        "params",
        "pepperVersion",
        "pinGenerationAt",
        "pinHash",
        "salt",
        "tenantId",
        "updatedAt",
        "userId",
      ].sort(),
    );
    expect(JSON.stringify(record)).not.toContain(PIN);
    expect(
      staffPinEdgeRecordSchema.safeParse({ ...record, pin: PIN }).success,
    ).toBe(false);
  });
});
