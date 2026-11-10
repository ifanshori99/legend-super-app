// Guest Wi-Fi sessions of a signed-in member (PRD v1.7 §3 F25 "Wi-Fi Berbasis
// Belanja"; FAC-12, FAC-13; bead legend-kmd3, brief sub-kmd3-wifi-quota.md).
// Routes: routes/wifi-guest.routes.ts (GET /policy, POST /sessions, GET
// /sessions/current, POST /sessions/current/refresh, POST /sessions/:id/end).
//
// - The caller is always a member: the profile comes from the member scope
//   (session), never from a path, query or body. A session of another account
//   answers 404 like a missing one.
// - The daily allowance is per ACCOUNT per outlet business day. The quota
//   numbers come from `computeAccountQuota` (ledger of paid spend, tier, peak
//   window); this file never takes spend from the client.
// - Usage accrues lazily: before each read, refresh and end the minutes since
//   `accrued_at` are added to the open sessions of the account. A new session
//   on the same business day inherits the day's highest `used_minutes`, so the
//   free allowance is not granted twice.
// - Every call runs under the account locks, so the device count and the
//   accrual are serial per account. Lock order: `withProfileLock` (row), then
//   `withWifiAccountLock` (advisory, the one the quota consumer takes alone).
// - One session = one controller device (MAC): a start that brings another MAC
//   for a session with a live grant ends that grant first (`device_moved`).
// - Running out of quota throttles (`speedTier: "base"`), it never ends a
//   session (FAC-13). Controller calls run after the transaction commits; the
//   cloud has no agent (503 WIFI_AGENT_NOT_READY) and that is not a failure.
// - The controller device id is passed to the agent only. It is never stored
//   in `wifi_sessions`; the device hash is sha256(`${tenantId}:${fingerprint}`).
import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import {
  businessDayRange,
  outletIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  assertWifiDeviceAllowed,
  wifiQuotaViewSchema,
  wifiRemainingMinutes,
  wifiSessionSchema,
  wifiSpeedTier,
  type StartWifiSessionInput,
  type WifiPolicy,
  type WifiQuotaView,
  type WifiSession,
} from "@starter/shared/facility";
import { db } from "../db/index.ts";
import { withMemberScope, withProfileLock } from "../db/member-scope.ts";
import type { MemberScope } from "../db/member-scope.ts";
import { wifiDeviceGrants } from "../db/schema/edge-wifi.ts";
import { wifiPolicies } from "../db/schema/facility.ts";
import { wifiSessions, type WifiSessionRow } from "../db/schema/wifi-quota.ts";
import { wifiEnforcement } from "../edge/wifi/port.ts";
import { HttpError } from "../lib/http-error.ts";
import { logger } from "../lib/logger.ts";
import { notFound, type Tx } from "./facility-shared.ts";
import { outletBusinessDayClock } from "./outlet-clock.ts";
import { businessDateFor, loadOutlet } from "./pos-order-support.ts";
import { toWifiPolicy } from "./wifi-policy.service.ts";
import {
  accrueUsage,
  applyWifiQuotaToEdge,
  computeAccountQuota,
  recomputeOpenSessions,
  withWifiAccountLock,
} from "./wifi-quota.service.ts";

type EndReason = "session_ended" | "device_moved" | "day_closed";
type EdgeAction = () => Promise<void>;

/** `sha256(tenantId:fingerprint)`: the raw fingerprint is never stored. */
export function wifiDeviceHash(tenantId: string, fingerprint: string): string {
  return createHash("sha256")
    .update(`${tenantId}:${fingerprint}`, "utf8")
    .digest("hex");
}

function profileIdOf(scope: MemberScope): string {
  if (!scope.customerProfileId)
    throw new HttpError(
      404,
      "CUSTOMER_NOT_FOUND",
      "Pelanggan tidak ditemukan.",
    );
  return scope.customerProfileId;
}

export function toWifiSession(row: WifiSessionRow): WifiSession {
  return wifiSessionSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    customerProfileId: row.customerProfileId,
    zoneId: row.zoneId,
    policyId: row.policyId,
    deviceHash: row.deviceHash,
    quotaMinutes: row.quotaMinutes,
    usedMinutes: row.usedMinutes,
    speedTier: row.speedTier,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
  });
}

function toView(
  row: WifiSessionRow,
  policy: WifiPolicy,
  now: Date,
): WifiQuotaView {
  const session = toWifiSession(row);
  return wifiQuotaViewSchema.parse({
    session,
    policy,
    remainingMinutes: wifiRemainingMinutes(session),
    serverTime: now.toISOString(),
  });
}

async function lockAccount(
  tx: Tx,
  tenantId: string,
  profileId: string,
): Promise<void> {
  await withProfileLock(tx, tenantId, profileId);
  await withWifiAccountLock(tx, tenantId, profileId);
}

