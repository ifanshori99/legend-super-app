// EDC agent in the cloud API (B2 legend-wasr7.21; design
// docs/design/edc-auto-cloud.md, protocol docs/design/edc-bridge-protocol.md).
// Cashier (PWA) -> API -> this agent (agent.ts, E1-E7, money rules unchanged)
// -> provider (bridge tablet over WSS, or BCA cloud in B5a) -> terminal.
//
// - One agent per process, outlets taken lazily: the first tablet of an outlet
//   that says `hello` makes the agent take the outlet's advisory lock
//   (`agent.start`). A second process gets no lock, grants no lease and so
//   never sends a command; its cashiers get `EDC_AGENT_NOT_READY`. single-vm
//   runs one API process; nothing here forwards a command to another process.
// - A terminal is ready only while a live session of THIS process holds its
//   lease with more than 30 s left (`edcBridgeLeaseAllowsCommand`). Otherwise
//   the registry answers `EDC_AGENT_NOT_READY` before any ledger row exists,
//   and the cashier uses EDC manual (X1, pos-edc-standalone.ts refuses it
//   while a sale is pending or unknown).
// - Outlet lock lost (CTO decision, B2): never the process. Only that outlet
//   stops: its bridge sockets are closed (`goodbye server_shutdown`, the
//   tablet reconnects), their leases leave memory, its commands still on the
//   wire stop listening on the session (their result is late: stored and
//   acked, never settling the ledger) and run to their deadline, so a
//   dispatched sale ends `unknown` and the next owner's inquiry settles it.
//   New requests of the outlet get `EDC_AGENT_NOT_READY` until the lock is
//   taken again (retried with backoff, 1 s doubling to 30 s). Other outlets
//   keep running. The lease rows stay: no other tablet takes the terminal
//   before the handover time; the same tablet gets it back. The edge agent
//   still exits (agent.ts fail-stop).
// - Leases live in `edc_bridge_terminal_leases` on the cloud clock. A terminal
//   goes to another tablet only after `issuedAt + ttlMs + 300 s + 30 s`
//   (`edcBridgeLeaseReusableAt`), checked in the same INSERT .. ON CONFLICT.
//   TTL 120 s, renewed every 30 s, so a command always has >= 90 s of lease.
// - Every command is kept in memory until its result or deadline
//   (`timeoutMs` + grace) and in `edc_bridge_commands`. A `result` counts only
//   for a command sent to that device with the same terminal, op and trace,
//   and a `replayOf` naming an earlier sale of the same device, terminal and
//   trace. A result whose command is no longer in memory (late, or after a
//   restart) is matched in tenant + outlet + device + terminal, stored and
//   acked; the ledger is then settled by inquiry, never by that late result.
// - Revoked device: its socket gets `goodbye token_revoked` and is closed, no
//   new command goes to it; its leases still run out on the cloud clock.
// - `sale_record_release` goes to a device for its sale traces whose
//   settlement line was matched (X2), after the import and on every `hello`.
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  outletIdSchema,
  tenantIdSchema,
  uuidToUlid,
  type OutletId,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  EdcError,
  type EcrTerminal,
  type EdcProvider,
} from "@starter/shared/edc";
import {
  EDC_BRIDGE_LEASE_HANDOVER_GRACE_MS,
  EDC_BRIDGE_MAX_COMMAND_TIMEOUT_MS,
  edcBridgeCommandSchema,
  edcBridgeDeviceTokenSchema,
  edcBridgeLeaseAllowsCommand,
  edcBridgeLinkSchema,
  isSupportedEdcBridgeVersion,
  type EdcBridgeAnswer,
  type EdcBridgeDownlink,
  type EdcBridgeGoodbye,
  type EdcBridgeLease,
  type EdcBridgeOp,
  type EdcBridgeResult,
  type EdcBridgeUplink,
} from "@starter/shared/edc/bridge";
import { db as defaultDb } from "../../db/index.ts";
import {
  edcBridgeCommands,
  edcBridgeDevices,
  edcBridgeTerminalLeases,
  edcSettlementRows,
  edcTransactions,
  paymentEdcTerminals,
} from "../../db/schema/index.ts";
import { withTenant } from "../../db/tenant.ts";
import { logger } from "../../lib/logger.ts";
import { createEdcAgent, type Database, type EdcAgent } from "./agent.ts";
import {
  createProductionBridgeCodecs,
  type EdcBridgeCodec,
} from "./bridge-codec.ts";
import {
  EdcBridgeProvider,
  type EdcBridgeTransport,
} from "./bridge-provider.ts";
import type { EdcProviderLookup, EdcProviderTarget } from "./registry.ts";
import { EDC_SALE_TIMEOUT_MS } from "./runtime.ts";

export const EDC_BRIDGE_LEASE_TTL_MS = 120_000;
export const EDC_BRIDGE_LEASE_RENEW_MS = 30_000;
/** Extra wait for a result after the command's own `timeoutMs`. */
export const EDC_BRIDGE_RESULT_GRACE_MS = 30_000;
const EDC_TRACE_TIMEOUT_MS = 15_000;
const MAX_GRANTS = 8;
const RELEASE_CHUNK = 500;

/** The socket of one bridge session (routes/edc-bridge.routes.ts). */
export type EdcBridgeSocket = {
  /** Writes one text frame now; false when the socket is not open (nothing
   * written). */
  send(text: string): boolean;
  close(): void;
};

export type EdcBridgeDevice = {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly outletId: OutletId;
};

type Lease = { leaseId: string; issuedAt: Date; ttlMs: number };

