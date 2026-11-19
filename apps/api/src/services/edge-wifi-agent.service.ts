// Edge Wi-Fi agent (bead legend-hsk; PRD v1.7 §3 F5 + F25, FAC-11, FAC-13).
//
// One ledger table, `wifi_device_grants`, on the edge's local Postgres. Each
// row is one controller grant; its id is the provider `reference`, so the
// request a row describes is fixed for life (the table trigger enforces it).
//
// Rules this file enforces:
// - Make-before-break: a speed change or renewal authorizes a NEW grant and
//   only then marks the old one `superseded`. The old grant is never revoked
//   by the agent: the controller replaces it in place (WifiProvider JSDoc), so
//   a speed change never cuts the device (FAC-13: throttle, never cut).
// - Write-ahead: the `pending` row is committed before the controller call. A
//   timeout or transport failure leaves `unknown`; the reconcile loop repeats
//   the identical request (same reference, idempotent at the provider).
// - Provider calls never run inside a database transaction. Decisions per
//   device run under a transaction-level advisory lock.
// - Running out of quota never ends a grant: the loop downgrades a full grant
//   to base speed before the controller can expire it (the grant carries its
//   own base rate, so this holds even when kmd3 is late).
// - The raw controller id (MAC) is kept only while a row is live and scrubbed
//   on every terminal row. Views expose an 8-hex tag of the device hash only.
// - A grant that lands after its row was revoked is revoked again. The row
//   keeps `revoke_retry_at` (the only column a terminal row may change) until
//   a revoke succeeds; the loop retries it with backoff (legend-nffy).
// - Provider calls use the edge node's own server-minted context
//   (`contextFor`), never a caller's; its tenant must equal the caller's.
//
// Permissions are checked by the callers (routes, kmd3 services), not here.
import { createHash } from "node:crypto";
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  assertOutletInScope,
  assertTrustedScopedContext,
  CoreError,
  outletIdSchema,
  tenantIdSchema,
  uuidSchema,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { WifiProvider, WifiRequest } from "@starter/shared/adapters";
import {
  applyWifiSessionInputSchema,
  buildWalledGarden,
  normalizeControllerDeviceId,
  supportsWalledGardenSync,
  wifiEndReasonSchema,
  wifiGrantViewSchema,
  WifiProviderError,
  type ApplyWifiSessionInput,
  type WifiEndReason,
  type WifiGrantView,
} from "@starter/shared/edge";
import { db } from "../db/index.ts";
import { wifiDeviceGrants } from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { logger } from "../lib/logger.ts";
import { loadWalledGardenSources } from "./edge-wifi-walled-garden.service.ts";

export const WIFI_RECONCILE_INTERVAL_MS = 30_000;
/** Added to every grant so a late loop tick never lets the controller cut. */
export const WIFI_FULL_GRACE_SECONDS = 300;
/** A base grant is renewed this long before it expires. */
export const WIFI_RENEW_LEAD_SECONDS = 600;
/** Length of one base-speed grant (before grace). */
export const WIFI_BASE_CHUNK_SECONDS = 14_400;

const RENEW_HORIZON_SECONDS = 86_400;
const DEFAULT_PROVIDER_TIMEOUT_MS = 5_000;
/** A pending/unknown row untouched this long is retried by the loop. */
const INFLIGHT_RETRY_AFTER_MS = 10_000;
const RECONCILE_BATCH = 100;
/** Backoff bounds for re-sending the revoke of a terminal row. The delay is
 * the row's age since `ended_at` (frozen), so it roughly doubles per try. */
const REVOKE_RETRY_MIN_SECONDS = 30;
const REVOKE_RETRY_MAX_SECONDS = 300;
/** A revoke still failing this long after `ended_at` is given up: the marker
 * is cleared so retention can purge the row, and an error is logged. */
export const WIFI_REVOKE_GIVE_UP_AFTER_SECONDS = 86_400;
const LIST_LIMIT = 500;
/** An active grant within this much of the wanted expiry is reused. */
const REUSE_TOLERANCE_SECONDS = 60;
const LIVE = ["pending", "active", "unknown"] as const;
const INFLIGHT = ["pending", "unknown"] as const;
const TERMINAL = ["superseded", "revoked", "failed"] as const;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type GrantRow = typeof wifiDeviceGrants.$inferSelect;
type SpeedTier = "full" | "base";