/** The agent is absent in the cloud: that is logged, never a failure. */
async function enforce(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (error instanceof HttpError && error.code === "WIFI_AGENT_NOT_READY") {
      logger.info("Wi-Fi agent not ready; controller call skipped");
      return;
    }
    throw error;
  }
}

async function runEdgeActions(actions: EdgeAction[]): Promise<void> {
  for (const action of actions) await action();
}

function endAction(
  context: ScopedTenantContext,
  row: Pick<WifiSessionRow, "id" | "outletId">,
  reason: EndReason,
): EdgeAction {
  return () =>
    enforce(() =>
      wifiEnforcement().endSession(context, {
        outletId: outletIdSchema.parse(row.outletId),
        wifiSessionId: row.id,
        reason,
      }),
    );
}

async function loadPolicyOfZone(
  tx: Tx,
  scope: MemberScope,
  zoneId: string,
): Promise<WifiPolicy> {
  const [row] = await tx
    .select()
    .from(wifiPolicies)
    .where(
      and(
        eq(wifiPolicies.tenantId, scope.context.tenant.tenantId),
        eq(wifiPolicies.zoneId, zoneId),
      ),
    )
    .limit(1);
  if (!row) throw notFound("Kebijakan Wi-Fi");
  return toWifiPolicy(row);
}

async function loadPolicyById(
  tx: Tx,
  scope: MemberScope,
  policyId: string,
): Promise<WifiPolicy> {
  const [row] = await tx
    .select()
    .from(wifiPolicies)
    .where(
      and(
        eq(wifiPolicies.tenantId, scope.context.tenant.tenantId),
        eq(wifiPolicies.id, policyId),
      ),
    )
    .limit(1);
  if (!row) throw notFound("Kebijakan Wi-Fi");
  return toWifiPolicy(row);
}

function ownOpen(scope: MemberScope, profileId: string) {
  return and(
    eq(wifiSessions.tenantId, scope.context.tenant.tenantId),
    eq(wifiSessions.customerProfileId, profileId),
    isNull(wifiSessions.endedAt),
  );
}

/**
 * Adds the elapsed minutes to every open session of the account and moves the
 * speed tier to base when the quota is spent. Pure arithmetic is
 * `accrueUsage`; this only writes the result.
 */
async function accrueOpenSessions(
  tx: Tx,
  scope: MemberScope,
  profileId: string,
  now: Date,
): Promise<WifiSessionRow[]> {
  const open = await tx
    .select()
    .from(wifiSessions)
    .where(ownOpen(scope, profileId));
  const result: WifiSessionRow[] = [];
  for (const row of open) {
    const { usedMinutes, accruedAt } = accrueUsage(row, now);
    const speedTier = wifiSpeedTier(usedMinutes, row.quotaMinutes);
    if (
      usedMinutes === row.usedMinutes &&
      accruedAt.getTime() === row.accruedAt.getTime() &&
      speedTier === row.speedTier
    ) {
      result.push(row);
      continue;
    }
    const [updated] = await tx
      .update(wifiSessions)
      .set({ usedMinutes, accruedAt, speedTier, updatedAt: now })
      .where(
        and(
          eq(wifiSessions.tenantId, row.tenantId),
          eq(wifiSessions.id, row.id),
        ),
      )
      .returning();
    result.push(updated ?? row);
  }
  return result;
}

async function endRows(
  tx: Tx,
  scope: MemberScope,
  rows: WifiSessionRow[],
  reason: EndReason,
  now: Date,
): Promise<EdgeAction[]> {
  if (rows.length === 0) return [];
  await tx
    .update(wifiSessions)
    .set({ endedAt: now, updatedAt: now })
    .where(
      and(
        eq(wifiSessions.tenantId, scope.context.tenant.tenantId),
        inArray(
          wifiSessions.id,
          rows.map((row) => row.id),
        ),
        isNull(wifiSessions.endedAt),
      ),
    );
  return rows.map((row) => endAction(scope.context, row, reason));
}

/**
 * Ends the open sessions whose business day is over (their own outlet's
 * clock). Returns the rows that stay open, already accrued.
 */
async function closeStaleSessions(
  tx: Tx,
  scope: MemberScope,
  profileId: string,
  now: Date,
  actions: EdgeAction[],
): Promise<WifiSessionRow[]> {
  const open = await accrueOpenSessions(tx, scope, profileId, now);
  const dateByOutlet = new Map<string, string>();
  for (const outletId of new Set(open.map((row) => row.outletId))) {
    const outlet = await loadOutlet(
      tx,
      scope.context,
      outletIdSchema.parse(outletId),
    );
    dateByOutlet.set(outletId, businessDateFor(outlet, now));
  }
  const stale = open.filter(
    (row) => dateByOutlet.get(row.outletId) !== row.businessDate,
  );
  actions.push(...(await endRows(tx, scope, stale, "day_closed", now)));
  return open.filter((row) => !stale.includes(row));
}