type Session = {
  readonly id: string;
  readonly device: EdcBridgeDevice;
  readonly socket: EdcBridgeSocket;
  readonly leases: Map<string, Lease>;
  helloed: boolean;
  closed: boolean;
  /** One lease renewal at a time per session (`hello`, the renewal tick):
   * overlapping renewals could hand the tablet two lease ids. */
  renewal: Promise<void>;
};

type Pending = {
  readonly commandId: string;
  readonly device: EdcBridgeDevice;
  readonly terminalId: string;
  readonly op: EdcBridgeOp;
  readonly trace: string;
  stored: Promise<boolean>;
  readonly settle: (answer: EdcBridgeAnswer) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  /** The outlet lock was lost after it went out: a result is late. */
  orphaned: boolean;
  /** The `edc_bridge_commands` row, kept to insert it again. */
  record: typeof edcBridgeCommands.$inferInsert | null;
};

/** Attempts of a command or result write: the first and 3 retries. */
const PERSIST_RETRY_MS = [100, 300, 900] as const;

/** Picks the provider per terminal (`connection_kind`). */
export class CloudEdcProviderRegistry implements EdcProviderLookup {
  readonly #bridge = new Map<string, EdcBridgeProvider>();
  readonly #bcaCloud: CloudEdcProvider | null;

  constructor(
    bridge: readonly EdcBridgeProvider[],
    bcaCloud: CloudEdcProvider | null,
  ) {
    for (const provider of bridge) {
      if (this.#bridge.has(provider.bank))
        throw new Error(
          `EDC bridge codec already registered for ${provider.bank}`,
        );
      this.#bridge.set(provider.bank, provider);
    }
    this.#bcaCloud = bcaCloud;
  }

  bridgeProvider(bank: string): EdcBridgeProvider | null {
    return this.#bridge.get(bank) ?? null;
  }

  /** Without a target (`canSell`): some provider exists for the bank. With
   * one: the terminal's own provider, refused (`EDC_AGENT_NOT_READY`) when
   * its transport is not live in this process. */
  get(bank: string, target?: EdcProviderTarget): EdcProvider {
    if (!target) {
      const any =
        this.#bridge.get(bank) ??
        (bank === "bca" ? this.#bcaCloud : null) ??
        null;
      if (!any) throw new EdcError("EDC_PROVIDER_UNKNOWN");
      return any;
    }
    const cloud = target.connectionKind === "bca_cloud" && bank === "bca";
    const provider =
      target.connectionKind === "bridge"
        ? this.#bridge.get(bank)
        : cloud
          ? this.#bcaCloud
          : null;
    // B5a: no BCA credentials in this process = not ready (EDC manual X1).
    if (!provider && cloud) throw new EdcError("EDC_AGENT_NOT_READY");
    if (!provider) throw new EdcError("EDC_PROVIDER_UNKNOWN");
    if (!provider.ready(target)) throw new EdcError("EDC_AGENT_NOT_READY");
    return provider;
  }
}

/** A cloud provider plugs in with its own readiness (B5a: BCA ECR cloud API,
 * docs/design/edc-bridge-protocol.md "Provider cloud"). */
export type CloudEdcProvider = EdcProvider & {
  ready(terminal: { tenantId: string; outletId: string; id: string }): boolean;
  /** Outlets with an active terminal of this provider: their lock is taken
   * at boot (`startOutlets`), since no tablet ever says `hello` for them. */
  outlets(): Promise<ReadonlyArray<{ tenantId: string; outletId: string }>>;
  /** Before a sale or the payment options of one of its outlets: gets what
   * `ready` needs (B5a: a fresh access token). Never throws. */
  prepare?(): Promise<void>;
};

/** The terminal rows `prepareSale` may get (payment options loaded them). */
export type CloudEdcTerminalHint = Pick<
  TerminalRow,
  "bankCode" | "connectionKind" | "status"
>;

/** An active terminal the `bca_cloud` provider serves. */
const servedByBcaCloud = (row: CloudEdcTerminalHint) =>
  row.connectionKind === "bca_cloud" &&
  row.bankCode === "bca" &&
  row.status === "active";

export type CloudEdcRuntimeOptions = {
  db?: Database;
  codecs?: readonly EdcBridgeCodec[];
  /** The `bca_cloud` provider (B5a, bca-cloud-provider.ts); none without
   * BCA credentials. */
  bcaCloud?: CloudEdcProvider | null;
  saleTimeoutMs?: number;
  /** Inquiry, cancel and void on the terminal. */
  traceTimeoutMs?: number;
  resultGraceMs?: number;
  leaseTtlMs?: number;
  renewMs?: number;
  now?: () => Date;
  /** Delay before retaking a lost outlet lock. Default 1 s doubling, capped
   * at 30 s (as the edge agent). */
  retryDelayMs?: (attempt: number) => number;
};

/** 1 s, doubling, capped at 30 s. */
const defaultRetryDelayMs = (attempt: number) =>
  Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));

const keyOf = (tenantId: string, id: string) =>
  `${tenantId.toLowerCase()}:${id.toLowerCase()}`;

export function edcBridgeDeviceContext(
  tenantId: string,
  outletId: string,
): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "device",
    }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
  );
}

function tenantWideContext(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "device",
    }),
    { kind: "tenant" },
  );
}

export const hashEdcBridgeToken = (token: string) =>
  createHash("sha256").update(token, "utf8").digest("hex");

/** Class only: driver errors can carry SQL parameters. */
function errClass(error: unknown) {
  const failure = error as { name?: unknown; code?: unknown };
  return {
    errName: typeof failure?.name === "string" ? failure.name : "Error",
    code: typeof failure?.code === "string" ? failure.code : undefined,
  };
}

type TerminalRow = typeof paymentEdcTerminals.$inferSelect;