export type WifiAgent = {
  applySession(
    ctx: ScopedTenantContext,
    input: ApplyWifiSessionInput,
  ): Promise<WifiGrantView>;
  endSession(
    ctx: ScopedTenantContext,
    input: { outletId: OutletId; wifiSessionId: string; reason: WifiEndReason },
  ): Promise<WifiGrantView[]>;
  listLiveGrants(
    ctx: ScopedTenantContext,
    outletId: OutletId,
  ): Promise<WifiGrantView[]>;
  walledGarden(
    ctx: ScopedTenantContext,
  ): Promise<{ hosts: string[]; version: string }>;
  reconcile(
    ctx: ScopedTenantContext,
    outletId: OutletId,
  ): Promise<{
    authorized: number;
    downgraded: number;
    renewed: number;
    revoked: number;
    failed: number;
  }>;
};

/** Thrown by the agent's own timeout; treated like a transport failure. */
class ProviderTimeout extends Error {
  readonly code = "WIFI_PROVIDER_TIMEOUT";
  constructor() {
    super("Wi-Fi controller did not answer in time.");
    this.name = "ProviderTimeout";
  }
}

function isTransportFailure(error: unknown): boolean {
  return error instanceof ProviderTimeout || error instanceof WifiProviderError;
}

/** Error code only; never a vendor message (it may carry device data). */
function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code)
    ? code
    : "WIFI_PROVIDER_ERROR";
}

export function wifiDeviceHash(tenantId: string, controllerDeviceId: string) {
  return createHash("sha256")
    .update(`${tenantId}:${normalizeControllerDeviceId(controllerDeviceId)}`)
    .digest("hex");
}

function walledGardenVersion(hosts: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify([...hosts].sort()))
    .digest("hex");
}

function toView(row: GrantRow): WifiGrantView {
  return wifiGrantViewSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    wifiSessionId: row.wifiSessionId,
    deviceTag: row.deviceHash.slice(0, 8),
    speedTier: row.speedTier,
    bandwidthKbps: row.bandwidthKbps,
    status: row.status,
    authorizedAt: row.authorizedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    endReason: row.endReason ?? null,
  });
}

const seconds = (ms: number) => Math.max(0, Math.floor(ms / 1000));
const addSeconds = (at: Date, s: number) => new Date(at.getTime() + s * 1000);

/** Base grant length: one chunk, never past the renewal horizon, plus grace. */
function baseDuration(now: Date, renewUntil: Date): number {
  return (
    Math.min(
      WIFI_BASE_CHUNK_SECONDS,
      seconds(renewUntil.getTime() - now.getTime()),
    ) + WIFI_FULL_GRACE_SECONDS
  );
}

function scopeOf(ctx: ScopedTenantContext, outletId: string): OutletId {
  assertTrustedScopedContext(ctx);
  const parsed = outletIdSchema.parse(outletId);
  assertOutletInScope(ctx.outletScope, parsed);
  return parsed;
}

