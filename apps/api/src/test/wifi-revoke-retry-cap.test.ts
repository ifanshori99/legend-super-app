// Wi-Fi controller revoke retry cap (bead legend-7z9c, from legend-nffy).
// Written from the bead text and the existing retry tests (edge-wifi-agent,
// edge-wifi-retention), not from the implementation.
//
// Bead: `reconcile` resends a failed controller revoke while `revoke_retry_at`
// is set (backoff 30-300 s by age since ended_at). There was no cap, so a revoke
// the controller refuses for good retried every 300 s forever and the row was
// never purged (retention keeps rows with `revoke_retry_at`). Wanted: a cap
// after which the marker is cleared, plus an alert.
//
// Assumptions (the bead leaves them open):
//  - The cap is measured on the age of the pending revoke (time since
//    `ended_at`) and is well under 31 days; the bead suggests "the grant is
//    dead at the controller once its time ran out". The tests never assert the
//    exact cap: "stale" = ended 31 days ago (beyond any sane cap and beyond
//    WIFI_GRANT_RETENTION_DAYS), "fresh" = ended 2 minutes ago (under any
//    sane cap; the grant lasts hours).
//  - Giving up is observable as: `revoke_retry_at` becomes NULL, the agent stops
//    calling the controller for that row, and the row is purged by the normal
//    retention run. It takes at most 3 `reconcile` runs (300 s apart) once the
//    row is stale: the agent may try once more before giving up.
//  - The alert is a `warn` or `error` line on the shared `logger`
//    (apps/api/src/lib/logger.ts) that contains the grant row id and the word
//    "revoke" (any case). An alert is NOT raised when the revoke succeeds.
//  - The row is seeded as the migration owner: a revoked, controller-less late
//    grant with `revoke_retry_at` already due (the shape the existing retry
//    tests produce through the agent). The controller reference of a revoke is
//    the grant row id (as in edge-wifi-agent.test.ts).
import { randomUUID, createHash } from "node:crypto";
import type { PoolClient } from "pg";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  outletIdSchema,
  tenantIdSchema,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { WifiProvider } from "@starter/shared/adapters";
import { db } from "../db/index.ts";
import { logger } from "../lib/logger.ts";
import { WifiControllerSimulator } from "../edge/wifi/simulator.ts";
import { createWifiAgent } from "../services/edge-wifi-agent.service.ts";
import { purgeExpiredWifiGrants } from "../services/edge-wifi-retention.service.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const DAY_MS = 86_400_000;
const START = new Date("2026-11-09T02:00:00.000Z");
const tenantIds: string[] = [];

// --- log capture --------------------------------------------------------

const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
type Captured = { level: string; text: string };
let captured: Captured[] = [];
const spies: Array<{ mockRestore: () => void }> = [];

function serialise(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v instanceof Error
      ? { name: v.name, message: v.message, stack: v.stack }
      : typeof v === "bigint"
        ? v.toString()
        : v,
  );
}

beforeEach(() => {
  captured = [];
  const target = logger as unknown as Record<
    string,
    (...a: unknown[]) => unknown
  >;
  for (const level of LEVELS) {
    spies.push(
      vi.spyOn(target, level).mockImplementation((...args: unknown[]) => {
        captured.push({ level, text: serialise(args) });
      }),
    );
  }
  spies.push(
    vi.spyOn(target, "child").mockImplementation(() => logger as never),
  );
});

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

/** warn/error lines about `rowId`'s revoke. */
const alertsFor = (rowId: string) =>
  captured.filter(
    (c) =>
      (c.level === "warn" || c.level === "error") &&
      c.text.includes(rowId) &&
      /revoke/i.test(c.text),
  );

// --- database helpers ----------------------------------------------------

const ctxFor = (tenant: IsolatedTenant): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    {
      kind: "outlets",
      outletIds: [outletIdSchema.parse(tenant.outletId)],
    },
  );

