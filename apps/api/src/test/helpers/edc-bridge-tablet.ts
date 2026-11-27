// Full Node emulator of the "Legend EDC Bridge" Android app (B3
// legend-wasr7.22), for the cloud tests and the B6 e2e. Same rules as the
// Kotlin app (apps/edc-bridge-android, core/BridgeCore.kt): lease `ttlMs` on a
// monotonic clock from receipt, sale-only dedupe by terminal + trace with the
// frame's SHA-256, `trace_conflict` on another frame, unacked results resent
// on every session until `ack`, sale records kept apart from that queue.
// The terminal is either a script or a real TCP peer spoken to with the
// `stx_bcdlen_etx_lrc` framing (ACK/NAK/LRC), like the tablet does.
//
// The thin `edc-bridge-emulator.ts` (B2) stays for the B2 tests that need no
// journal.
import net from "node:net";
import WebSocket from "ws";
import {
  EDC_BRIDGE_PROTOCOL_VERSION,
  edcBridgeDedupeDecision,
  edcBridgeDedupeKey,
  edcBridgeFrameSha256,
  edcBridgeLinkTargetsSelf,
  edcBridgeSaleRecordDeletable,
  parseEdcBridgeDownlink,
  type EdcBridgeAnswer,
  type EdcBridgeCommand,
  type EdcBridgeDownlink,
  type EdcBridgeHello,
  type EdcBridgeLeaseGrant,
  type EdcBridgeLink,
  type EdcBridgeResult,
  type EdcBridgeSaleRecord,
} from "@starter/shared/edc/bridge";

// Link framing (mirror of link/EcrFraming.kt and link/FramedExchange.kt).

export const STX = 0x02;
export const ETX = 0x03;
export const ACK = 0x06;
export const NAK = 0x15;
export const MAX_RESENDS = 3;

export function bcdLength(length: number): Buffer {
  if (!Number.isInteger(length) || length < 0 || length > 9_999)
    throw new Error("body too long");
  const digits = String(length).padStart(4, "0");
  return Buffer.from([
    (Number(digits[0]) << 4) | Number(digits[1]),
    (Number(digits[2]) << 4) | Number(digits[3]),
  ]);
}

export function lengthOf(high: number, low: number): number | null {
  const nibbles = [high >> 4, high & 0x0f, low >> 4, low & 0x0f];
  if (nibbles.some((d) => d > 9)) return null;
  return nibbles.reduce((acc, d) => acc * 10 + d, 0);
}

export function lrc(bytes: Uint8Array): number {
  return bytes.reduce((x, b) => x ^ b, 0);
}

/** STX, BCD length, body, ETX, LRC (XOR of length..ETX). */
export function frameBody(body: Uint8Array): Buffer {
  const inner = Buffer.concat([
    bcdLength(body.length),
    Buffer.from(body),
    Buffer.from([ETX]),
  ]);
  return Buffer.concat([Buffer.from([STX]), inner, Buffer.from([lrc(inner)])]);
}

/** Byte reader over a socket with per-read timeouts. */
class ByteQueue {
  private bytes: number[] = [];
  private waiters: Array<() => void> = [];
  private closed = false;

  constructor(socket: net.Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.bytes.push(...chunk);
      this.wake();
    });
    socket.on("close", () => {
      this.closed = true;
      this.wake();
    });
    socket.on("error", () => {
      this.closed = true;
      this.wake();
    });
  }

  private wake() {
    for (const wake of this.waiters.splice(0)) wake();
  }

  /** Next byte, `null` on timeout; throws when the peer is gone. */
  async read(timeoutMs: number): Promise<number | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const next = this.bytes.shift();
      if (next !== undefined) return next;
      if (this.closed) throw new Error("link closed");
      const left = deadline - Date.now();
      if (left <= 0) return null;
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, left).unref();
      });
    }
  }
}

const timeoutAnswer: EdcBridgeAnswer = {
  outcome: "transport_error",
  kind: "timeout",
};
const protocolAnswer: EdcBridgeAnswer = {
  outcome: "transport_error",
  kind: "protocol",
};