/** The raw controller id of the session's live grant (edge-local), if any. */
async function liveControllerDeviceId(
  tx: Tx,
  row: Pick<WifiSessionRow, "tenantId" | "id">,
): Promise<string | undefined> {
  const [grant] = await tx
    .select({ controllerDeviceId: wifiDeviceGrants.controllerDeviceId })
    .from(wifiDeviceGrants)
    .where(
      and(
        eq(wifiDeviceGrants.tenantId, row.tenantId),
        eq(wifiDeviceGrants.wifiSessionId, row.id),
        inArray(wifiDeviceGrants.status, ["active", "pending", "unknown"]),
        isNotNull(wifiDeviceGrants.controllerDeviceId),
      ),
    )
    .orderBy(desc(wifiDeviceGrants.requestedAt))
    .limit(1);
  return grant?.controllerDeviceId ?? undefined;
}

/** GET /policy: the policy of a zone, for the portal's quota meter. */
export async function getWifiPolicyForZone(
  scope: MemberScope,
  zoneId: string,
): Promise<WifiPolicy> {
  profileIdOf(scope);
  return withMemberScope(db, scope, (tx) =>
    loadPolicyOfZone(tx, scope, zoneId),
  );
}

/**
 * POST /sessions: opens (or re-uses) the session of one device. A device that
 * already holds an open session gets its quota recomputed; a new device beyond
 * the policy's `maxDevices` is refused with 409 WIFI_DEVICE_LIMIT.
 */
export async function startWifiSession(
  scope: MemberScope,
  input: StartWifiSessionInput,
  now = new Date(),
): Promise<WifiQuotaView> {
  const profileId = profileIdOf(scope);
  const tenantId = scope.context.tenant.tenantId;
  const deviceHash = wifiDeviceHash(tenantId, input.deviceFingerprint);
  const actions: EdgeAction[] = [];
  const view = await withMemberScope(db, scope, async (tx) => {
    await lockAccount(tx, tenantId, profileId);
    const policy = await loadPolicyOfZone(tx, scope, input.zoneId);
    const outlet = await loadOutlet(
      tx,
      scope.context,
      outletIdSchema.parse(policy.outletId),
    );
    const businessDate = businessDateFor(outlet, now);

    let open = await closeStaleSessions(tx, scope, profileId, now, actions);
    // The same device moving to another zone starts over in the new zone.
    const moved = open.filter(
      (row) => row.deviceHash === deviceHash && row.zoneId !== policy.zoneId,
    );
    actions.push(...(await endRows(tx, scope, moved, "device_moved", now)));
    open = open.filter((row) => !moved.includes(row));
    const existing = open.find((row) => row.deviceHash === deviceHash);

    assertWifiDeviceAllowed(open.length, policy, {
      deviceAlreadyActive: existing !== undefined,
    });

    const { quotaMinutes } = await computeAccountQuota(tx, scope.context, {
      policy,
      outletTimeZone: outlet.timezone,
      outletId: policy.outletId,
      customerProfileId: profileId,
      businessDate,
      now,
    });

    let row: WifiSessionRow;
    if (existing) {
      const speedTier = wifiSpeedTier(existing.usedMinutes, quotaMinutes);
      [row] = await tx
        .update(wifiSessions)
        .set({
          policyId: policy.id,
          quotaMinutes,
          speedTier,
          quotaUpdatedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(wifiSessions.tenantId, tenantId),
            eq(wifiSessions.id, existing.id),
          ),
        )
        .returning();
    } else {
      // The day's allowance is spent once per account, not once per session.
      const [day] = await tx
        .select({
          used: sql<number>`COALESCE(MAX(${wifiSessions.usedMinutes}), 0)::int`,
        })
        .from(wifiSessions)
        .where(
          and(
            eq(wifiSessions.tenantId, tenantId),
            eq(wifiSessions.outletId, policy.outletId),
            eq(wifiSessions.customerProfileId, profileId),
            eq(wifiSessions.businessDate, businessDate),
          ),
        );
      const usedMinutes = Math.min(day?.used ?? 0, 1440);
      [row] = await tx
        .insert(wifiSessions)
        .values({
          tenantId,
          outletId: policy.outletId,
          customerProfileId: profileId,
          zoneId: policy.zoneId,
          policyId: policy.id,
          deviceHash,
          businessDate,
          quotaMinutes,
          usedMinutes,
          speedTier: wifiSpeedTier(usedMinutes, quotaMinutes),
          startedAt: now,
          accruedAt: now,
          quotaUpdatedAt: now,
        })
        .returning();
    }
    if (!row) throw new Error("Wi-Fi session write returned no row");

    const liveDeviceId = await liveControllerDeviceId(tx, row);
    const controllerDeviceId = input.controllerDeviceId ?? liveDeviceId;
    // One session, one MAC: a different MAC replaces the live grant.
    if (
      existing &&
      liveDeviceId !== undefined &&
      controllerDeviceId !== liveDeviceId
    )
      actions.push(endAction(scope.context, row, "device_moved"));
    const written = row;
    const sessionEndsAt = businessDayRange(
      written.businessDate,
      outletBusinessDayClock(outlet),
    ).end;
    actions.push(() =>
      applyWifiQuotaToEdge(
        scope.context,
        written,
        policy,
        controllerDeviceId,
        sessionEndsAt,
        { strict: true },
      ),
    );
    return toView(row, policy, now);
  });
  await runEdgeActions(actions);
  return view;
}

