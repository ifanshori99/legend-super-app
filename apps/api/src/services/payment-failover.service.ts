// Automatic "pay at the cashier" failover (PRD §3.13 "Failover", legend-8vgid).
//
// The gateway adapter only answers "how is the gateway right now" (`health()`);
// nothing remembered it. This service turns that live reading into incidents:
//
//   up -> down    one `payment.gateway_failover_started` audit row, and ONE
//                 in-app alert to the outlet's supervisors;
//   down -> up    one `payment.gateway_recovered` audit row.
//
// The incident state lives in the audit log (no new table): each row carries an
// incident number in `maskedChanges.after`, and the newest row decides whether
// an incident is open. A per-outlet advisory lock serialises the transitions,
// so two guests loading their bill during the same outage raise one alert.
//
// Three guards keep the alert meaningful:
//   - an outlet that never set up a gateway reads `down` with reason
//     `unconfigured`: that is not an outage, so nothing is recorded;
//   - a gateway that comes back and fails again within REOPEN_MS reopens the
//     same incident silently (a flapping gateway alerts once, not every minute);
//   - an incident still open after STALE_OPEN_MS is treated as a new one, so a
//     recovery nobody observed (no guest traffic) cannot silence the next
//     outage forever.
//
// Failover never touches money: it records which bills were moved to the
// cashier and leaves intents, payments and `paidIdr` alone. A code that is paid
// at the gateway anyway is settled once by its verified webhook (the existing
// idempotent confirmation path), never twice.
import { and, desc, eq, gt, gte, inArray, isNotNull, sql } from "drizzle-orm";
import {
  createUlid,
  outletIdSchema,
  toIsoDateTime,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { PaymentGatewayStatus } from "@starter/shared/payment";
import { db } from "../db";
import { auditLogs } from "../db/schema/core-audit";
import { withTenant } from "../db/tenant";
import { logger } from "../lib/logger";
import { recordAudit } from "./core-audit";
import { notifyOutletSupervisors } from "./edge-sync-conflict-alert";
import type { GatewayHealth } from "./payment-gateway";
import { outletGatewayHealth } from "./payment-gateway-select";
import type { Tx } from "./permission-resolver";

const FAILOVER_STARTED = "payment.gateway_failover_started";
const STILL_DOWN = "payment.gateway_still_down";
const GATEWAY_RECOVERED = "payment.gateway_recovered";
const LINK_FAILOVER = "payment.link_failover_to_cashier";
const ALERT_EVENT = "payment_gateway.failover_started";
const INCIDENT_FIELDS = [
  "incident",
  "seq",
  "provider",
  "status",
  "reopened",
] as const;

/** Only markers this recent count. */
const MARKER_WINDOW_MS = 7 * 24 * 60 * 60_000;
/** Down again this soon after recovery: the same incident, no new alert. */
export const REOPEN_MS = 10 * 60_000;
/** An open incident whose newest row is this old is closed implicitly; the
 * next `down` alerts. */
export const STALE_OPEN_MS = 6 * 60 * 60_000;
/** A `down` reading that finds the newest row this old renews it
 * (`payment.gateway_still_down`), so a long outage that is being observed
 * never goes stale. Written at most once per interval, however many readings. */
export const HEARTBEAT_MS = 3 * 60 * 60_000;
/** What this process learned from the database is trusted this long, so the
 * hot payment-screen path does not query the audit log on every request. */
const TRUST_MS = 60_000;

export type GatewayTransition =
  "failover_started" | "heartbeat" | "reopened" | "recovered" | "none";

export type GatewayIncidentResult = {
  readonly transition: GatewayTransition;
  /** Incident number while the gateway is down, else null. */
  readonly openIncident: number | null;
};

type IncidentMarker = {
  readonly incident: number;
  readonly open: boolean;
  /** Rows written for the incident so far; the newest row has the highest. */
  readonly seq: number;
  /** When the marker row was written (its own `createdAt`, in ms). */
  readonly at: number;
};

type Known =
  | { readonly state: "up"; readonly until: number }
  | {
      readonly state: "open";
      readonly incident: number;
      readonly until: number;
    };

const known = new Map<string, Known>();
const markedLinks = new Set<string>();

/** For tests: forget what this process learned about outlets and bills. */
export function resetGatewayHealthCache(): void {
  known.clear();
  markedLinks.clear();
}

async function lockKey(tx: Tx, key: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
  );
}

