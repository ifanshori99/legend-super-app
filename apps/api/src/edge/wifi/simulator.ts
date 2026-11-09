// In-memory Wi-Fi controller simulator (bead legend-hsk) for dev, test and demo.
// It models what a real controller remembers: one current grant per device, a
// pre-auth allowlist per outlet and a clock. A new grant for a device replaces
// the old one without a gap; a grant that lapses while the device was never
// revoked is a cut, and `cuts()` records it so tests can prove a speed change or
// a late loop never cut a guest (FAC-13). Behavior per call is scripted with
// `script()`; the default is `ok`.
import {
  CoreError,
  assertOutletInScope,
  assertTrustedScopedContext,
} from "@starter/shared/core";
import type { ScopedTenantContext, z } from "@starter/shared/core";
import {
  scopedReferenceSchema,
  stableStringify,
  wifiRequestSchema,
  wifiResultSchema,
} from "@starter/shared/adapters";
import type {
  ScopedReference,
  WifiProvider,
  WifiRequest,
  WifiResult,
} from "@starter/shared/adapters";
import { WifiProviderError, buildWalledGarden } from "@starter/shared/edge";
import type { WifiWalledGardenSync } from "@starter/shared/edge";

export type WifiSimulatorMethod = "authorize" | "revoke" | "syncWalledGarden";
/** - `reject`: authorize answers `authorized: false` and applies nothing; revoke
 *   and sync throw `WIFI_PROVIDER_UNAVAILABLE` (an error answer, applies nothing).
 * - `timeout`, `transport_error`: throw `WIFI_PROVIDER_TIMEOUT` or
 *   `WIFI_PROVIDER_UNAVAILABLE`, nothing applied.
 * - `applied_then_timeout`: the call takes effect, then throws
 *   `WIFI_PROVIDER_TIMEOUT` (the caller cannot know). */
export type WifiSimulatorOutcome =
  "ok" | "reject" | "timeout" | "transport_error" | "applied_then_timeout";

export type WifiDeviceAccess =
  | { state: "blocked" }
  | {
      state: "online";
      bandwidthKbps: number;
      reference: string;
      expiresAt: Date;
    };

export type WifiSimulatorCut = {
  tenantId: string;
  outletId: string;
  deviceId: string;
  reference: string;
  /** The moment the grant lapsed. */
  at: Date;
};

export type WifiSimulatorCalls = Record<WifiSimulatorMethod, number>;

type GrantRecord = {
  reference: string;
  fingerprint: string;
  deviceKey: string;
  tenantId: string;
  outletId: string;
  deviceId: string;
  bandwidthKbps: number;
  expiresAt: Date;
  revoked: boolean;
  superseded: boolean;
  cutRecorded: boolean;
};

const keyOf = (...parts: readonly unknown[]) => JSON.stringify(parts);
const reused = () =>
  new CoreError(
    "IDEMPOTENCY_KEY_REUSED",
    "Kunci atau referensi yang sama dipakai dengan permintaan berbeda.",
  );