/** The newest open session of the account (one account may hold several devices). */
function latestOpen(rows: WifiSessionRow[]): WifiSessionRow | undefined {
  return [...rows].sort(
    (a, b) => b.startedAt.getTime() - a.startedAt.getTime(),
  )[0];
}

/** GET /sessions/current: usage accrued up to now; `null` without an open session. */
export async function getCurrentWifiSession(
  scope: MemberScope,
  now = new Date(),
): Promise<WifiQuotaView | null> {
  const profileId = profileIdOf(scope);
  const tenantId = scope.context.tenant.tenantId;
  const actions: EdgeAction[] = [];
  const view = await withMemberScope(db, scope, async (tx) => {
    await lockAccount(tx, tenantId, profileId);
    const open = await closeStaleSessions(tx, scope, profileId, now, actions);
    const row = latestOpen(open);
    if (!row) return null;
    return toView(row, await loadPolicyById(tx, scope, row.policyId), now);
  });
  await runEdgeActions(actions);
  return view;
}

/**
 * POST /sessions/current/refresh: recomputes the allowance from the ledger of
 * the business day and the clock (peak window, tier). 404 without an open
 * session.
 */
export async function refreshWifiQuota(
  scope: MemberScope,
  now = new Date(),
): Promise<WifiQuotaView> {
  const profileId = profileIdOf(scope);
  const tenantId = scope.context.tenant.tenantId;
  const actions: EdgeAction[] = [];
  const view = await withMemberScope(db, scope, async (tx) => {
    await lockAccount(tx, tenantId, profileId);
    const open = await closeStaleSessions(tx, scope, profileId, now, actions);
    if (open.length === 0) throw notFound("Sesi Wi-Fi");
    for (const date of new Set(open.map((row) => row.businessDate)))
      await recomputeOpenSessions(tx, scope.context, {
        customerProfileId: profileId,
        businessDate: date,
        now,
        reason: "spend",
      });
    const reread = await tx
      .select()
      .from(wifiSessions)
      .where(ownOpen(scope, profileId));
    const row = latestOpen(reread);
    if (!row) throw notFound("Sesi Wi-Fi");
    return toView(row, await loadPolicyById(tx, scope, row.policyId), now);
  });
  await runEdgeActions(actions);
  return view;
}

/**
 * POST /sessions/:sessionId/end: ends one of the caller's own sessions. Repeat
 * calls answer the ended session again (and ask the agent again, so a failed
 * revoke can be retried).
 */
export async function endWifiSession(
  scope: MemberScope,
  sessionId: string,
  now = new Date(),
): Promise<WifiSession> {
  const profileId = profileIdOf(scope);
  const tenantId = scope.context.tenant.tenantId;
  const actions: EdgeAction[] = [];
  const session = await withMemberScope(db, scope, async (tx) => {
    await lockAccount(tx, tenantId, profileId);
    const [found] = await tx
      .select()
      .from(wifiSessions)
      .where(
        and(
          eq(wifiSessions.tenantId, tenantId),
          eq(wifiSessions.id, sessionId),
          eq(wifiSessions.customerProfileId, profileId),
        ),
      )
      .limit(1);
    if (!found) throw notFound("Sesi Wi-Fi");
    if (found.endedAt) {
      actions.push(endAction(scope.context, found, "session_ended"));
      return toWifiSession(found);
    }
    const { usedMinutes, accruedAt } = accrueUsage(found, now);
    const [ended] = await tx
      .update(wifiSessions)
      .set({
        usedMinutes,
        accruedAt,
        speedTier: wifiSpeedTier(usedMinutes, found.quotaMinutes),
        endedAt: now,
        updatedAt: now,
      })
      .where(
        and(eq(wifiSessions.tenantId, tenantId), eq(wifiSessions.id, found.id)),
      )
      .returning();
    actions.push(endAction(scope.context, found, "session_ended"));
    return toWifiSession(ended ?? found);
  });
  await runEdgeActions(actions);
  return session;
}
