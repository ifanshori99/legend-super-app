import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { EventEnvelope } from "@starter/shared/events";
import { createUlid, outletIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { logger } from "../lib/logger.ts";
import type { EdgeTx } from "../services/edge-queue.service.ts";
import {
  drainParkedAccessEvents,
  registerAccessEdgeApplier,
} from "./access-applier.ts";
import { resetEdgeApplierRegistryForTests } from "./applier-registry.ts";
import { edgeEventApplier } from "./ports.ts";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OUTLET = outletIdSchema.parse("22222222-2222-4222-8222-222222222222");
const PRIVATE = "private-envelope-pin-and-identifiers";
const meta = {
  context: establishScopedTenantContext(
    establishTenantContext({
      tenantId: TENANT,
      brandId: null,
      source: "session",
    }),
    { kind: "outlets", outletIds: [OUTLET] },
  ),
  direction: "edge_to_cloud",
  kind: "transaction_event",
} as const;

afterEach(() => vi.restoreAllMocks());

function brokenDrain(stage: "select" | "update"): EdgeTx {
  const query = {
    from: () => query,
    where: () => query,
    orderBy: () => query,
    limit: () => query,
    for: async () => {
      if (stage === "select") throw new Error(PRIVATE);
      return [
        {
          eventId: PRIVATE,
          edgeNodeId: PRIVATE,
          // A real envelope always has a name (redactEdgeEnvelopeSecrets reads it).
          envelope: { name: "staff_pin.unknown", secret: PRIVATE },
        },
      ];
    },
  };
  const tx = {
    transaction: async <T>(
      run: (savepoint: EdgeTx) => Promise<T>,
    ): Promise<T> => run(tx as unknown as EdgeTx),
    select: () => query,
    update: () => ({
      set: () => ({
        where: async () => {
          throw new Error(PRIVATE);
        },
      }),
    }),
  };
  return tx as unknown as EdgeTx;
}

describe("legend-bzh1z access drain failures are observable", () => {
  it.each(["select", "update"] as const)(
    "propagates %s failures to sweep accounting and logs sanitized metadata",
    async (stage) => {
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
      await expect(
        drainParkedAccessEvents(brokenDrain(stage), meta, OUTLET),
      ).rejects.toThrow(PRIVATE);
      expect(warn).toHaveBeenCalledWith(
        { drained: 0, errorClasses: ["Error"] },
        "Parked edge access drain failed",
      );
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).not.toContain(PRIVATE);
      expect(logged).not.toContain(TENANT);
      expect(logged).not.toContain(OUTLET);
    },
  );
});

describe("legend-bzh1z a failed housekeeping drain preserves live access writes", () => {
  it.each(["select", "update"] as const)(
    "still applies a valid live lock after a parked %s failure",
    async (stage) => {
      vi.spyOn(logger, "warn").mockImplementation(() => undefined);
      resetEdgeApplierRegistryForTests();
      registerAccessEdgeApplier();
      const pin = randomUUID();
      const returning = vi.fn(async () => [{ id: pin }]);
      const liveUpdate = vi.fn(() => ({
        set: () => ({ where: () => ({ returning }) }),
      }));
      const tx = {
        transaction: async <T>(
          run: (savepoint: EdgeTx) => Promise<T>,
        ): Promise<T> => run(brokenDrain(stage)),
        select: (projection: Record<string, unknown>) => ({
          from: () => ({
            where: () => {
              const rows =
                "outletId" in projection
                  ? [{ outletId: OUTLET }]
                  : "banned" in projection
                    ? [{ banned: false }]
                    : [{ id: randomUUID() }];
              return Object.assign(Promise.resolve(rows), {
                limit: async () => rows,
              });
            },
          }),
        }),
        update: liveUpdate,
      };
      const event: EventEnvelope = {
        id: createUlid(),
        tenantId: meta.context.tenant.tenantId,
        outletId: OUTLET,
        name: "staff_pin.locked",
        version: 1,
        aggregateType: "staff_pin",
        aggregateId: pin,
        sequence: 1,
        occurredAt: new Date().toISOString(),
        actor: { type: "system" },
        deviceId: null,
        idempotencyKey: `staff_pin.locked:${pin}`,
        payloadSchemaRef: "staff_pin.locked.v1",
        payload: {
          staffPinId: pin,
          userId: randomUUID(),
          lockedUntil: new Date(Date.now() + 60_000).toISOString(),
        },
      };
      await expect(
        edgeEventApplier("edge_to_cloud").apply(
          tx as unknown as EdgeTx,
          event,
          { ...meta, edgeNodeId: randomUUID() },
        ),
      ).resolves.toBeUndefined();
      expect(liveUpdate).toHaveBeenCalledTimes(1);
      expect(returning).toHaveBeenCalledTimes(1);
      resetEdgeApplierRegistryForTests();
    },
  );
});