/** One command over an open socket, like FramedExchange.exchange. */
export async function framedExchange(
  socket: net.Socket,
  body: Uint8Array,
  timeoutMs: number,
  options: { ackTimeoutMs?: number; byteTimeoutMs?: number } = {},
): Promise<EdcBridgeAnswer> {
  const ackTimeoutMs = options.ackTimeoutMs ?? 2_000;
  const byteTimeoutMs = options.byteTimeoutMs ?? 1_000;
  const queue = new ByteQueue(socket);
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(0, deadline - Date.now());
  const readByte = () => queue.read(Math.min(byteTimeoutMs, remaining()));
  try {
    const frame = frameBody(body);
    for (let sends = 1; ; sends++) {
      socket.write(frame);
      const reply = await queue.read(Math.min(ackTimeoutMs, remaining()));
      if (reply === ACK) break;
      if (reply === null) return timeoutAnswer;
      if (reply !== NAK || sends > MAX_RESENDS) return protocolAnswer;
    }
    for (let naks = 0; ;) {
      for (;;) {
        const b = await queue.read(remaining());
        if (b === null) return timeoutAnswer;
        if (b === STX) break;
      }
      const high = await readByte();
      const low = await readByte();
      if (high === null || low === null) return timeoutAnswer;
      const length = lengthOf(high, low);
      let good = false;
      const received: number[] = [];
      if (length !== null) {
        for (let i = 0; i < length; i++) {
          const b = await readByte();
          if (b === null) return timeoutAnswer;
          received.push(b);
        }
        const etx = await readByte();
        const sum = await readByte();
        if (etx === null || sum === null) return timeoutAnswer;
        good =
          etx === ETX &&
          sum === (high ^ low ^ lrc(Buffer.from(received)) ^ ETX);
      }
      if (good) {
        socket.write(Buffer.from([ACK]));
        return {
          outcome: "response",
          frame: Buffer.from(received).toString("base64"),
        };
      }
      naks++;
      if (naks > MAX_RESENDS) return protocolAnswer;
      socket.write(Buffer.from([NAK]));
    }
  } catch {
    return { outcome: "transport_error", kind: "disconnected" };
  }
}

/** What the emulated tablet does with an admitted command. */
export type EmulatedTerminal = (
  command: EdcBridgeCommand,
  link: EdcBridgeLink,
) => Promise<EdcBridgeAnswer>;

/** A terminal reached over TCP with the bridge framing. The contract only
 * leases private IPv4 hosts, so tests map the leased address to a local port
 * with `resolve`. Could not connect: `refused link_down` (nothing sent). */
export function tcpTerminal(
  resolve: (link: Extract<EdcBridgeLink, { connection: "lan" }>) => {
    host: string;
    port: number;
  } = (link) => link,
): EmulatedTerminal {
  return async (command, link) => {
    if (link.connection !== "lan")
      return { outcome: "refused", reason: "link_down" };
    const target = resolve(link);
    const socket = await new Promise<net.Socket | null>((done) => {
      const s = net.connect(target.port, target.host);
      s.once("connect", () => done(s));
      s.once("error", () => done(null));
    });
    if (!socket) return { outcome: "refused", reason: "link_down" };
    try {
      return await framedExchange(
        socket,
        Buffer.from(command.frame, "base64"),
        command.timeoutMs,
      );
    } finally {
      socket.destroy();
    }
  };
}

/** A fake ECR terminal on 127.0.0.1 speaking the bridge framing. `respond`
 * gets each request body; `nakFirst` NAKs that many sends before ACKing. */