async function lockDevice(
  tx: Tx,
  tenantId: string,
  outletId: string,
  deviceHash: string,
) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`wifi-grant:${tenantId}:${outletId}:${deviceHash}`}, 0))`,
  );
}

const scoped = (tenantId: string, outletId: string, ...rest: SQL[]) =>
  and(
    eq(wifiDeviceGrants.tenantId, tenantIdSchema.parse(tenantId)),
    eq(wifiDeviceGrants.outletId, outletIdSchema.parse(outletId)),
    ...rest,
  );

export function createWifiAgent(options: {
  provider: WifiProvider;
  /** Server-minted context of the edge node for this outlet. */
  contextFor(outletId: OutletId): ScopedTenantContext;
  now?: () => Date;
  providerTimeoutMs?: number;
}): WifiAgent {
  const { provider } = options;
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  /** Last walled-garden version pushed to the controller, per tenant:outlet. */
  const syncedGarden = new Map<string, string>();
  /** Walled garden sent with an in-flight reference. A retry must repeat the
   * exact request (the controller fingerprints all of it), so it reuses this
   * list. Lost on restart: a retry with a changed list is then refused
   * (IDEMPOTENCY_KEY_REUSED) and the row fails; the old grant stays and the
   * next tick or apply asks for a new grant. */
  const inFlightGarden = new Map<string, readonly string[]>();
  /** Last walled garden built without error, per tenant:outlet. The loop
   * falls back to it when a build fails, so one bad input never stops
   * renewals (FAC-13). */
  const lastGoodGarden = new Map<string, readonly string[]>();

  function providerContext(
    ctx: ScopedTenantContext,
    outletId: OutletId,
  ): ScopedTenantContext {
    const node = options.contextFor(outletId);
    assertTrustedScopedContext(node);
    if (node.tenant.tenantId !== ctx.tenant.tenantId)
      throw new CoreError("FORBIDDEN", "Tenant node tidak cocok.");
    assertOutletInScope(node.outletScope, outletId);
    return node;
  }

  async function withTimeout<T>(call: () => Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ProviderTimeout()), timeoutMs);
    });
    try {
      return await Promise.race([call(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function walledGarden(ctx: ScopedTenantContext) {
    const hosts = [...buildWalledGarden(await loadWalledGardenSources(ctx))];
    return { hosts, version: walledGardenVersion(hosts) };
  }

  async function readRow(
    ctx: ScopedTenantContext,
    outletId: string,
    id: string,
  ): Promise<GrantRow> {
    const [row] = await withTenant(db, ctx, (tx) =>
      tx
        .select()
        .from(wifiDeviceGrants)
        .where(
          scoped(ctx.tenant.tenantId, outletId, eq(wifiDeviceGrants.id, id)),
        ),
    );
    if (!row) throw new CoreError("NOT_FOUND", "Grant Wi-Fi tidak ditemukan.");
    return row;
  }

  type Outcome = { outcome: "active" | "failed" | "unknown"; row: GrantRow };

  /**
   * Sends the row's request to the controller and records the answer. On
   * success the device's previous active grant becomes `superseded` in the
   * same transaction (no provider revoke: the controller replaced it).
   */
  async function authorizeRow(
    ctx: ScopedTenantContext,
    row: GrantRow,
    hosts: readonly string[],
  ): Promise<Outcome> {
    const tenantId = ctx.tenant.tenantId;
    const outletId = row.outletId as OutletId;
    if (row.controllerDeviceId === null)
      throw new Error("Live grant without controller device id");
    const garden = inFlightGarden.get(row.id) ?? hosts;
    inFlightGarden.set(row.id, garden);
    const request: WifiRequest = {
      tenantId: ctx.tenant.tenantId,
      outletId,
      reference: row.id,
      deviceId: row.controllerDeviceId,
      durationSeconds: row.durationSeconds,
      bandwidthKbps: row.bandwidthKbps,
      walledGarden: [...garden],
    };
    let authorized: boolean | null = null;
    let failure: unknown = null;
    try {
      const node = providerContext(ctx, outletId);
      const result = await withTimeout(() => provider.authorize(node, request));
      authorized = result.authorized === true && result.reference === row.id;
    } catch (error) {
      failure = error;
    }
    const at = now();
    const updated = await withTenant(db, ctx, async (tx) => {
      await lockDevice(tx, tenantId, outletId, row.deviceHash);
      const stillInFlight = and(
        scoped(tenantId, outletId, eq(wifiDeviceGrants.id, row.id)),
        inArray(wifiDeviceGrants.status, [...INFLIGHT]),
      );
      if (authorized === true) {
        // Supersede the old grant only while this row is still in flight. A
        // row revoked meanwhile must not end the old row: the old row may
        // still wait for its own revoke.
        const [inflight] = await tx
          .select({ id: wifiDeviceGrants.id })
          .from(wifiDeviceGrants)
          .where(stillInFlight);
        if (!inflight) {
          // Landed after its revoke: mark the revoke as owed before sending
          // it, so a crash or a failed call still leaves it for the loop.
          await tx
            .update(wifiDeviceGrants)
            .set({ revokeRetryAt: at })
            .where(
              scoped(
                tenantId,
                outletId,
                eq(wifiDeviceGrants.id, row.id),
                eq(wifiDeviceGrants.status, "revoked"),
              ),
            );
          return [];
        }
        await tx
          .update(wifiDeviceGrants)
          .set({
            status: "superseded",
            supersededBy: row.id,
            endedAt: at,
            controllerDeviceId: null,
            updatedAt: at,
          })
          .where(
            scoped(
              tenantId,
              outletId,
              eq(wifiDeviceGrants.deviceHash, row.deviceHash),
              eq(wifiDeviceGrants.status, "active"),
              ne(wifiDeviceGrants.id, row.id),
            ),
          );
        return tx
          .update(wifiDeviceGrants)
          .set({
            status: "active",
            authorizedAt: at,
            // The controller counts from its first apply, never earlier than
            // requested_at. A replay must not push the expiry later than the
            // controller's, or renewal comes too late and the device is cut.
            expiresAt: addSeconds(row.requestedAt, row.durationSeconds),
            attemptCount: sql`${wifiDeviceGrants.attemptCount} + 1`,
            lastErrorCode: null,
            updatedAt: at,
          })
          .where(stillInFlight)
          .returning();
      }
      if (authorized === false || !isTransportFailure(failure)) {
        return tx
          .update(wifiDeviceGrants)
          .set({
            status: "failed",
            endedAt: at,
            controllerDeviceId: null,
            attemptCount: sql`${wifiDeviceGrants.attemptCount} + 1`,
            lastErrorCode:
              authorized === false
                ? "WIFI_AUTHORIZE_REFUSED"
                : errorCode(failure),
            updatedAt: at,
          })
          .where(stillInFlight)
          .returning();
      }
      return tx
        .update(wifiDeviceGrants)
        .set({
          status: "unknown",
          attemptCount: sql`${wifiDeviceGrants.attemptCount} + 1`,
          lastErrorCode: errorCode(failure),
          updatedAt: at,
        })
        .where(stillInFlight)
        .returning();
    });
    if (failure !== null && !isTransportFailure(failure))
      logger.warn(
        {
          module: "edge-wifi",
          err: { name: (failure as Error)?.name, code: errorCode(failure) },
        },
        "Wi-Fi authorize failed.",
      );
    const current = updated[0] ?? (await readRow(ctx, outletId, row.id));
    // The grant landed after its revoke: the controller may have had no
    // record to revoke then, so the device is online. Revoke it again.
    if (
      authorized === true &&
      updated.length === 0 &&
      current.status === "revoked" &&
      current.revokeRetryAt !== null
    )
      await retryTerminalRevoke(ctx, current);
    if (current.status !== "pending" && current.status !== "unknown")
      inFlightGarden.delete(row.id);
    if (current.status === "active") return { outcome: "active", row: current };
    if (current.status === "failed") return { outcome: "failed", row: current };
    return { outcome: "unknown", row: current };
  }

  /**
   * Re-sends the controller revoke of a terminal row that owes one
   * (`revoke_retry_at` set). Success clears the marker; a failure moves it
   * out by the backoff. Once the grant's `expires_at` has passed (the
   * controller dropped it) or `WIFI_REVOKE_GIVE_UP_AFTER_SECONDS` have gone by
   * since `ended_at`, a failed revoke is given up: the marker is cleared and
   * an error is logged. Only `revoke_retry_at` is written: every other
   * column of a terminal row is frozen.
   */
  async function retryTerminalRevoke(
    ctx: ScopedTenantContext,
    row: GrantRow,
  ): Promise<boolean> {
    const tenantId = ctx.tenant.tenantId;
    const outletId = row.outletId as OutletId;
    let failure: unknown = null;
    try {
      const node = providerContext(ctx, outletId);
      await withTimeout(() =>
        provider.revoke(node, { tenantId, outletId, reference: row.id }),
      );
    } catch (error) {
      failure = error;
    }
    const at = now();
    const delay = Math.min(
      REVOKE_RETRY_MAX_SECONDS,
      Math.max(
        REVOKE_RETRY_MIN_SECONDS,
        seconds(at.getTime() - (row.endedAt ?? at).getTime()),
      ),
    );
    const giveUp =
      failure !== null &&
      ((row.expiresAt !== null && row.expiresAt.getTime() <= at.getTime()) ||
        (row.endedAt !== null &&
          seconds(at.getTime() - row.endedAt.getTime()) >=
            WIFI_REVOKE_GIVE_UP_AFTER_SECONDS));
    await withTenant(db, ctx, (tx) =>
      tx
        .update(wifiDeviceGrants)
        .set({
          revokeRetryAt:
            failure === null || giveUp ? null : addSeconds(at, delay),
        })
        .where(
          scoped(
            tenantId,
            outletId,
            eq(wifiDeviceGrants.id, row.id),
            isNotNull(wifiDeviceGrants.revokeRetryAt),
          ),
        ),
    );
    // Log only: the supervisor notification (`notifyOutletSupervisors`) needs
    // the cloud user/role tables, which the edge process does not have.
    if (giveUp)
      logger.error(
        {
          module: "edge-wifi",
          alert: "wifi_revoke_given_up",
          tenantId,
          outletId,
          grantId: row.id,
          endedAt: row.endedAt?.toISOString() ?? null,
          expiresAt: row.expiresAt?.toISOString() ?? null,
          err: { name: (failure as Error)?.name, code: errorCode(failure) },
        },
        "Wi-Fi revoke of an ended grant gave up; the device may stay online until the controller drops it.",
      );
    else if (failure !== null)
      logger.warn(
        {
          module: "edge-wifi",
          err: { name: (failure as Error)?.name, code: errorCode(failure) },
        },
        "Wi-Fi revoke of an ended grant failed; the reconcile loop retries it.",
      );
    return failure === null;
  }

  /** Revokes one live row at the controller; success makes it `revoked`. */
  async function revokeRow(
    ctx: ScopedTenantContext,
    row: GrantRow,
  ): Promise<boolean> {
    const tenantId = ctx.tenant.tenantId;
    const outletId = row.outletId as OutletId;
    let failure: unknown = null;
    try {
      const node = providerContext(ctx, outletId);
      await withTimeout(() =>
        provider.revoke(node, { tenantId, outletId, reference: row.id }),
      );
    } catch (error) {
      failure = error;
    }
    const at = now();
    await withTenant(db, ctx, async (tx) => {
      await lockDevice(tx, tenantId, outletId, row.deviceHash);
      const where = scoped(
        tenantId,
        outletId,
        eq(wifiDeviceGrants.id, row.id),
        inArray(wifiDeviceGrants.status, [...LIVE]),
      );
      if (failure === null)
        await tx
          .update(wifiDeviceGrants)
          .set({
            status: "revoked",
            endedAt: at,
            controllerDeviceId: null,
            lastErrorCode: null,
            // An in-flight authorize may still land after this revoke (a
            // timed-out call, or one still running): owe one delayed
            // confirming revoke. Step 1b sends it and clears the marker.
            revokeRetryAt: sql`CASE WHEN ${inArray(wifiDeviceGrants.status, [...INFLIGHT])} THEN ${addSeconds(at, REVOKE_RETRY_MIN_SECONDS).toISOString()}::timestamptz END`,
            updatedAt: at,
          })
          .where(where);
      else
        await tx
          .update(wifiDeviceGrants)
          .set({ lastErrorCode: errorCode(failure), updatedAt: at })
          .where(where);
    });
    if (failure !== null)
      logger.warn(
        {
          module: "edge-wifi",
          err: { name: (failure as Error)?.name, code: errorCode(failure) },
        },
        "Wi-Fi revoke failed; the reconcile loop retries it.",
      );
    return failure === null;
  }

  /**
   * Make-before-break replacement of an active grant by a base grant (quota
   * spent or renewal). Returns null when the device changed meanwhile.
   */
  async function replaceWithBase(
    ctx: ScopedTenantContext,
    old: GrantRow,
    hosts: readonly string[],
  ): Promise<Outcome | null> {
    const tenantId = ctx.tenant.tenantId;
    const outletId = old.outletId;
    const at = now();
    const inserted = await withTenant(db, ctx, async (tx) => {
      await lockDevice(tx, tenantId, outletId, old.deviceHash);
      const live = await tx
        .select()
        .from(wifiDeviceGrants)
        .where(
          scoped(
            tenantId,
            outletId,
            eq(wifiDeviceGrants.deviceHash, old.deviceHash),
            inArray(wifiDeviceGrants.status, [...LIVE]),
          ),
        );
      const stillCurrent = live.find(
        (r) =>
          r.id === old.id &&
          r.status === "active" &&
          r.revokeRequestedAt === null,
      );
      if (!stillCurrent || live.some((r) => r.status !== "active")) return null;
      const [row] = await tx
        .insert(wifiDeviceGrants)
        .values({
          tenantId,
          outletId,
          wifiSessionId: old.wifiSessionId,
          deviceHash: old.deviceHash,
          controllerDeviceId: stillCurrent.controllerDeviceId,
          speedTier: "base",
          bandwidthKbps: old.baseBandwidthKbps,
          baseBandwidthKbps: old.baseBandwidthKbps,
          durationSeconds: baseDuration(at, old.renewUntil),
          status: "pending",
          renewUntil: old.renewUntil,
          requestedAt: at,
          createdAt: at,
          updatedAt: at,
        })
        .returning();
      return row ?? null;
    });
    if (!inserted) return null;
    return authorizeRow(ctx, inserted, hosts);
  }

  async function applySession(
    ctx: ScopedTenantContext,
    rawInput: ApplyWifiSessionInput,
  ): Promise<WifiGrantView> {
    assertTrustedScopedContext(ctx);
    const input = applyWifiSessionInputSchema.parse(rawInput);
    const outletId = scopeOf(ctx, input.outletId);
    const tenantId = ctx.tenant.tenantId;
    const controllerDeviceId = normalizeControllerDeviceId(
      input.controllerDeviceId,
    );
    const deviceHash = wifiDeviceHash(tenantId, controllerDeviceId);
    const tier: SpeedTier =
      input.speedTier === "full" && input.remainingSeconds > 0
        ? "full"
        : "base";
    const at = now();
    const renewUntil = new Date(
      Math.min(
        new Date(input.sessionEndsAt).getTime(),
        addSeconds(at, RENEW_HORIZON_SECONDS).getTime(),
      ),
    );
    const untilRenew = seconds(renewUntil.getTime() - at.getTime());
    const bandwidthKbps =
      tier === "full" ? input.fullSpeedKbps : input.baseSpeedKbps;
    const durationSeconds =
      tier === "full"
        ? Math.min(input.remainingSeconds, untilRenew) + WIFI_FULL_GRACE_SECONDS
        : baseDuration(at, renewUntil);
    const wantedExpiry = addSeconds(at, durationSeconds).getTime();
    const sameRequest = (r: GrantRow) =>
      r.speedTier === tier &&
      r.bandwidthKbps === bandwidthKbps &&
      r.baseBandwidthKbps === input.baseSpeedKbps &&
      Math.abs(r.renewUntil.getTime() - renewUntil.getTime()) <=
        REUSE_TOLERANCE_SECONDS * 1000;
    // Built before the write so a bad list never leaves a pending row behind.
    const garden = await walledGarden(ctx);

    const decision = await withTenant(db, ctx, async (tx) => {
      await lockDevice(tx, tenantId, outletId, deviceHash);
      const live = await tx
        .select()
        .from(wifiDeviceGrants)
        .where(
          scoped(
            tenantId,
            outletId,
            eq(wifiDeviceGrants.deviceHash, deviceHash),
            inArray(wifiDeviceGrants.status, [...LIVE]),
          ),
        );
      if (live.some((r) => r.wifiSessionId !== input.wifiSessionId))
        throw new HttpError(
          409,
          "WIFI_DEVICE_BOUND_ELSEWHERE",
          "Perangkat ini sedang dipakai sesi Wi-Fi lain.",
        );
      if (live.some((r) => r.revokeRequestedAt !== null))
        throw new HttpError(
          409,
          "WIFI_SESSION_ENDED",
          "Sesi Wi-Fi ini sedang diakhiri.",
        );
      const inflight = live.find((r) => r.status !== "active");
      if (inflight) {
        if (sameRequest(inflight))
          return { kind: "existing" as const, row: inflight };
        throw new HttpError(
          409,
          "WIFI_GRANT_IN_FLIGHT",
          "Perubahan Wi-Fi sebelumnya masih diproses. Coba lagi sebentar.",
        );
      }
      const active = live.find((r) => r.status === "active");
      if (active && sameRequest(active) && active.expiresAt) {
        const expiry = active.expiresAt.getTime();
        const farEnough =
          tier === "full"
            ? Math.abs(expiry - wantedExpiry) <= REUSE_TOLERANCE_SECONDS * 1000
            : expiry - at.getTime() > WIFI_RENEW_LEAD_SECONDS * 1000;
        if (farEnough) return { kind: "existing" as const, row: active };
      }
      const [row] = await tx
        .insert(wifiDeviceGrants)
        .values({
          tenantId,
          outletId,
          wifiSessionId: input.wifiSessionId,
          deviceHash,
          controllerDeviceId,
          speedTier: tier,
          bandwidthKbps,
          baseBandwidthKbps: input.baseSpeedKbps,
          durationSeconds,
          status: "pending",
          renewUntil,
          requestedAt: at,
          createdAt: at,
          updatedAt: at,
        })
        .returning();
      if (!row) throw new Error("Wi-Fi grant insert returned no row");
      return { kind: "new" as const, row };
    });
    if (decision.kind === "existing") return toView(decision.row);

    const { outcome, row } = await authorizeRow(
      ctx,
      decision.row,
      garden.hosts,
    );
    if (outcome === "failed")
      throw new HttpError(
        502,
        "WIFI_AUTHORIZE_REFUSED",
        "Controller Wi-Fi menolak perangkat ini.",
      );
    return toView(row);
  }

  async function endSession(
    ctx: ScopedTenantContext,
    input: { outletId: OutletId; wifiSessionId: string; reason: WifiEndReason },
  ): Promise<WifiGrantView[]> {
    const outletId = scopeOf(ctx, input.outletId);
    const wifiSessionId = uuidSchema.parse(input.wifiSessionId);
    const reason = wifiEndReasonSchema.parse(input.reason);
    const tenantId = ctx.tenant.tenantId;
    const bySession = eq(wifiDeviceGrants.wifiSessionId, wifiSessionId);
    const at = now();
    const live = await withTenant(db, ctx, async (tx) => {
      const [any] = await tx
        .select({ id: wifiDeviceGrants.id })
        .from(wifiDeviceGrants)
        .where(scoped(tenantId, outletId, bySession))
        .limit(1);
      if (!any)
        throw new HttpError(
          404,
          "WIFI_SESSION_NOT_FOUND",
          "Sesi Wi-Fi tidak ditemukan.",
        );
      await tx
        .update(wifiDeviceGrants)
        .set({ revokeRequestedAt: at, endReason: reason, updatedAt: at })
        .where(
          scoped(
            tenantId,
            outletId,
            bySession,
            inArray(wifiDeviceGrants.status, [...LIVE]),
            isNull(wifiDeviceGrants.revokeRequestedAt),
          ),
        );
      return tx
        .select()
        .from(wifiDeviceGrants)
        .where(
          scoped(
            tenantId,
            outletId,
            bySession,
            inArray(wifiDeviceGrants.status, [...LIVE]),
          ),
        );
    });
    for (const row of live) await revokeRow(ctx, row);
    return sessionGrants(ctx, outletId, wifiSessionId);
  }

  async function sessionGrants(
    ctx: ScopedTenantContext,
    outletId: string,
    wifiSessionId: string,
  ): Promise<WifiGrantView[]> {
    const rows = await withTenant(db, ctx, (tx) =>
      tx
        .select()
        .from(wifiDeviceGrants)
        .where(
          scoped(
            ctx.tenant.tenantId,
            outletId,
            eq(wifiDeviceGrants.wifiSessionId, wifiSessionId),
          ),
        )
        .orderBy(asc(wifiDeviceGrants.requestedAt), asc(wifiDeviceGrants.id))
        .limit(LIST_LIMIT),
    );
    return rows.map(toView);
  }

  async function listLiveGrants(
    ctx: ScopedTenantContext,
    rawOutletId: OutletId,
  ): Promise<WifiGrantView[]> {
    const outletId = scopeOf(ctx, rawOutletId);
    const rows = await withTenant(db, ctx, (tx) =>
      tx
        .select()
        .from(wifiDeviceGrants)
        .where(
          scoped(
            ctx.tenant.tenantId,
            outletId,
            inArray(wifiDeviceGrants.status, [...LIVE]),
          ),
        )
        .orderBy(asc(wifiDeviceGrants.requestedAt), asc(wifiDeviceGrants.id))
        .limit(LIST_LIMIT),
    );
    return rows.map(toView);
  }

  async function reconcile(ctx: ScopedTenantContext, rawOutletId: OutletId) {
    const outletId = scopeOf(ctx, rawOutletId);
    const tenantId = ctx.tenant.tenantId;
    const counts = {
      authorized: 0,
      downgraded: 0,
      renewed: 0,
      revoked: 0,
      failed: 0,
    };
    let budget = RECONCILE_BATCH;
    const at = now();
    const select = (where: SQL | undefined, limit: number) =>
      withTenant(db, ctx, (tx) =>
        tx
          .select()
          .from(wifiDeviceGrants)
          .where(where)
          .orderBy(asc(wifiDeviceGrants.updatedAt), asc(wifiDeviceGrants.id))
          .limit(limit),
      );
    const gardenKey = `${tenantId}:${outletId}`;
    let garden: { hosts: string[]; version: string } | null = null;
    let gardenFailed = false;
    // A failed build never stops renewals: fall back to the last good list
    // (a retry reuses its in-flight list in authorizeRow anyway).
    const hosts = async (): Promise<readonly string[]> => {
      if (garden) return garden.hosts;
      if (!gardenFailed)
        try {
          garden = await walledGarden(ctx);
          lastGoodGarden.set(gardenKey, garden.hosts);
          return garden.hosts;
        } catch (error) {
          gardenFailed = true;
          logger.warn(
            {
              module: "edge-wifi",
              err: { name: (error as Error)?.name, code: errorCode(error) },
            },
            "Wi-Fi walled-garden build failed; the last good list is used.",
          );
        }
      return lastGoodGarden.get(gardenKey) ?? [];
    };
    const tally = (outcome: Outcome["outcome"], key: keyof typeof counts) => {
      if (outcome === "active") counts[key] += 1;
      else if (outcome === "failed") counts.failed += 1;
    };

    // 1. Revokes that did not reach the controller.
    for (const row of await select(
      scoped(
        tenantId,
        outletId,
        inArray(wifiDeviceGrants.status, [...LIVE]),
        isNotNull(wifiDeviceGrants.revokeRequestedAt),
      ),
      budget,
    )) {
      budget -= 1;
      if (await revokeRow(ctx, row)) counts.revoked += 1;
    }
    // Ended rows that still owe a controller revoke (a grant that landed
    // after its revoke), once their backoff is due.
    if (budget > 0)
      for (const row of await withTenant(db, ctx, (tx) =>
        tx
          .select()
          .from(wifiDeviceGrants)
          .where(
            scoped(
              tenantId,
              outletId,
              inArray(wifiDeviceGrants.status, [...TERMINAL]),
              lte(wifiDeviceGrants.revokeRetryAt, at),
            ),
          )
          .orderBy(
            asc(wifiDeviceGrants.revokeRetryAt),
            asc(wifiDeviceGrants.id),
          )
          .limit(budget),
      )) {
        budget -= 1;
        if (await retryTerminalRevoke(ctx, row)) counts.revoked += 1;
      }

    // 2. In-flight rows left by a timeout or crash: repeat the identical
    //    request (same reference, idempotent at the controller).
    if (budget > 0)
      for (const row of await select(
        scoped(
          tenantId,
          outletId,
          inArray(wifiDeviceGrants.status, [...INFLIGHT]),
          isNull(wifiDeviceGrants.revokeRequestedAt),
          lte(
            wifiDeviceGrants.updatedAt,
            new Date(at.getTime() - INFLIGHT_RETRY_AFTER_MS),
          ),
        ),
        budget,
      )) {
        budget -= 1;
        tally(
          (await authorizeRow(ctx, row, await hosts())).outcome,
          "authorized",
        );
      }

    // 3. Full grants whose quota is spent: base grant before the controller
    //    expiry (FAC-13 throttle, never cut).
    if (budget > 0)
      for (const row of await select(
        scoped(
          tenantId,
          outletId,
          eq(wifiDeviceGrants.status, "active"),
          eq(wifiDeviceGrants.speedTier, "full"),
          isNull(wifiDeviceGrants.revokeRequestedAt),
          lte(
            wifiDeviceGrants.expiresAt,
            addSeconds(at, WIFI_FULL_GRACE_SECONDS),
          ),
          sql`${wifiDeviceGrants.renewUntil} > ${at}`,
        ),
        budget,
      )) {
        budget -= 1;
        const result = await replaceWithBase(ctx, row, await hosts());
        if (result) tally(result.outcome, "downgraded");
      }

    // 4. Base grants close to expiry, while the session lasts: renew.
    if (budget > 0)
      for (const row of await select(
        scoped(
          tenantId,
          outletId,
          eq(wifiDeviceGrants.status, "active"),
          eq(wifiDeviceGrants.speedTier, "base"),
          isNull(wifiDeviceGrants.revokeRequestedAt),
          lte(
            wifiDeviceGrants.expiresAt,
            addSeconds(at, WIFI_RENEW_LEAD_SECONDS),
          ),
          sql`${wifiDeviceGrants.renewUntil} > ${at}`,
          // Only when a new grant would last longer: near renew_until the
          // current grant already runs to renew_until + grace.
          sql`${wifiDeviceGrants.expiresAt} + interval '1 second' < LEAST(${wifiDeviceGrants.renewUntil}, ${addSeconds(at, WIFI_BASE_CHUNK_SECONDS)}::timestamptz) + make_interval(secs => ${WIFI_FULL_GRACE_SECONDS})`,
        ),
        budget,
      )) {
        budget -= 1;
        const result = await replaceWithBase(ctx, row, await hosts());
        if (result) tally(result.outcome, "renewed");
      }

    // 5. Grants past expiry once the session's renewal window closed.
    if (budget > 0) {
      const ended = await withTenant(db, ctx, async (tx) => {
        const due = await tx
          .select({ id: wifiDeviceGrants.id })
          .from(wifiDeviceGrants)
          .where(
            scoped(
              tenantId,
              outletId,
              eq(wifiDeviceGrants.status, "active"),
              isNull(wifiDeviceGrants.revokeRequestedAt),
              lte(wifiDeviceGrants.expiresAt, at),
              lte(wifiDeviceGrants.renewUntil, at),
            ),
          )
          .orderBy(asc(wifiDeviceGrants.expiresAt), asc(wifiDeviceGrants.id))
          .limit(budget);
        if (due.length === 0) return [];
        return tx
          .update(wifiDeviceGrants)
          .set({
            revokeRequestedAt: at,
            endReason: "day_closed",
            updatedAt: at,
          })
          .where(
            scoped(
              tenantId,
              outletId,
              inArray(
                wifiDeviceGrants.id,
                due.map((r) => r.id),
              ),
              eq(wifiDeviceGrants.status, "active"),
              isNull(wifiDeviceGrants.revokeRequestedAt),
            ),
          )
          .returning();
      });
      for (const row of ended) {
        budget -= 1;
        if (await revokeRow(ctx, row)) counts.revoked += 1;
      }
    }

    // 6. Pre-auth allowlist at the controller, when the adapter can set it.
    //    Skipped when the build failed this tick: a fallback list is never
    //    pushed (it could wipe the controller's allowlist).
    if (supportsWalledGardenSync(provider) && !gardenFailed) {
      const key = gardenKey;
      try {
        const current = garden ?? (await walledGarden(ctx));
        lastGoodGarden.set(key, current.hosts);
        if (syncedGarden.get(key) !== current.version) {
          await withTimeout(() =>
            provider.syncWalledGarden(
              providerContext(ctx, outletId),
              current.hosts,
            ),
          );
          syncedGarden.set(key, current.version);
        }
      } catch (error) {
        logger.warn(
          {
            module: "edge-wifi",
            err: { name: (error as Error)?.name, code: errorCode(error) },
          },
          "Wi-Fi walled-garden sync failed; retried next tick.",
        );
      }
    }
    return counts;
  }

  return { applySession, endSession, listLiveGrants, walledGarden, reconcile };
}