/** Newest marker of the outlet: highest incident number, then highest `seq`
 * (rows are written under the outlet lock, so `seq` never ties). */
async function latestMarker(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
  now: Date,
): Promise<IncidentMarker | null> {
  const written = sql`${auditLogs.event}->>'createdAt'`;
  const [row] = await tx
    .select({
      action: sql<string>`${auditLogs.event}->>'action'`,
      incident: sql<string>`${auditLogs.event}->'maskedChanges'->'after'->>'incident'`,
      seq: sql<string>`${auditLogs.event}->'maskedChanges'->'after'->>'seq'`,
      at: sql<string>`${written}`,
    })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.tenantId, context.tenant.tenantId),
        eq(auditLogs.outletId, outletId),
        gt(auditLogs.createdAt, new Date(now.getTime() - MARKER_WINDOW_MS)),
        sql`${auditLogs.event}->>'action' IN (${FAILOVER_STARTED}, ${STILL_DOWN}, ${GATEWAY_RECOVERED})`,
      ),
    )
    .orderBy(
      desc(
        sql`(${auditLogs.event}->'maskedChanges'->'after'->>'incident')::int`,
      ),
      desc(sql`(${auditLogs.event}->'maskedChanges'->'after'->>'seq')::int`),
    )
    .limit(1);
  if (!row) return null;
  return {
    incident: Number(row.incident),
    seq: Number(row.seq),
    open: row.action !== GATEWAY_RECOVERED,
    at: Date.parse(row.at),
  };
}

type Step = "none" | "recover" | "reopen" | "start" | "heartbeat";

/** What a reading means given the newest marker. Pure. */
function decide(
  marker: IncidentMarker | null,
  isDown: boolean,
  now: Date,
): Step {
  if (!isDown) return marker?.open ? "recover" : "none";
  if (!marker) return "start";
  if (marker.open) {
    const age = now.getTime() - marker.at;
    if (age > STALE_OPEN_MS) return "start";
    return age > HEARTBEAT_MS ? "heartbeat" : "none";
  }
  return now.getTime() - marker.at < REOPEN_MS ? "reopen" : "start";
}

async function writeIncidentRow(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    id: string;
    outletId: string;
    action: string;
    incident: number;
    seq: number;
    /** Provider(s) behind the reading, for the audit row only. */
    provider: string;
    status: PaymentGatewayStatus;
    reopened?: boolean;
    now: Date;
  },
): Promise<void> {
  await recordAudit(
    tx,
    context,
    {
      id: input.id,
      tenantId: context.tenant.tenantId,
      outletId: input.outletId,
      actorType: "system",
      actorId: null,
      deviceId: null,
      action: input.action,
      objectType: "payment_gateway",
      objectId: input.outletId,
      reason: "gateway_health",
      maskedChanges: {
        before: null,
        after: {
          incident: input.incident,
          seq: input.seq,
          provider: input.provider,
          status: input.status,
          ...(input.reopened ? { reopened: true } : {}),
        },
      },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: toIsoDateTime(input.now),
    },
    INCIDENT_FIELDS,
  );
}

/**
 * Outlets of the tenant whose newest marker says an incident is open (the
 * scheduled probe's work list). Oldest incident first. Scoped by tenant row
 * level security plus the explicit tenant filter.
 */
export async function listOutletsWithOpenIncident(
  context: ScopedTenantContext,
  now = new Date(),
  limit = 10,
): Promise<string[]> {
  const incident = sql`(${auditLogs.event}->'maskedChanges'->'after'->>'incident')::int`;
  const seq = sql`(${auditLogs.event}->'maskedChanges'->'after'->>'seq')::int`;
  const rows = await withTenant(db, context, (tx) =>
    tx
      .selectDistinctOn([auditLogs.outletId], {
        outletId: auditLogs.outletId,
        action: sql<string>`${auditLogs.event}->>'action'`,
        at: sql<string>`${auditLogs.event}->>'createdAt'`,
      })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.tenantId, context.tenant.tenantId),
          isNotNull(auditLogs.outletId),
          gt(auditLogs.createdAt, new Date(now.getTime() - MARKER_WINDOW_MS)),
          inArray(sql`${auditLogs.event}->>'action'`, [
            FAILOVER_STARTED,
            STILL_DOWN,
            GATEWAY_RECOVERED,
          ]),
        ),
      )
      .orderBy(auditLogs.outletId, desc(incident), desc(seq)),
  );
  return (
    rows
      // An incident whose NEWEST row is older than STALE_OPEN_MS is implicitly
      // closed (`decide`), so it is not worth a probe slot. Filtered here, after
      // the newest row per outlet is chosen, never before it.
      .filter(
        (row) =>
          row.outletId !== null &&
          row.action !== GATEWAY_RECOVERED &&
          Date.parse(row.at) > now.getTime() - STALE_OPEN_MS,
      )
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
      .slice(0, limit)
      .map((row) => row.outletId as string)
  );
}