export async function startFakeEcrTerminal(options: {
  respond: (body: Buffer) => Buffer | null;
  nakFirst?: number;
  corruptFirstResponses?: number;
}) {
  const requests: Buffer[] = [];
  let naksLeft = options.nakFirst ?? 0;
  let corruptLeft = options.corruptFirstResponses ?? 0;
  const server = net.createServer((socket) => {
    const queue = new ByteQueue(socket);
    void (async () => {
      try {
        for (;;) {
          if ((await queue.read(30_000)) !== STX) continue;
          const high = (await queue.read(1_000)) ?? 0;
          const low = (await queue.read(1_000)) ?? 0;
          const length = lengthOf(high, low) ?? 0;
          const body: number[] = [];
          for (let i = 0; i < length; i++)
            body.push((await queue.read(1_000)) ?? 0);
          await queue.read(1_000);
          await queue.read(1_000);
          if (naksLeft > 0) {
            naksLeft--;
            socket.write(Buffer.from([NAK]));
            continue;
          }
          socket.write(Buffer.from([ACK]));
          const request = Buffer.from(body);
          requests.push(request);
          const answer = options.respond(request);
          if (!answer) continue;
          for (;;) {
            const framed = frameBody(answer);
            if (corruptLeft > 0) {
              corruptLeft--;
              framed[framed.length - 1] ^= 0xff;
            }
            socket.write(framed);
            if ((await queue.read(2_000)) !== NAK) break;
          }
        }
      } catch {
        socket.destroy();
      }
    })();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address() as net.AddressInfo;
  return {
    port: address.port,
    requests,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

// Tablet

type StoredSaleRecord = EdcBridgeSaleRecord & {
  readonly terminalId: string;
  readonly trace: string;
  readonly storedAt: Date;
  readonly released: boolean;
};

export type EdcBridgeTabletOptions = {
  terminal: EmulatedTerminal;
  appVersion?: string;
  /** Monotonic clock for leases (ms). Default `performance.now()`. */
  monoMs?: () => number;
  /** Wall clock for `completedAt` and record age. */
  now?: () => Date;
  ownAddresses?: readonly string[];
};

/**
 * The tablet's journal and rules survive `disconnect()`/`connect()`, like the
 * app's Room journal survives a dropped socket. `restart()` additionally
 * drops in-memory leases and turns in-flight sales into
 * `transport_error disconnected` results, like the app after a crash.
 */
export class EdcBridgeTablet {
  readonly received: EdcBridgeDownlink[] = [];
  readonly sent: EdcBridgeResult[] = [];
  /** Commands that reached the terminal. */
  readonly ran: EdcBridgeCommand[] = [];
  readonly saleRecords = new Map<string, StoredSaleRecord>();
  readonly unacked = new Map<string, EdcBridgeResult>();
  private leases = new Map<
    string,
    { grant: EdcBridgeLeaseGrant; receivedAt: number }
  >();
  private busy = new Set<string>();
  private ws: WebSocket | null = null;
  private resent = false;
  private waiters: Array<() => void> = [];
  private readonly monoMs: () => number;
  private readonly now: () => Date;

  constructor(private readonly options: EdcBridgeTabletOptions) {
    this.monoMs = options.monoMs ?? (() => performance.now());
    this.now = options.now ?? (() => new Date());
  }

  hello(): EdcBridgeHello {
    const now = this.now();
    let held = 0;
    for (const record of this.saleRecords.values()) {
      const age = now.getTime() - record.storedAt.getTime();
      if (!record.released && age >= 48 * 3_600_000) held++;
    }
    return {
      type: "hello",
      protocolVersion: EDC_BRIDGE_PROTOCOL_VERSION,
      appVersion: this.options.appVersion ?? "0.1.0",
      unackedResults: this.unacked.size,
      heldSaleRecords: held,
    };
  }

  /** Opens the WSS session and sends `hello`. Resolves with the HTTP status
   * when the upgrade is refused. */
  async connect(
    url: string,
    token: string | null,
  ): Promise<{ ok: true } | { ok: false; status: number }> {
    const ws = new WebSocket(url, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    const opened = await new Promise<
      { ok: true } | { ok: false; status: number }
    >((resolve) => {
      ws.once("open", () => resolve({ ok: true }));
      ws.once("unexpected-response", (_req, res) =>
        resolve({ ok: false, status: res.statusCode ?? 0 }),
      );
      ws.once("error", () => resolve({ ok: false, status: 0 }));
    });
    if (!opened.ok) return opened;
    this.ws = ws;
    this.resent = false;
    ws.on("message", (data) => void this.onMessage(String(data)));
    ws.on("close", () => {
      if (this.ws === ws) this.ws = null;
      this.wake();
    });
    ws.send(JSON.stringify(this.hello()));
    return opened;
  }

  disconnect() {
    this.ws?.terminate();
    this.ws = null;
  }

  /** App restart: socket, leases and busy flags gone; in-flight sales become
   * `transport_error disconnected` results (the cloud inquires). */
  restart() {
    this.disconnect();
    this.leases.clear();
    this.busy.clear();
    for (const [key, record] of this.saleRecords) {
      if (record.state !== "in_flight") continue;
      const answer: EdcBridgeAnswer = {
        outcome: "transport_error",
        kind: "disconnected",
      };
      this.saleRecords.set(key, { ...record, state: "done", answer });
      this.enqueue({
        type: "result",
        commandId: record.commandId,
        terminalId: record.terminalId,
        op: "sale",
        trace: record.trace,
        replayOf: null,
        completedAt: this.now().toISOString(),
        answer,
      });
    }
  }

  get connected() {
    return this.ws !== null;
  }

  /** Deletes sale records the contract allows (48 h AND released, or 30 days). */
  purge(): number {
    const now = this.now();
    let gone = 0;
    for (const [key, record] of this.saleRecords) {
      if (edcBridgeSaleRecordDeletable(record, now)) {
        this.saleRecords.delete(key);
        gone++;
      }
    }
    return gone;
  }

  async waitFor(
    predicate: () => boolean,
    timeoutMs = 10_000,
    what = "condition",
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline)
        throw new Error(`EDC bridge tablet: no ${what}`);
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 50).unref();
      });
    }
  }

  /** The result sent for `commandId` (the latest one). */
  async resultFor(commandId: string, timeoutMs = 10_000) {
    await this.waitFor(
      () => this.sent.some((r) => r.commandId === commandId),
      timeoutMs,
      `result for ${commandId}`,
    );
    return this.sent.filter((r) => r.commandId === commandId).at(-1)!;
  }

  private wake() {
    for (const wake of this.waiters.splice(0)) wake();
  }

  private send(result: EdcBridgeResult) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(result));
    this.sent.push(result);
    this.wake();
  }

  private enqueue(result: EdcBridgeResult) {
    this.unacked.delete(result.commandId);
    this.unacked.set(result.commandId, result);
  }

  private async onMessage(raw: string) {
    let message: EdcBridgeDownlink;
    try {
      message = parseEdcBridgeDownlink(raw);
    } catch {
      this.ws?.close(1008, "contract");
      return;
    }
    this.received.push(message);
    this.wake();
    switch (message.type) {
      case "lease": {
        const at = this.monoMs();
        this.leases = new Map(
          message.grants.map((grant) => [
            grant.terminalId,
            { grant, receivedAt: at },
          ]),
        );
        if (!this.resent) {
          this.resent = true;
          for (const result of [...this.unacked.values()]) this.send(result);
        }
        return;
      }
      case "ack":
        this.unacked.delete(message.commandId);
        return;
      case "sale_record_release":
        for (const trace of message.traces) {
          const key = edcBridgeDedupeKey({
            terminalId: message.terminalId,
            op: "sale",
            trace,
          });
          const record = key ? this.saleRecords.get(key) : undefined;
          if (key && record)
            this.saleRecords.set(key, { ...record, released: true });
        }
        return;
      case "goodbye":
        return;
      case "command":
        await this.onCommand(message);
    }
  }

  private async onCommand(command: EdcBridgeCommand) {
    const lease = this.leases.get(command.terminalId);
    const leaseOk =
      lease !== undefined &&
      lease.grant.leaseId === command.leaseId &&
      this.monoMs() - lease.receivedAt < lease.grant.ttlMs &&
      !edcBridgeLinkTargetsSelf(
        lease.grant.link,
        this.options.ownAddresses ?? [],
      );
    if (!lease || !leaseOk)
      return this.reply(command, {
        outcome: "refused",
        reason: "lease_invalid",
      });
    const key = edcBridgeDedupeKey(command);
    const hash = await edcBridgeFrameSha256(command.frame);
    if (key) {
      const decision = edcBridgeDedupeDecision(
        command,
        this.saleRecords.get(key) ?? null,
        hash,
      );
      if (decision.action === "refuse")
        return this.reply(command, {
          outcome: "refused",
          reason: decision.reason,
        });
      if (decision.action === "replay")
        return this.reply(
          command,
          this.saleRecords.get(key)!.answer!,
          decision.replayOf,
        );
    }
    if (this.busy.has(command.terminalId))
      return this.reply(command, {
        outcome: "refused",
        reason: "terminal_busy",
      });
    if (key)
      this.saleRecords.set(key, {
        commandId: command.commandId,
        frameSha256: hash,
        state: "in_flight",
        answer: null,
        terminalId: command.terminalId,
        trace: command.trace,
        storedAt: this.now(),
        released: false,
      });
    this.busy.add(command.terminalId);
    this.ran.push(command);
    let answer: EdcBridgeAnswer;
    try {
      answer = await this.options.terminal(command, lease.grant.link);
    } catch {
      answer = protocolAnswer;
    }
    this.busy.delete(command.terminalId);
    const result = this.resultOf(command, answer, null);
    if (key) {
      const record = this.saleRecords.get(key);
      if (record)
        this.saleRecords.set(key, { ...record, state: "done", answer });
    }
    this.enqueue(result);
    this.send(result);
  }

  private reply(
    command: EdcBridgeCommand,
    answer: EdcBridgeAnswer,
    replayOf: string | null = null,
  ) {
    const result = this.resultOf(command, answer, replayOf);
    this.enqueue(result);
    this.send(result);
  }

  private resultOf(
    command: EdcBridgeCommand,
    answer: EdcBridgeAnswer,
    replayOf: string | null,
  ): EdcBridgeResult {
    return {
      type: "result",
      commandId: command.commandId,
      terminalId: command.terminalId,
      op: command.op,
      trace: command.trace,
      replayOf,
      completedAt: this.now().toISOString(),
      answer,
    };
  }
}