async function asOwner<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** A revoked late grant whose controller revoke is owed, due now. */
async function seedPendingRevoke(
  tenant: IsolatedTenant,
  endedAt: Date,
  dueAt: Date,
): Promise<string> {
  const id = randomUUID();
  const mac = randomUUID().replace(/-/g, "").slice(0, 12);
  const hash = createHash("sha256")
    .update(`${tenant.tenantId}:${mac}`)
    .digest("hex");
  await asOwner(tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO wifi_device_grants
        (id, tenant_id, outlet_id, wifi_session_id, device_hash, controller_device_id,
         speed_tier, bandwidth_kbps, base_bandwidth_kbps, duration_seconds, status,
         renew_until, requested_at, authorized_at, expires_at, revoke_requested_at,
         end_reason, ended_at, superseded_by, revoke_retry_at)
       VALUES ($1, $2, $3, $4, $5, NULL, 'full', 20000, 2000, 3900, 'revoked',
         $6, $7, NULL, NULL, $8, 'session_ended', $8, NULL, $9)`,
      [
        id,
        tenant.tenantId,
        tenant.outletId,
        randomUUID(),
        hash,
        new Date(endedAt.getTime() + 8 * 3_600_000),
        new Date(endedAt.getTime() - 3_600_000),
        endedAt,
        dueAt,
      ],
    ),
  );
  return id;
}

async function retryMarker(
  tenant: IsolatedTenant,
  id: string,
): Promise<Date | null | undefined> {
  return asOwner(tenant.tenantId, async (client) => {
    const result = await client.query<{ revoke_retry_at: Date | null }>(
      "SELECT revoke_retry_at FROM wifi_device_grants WHERE tenant_id = $1 AND id = $2",
      [tenant.tenantId, id],
    );
    return result.rows[0] ? result.rows[0].revoke_retry_at : undefined;
  });
}

// --- fixture -------------------------------------------------------------

/**
 * One isolated tenant (one outlet), a controller that records every revoke and
 * either refuses them all (`refuse`) or delegates to the simulator, an agent
 * and a clock the test moves.
 */
async function fixture(options: { refuse: boolean }) {
  const tenant = await createIsolatedTenant(
    `wifirc-${randomUUID().slice(0, 8)}`,
  );
  tenantIds.push(tenant.tenantId);
  let clock = new Date(START);
  const now = () => new Date(clock);
  const sim = new WifiControllerSimulator({ now });
  const ctx = ctxFor(tenant);
  const outletId = outletIdSchema.parse(tenant.outletId);
  const revokeCalls: string[] = [];
  const provider: WifiProvider = {
    authorize: (context, request) => sim.authorize(context, request),
    async revoke(context, reference) {
      revokeCalls.push(reference.reference);
      if (options.refuse) throw new Error("controller refused the revoke");
      return sim.revoke(context, reference);
    },
  };
  const agent = createWifiAgent({
    provider,
    contextFor: (id: OutletId) => {
      if (id !== outletId) throw new Error("No node context for outlet");
      return ctx;
    },
    now,
    providerTimeoutMs: 2_000,
  });
  return {
    tenant,
    ctx,
    outletId,
    agent,
    now,
    revokeCalls,
    advance(seconds: number) {
      clock = new Date(clock.getTime() + seconds * 1000);
    },
  };
}

afterAll(async () => {
  if (tenantIds.length > 0)
    await owner.query(
      "UPDATE tenants SET created_by = $2 WHERE id = ANY($1::uuid[])",
      [tenantIds, randomUUID()],
    );
  await owner.end();
});

describe("Wi-Fi revoke retry cap (legend-7z9c)", () => {
  it("legend-7z9c a revoke refused for good stops retrying, clears the marker and raises an alert", async () => {
    const f = await fixture({ refuse: true });
    const id = await seedPendingRevoke(
      f.tenant,
      new Date(START.getTime() - 31 * DAY_MS),
      START,
    );
    expect(await retryMarker(f.tenant, id)).not.toBeNull();

    // At most 3 runs (300 s apart) until the agent gives up.
    for (let run = 0; run < 3; run++) {
      await f.agent.reconcile(f.ctx, f.outletId);
      f.advance(300);
      if ((await retryMarker(f.tenant, id)) === null) break;
    }
    expect(await retryMarker(f.tenant, id)).toBeNull();
    expect(alertsFor(id).length).toBeGreaterThanOrEqual(1);

    // Given up: no more controller calls and no more alerts for this row.
    const callsAfterGiveUp = f.revokeCalls.length;
    const alertsAfterGiveUp = alertsFor(id).length;
    for (let run = 0; run < 3; run++) {
      f.advance(3_600);
      await f.agent.reconcile(f.ctx, f.outletId);
    }
    expect(f.revokeCalls.length).toBe(callsAfterGiveUp);
    expect(alertsFor(id).length).toBe(alertsAfterGiveUp);
    expect(await retryMarker(f.tenant, id)).toBeNull();
  });

  it("legend-7z9c a given-up row no longer blocks retention", async () => {
    const f = await fixture({ refuse: true });
    const id = await seedPendingRevoke(
      f.tenant,
      new Date(START.getTime() - 31 * DAY_MS),
      START,
    );
    // While the marker is set, retention keeps the row (existing rule).
    expect(await purgeExpiredWifiGrants(db, f.ctx, f.now())).toBe(0);
    for (let run = 0; run < 3; run++) {
      await f.agent.reconcile(f.ctx, f.outletId);
      f.advance(300);
      if ((await retryMarker(f.tenant, id)) === null) break;
    }
    expect(await retryMarker(f.tenant, id)).toBeNull();
    expect(await purgeExpiredWifiGrants(db, f.ctx, f.now())).toBe(1);
    expect(await retryMarker(f.tenant, id)).toBeUndefined();
  });

  it("legend-7z9c a young pending revoke that is refused keeps retrying with a later marker and no give-up", async () => {
    const f = await fixture({ refuse: true });
    const id = await seedPendingRevoke(
      f.tenant,
      new Date(START.getTime() - 120_000),
      START,
    );
    await f.agent.reconcile(f.ctx, f.outletId);
    expect(f.revokeCalls).toEqual([id]);
    const marker = await retryMarker(f.tenant, id);
    expect(marker).toBeInstanceOf(Date);
    expect(marker!.getTime()).toBeGreaterThan(f.now().getTime());
    // Backoff stays within 300 s (nffy): it will be tried again soon.
    expect(marker!.getTime()).toBeLessThanOrEqual(f.now().getTime() + 300_000);
  });

  it("legend-7z9c a stale revoke that finally succeeds clears the marker without an alert", async () => {
    const f = await fixture({ refuse: false });
    const id = await seedPendingRevoke(
      f.tenant,
      new Date(START.getTime() - 31 * DAY_MS),
      START,
    );
    await f.agent.reconcile(f.ctx, f.outletId);
    expect(await retryMarker(f.tenant, id)).toBeNull();
    expect(alertsFor(id)).toEqual([]);
  });
});