export class CloudEdcRuntime {
  readonly agent: EdcAgent;
  readonly registry: CloudEdcProviderRegistry;
  readonly #db: Database;
  readonly #now: () => Date;
  readonly #ttlMs: number;
  readonly #graceMs: number;
  /** Live session per device. */
  readonly #sessions = new Map<string, Session>();
  /** Session holding each terminal's lease, by tenant + terminal. */
  readonly #holders = new Map<string, Session>();
  readonly #pending = new Map<string, Pending>();
  /** Outlets whose advisory lock the agent holds, by tenant + outlet. */
  readonly #owned = new Set<string>();
  readonly #starting = new Map<string, Promise<boolean>>();
  /** Lock losses per outlet: a start begun before a loss does not count. */
  readonly #losses = new Map<string, number>();
  readonly #retries = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #retryDelayMs: (attempt: number) => number;
  readonly #bcaCloud: CloudEdcProvider | null;
  readonly #renewTimer: ReturnType<typeof setInterval>;
  #stopped = false;

  constructor(options: CloudEdcRuntimeOptions = {}) {
    this.#db = options.db ?? defaultDb;
    this.#now = options.now ?? (() => new Date());
    this.#ttlMs = options.leaseTtlMs ?? EDC_BRIDGE_LEASE_TTL_MS;
    this.#graceMs = options.resultGraceMs ?? EDC_BRIDGE_RESULT_GRACE_MS;
    this.#retryDelayMs = options.retryDelayMs ?? defaultRetryDelayMs;
    this.#bcaCloud = options.bcaCloud ?? null;
    const saleTimeoutMs = options.saleTimeoutMs ?? EDC_SALE_TIMEOUT_MS;
    const traceTimeoutMs = options.traceTimeoutMs ?? EDC_TRACE_TIMEOUT_MS;
    const transport: EdcBridgeTransport = {
      ready: (terminal) => this.#leaseFor(terminal) !== null,
      send: (command) => this.#send(command),
    };
    const codecs = options.codecs ?? createProductionBridgeCodecs();
    this.registry = new CloudEdcProviderRegistry(
      codecs.map(
        (codec) =>
          new EdcBridgeProvider(codec, transport, {
            saleTimeoutMs,
            traceTimeoutMs,
          }),
      ),
      options.bcaCloud ?? null,
    );
    this.agent = createEdcAgent({
      db: this.#db,
      registry: this.registry,
      saleTimeoutMs,
      inquiryTimeoutMs: traceTimeoutMs,
      cancelTimeoutMs: traceTimeoutMs,
      ...(options.now ? { now: options.now } : {}),
      // Never `process.exit` in the cloud: one outlet stops, not the API.
      onFatal: ({ tenantId, outletId, liveCalls }) =>
        this.#outletLost(tenantId, outletId, liveCalls),
      onOutletLost: ({ tenantId, outletId }) =>
        this.#outletLost(tenantId, outletId, 0),
    });
    this.#renewTimer = setInterval(
      () => void this.renewAll(),
      options.renewMs ?? EDC_BRIDGE_LEASE_RENEW_MS,
    );
    this.#renewTimer.unref();
  }

  /** Takes the outlet for the agent (advisory lock), unless already owned.
   * Idempotent; concurrent calls share one attempt. False when another
   * process holds it, the runtime is stopped, or the start failed (logged).
   * Bridge outlets are taken on `hello`; cloud-provider outlets at boot and
   * on their first sale (`prepareSale`). */
  ensureOutlet(tenantId: string, outletId: string): Promise<boolean> {
    return this.#ensureOutlet(tenantId, outletId);
  }

  /** Boot: takes every outlet the cloud provider serves. A refused outlet is
   * retried with backoff. Never throws. */
  async startOutlets(): Promise<void> {
    if (!this.#bcaCloud) return;
    let outlets: ReadonlyArray<{ tenantId: string; outletId: string }>;
    try {
      outlets = await this.#bcaCloud.outlets();
    } catch (error) {
      logger.error(
        errClass(error),
        "The cloud EDC provider could not list its outlets",
      );
      return;
    }
    for (const { tenantId, outletId } of outlets)
      if (!(await this.#ensureOutlet(tenantId, outletId)))
        this.#retryOutlet(tenantId, outletId, 0);
  }

  /** Before a sale or the payment options of an outlet: with a cloud
   * provider configured and an active `bca_cloud` terminal at the outlet,
   * the provider is prepared and the outlet taken lazily (an outlet added
   * after boot). No-op otherwise (B2 review P3): an outlet without such a
   * terminal never takes a lock here, and bridge outlets wait for their
   * tablet. `terminals`: the outlet's terminal rows when the caller has them
   * (payment options); without them one row is read. Never throws. */
  async prepareSale(
    tenantId: string,
    outletId: string,
    terminals?: readonly CloudEdcTerminalHint[],
  ): Promise<void> {
    const provider = this.#bcaCloud;
    if (!provider || this.#stopped) return;
    const serves = terminals
      ? terminals.some(servedByBcaCloud)
      : await this.#hasCloudTerminal(tenantId, outletId);
    if (!serves) return;
    await provider.prepare?.();
    if (!this.#owned.has(keyOf(tenantId, outletId)))
      await this.#ensureOutlet(tenantId, outletId);
  }

  async #hasCloudTerminal(tenantId: string, outletId: string) {
    try {
      const ctx = edcBridgeDeviceContext(tenantId, outletId);
      const [row] = await withTenant(this.#db, ctx, (tx) =>
        tx
          .select({ id: paymentEdcTerminals.id })
          .from(paymentEdcTerminals)
          .where(
            and(
              eq(paymentEdcTerminals.tenantId, ctx.tenant.tenantId),
              eq(paymentEdcTerminals.outletId, outletIdSchema.parse(outletId)),
              eq(paymentEdcTerminals.connectionKind, "bca_cloud"),
              eq(paymentEdcTerminals.bankCode, "bca"),
              eq(paymentEdcTerminals.status, "active"),
            ),
          )
          .limit(1),
      );
      return row !== undefined;
    } catch (error) {
      logger.warn(
        { ...errClass(error), outletId },
        "The cloud EDC runtime could not read the outlet's terminals",
      );
      return false;
    }
  }

  /** The agent, when this process owns the outlet. */
  agentFor(tenantId: string, outletId: string): EdcAgent | null {
    return this.#owned.has(keyOf(tenantId, outletId)) ? this.agent : null;
  }

  /** Presentation only (payment options): would an ECR sale on this terminal
   * reach it now? `requestPayment` checks again. */
  terminalReady(row: TerminalRow): boolean {
    try {
      this.registry.get(row.bankCode, row);
      return true;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------ auth

  /** The device of a bearer token, or null (malformed, unknown, revoked). */
  async authenticate(token: string): Promise<EdcBridgeDevice | null> {
    if (!edcBridgeDeviceTokenSchema.safeParse(token).success) return null;
    const hash = hashEdcBridgeToken(token);
    const resolved = await this.#db.execute<{ id: string; tenant_id: string }>(
      sql`SELECT id, tenant_id FROM app.edc_bridge_resolve_token(${hash})`,
    );
    const hit = resolved.rows[0];
    if (!hit) return null;
    const [row] = await withTenant(
      this.#db,
      tenantWideContext(hit.tenant_id),
      (tx) =>
        tx
          .select({
            id: edcBridgeDevices.id,
            tenantId: edcBridgeDevices.tenantId,
            outletId: edcBridgeDevices.outletId,
            tokenHash: edcBridgeDevices.tokenHash,
            revokedAt: edcBridgeDevices.revokedAt,
          })
          .from(edcBridgeDevices)
          .where(
            and(
              eq(
                edcBridgeDevices.tenantId,
                tenantIdSchema.parse(hit.tenant_id),
              ),
              eq(edcBridgeDevices.id, uuidToUlid(hit.id)),
            ),
          )
          .limit(1),
    );
    if (!row || row.revokedAt !== null) return null;
    if (
      !timingSafeEqual(
        Buffer.from(row.tokenHash, "hex"),
        Buffer.from(hash, "hex"),
      )
    )
      return null;
    // The token names its device: a hash hit for another id is refused.
    if (token.slice(5, 31) !== row.id.toUpperCase()) return null;
    return { id: row.id, tenantId: row.tenantId, outletId: row.outletId };
  }

  // -------------------------------------------------------- sessions

  /** A socket authenticated as `device`. A newer session of the device
   * replaces the older one. Returns the handlers of the socket. */
  open(device: EdcBridgeDevice, socket: EdcBridgeSocket) {
    const older = this.#sessions.get(device.id);
    if (older) this.#end(older, "replaced_by_newer_session");
    const session: Session = {
      id: randomUUID(),
      device,
      socket,
      leases: new Map(),
      helloed: false,
      closed: false,
      renewal: Promise.resolve(),
    };
    this.#sessions.set(device.id, session);
    return {
      /** One parsed uplink message. Resolves false when the socket must be
       * closed (protocol violation). */
      message: (message: EdcBridgeUplink) => this.#onMessage(session, message),
      closed: () => this.#drop(session),
    };
  }

  /** Revocation: the device's socket is told and closed at once. */
  revoked(tenantId: string, deviceId: string): void {
    const session = this.#sessions.get(deviceId);
    if (session && session.device.tenantId === tenantId)
      this.#end(session, "token_revoked");
  }

  #write(session: Session, message: EdcBridgeDownlink): boolean {
    if (session.closed) return false;
    return session.socket.send(JSON.stringify(message));
  }

  #end(session: Session, reason: EdcBridgeGoodbye["reason"]) {
    if (!session.closed)
      this.#write(session, { type: "goodbye", reason } as EdcBridgeGoodbye);
    this.#drop(session);
    session.socket.close();
  }

  /** The session stops holding anything. Commands already sent keep waiting
   * for their deadline: a reconnect may still bring their result. */
  #drop(session: Session) {
    session.closed = true;
    if (this.#sessions.get(session.device.id) === session)
      this.#sessions.delete(session.device.id);
    for (const terminalId of session.leases.keys()) {
      const key = keyOf(session.device.tenantId, terminalId);
      if (this.#holders.get(key) === session) this.#holders.delete(key);
    }
    session.leases.clear();
  }

  async #onMessage(session: Session, message: EdcBridgeUplink) {
    if (session.closed) return true;
    if (message.type === "hello") {
      if (session.helloed) return false;
      if (!isSupportedEdcBridgeVersion(message.protocolVersion)) {
        this.#end(session, "protocol_unsupported");
        return true;
      }
      session.helloed = true;
      await this.#renew(session);
      await this.#sendReleases(session);
      return true;
    }
    if (!session.helloed) return false;
    await this.#onResult(session, message);
    return true;
  }

  // ----------------------------------------------------------- leases

  async #ensureOutlet(tenantId: string, outletId: string): Promise<boolean> {
    const key = keyOf(tenantId, outletId);
    if (this.#owned.has(key)) return true;
    if (this.#stopped) return false;
    const running = this.#starting.get(key);
    if (running) return running;
    const losses = this.#losses.get(key) ?? 0;
    const start = this.agent
      .start(edcBridgeDeviceContext(tenantId, outletId))
      .then(
        () => {
          // Lost again while starting, or stopped meanwhile: not ours.
          if (this.#stopped || (this.#losses.get(key) ?? 0) !== losses)
            return false;
          this.#owned.add(key);
          return true;
        },
        (error: unknown) => {
          logger.warn(
            { ...errClass(error), outletId },
            "The cloud EDC agent could not take the outlet; its bridges get no lease.",
          );
          return false;
        },
      )
      .finally(() => this.#starting.delete(key));
    this.#starting.set(key, start);
    return start;
  }

  /** The agent lost the outlet's lock (`liveCalls` > 0: with commands on the
   * wire). Only this outlet stops; see the header. Never throws. */
  #outletLost(tenantId: string, outletId: string, liveCalls: number): void {
    const key = keyOf(tenantId, outletId);
    this.#owned.delete(key);
    this.#losses.set(key, (this.#losses.get(key) ?? 0) + 1);
    for (const pending of this.#pending.values())
      if (
        pending.device.tenantId.toLowerCase() === tenantId.toLowerCase() &&
        pending.device.outletId.toLowerCase() === outletId.toLowerCase()
      )
        pending.orphaned = true;
    for (const session of [...this.#sessions.values()])
      if (
        session.device.tenantId.toLowerCase() === tenantId.toLowerCase() &&
        session.device.outletId.toLowerCase() === outletId.toLowerCase()
      )
        this.#end(session, "server_shutdown");
    // Ops alert: the outlet's ECR is down until the lock is back.
    logger.error(
      { alert: "edc_cloud_outlet_lock_lost", outletId, liveCalls },
      "The cloud EDC agent lost an outlet lock: that outlet's ECR stops until it is taken again; the API keeps running.",
    );
    this.#retryOutlet(tenantId, outletId, 0);
  }

  #retryOutlet(tenantId: string, outletId: string, attempt: number): void {
    const key = keyOf(tenantId, outletId);
    if (this.#stopped || this.#retries.has(key)) return;
    const timer = setTimeout(() => {
      this.#retries.delete(key);
      void this.#ensureOutlet(tenantId, outletId).then((owned) => {
        if (!owned) this.#retryOutlet(tenantId, outletId, attempt + 1);
      });
    }, this.#retryDelayMs(attempt));
    timer.unref();
    this.#retries.set(key, timer);
  }

  /** Grants (or renews) the device's leases and sends the full `lease`,
   * after any renewal of the session still running. */
  #renew(session: Session): Promise<void> {
    const next = session.renewal.then(() => this.#renewOnce(session));
    session.renewal = next.catch(() => undefined);
    return next;
  }

  async #renewOnce(session: Session): Promise<void> {
    const { device } = session;
    const owned = await this.#ensureOutlet(device.tenantId, device.outletId);
    const at = this.#now();
    const ctx = edcBridgeDeviceContext(device.tenantId, device.outletId);
    const outcome = await withTenant(this.#db, ctx, async (tx) => {
      const [live] = await tx
        .update(edcBridgeDevices)
        .set({ lastSeenAt: at })
        .where(
          and(
            eq(edcBridgeDevices.tenantId, device.tenantId),
            eq(edcBridgeDevices.id, device.id),
            isNull(edcBridgeDevices.revokedAt),
          ),
        )
        .returning({ id: edcBridgeDevices.id });
      if (!live) return null;
      const terminals = await tx
        .select()
        .from(paymentEdcTerminals)
        .where(
          and(
            eq(paymentEdcTerminals.tenantId, device.tenantId),
            eq(paymentEdcTerminals.outletId, device.outletId),
            eq(paymentEdcTerminals.bridgeDeviceId, device.id),
          ),
        )
        .orderBy(paymentEdcTerminals.id)
        .limit(MAX_GRANTS);
      const lease: EdcBridgeLease = { type: "lease", grants: [], refused: [] };
      const granted = new Map<string, Lease>();
      for (const terminal of terminals) {
        const refusal = this.#refusalOf(terminal);
        if (refusal) {
          lease.refused.push({
            terminalId: terminal.id,
            reason: refusal.reason,
          });
          continue;
        }
        if (!owned) {
          lease.refused.push({
            terminalId: terminal.id,
            reason: "held_by_other_device",
          });
          continue;
        }
        const leaseId =
          session.leases.get(terminal.id)?.leaseId ?? randomUUID();
        // Another device's lease is taken over only once it can no longer
        // be in use (cloud clock): issued_at + ttl + 300 s + 30 s, as
        // `edcBridgeLeaseReusableAt`.
        const reusableMs =
          EDC_BRIDGE_MAX_COMMAND_TIMEOUT_MS +
          EDC_BRIDGE_LEASE_HANDOVER_GRACE_MS;
        const [row] = await tx
          .insert(edcBridgeTerminalLeases)
          .values({
            tenantId: device.tenantId,
            outletId: device.outletId,
            terminalId: terminal.id,
            deviceId: device.id,
            leaseId,
            issuedAt: at,
            ttlMs: this.#ttlMs,
          })
          .onConflictDoUpdate({
            target: edcBridgeTerminalLeases.terminalId,
            set: {
              deviceId: device.id,
              leaseId,
              issuedAt: at,
              ttlMs: this.#ttlMs,
            },
            setWhere: sql`${edcBridgeTerminalLeases.tenantId} = ${device.tenantId}
              AND (${edcBridgeTerminalLeases.deviceId} = excluded.device_id
                OR ${edcBridgeTerminalLeases.issuedAt} + ((${edcBridgeTerminalLeases.ttlMs} + ${reusableMs}) * interval '1 millisecond') <= ${at})`,
          })
          .returning({ leaseId: edcBridgeTerminalLeases.leaseId });
        if (!row) {
          lease.refused.push({
            terminalId: terminal.id,
            reason: "held_by_other_device",
          });
          continue;
        }
        granted.set(terminal.id, { leaseId, issuedAt: at, ttlMs: this.#ttlMs });
        lease.grants.push({
          terminalId: terminal.id,
          leaseId,
          ttlMs: this.#ttlMs,
          link: this.#linkOf(terminal)!,
          framing: this.registry.bridgeProvider(terminal.bankCode)!.framing,
        });
      }
      return { lease, granted };
    });
    if (session.closed) return;
    if (outcome === null) {
      this.#end(session, "token_revoked");
      return;
    }
    // Leases this session no longer holds stop at once.
    for (const terminalId of session.leases.keys())
      if (!outcome.granted.has(terminalId)) {
        const key = keyOf(device.tenantId, terminalId);
        if (this.#holders.get(key) === session) this.#holders.delete(key);
      }
    session.leases.clear();
    for (const [terminalId, lease] of outcome.granted) {
      session.leases.set(terminalId, lease);
      this.#holders.set(keyOf(device.tenantId, terminalId), session);
    }
    this.#write(session, outcome.lease);
  }

  #linkOf(terminal: TerminalRow) {
    const link =
      terminal.connection === "lan"
        ? {
            connection: "lan",
            host: terminal.ipAddress,
            port: terminal.linkPort,
          }
        : terminal.connection === "usb"
          ? { connection: "usb", baudRate: terminal.linkBaudRate }
          : null;
    const parsed = edcBridgeLinkSchema.safeParse(link);
    return parsed.success ? parsed.data : null;
  }

  #refusalOf(terminal: TerminalRow): {
    reason: EdcBridgeLease["refused"][number]["reason"];
  } | null {
    if (terminal.status !== "active") return { reason: "terminal_inactive" };
    if (
      terminal.connectionKind !== "bridge" ||
      this.#linkOf(terminal) === null ||
      this.registry.bridgeProvider(terminal.bankCode) === null
    )
      return { reason: "connection_unsupported" };
    return null;
  }

  /** Renewal tick: every live session. Also notices a revocation made by
   * another process and an outlet lock that came free. */
  async renewAll(): Promise<void> {
    if (this.#stopped) return;
    for (const session of [...this.#sessions.values()]) {
      if (!session.helloed || session.closed) continue;
      await this.#renew(session).catch((error: unknown) =>
        logger.error(
          { ...errClass(error), deviceId: session.device.id },
          "EDC bridge lease renewal failed",
        ),
      );
    }
  }

  #leaseFor(terminal: {
    tenantId: string;
    outletId: string;
    id: string;
  }): { session: Session; lease: Lease } | null {
    const session = this.#holders.get(keyOf(terminal.tenantId, terminal.id));
    if (!session || session.closed || this.#stopped) return null;
    if (
      session.device.tenantId.toLowerCase() !==
        terminal.tenantId.toLowerCase() ||
      session.device.outletId.toLowerCase() !== terminal.outletId.toLowerCase()
    )
      return null;
    if (!this.#owned.has(keyOf(terminal.tenantId, terminal.outletId)))
      return null;
    const lease = session.leases.get(terminal.id);
    if (!lease) return null;
    if (!edcBridgeLeaseAllowsCommand(lease.issuedAt, lease.ttlMs, this.#now()))
      return null;
    return { session, lease };
  }

  // --------------------------------------------------------- commands

  #send(command: {
    terminal: EcrTerminal;
    op: EdcBridgeOp;
    trace: string;
    frame: string;
    timeoutMs: number;
  }): Promise<EdcBridgeAnswer> | null {
    try {
      const held = this.#leaseFor(command.terminal);
      if (!held) return null;
      const { session, lease } = held;
      const message = edcBridgeCommandSchema.parse({
        type: "command",
        commandId: randomUUID(),
        leaseId: lease.leaseId,
        terminalId: command.terminal.id,
        op: command.op,
        trace: command.trace,
        frame: command.frame,
        timeoutMs: command.timeoutMs,
      });
      let settle!: (answer: EdcBridgeAnswer) => void;
      const answer = new Promise<EdcBridgeAnswer>((resolve) => {
        settle = resolve;
      });
      const timer = setTimeout(() => {
        if (this.#pending.get(message.commandId) !== pending) return;
        this.#pending.delete(message.commandId);
        settle({ outcome: "transport_error", kind: "timeout" });
      }, command.timeoutMs + this.#graceMs);
      timer.unref();
      const pending: Pending = {
        commandId: message.commandId,
        device: session.device,
        terminalId: message.terminalId,
        op: message.op,
        trace: message.trace,
        stored: Promise.resolve(false),
        settle,
        timer,
        orphaned: false,
        record: null,
      };
      this.#pending.set(message.commandId, pending);
      // Written now, in this tick: from here on the command is dispatched.
      if (!session.socket.send(JSON.stringify(message))) {
        clearTimeout(timer);
        this.#pending.delete(message.commandId);
        return null;
      }
      // Sent: whatever fails from here, the answer (or the deadline's
      // transport error, `unknown`) is the only outcome; never "not sent".
      try {
        pending.record = {
          id: message.commandId,
          tenantId: session.device.tenantId,
          outletId: session.device.outletId,
          terminalId: message.terminalId,
          deviceId: session.device.id,
          leaseId: message.leaseId,
          op: message.op,
          trace: message.trace,
          sentAt: this.#now(),
        };
        pending.stored = this.#persistCommand(pending.record);
      } catch (error) {
        logger.error(
          { ...errClass(error), commandId: message.commandId },
          "EDC bridge command could not be recorded",
        );
      }
      return answer;
    } catch (error) {
      logger.error(errClass(error), "EDC bridge command not sent");
      return null;
    }
  }

  /** `replayOf` must name an earlier sale of the same device, terminal and
   * trace. */
  async #replayOk(session: Session, result: EdcBridgeResult) {
    if (result.replayOf === null) return true;
    if (result.op !== "sale" || result.replayOf === result.commandId)
      return false;
    const first = await this.#storedCommand(session, {
      ...result,
      commandId: result.replayOf,
    });
    return first !== null;
  }

  /** A command of this device, tenant, outlet and terminal with this op and
   * trace; never another outlet's. */
  async #storedCommand(
    session: Session,
    ref: Pick<EdcBridgeResult, "commandId" | "terminalId" | "op" | "trace">,
  ) {
    const { device } = session;
    const [row] = await withTenant(
      this.#db,
      edcBridgeDeviceContext(device.tenantId, device.outletId),
      (tx) =>
        tx
          .select({ id: edcBridgeCommands.id })
          .from(edcBridgeCommands)
          .where(
            and(
              eq(edcBridgeCommands.tenantId, device.tenantId),
              eq(edcBridgeCommands.outletId, device.outletId),
              eq(edcBridgeCommands.deviceId, device.id),
              eq(edcBridgeCommands.id, ref.commandId),
              eq(edcBridgeCommands.terminalId, ref.terminalId),
              eq(edcBridgeCommands.op, ref.op),
              eq(edcBridgeCommands.trace, ref.trace),
            ),
          )
          .limit(1),
    );
    return row ?? null;
  }

  /** `write` with the first try and 3 retries (100, 300, 900 ms). False
   * when every attempt failed (logged by class only). Never throws. */
  async #persist(
    what: string,
    commandId: string,
    write: () => Promise<unknown>,
  ): Promise<boolean> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await write();
        return true;
      } catch (error) {
        const delay = PERSIST_RETRY_MS[attempt];
        logger.warn(
          { ...errClass(error), commandId, attempt },
          `EDC bridge ${what} could not be recorded`,
        );
        if (delay === undefined || this.#stopped) return false;
        await new Promise((resolve) => setTimeout(resolve, delay).unref());
      }
    }
  }

  #persistCommand(
    record: typeof edcBridgeCommands.$inferInsert,
  ): Promise<boolean> {
    return this.#persist("command", record.id, () =>
      withTenant(
        this.#db,
        edcBridgeDeviceContext(record.tenantId, record.outletId),
        (tx) =>
          tx.insert(edcBridgeCommands).values(record).onConflictDoNothing(),
      ),
    );
  }

  /** Stores the result with its decoded evidence (no PAN, no free text). */
  #storeResult(session: Session, result: EdcBridgeResult): Promise<boolean> {
    const { device } = session;
    const ctx = edcBridgeDeviceContext(device.tenantId, device.outletId);
    return this.#persist("result", result.commandId, () =>
      withTenant(this.#db, ctx, async (tx) => {
        const [terminal] = await tx
          .select({ bankCode: paymentEdcTerminals.bankCode })
          .from(paymentEdcTerminals)
          .where(
            and(
              eq(paymentEdcTerminals.tenantId, device.tenantId),
              eq(paymentEdcTerminals.id, result.terminalId),
            ),
          )
          .limit(1);
        const evidence = terminal
          ? (this.registry
              .bridgeProvider(terminal.bankCode)
              ?.evidence(result.op, result.answer) ?? null)
          : null;
        await tx
          .update(edcBridgeCommands)
          .set({
            resultOutcome: result.answer.outcome,
            resultAt: this.#now(),
            resultEvidence: evidence,
          })
          .where(
            and(
              eq(edcBridgeCommands.tenantId, device.tenantId),
              eq(edcBridgeCommands.deviceId, device.id),
              eq(edcBridgeCommands.id, result.commandId),
              isNull(edcBridgeCommands.resultAt),
            ),
          );
      }),
    );
  }

  /** Ack only once the result is in the database; otherwise the tablet
   * sends it again (idempotent) and ops are alerted. */
  async #ackStored(session: Session, result: EdcBridgeResult, log: object) {
    if (await this.#storeResult(session, result)) {
      this.#write(session, { type: "ack", commandId: result.commandId });
      return true;
    }
    logger.error(
      { ...log, alert: "edc_cloud_result_persist_failed" },
      "EDC bridge result could not be stored; not acked, the tablet sends it again",
    );
    return false;
  }

  async #onResult(session: Session, result: EdcBridgeResult) {
    const { device } = session;
    const pending = this.#pending.get(result.commandId);
    const log = { commandId: result.commandId, deviceId: device.id };
    try {
      if (pending && !pending.orphaned) {
        const same =
          pending.device.id === device.id &&
          pending.device.tenantId === device.tenantId &&
          pending.device.outletId === device.outletId &&
          pending.terminalId === result.terminalId &&
          pending.op === result.op &&
          pending.trace === result.trace;
        if (!same || !(await this.#replayOk(session, result))) {
          logger.warn(
            log,
            "EDC bridge result does not match its command; dropped",
          );
          return;
        }
        if (this.#pending.get(result.commandId) !== pending) return;
        this.#pending.delete(result.commandId);
        clearTimeout(pending.timer);
        pending.settle(result.answer);
        // The command row failed at send time: try it again before the
        // result (its retries are spent; ack waits for both).
        let stored = await pending.stored;
        if (!stored && pending.record)
          stored = await this.#persistCommand(pending.record);
        if (stored) await this.#ackStored(session, result, log);
        else
          logger.error(
            { ...log, alert: "edc_cloud_result_persist_failed" },
            "EDC bridge command could not be stored; result not acked",
          );
        return;
      }
      // Late (deadline passed, outlet lock lost since) or after a restart:
      // only a command of this device in its own tenant + outlet + terminal.
      // Stored and acked; the ledger row is settled by inquiry.
      if (pending) await pending.stored;
      const stored = await this.#storedCommand(session, result);
      if (!stored || !(await this.#replayOk(session, result))) {
        logger.warn(
          log,
          "EDC bridge result for no command of this device; dropped",
        );
        return;
      }
      if (await this.#ackStored(session, result, log))
        logger.warn(
          log,
          "Late EDC bridge result stored; the sale is settled by inquiry",
        );
    } catch (error) {
      logger.error({ ...errClass(error), ...log }, "EDC bridge result failed");
    }
  }

  // --------------------------------------------------------- releases

  /** X2: settlement lines of this outlet were matched. Never throws. */
  async settlementMatched(tenantId: string, outletId: string): Promise<void> {
    for (const session of [...this.#sessions.values()])
      if (
        session.helloed &&
        session.device.tenantId === tenantId &&
        session.device.outletId === outletId
      )
        await this.#sendReleases(session);
  }

  async #sendReleases(session: Session): Promise<void> {
    const { device } = session;
    const ctx = edcBridgeDeviceContext(device.tenantId, device.outletId);
    try {
      const rows = await withTenant(this.#db, ctx, (tx) =>
        tx
          .selectDistinct({
            id: edcBridgeCommands.id,
            terminalId: edcBridgeCommands.terminalId,
            trace: edcBridgeCommands.trace,
          })
          .from(edcBridgeCommands)
          .innerJoin(
            edcTransactions,
            and(
              eq(edcTransactions.tenantId, edcBridgeCommands.tenantId),
              eq(edcTransactions.terminalId, edcBridgeCommands.terminalId),
              eq(edcTransactions.trace, edcBridgeCommands.trace),
              eq(edcTransactions.type, "sale"),
            ),
          )
          .innerJoin(
            edcSettlementRows,
            and(
              eq(edcSettlementRows.tenantId, edcTransactions.tenantId),
              eq(edcSettlementRows.matchedEdcTransactionId, edcTransactions.id),
              eq(edcSettlementRows.matchStatus, "matched"),
            ),
          )
          .where(
            and(
              eq(edcBridgeCommands.tenantId, device.tenantId),
              eq(edcBridgeCommands.outletId, device.outletId),
              eq(edcBridgeCommands.deviceId, device.id),
              eq(edcBridgeCommands.op, "sale"),
              isNull(edcBridgeCommands.releaseSentAt),
            ),
          )
          .limit(5_000),
      );
      const byTerminal = new Map<string, typeof rows>();
      for (const row of rows)
        byTerminal.set(row.terminalId, [
          ...(byTerminal.get(row.terminalId) ?? []),
          row,
        ]);
      for (const [terminalId, list] of byTerminal)
        for (let i = 0; i < list.length; i += RELEASE_CHUNK) {
          const chunk = list.slice(i, i + RELEASE_CHUNK);
          const sent = this.#write(session, {
            type: "sale_record_release",
            terminalId,
            traces: [...new Set(chunk.map((row) => row.trace))],
          });
          if (!sent) return;
          const at = this.#now();
          await withTenant(this.#db, ctx, (tx) =>
            tx
              .update(edcBridgeCommands)
              .set({ releaseSentAt: at })
              .where(
                and(
                  eq(edcBridgeCommands.tenantId, device.tenantId),
                  eq(edcBridgeCommands.deviceId, device.id),
                  sql`${edcBridgeCommands.id} IN (${sql.join(
                    chunk.map((row) => sql`${row.id}`),
                    sql`, `,
                  )})`,
                ),
              ),
          );
        }
    } catch (error) {
      logger.error(
        { ...errClass(error), deviceId: device.id },
        "EDC bridge sale record release failed",
      );
    }
  }

  // ------------------------------------------------------------- stop

  /** Sessions are told and closed; commands still waiting become transport
   * errors (`unknown`); the agent waits for its writes, then frees outlets. */
  async stop(): Promise<void> {
    this.#stopped = true;
    clearInterval(this.#renewTimer);
    for (const timer of this.#retries.values()) clearTimeout(timer);
    this.#retries.clear();
    for (const session of [...this.#sessions.values()])
      this.#end(session, "server_shutdown");
    for (const pending of [...this.#pending.values()]) {
      clearTimeout(pending.timer);
      this.#pending.delete(pending.commandId);
      pending.settle({ outcome: "transport_error", kind: "disconnected" });
    }
    await this.agent.stop();
    this.#owned.clear();
  }
}

let current: CloudEdcRuntime | null = null;

export function getCloudEdcRuntime(): CloudEdcRuntime | null {
  return current;
}

/** One runtime per process (server.ts on the cloud, tests). */
export function startCloudEdcRuntime(
  options: CloudEdcRuntimeOptions = {},
): CloudEdcRuntime {
  if (current) throw new Error("The cloud EDC runtime is already running");
  current = new CloudEdcRuntime(options);
  return current;
}

export async function stopCloudEdcRuntime(): Promise<void> {
  const runtime = current;
  current = null;
  await runtime?.stop();
}

/** Force-exit timer of the graceful shutdown with the cloud agent on: long
 * enough for a sale on the wire (as `edgeShutdownForceMs`). */
export function cloudEdcShutdownForceMs(running: boolean): number {
  return running
    ? EDC_SALE_TIMEOUT_MS + EDC_BRIDGE_RESULT_GRACE_MS + 10_000
    : 5_000;
}