export class WifiControllerSimulator
  implements WifiProvider, WifiWalledGardenSync
{
  readonly #now: () => Date;
  /** Every grant by (tenant, outlet, reference). */
  readonly #grants = new Map<string, GrantRecord>();
  /** References revoked before the controller ever saw them (same key as
   * `#grants`). A revoked reference never authorizes again, even one the
   * controller first hears of later (provider contract). */
  readonly #revokedUnknown = new Set<string>();
  /** Key (in `#grants`) of the grant currently applied to a device. */
  readonly #current = new Map<string, string>();
  /** Pre-auth allowlist by (tenant, outlet); outlet null = tenant-wide scope. */
  readonly #allowlists = new Map<string, readonly string[]>();
  readonly #scripts = new Map<WifiSimulatorMethod, WifiSimulatorOutcome[]>();
  readonly #cuts: WifiSimulatorCut[] = [];
  readonly #requests: WifiRequest[] = [];
  readonly calls: WifiSimulatorCalls = {
    authorize: 0,
    revoke: 0,
    syncWalledGarden: 0,
  };

  constructor(options: { now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  /** Queue the outcome of the next call to `method` (one outcome per call). */
  script(method: WifiSimulatorMethod, outcome: WifiSimulatorOutcome): this {
    const queue = this.#scripts.get(method) ?? [];
    queue.push(outcome);
    this.#scripts.set(method, queue);
    return this;
  }

  async authorize(
    context: ScopedTenantContext,
    input: WifiRequest,
  ): Promise<WifiResult> {
    const v = this.#accept(context, wifiRequestSchema, input);
    this.calls.authorize += 1;
    const outcome = this.#nextOutcome("authorize");
    this.#sweep();
    if (outcome === "timeout") throw timeoutError();
    if (outcome === "transport_error") throw unavailableError();
    const key = keyOf(v.tenantId, v.outletId, v.reference);
    const fingerprint = stableStringify(v);
    const existing = this.#grants.get(key);
    if (existing && existing.fingerprint !== fingerprint) throw reused();
    if ((outcome === "reject" || this.#revokedUnknown.has(key)) && !existing)
      return wifiResultSchema.parse({
        reference: v.reference,
        authorized: false,
      });
    let authorized: boolean;
    if (existing) {
      // Replay: the first answer, nothing applied again.
      authorized = !existing.revoked;
    } else {
      this.#requests.push(structuredClone(v));
      const deviceKey = keyOf(v.tenantId, v.outletId, v.deviceId);
      const previousKey = this.#current.get(deviceKey);
      const previous =
        previousKey === undefined ? undefined : this.#grants.get(previousKey);
      if (previous) previous.superseded = true;
      this.#grants.set(key, {
        reference: v.reference,
        fingerprint,
        deviceKey,
        tenantId: v.tenantId,
        outletId: v.outletId,
        deviceId: v.deviceId,
        bandwidthKbps: v.bandwidthKbps,
        expiresAt: new Date(this.#now().getTime() + v.durationSeconds * 1000),
        revoked: false,
        superseded: false,
        cutRecorded: false,
      });
      this.#current.set(deviceKey, key);
      authorized = true;
    }
    if (outcome === "applied_then_timeout") throw timeoutError();
    return wifiResultSchema.parse({ reference: v.reference, authorized });
  }

  /** Revoking the current reference blocks the device; a superseded or unknown
   * reference changes nothing on the device. An unknown reference is
   * remembered: a later authorize of it is refused. Always answers
   * `authorized: false`. */
  async revoke(
    context: ScopedTenantContext,
    input: ScopedReference,
  ): Promise<WifiResult> {
    const v = this.#accept(context, scopedReferenceSchema, input);
    this.calls.revoke += 1;
    const outcome = this.#nextOutcome("revoke");
    this.#sweep();
    if (outcome === "timeout") throw timeoutError();
    if (outcome === "transport_error" || outcome === "reject")
      throw unavailableError();
    const grant = this.#grants.get(keyOf(v.tenantId, v.outletId, v.reference));
    // A superseded grant is no longer the device's: revoking it changes nothing
    // on the device, but the reference never authorizes again.
    if (grant) grant.revoked = true;
    else this.#revokedUnknown.add(keyOf(v.tenantId, v.outletId, v.reference));
    if (outcome === "applied_then_timeout") throw timeoutError();
    return wifiResultSchema.parse({
      reference: v.reference,
      authorized: false,
    });
  }

  /** Stores the pre-auth allowlist for every outlet the context reaches. */
  async syncWalledGarden(
    context: ScopedTenantContext,
    hosts: readonly string[],
  ): Promise<void> {
    assertTrustedScopedContext(context);
    const list = buildWalledGarden({ extraHosts: hosts });
    this.calls.syncWalledGarden += 1;
    const outcome = this.#nextOutcome("syncWalledGarden");
    if (outcome === "timeout") throw timeoutError();
    if (outcome === "transport_error" || outcome === "reject")
      throw unavailableError();
    const { tenantId } = context.tenant;
    const scope = context.outletScope;
    const outlets = scope.kind === "outlets" ? scope.outletIds : [null];
    for (const outletId of outlets)
      this.#allowlists.set(keyOf(tenantId, outletId), list);
    if (outcome === "applied_then_timeout") throw timeoutError();
  }

  /** What the controller does with this device right now. */
  deviceAccess(
    tenantId: string,
    outletId: string,
    deviceId: string,
  ): WifiDeviceAccess {
    this.#sweep();
    const grantKey = this.#current.get(keyOf(tenantId, outletId, deviceId));
    const grant =
      grantKey === undefined ? undefined : this.#grants.get(grantKey);
    if (!grant || !this.#live(grant)) return { state: "blocked" };
    return {
      state: "online",
      bandwidthKbps: grant.bandwidthKbps,
      reference: grant.reference,
      expiresAt: new Date(grant.expiresAt),
    };
  }

  /** Can this device open `host`? Yes when the device is online or the host is
   * in the outlet's pre-auth allowlist (exact, or `*.suffix` for a subdomain).
   * `deviceId` null: an unknown device that never authenticated. */
  canReach(
    tenantId: string,
    outletId: string,
    deviceId: string | null,
    host: string,
  ): boolean {
    if (
      deviceId !== null &&
      this.deviceAccess(tenantId, outletId, deviceId).state === "online"
    )
      return true;
    const wanted = host.trim().toLowerCase().replace(/\.$/, "");
    const list =
      this.#allowlists.get(keyOf(tenantId, outletId)) ??
      this.#allowlists.get(keyOf(tenantId, null)) ??
      [];
    return list.some((entry) =>
      entry.startsWith("*.")
        ? wanted.endsWith(entry.slice(1))
        : entry === wanted,
    );
  }

  /** Each time a grant lapsed while its device was never revoked. */
  cuts(): readonly WifiSimulatorCut[] {
    this.#sweep();
    return this.#cuts.map((cut) => ({ ...cut, at: new Date(cut.at) }));
  }

  /** Authorize requests the controller applied (replays and failures excluded). */
  get requests(): readonly WifiRequest[] {
    return this.#requests;
  }

  #live(grant: GrantRecord): boolean {
    return !grant.revoked && grant.expiresAt.getTime() > this.#now().getTime();
  }

  /** Records a cut for every current grant that lapsed and was not revoked. */
  #sweep(): void {
    const now = this.#now().getTime();
    for (const grantKey of this.#current.values()) {
      const grant = this.#grants.get(grantKey);
      if (
        !grant ||
        grant.revoked ||
        grant.cutRecorded ||
        grant.expiresAt.getTime() > now
      )
        continue;
      grant.cutRecorded = true;
      this.#cuts.push({
        tenantId: grant.tenantId,
        outletId: grant.outletId,
        deviceId: grant.deviceId,
        reference: grant.reference,
        at: new Date(grant.expiresAt),
      });
    }
  }

  #nextOutcome(method: WifiSimulatorMethod): WifiSimulatorOutcome {
    return this.#scripts.get(method)?.shift() ?? "ok";
  }

  /** Trusted context, schema, then tenant and outlet checks (as the fake). */
  #accept<S extends z.ZodType<{ tenantId: string; outletId: string }>>(
    context: ScopedTenantContext,
    schema: S,
    input: unknown,
  ): z.output<S> {
    assertTrustedScopedContext(context);
    const value = schema.parse(input);
    if (context.tenant.tenantId !== value.tenantId)
      throw new TypeError("Tenant mismatch");
    assertOutletInScope(context.outletScope, value.outletId);
    return value;
  }
}

const timeoutError = () =>
  new WifiProviderError("WIFI_PROVIDER_TIMEOUT", "Controller timeout");
const unavailableError = () =>
  new WifiProviderError("WIFI_PROVIDER_UNAVAILABLE", "Controller unavailable");
