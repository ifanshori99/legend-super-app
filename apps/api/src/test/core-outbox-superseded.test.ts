// legend-gzcw (bundle 1158, card 1): a superseded outbox dispatch job is a
// no-op and a lease-expiry recovery is observable.
//
// Source of truth: bead legend-gzcw ("consider returning a superseded-
// generation result from consumeOutbox so the job completes without retries,
// and emit a counter/log line when recoverExpiredDispatches re-dispatches a
// row"; PRD section 3 F3 outbox, section 5 Worker).
//
// Assumptions (spec is open on the exact shape; recorded here and in the report):
// - "Superseded" = a job whose generation is lower than the row's current
//   dispatch generation (after a lease-expiry recovery or an operator replay).
//   consumeOutbox then RESOLVES instead of throwing (pg-boss retries a thrown
//   job five times and dead-letters it), never calls deliver, and returns a
//   value that is not `true`. The exact value (`false` or a "superseded"
//   marker) is not asserted.
// - A dead-lettered job at the CURRENT generation keeps throwing
//   "Stale or dead-lettered job": only the superseded case becomes a no-op.
// - The recovery log goes through the shared pino `logger` of lib/logger (the
//   logger itself or a child of it), at any level, emitted by relayOutbox's
//   sweep. The line mentions "recover" or "re-dispatch" and carries the number
//   of recovered rows as a standalone number; no line is written when the
//   sweep recovers nothing.
// - The two existing assertions in core-outbox.test.ts that expect a stale
//   generation-0 job to reject conflict with this card; the implementer
//   updates them (this file does not touch existing tests).
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { tenantIdSchema } from "@starter/shared/core";
import { eventFixture } from "@starter/shared/events";
import * as schema from "../db/schema";
import { withTenant } from "../db/tenant";
import { logger } from "../lib/logger";
import {
  appendOutbox,
  consumeOutbox,
  markOutboxDead,
  relayOutbox,
} from "../services/core-outbox";

const appPool = new Pool({ connectionString: process.env.APP_DATABASE_URL });
const database = drizzle(appPool, { schema });
const context = (tenantId: string) =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "domain",
    }),
    { kind: "tenant" },
  );

// ULID-shaped ids, unique per call so tests never collide on a shared database.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulid = () =>
  "01" +
  Array.from(
    { length: 24 },
    () => CROCKFORD[Math.floor(Math.random() * 32)],
  ).join("");

const jobId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const enqueue = async () => jobId;

function outboxRow(tenant: string) {
  const id = ulid();
  return {
    id,
    event: {
      ...eventFixture,
      tenantId: tenant,
      outletId: null,
      id: ulid(),
      aggregateId: ulid(),
      sequence: 1,
    },
    destination: "test",
    direction: null,
    peerId: null,
  } as const;
}

async function append(tenant: string, row: ReturnType<typeof outboxRow>) {
  await withTenant(database, context(tenant), (tx) =>
    appendOutbox(tx, context(tenant), row),
  );
}

async function expireLease(tenant: string, eventId: string) {
  await withTenant(database, context(tenant), (tx) =>
    tx.execute(
      sql`UPDATE domain_event_outbox SET dispatch_lease_until = now() - interval '1 second' WHERE event->>'id' = ${eventId}`,
    ),
  );
}

async function state(tenant: string, eventId: string) {
  return withTenant(
    database,
    context(tenant),
    async (tx) =>
      (
        await tx.execute(
          sql`SELECT dispatch_state, dispatch_generation FROM domain_event_outbox WHERE event->>'id' = ${eventId}`,
        )
      ).rows[0],
  );
}

// Captures every line written through the shared logger or a child of it.
function captureLogs() {
  const lines: string[] = [];
  const record = (...args: unknown[]) => {
    for (const arg of args) {
      try {
        lines.push(
          typeof arg === "string"
            ? arg
            : JSON.stringify(arg, Object.getOwnPropertyNames(arg ?? {})),
        );
      } catch {
        lines.push(String(arg));
      }
    }
  };
  const levels = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
  const spyLevels = (target: Record<string, unknown>) => {
    for (const level of levels)
      if (typeof target[level] === "function")
        vi.spyOn(
          target as Record<string, (...a: unknown[]) => unknown>,
          level,
        ).mockImplementation((...args: unknown[]) => record(...args));
  };
  spyLevels(logger as unknown as Record<string, unknown>);
  const originalChild = logger.child.bind(logger);
  vi.spyOn(logger, "child").mockImplementation(((...args: unknown[]) => {
    const child = (originalChild as (...a: unknown[]) => unknown)(...args);
    spyLevels(child as Record<string, unknown>);
    return child;
  }) as unknown as typeof logger.child);
  return lines;
}

afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  await appPool.end();
});

describe("legend-gzcw outbox superseded job and recovery visibility", () => {
  it("legend-gzcw a superseded job completes as a no-op: no throw, no delivery, current generation untouched", async () => {
    const tenant = randomUUID();
    const row = outboxRow(tenant);
    await append(tenant, row);
    expect(await relayOutbox(database, context(tenant), enqueue)).toBe(1);
    // pg-boss lost the job; the lease expired and the sweep re-dispatches it
    // as generation 1.
    await expireLease(tenant, row.event.id);
    expect(await relayOutbox(database, context(tenant), enqueue)).toBe(1);

    const deliver = vi.fn(async () => {});
    // The old generation-0 job finally runs: it must finish quietly so
    // pg-boss does not retry it five times and dead-letter it.
    const result = await consumeOutbox(database, context(tenant), {
      outboxId: row.id,
      generation: 0,
      authorize: async () => true,
      deliver,
    });
    expect(result).not.toBe(true);
    expect(deliver).not.toHaveBeenCalled();
    // The superseded no-op must not dead-letter or otherwise move the row.
    const after = await state(tenant, row.event.id);
    expect(after?.dispatch_state).toBe("queued");
    expect(Number(after?.dispatch_generation)).toBe(1);

    // Calling it again is still harmless (pg-boss may deliver it twice).
    await expect(
      consumeOutbox(database, context(tenant), {
        outboxId: row.id,
        generation: 0,
        authorize: async () => true,
        deliver,
      }),
    ).resolves.not.toBe(true);
    expect(deliver).not.toHaveBeenCalled();

    // The current generation still delivers exactly once.
    expect(
      await consumeOutbox(database, context(tenant), {
        outboxId: row.id,
        generation: 1,
        authorize: async () => true,
        deliver,
      }),
    ).toBe(true);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("legend-gzcw a job dead-lettered at its own generation still fails loudly", async () => {
    const tenant = randomUUID();
    const row = outboxRow(tenant);
    await append(tenant, row);
    expect(await relayOutbox(database, context(tenant), enqueue)).toBe(1);
    await markOutboxDead(database, context(tenant), {
      outboxId: row.id,
      generation: 0,
    });
    const deliver = vi.fn(async () => {});
    await expect(
      consumeOutbox(database, context(tenant), {
        outboxId: row.id,
        generation: 0,
        authorize: async () => true,
        deliver,
      }),
    ).rejects.toThrow("Stale or dead-lettered job");
    expect(deliver).not.toHaveBeenCalled();
  });

  it("legend-gzcw a lease-expiry recovery is logged with the number of recovered rows", async () => {
    const tenant = randomUUID();
    const first = outboxRow(tenant);
    const second = outboxRow(tenant);
    await append(tenant, first);
    await append(tenant, second);
    expect(await relayOutbox(database, context(tenant), enqueue)).toBe(2);
    await expireLease(tenant, first.event.id);
    await expireLease(tenant, second.event.id);

    const lines = captureLogs();
    expect(await relayOutbox(database, context(tenant), enqueue)).toBe(2);
    const recoveryLines = lines.filter((line) =>
      /recover|re-?dispatch/i.test(line),
    );
    expect(recoveryLines.length).toBeGreaterThan(0);
    expect(recoveryLines.some((line) => /\b2\b/.test(line))).toBe(true);
  });

  it("legend-gzcw a sweep that recovers nothing writes no recovery line", async () => {
    const tenant = randomUUID();
    const row = outboxRow(tenant);
    await append(tenant, row);
    expect(await relayOutbox(database, context(tenant), enqueue)).toBe(1);

    const lines = captureLogs();
    // The lease is still live: nothing to recover, nothing to dispatch.
    expect(await relayOutbox(database, context(tenant), enqueue)).toBe(0);
    expect(lines.filter((line) => /recover|re-?dispatch/i.test(line))).toEqual(
      [],
    );
  });
});