/**
 * Record what the gateway health reading means for the outlet. Idempotent:
 * repeating the same reading changes nothing, so any caller may report it.
 * `degraded` still takes payments (same rule as the payment link view), so
 * only `down` opens an incident, and `down` because of `unconfigured` is no
 * incident at all.
 */
export async function syncGatewayHealth(
  context: ScopedTenantContext,
  outletId: string,
  health: GatewayHealth,
  now = new Date(),
  provider = "unknown",
): Promise<GatewayIncidentResult> {
  if (health.reason === "unconfigured")
    return { transition: "none", openIncident: null };
  const isDown = health.status === "down";
  const cacheKey = `${context.tenant.tenantId}:${outletId}`;
  const cached = known.get(cacheKey);
  if (cached && cached.until > now.getTime()) {
    if (!isDown && cached.state === "up")
      return { transition: "none", openIncident: null };
    if (isDown && cached.state === "open")
      return { transition: "none", openIncident: cached.incident };
  }

  // Read without the lock first: only a transition needs it.
  const peeked = await withTenant(db, context, (tx) =>
    latestMarker(tx, context, outletId, now),
  );
  if (decide(peeked, isDown, now) === "none")
    return remember(cacheKey, peeked, isDown, now);

  const result = await withTenant<GatewayIncidentResult>(
    db,
    context,
    async (tx) => {
      await lockKey(
        tx,
        `legend:gateway-failover:${context.tenant.tenantId}:${outletId}`,
      );
      const marker = await latestMarker(tx, context, outletId, now);
      const step = decide(marker, isDown, now);
      if (step === "none")
        return {
          transition: "none",
          openIncident: marker?.open ? marker.incident : null,
        };

      if (step === "recover" && marker) {
        await writeIncidentRow(tx, context, {
          id: createUlid(now.getTime()),
          outletId,
          action: GATEWAY_RECOVERED,
          incident: marker.incident,
          seq: marker.seq + 1,
          provider,
          status: health.status,
          now,
        });
        return { transition: "recovered", openIncident: null };
      }

      if (step === "heartbeat" && marker) {
        await writeIncidentRow(tx, context, {
          id: createUlid(now.getTime()),
          outletId,
          action: STILL_DOWN,
          incident: marker.incident,
          seq: marker.seq + 1,
          provider,
          status: health.status,
          now,
        });
        return { transition: "heartbeat", openIncident: marker.incident };
      }

      if (step === "reopen" && marker) {
        await writeIncidentRow(tx, context, {
          id: createUlid(now.getTime()),
          outletId,
          action: FAILOVER_STARTED,
          incident: marker.incident,
          seq: marker.seq + 1,
          provider,
          status: health.status,
          reopened: true,
          now,
        });
        return { transition: "reopened", openIncident: marker.incident };
      }

      const incident = (marker?.incident ?? 0) + 1;
      const id = createUlid(now.getTime());
      await writeIncidentRow(tx, context, {
        id,
        outletId,
        action: FAILOVER_STARTED,
        incident,
        seq: 1,
        provider,
        status: health.status,
        now,
      });
      // The audit row and the alert commit together; the alert's id is the
      // audit row's id, so a retried transaction cannot alert twice.
      await notifyOutletSupervisors(
        tx,
        context,
        {
          tenantId: context.tenant.tenantId,
          outletId: outletIdSchema.parse(outletId),
          category: "payment_failover",
          id,
          eventName: ALERT_EVENT,
          aggregateType: "payment_gateway",
          aggregateId: id,
          payload: { incident: String(incident) },
          title: "Gateway pembayaran bermasalah",
          body: "Pembayaran online tidak tersedia. Tagihan baru diarahkan untuk bayar di kasir; siapkan kasir.",
        },
        now,
      );
      return { transition: "failover_started", openIncident: incident };
    },
  );
  known.set(
    cacheKey,
    result.openIncident === null
      ? { state: "up", until: now.getTime() + TRUST_MS }
      : {
          state: "open",
          incident: result.openIncident,
          until: now.getTime() + TRUST_MS,
        },
  );
  return result;
}

/** Cache what a no-transition read found, and answer for it. */
function remember(
  cacheKey: string,
  marker: IncidentMarker | null,
  isDown: boolean,
  now: Date,
): GatewayIncidentResult {
  const until = now.getTime() + TRUST_MS;
  // `up` and no open incident, or `down` and an incident already open.
  if (isDown && marker?.open) {
    known.set(cacheKey, { state: "open", incident: marker.incident, until });
    return { transition: "none", openIncident: marker.incident };
  }
  if (!isDown && !marker?.open) known.set(cacheKey, { state: "up", until });
  return { transition: "none", openIncident: null };
}

/** Probe the configured gateway for the outlet and record the result. For a
 * scheduled caller; request paths already hold a reading and use
 * `syncGatewayHealth` directly. */
export async function probeGatewayHealth(
  context: ScopedTenantContext,
  outletId: string,
  now = new Date(),
): Promise<GatewayIncidentResult & { status: PaymentGatewayStatus }> {
  const health = await outletGatewayHealth(context, outletId);
  const result = await syncGatewayHealth(
    context,
    outletId,
    health,
    now,
    health.provider,
  );
  return { ...result, status: health.status };
}

/**
 * Bookkeeping for a request path: a failure here must never break the guest's
 * payment screen, so it is logged and swallowed.
 */
export async function syncGatewayHealthSafely(
  context: ScopedTenantContext,
  outletId: string,
  health: GatewayHealth,
  now = new Date(),
  provider?: string,
): Promise<GatewayIncidentResult | null> {
  try {
    return await syncGatewayHealth(context, outletId, health, now, provider);
  } catch (error) {
    logger.warn({ err: error, outletId }, "gateway health sync failed");
    return null;
  }
}

type FailoverLink = {
  id: string;
  outletId: string;
  reference: string;
  createdAt: Date;
};

/**
 * Mark one bill as moved to the cashier during incident `incident`. Once per
 * (bill, incident): a guest reloading the screen adds no row. Money columns
 * are not touched. The lookup is bounded to the outlet and to rows written
 * since the bill opened.
 */
export async function markLinkFailedOverToCashier(
  tx: Tx,
  context: ScopedTenantContext,
  link: FailoverLink,
  incident: number,
  now = new Date(),
): Promise<boolean> {
  await lockKey(
    tx,
    `legend:link-failover:${context.tenant.tenantId}:${link.id}:${incident}`,
  );
  const [existing] = await tx
    .select({ one: sql<number>`1` })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.tenantId, context.tenant.tenantId),
        eq(auditLogs.outletId, link.outletId),
        gte(auditLogs.createdAt, link.createdAt),
        sql`${auditLogs.event}->>'action' = ${LINK_FAILOVER}`,
        sql`${auditLogs.event}->>'objectId' = ${link.id}`,
        sql`${auditLogs.event}->'maskedChanges'->'after'->>'incident' = ${String(incident)}`,
      ),
    )
    .limit(1);
  if (existing) return false;
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(now.getTime()),
      tenantId: context.tenant.tenantId,
      outletId: link.outletId,
      actorType: "system",
      actorId: null,
      deviceId: null,
      action: LINK_FAILOVER,
      objectType: "payment_link",
      objectId: link.id,
      reason: "gateway_failover",
      maskedChanges: {
        before: null,
        after: { reference: link.reference, incident },
      },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: toIsoDateTime(now),
    },
    ["reference", "incident"],
  );
  return true;
}

/** `markLinkFailedOverToCashier` in its own transaction, for a request path
 * that must not fail because of the bookkeeping. A bill this process already
 * marked for the incident costs no query. */
export async function failOverLinkSafely(
  context: ScopedTenantContext,
  link: FailoverLink,
  incident: number,
  now = new Date(),
): Promise<void> {
  const key = `${context.tenant.tenantId}:${link.id}:${incident}`;
  if (markedLinks.has(key)) return;
  try {
    await withTenant(db, context, (tx) =>
      markLinkFailedOverToCashier(tx, context, link, incident, now),
    );
    if (markedLinks.size >= 5_000) markedLinks.clear();
    markedLinks.add(key);
  } catch (error) {
    logger.warn({ err: error, linkId: link.id }, "link failover mark failed");
  }
}
