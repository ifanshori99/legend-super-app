// B3 legend-wasr7.22: the full Node emulator of the Android bridge, against a
// fake cloud socket, plus the contract fixtures the Kotlin JVM tests read.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import {
  parseEdcBridgeUplink,
  type EdcBridgeUplink,
} from "@starter/shared/edc/bridge";
import { buildEdcBridgeFixtures } from "./helpers/edc-bridge-fixtures.ts";
import {
  EdcBridgeTablet,
  frameBody,
  startFakeEcrTerminal,
  tcpTerminal,
  type EmulatedTerminal,
} from "./helpers/edc-bridge-tablet.ts";

const fixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../edc-bridge-android/app/src/test/resources/edc-bridge-contract-fixtures.json",
);

const T1 = "3f0e2a4c-1b2d-4c3e-8f40-5a6b7c8d9e01";
const L1 = "7a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d";
const L2 = "7a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3e";
const cmd = (n: number) =>
  `0b1c2d3e-4f50-4162-a374-${String(n).padStart(12, "0")}`;
const SALE_FRAME = Buffer.from('{"op":"sale","amount":"opaque"}').toString(
  "base64",
);
const OTHER_FRAME = Buffer.from('{"op":"sale","amount":"other"}').toString(
  "base64",
);
const APPROVED = Buffer.from('{"rc":"00"}');

type FakeCloud = Awaited<ReturnType<typeof startFakeCloud>>;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A cloud stand-in: records uplinks, sends what the test asks. */
async function startFakeCloud() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((done) => server.once("listening", () => done()));
  const uplinks: EdcBridgeUplink[] = [];
  const auth: Array<string | undefined> = [];
  let socket: WebSocket | null = null;
  server.on("connection", (ws, req) => {
    socket = ws;
    auth.push(req.headers.authorization);
    ws.on("message", (data) =>
      uplinks.push(parseEdcBridgeUplink(String(data))),
    );
  });
  const port = (server.address() as { port: number }).port;
  cleanups.push(() => new Promise<void>((done) => server.close(() => done())));
  return {
    url: `ws://127.0.0.1:${port}/api/edc-bridge`,
    uplinks,
    auth,
    send(message: unknown) {
      socket!.send(JSON.stringify(message));
    },
    lease(leaseId = L1, ttlMs = 120_000) {
      this.send({
        type: "lease",
        grants: [
          {
            terminalId: T1,
            leaseId,
            ttlMs,
            link: { connection: "lan", host: "192.168.1.50", port: 9000 },
            framing: "stx_bcdlen_etx_lrc",
          },
        ],
        refused: [],
      });
    },
    command(n: number, extra: Record<string, unknown> = {}) {
      this.send({
        type: "command",
        commandId: cmd(n),
        leaseId: L1,
        terminalId: T1,
        op: "sale",
        trace: "000123",
        frame: SALE_FRAME,
        timeoutMs: 5_000,
        ...extra,
      });
    },
    results: () => uplinks.flatMap((u) => (u.type === "result" ? [u] : [])),
  };
}

async function connected(
  cloud: FakeCloud,
  terminal: EmulatedTerminal,
  options: Partial<ConstructorParameters<typeof EdcBridgeTablet>[0]> = {},
) {
  const tablet = new EdcBridgeTablet({ terminal, ...options });
  cleanups.push(() => tablet.disconnect());
  expect(await tablet.connect(cloud.url, "edcb_token")).toEqual({ ok: true });
  await tablet.waitFor(() => cloud.uplinks.some((u) => u.type === "hello"));
  return tablet;
}

const approve: EmulatedTerminal = async () => ({
  outcome: "response",
  frame: APPROVED.toString("base64"),
});

describe("Android contract fixtures (B3)", () => {
  it("the committed fixtures match the zod contract", async () => {
    const fresh = JSON.parse(JSON.stringify(await buildEdcBridgeFixtures()));
    if (process.env.UPDATE_EDC_BRIDGE_FIXTURES === "1")
      await writeFile(fixturePath, `${JSON.stringify(fresh, null, 2)}\n`);
    const committed = JSON.parse(await readFile(fixturePath, "utf8"));
    expect(committed).toEqual(fresh);
    // Sanity: the cases cover both outcomes.
    expect(
      fresh.downlink.filter((c: { valid: boolean }) => c.valid).length,
    ).toBeGreaterThan(20);
    expect(
      fresh.downlink.filter((c: { valid: boolean }) => !c.valid).length,
    ).toBeGreaterThan(40);
  });
});

describe("EDC bridge tablet emulator (B3)", () => {
  it("hello first, token only in the upgrade header, sale over TCP framing", async () => {
    const ecr = await startFakeEcrTerminal({ respond: () => APPROVED });
    cleanups.push(ecr.close);
    const cloud = await startFakeCloud();
    const tablet = await connected(
      cloud,
      tcpTerminal(() => ({ host: "127.0.0.1", port: ecr.port })),
    );
    expect(cloud.auth).toEqual(["Bearer edcb_token"]);
    expect(cloud.uplinks[0]).toMatchObject({
      type: "hello",
      protocolVersion: 1,
      unackedResults: 0,
      heldSaleRecords: 0,
    });
    cloud.lease();
    cloud.command(1);
    const result = await tablet.resultFor(cmd(1));
    expect(result.answer).toEqual({
      outcome: "response",
      frame: APPROVED.toString("base64"),
    });
    expect(result.replayOf).toBeNull();
    expect(ecr.requests.map((r) => r.toString("base64"))).toEqual([SALE_FRAME]);
    // Journaled until the ack; the sale record stays after it.
    expect([...tablet.unacked.keys()]).toEqual([cmd(1)]);
    cloud.send({ type: "ack", commandId: cmd(1) });
    await tablet.waitFor(() => tablet.unacked.size === 0);
    expect(tablet.saleRecords.size).toBe(1);
  });

  it("NAKs are resent and a bad LRC is NAKed, at most 3 times each", async () => {
    const ecr = await startFakeEcrTerminal({
      respond: () => APPROVED,
      nakFirst: 2,
      corruptFirstResponses: 2,
    });
    cleanups.push(ecr.close);
    const cloud = await startFakeCloud();
    const tablet = await connected(
      cloud,
      tcpTerminal(() => ({ host: "127.0.0.1", port: ecr.port })),
    );
    cloud.lease();
    cloud.command(1);
    expect((await tablet.resultFor(cmd(1))).answer.outcome).toBe("response");

    const stubborn = await startFakeEcrTerminal({
      respond: () => APPROVED,
      nakFirst: 4,
    });
    cleanups.push(stubborn.close);
    const other = await startFakeCloud();
    const tablet2 = await connected(
      other,
      tcpTerminal(() => ({ host: "127.0.0.1", port: stubborn.port })),
    );
    other.lease();
    other.command(2);
    expect((await tablet2.resultFor(cmd(2))).answer).toEqual({
      outcome: "transport_error",
      kind: "protocol",
    });
  });

  it("a closed terminal port is refused link_down", async () => {
    const cloud = await startFakeCloud();
    const tablet = await connected(
      cloud,
      tcpTerminal(() => ({ host: "127.0.0.1", port: 1 })),
    );
    cloud.lease();
    cloud.command(1);
    expect((await tablet.resultFor(cmd(1))).answer).toEqual({
      outcome: "refused",
      reason: "link_down",
    });
  });

  it("a repeated sale replays the first answer; another frame is trace_conflict", async () => {
    const cloud = await startFakeCloud();
    const tablet = await connected(cloud, approve);
    cloud.lease();
    cloud.command(1);
    const first = await tablet.resultFor(cmd(1));
    cloud.command(2);
    const replay = await tablet.resultFor(cmd(2));
    expect(replay.replayOf).toBe(cmd(1));
    expect(replay.answer).toEqual(first.answer);
    cloud.command(3, { frame: OTHER_FRAME });
    expect((await tablet.resultFor(cmd(3))).answer).toEqual({
      outcome: "refused",
      reason: "trace_conflict",
    });
    expect(tablet.ran.map((c) => c.commandId)).toEqual([cmd(1)]);
  });

  it("a sale still running is duplicate_in_flight; void, cancel and inquiry always run", async () => {
    let release: () => void = () => {};
    const slow: EmulatedTerminal = (command) =>
      command.op === "sale" && command.commandId === cmd(1)
        ? new Promise((done) => {
            release = () => done({ outcome: "response", frame: "AAAA" });
          })
        : approve(command, { connection: "usb", baudRate: 9_600 });
    const cloud = await startFakeCloud();
    const tablet = await connected(cloud, slow);
    cloud.lease();
    cloud.command(1);
    await tablet.waitFor(() => tablet.ran.length === 1);
    cloud.command(2);
    expect((await tablet.resultFor(cmd(2))).answer).toEqual({
      outcome: "refused",
      reason: "duplicate_in_flight",
    });
    cloud.command(3, { op: "void" });
    expect((await tablet.resultFor(cmd(3))).answer).toEqual({
      outcome: "refused",
      reason: "terminal_busy",
    });
    release();
    await tablet.resultFor(cmd(1));
    for (const [n, op] of [
      [4, "void"],
      [5, "void"],
      [6, "cancel"],
      [7, "inquiry"],
      [8, "inquiry"],
    ] as const) {
      cloud.command(n, { op });
      expect((await tablet.resultFor(cmd(n))).replayOf).toBeNull();
    }
    expect(tablet.ran.map((c) => c.op)).toEqual([
      "sale",
      "void",
      "void",
      "cancel",
      "inquiry",
      "inquiry",
    ]);
  });

  it("ttlMs counts from receipt on the monotonic clock; wrong lease id is lease_invalid", async () => {
    let mono = 1_000_000;
    const cloud = await startFakeCloud();
    const tablet = await connected(cloud, approve, {
      monoMs: () => mono,
      // The wall clock is far off; it must not matter.
      now: () => new Date("2001-01-01T00:00:00Z"),
    });
    const leases = () =>
      tablet.received.filter((m) => m.type === "lease").length;
    cloud.lease(L1, 60_000);
    await tablet.waitFor(() => leases() === 1);
    mono += 59_999;
    cloud.command(1, { op: "inquiry" });
    expect((await tablet.resultFor(cmd(1))).answer.outcome).toBe("response");
    mono += 1;
    cloud.command(2, { op: "inquiry" });
    expect((await tablet.resultFor(cmd(2))).answer).toEqual({
      outcome: "refused",
      reason: "lease_invalid",
    });
    cloud.lease(L2, 60_000);
    await tablet.waitFor(() => leases() === 2);
    cloud.command(3, { op: "inquiry" });
    expect((await tablet.resultFor(cmd(3))).answer.outcome).toBe("refused");
    cloud.command(4, { op: "inquiry", leaseId: L2 });
    expect((await tablet.resultFor(cmd(4))).answer.outcome).toBe("response");
    cloud.send({ type: "lease", grants: [], refused: [] });
    await tablet.waitFor(() => leases() === 3);
    cloud.command(5, { op: "inquiry", leaseId: L2 });
    expect((await tablet.resultFor(cmd(5))).answer).toEqual({
      outcome: "refused",
      reason: "lease_invalid",
    });
  });

  it("a lease pointing at the tablet's own address is lease_invalid", async () => {
    const cloud = await startFakeCloud();
    const tablet = await connected(cloud, approve, {
      ownAddresses: ["192.168.1.50"],
    });
    cloud.lease();
    cloud.command(1);
    expect((await tablet.resultFor(cmd(1))).answer).toEqual({
      outcome: "refused",
      reason: "lease_invalid",
    });
    expect(tablet.ran).toEqual([]);
  });

  it("unacked results are resent on every session until acked", async () => {
    const cloud = await startFakeCloud();
    const tablet = await connected(cloud, approve);
    cloud.lease();
    cloud.command(1);
    await tablet.resultFor(cmd(1));
    tablet.disconnect();

    await tablet.connect(cloud.url, "edcb_token");
    await tablet.waitFor(
      () => cloud.uplinks.filter((u) => u.type === "hello").length === 2,
    );
    expect(cloud.uplinks.at(-1)).toMatchObject({
      type: "hello",
      unackedResults: 1,
    });
    cloud.lease();
    await tablet.waitFor(() => cloud.results().length === 2);
    expect(cloud.results().map((r) => r.commandId)).toEqual([cmd(1), cmd(1)]);
    cloud.send({ type: "ack", commandId: cmd(1) });
    await tablet.waitFor(() => tablet.unacked.size === 0);
    tablet.disconnect();

    await tablet.connect(cloud.url, "edcb_token");
    cloud.lease();
    await tablet.waitFor(
      () => tablet.received.filter((m) => m.type === "lease").length === 3,
    );
    expect(cloud.results()).toHaveLength(2);
  });

  it("after a restart an in-flight sale is reported transport_error and never rerun", async () => {
    const cloud = await startFakeCloud();
    const tablet = await connected(cloud, () => new Promise(() => {}));
    cloud.lease();
    cloud.command(1);
    await tablet.waitFor(() => tablet.ran.length === 1);
    tablet.restart();
    expect(tablet.unacked.get(cmd(1))?.answer).toEqual({
      outcome: "transport_error",
      kind: "disconnected",
    });
    await tablet.connect(cloud.url, "edcb_token");
    cloud.lease();
    await tablet.waitFor(() => cloud.results().length === 1);
    cloud.command(2);
    const again = await tablet.resultFor(cmd(2));
    expect(again.replayOf).toBe(cmd(1));
    expect(again.answer.outcome).toBe("transport_error");
    expect(tablet.ran).toHaveLength(1);
  });

  it("sale records go after 48 h and release, or after 30 days", async () => {
    let wall = new Date("2026-11-01T00:00:00Z").getTime();
    let mono = 1_000;
    const advance = (ms: number) => {
      wall += ms;
      mono += ms;
    };
    const cloud = await startFakeCloud();
    const tablet = await connected(cloud, approve, {
      now: () => new Date(wall),
      monoMs: () => mono,
    });
    cloud.lease();
    cloud.command(1);
    await tablet.resultFor(cmd(1));
    cloud.command(2, { trace: "000124" });
    await tablet.resultFor(cmd(2));
    cloud.send({
      type: "sale_record_release",
      terminalId: T1,
      traces: ["000123", "999999"],
    });
    await tablet.waitFor(() =>
      tablet.received.some((m) => m.type === "sale_record_release"),
    );
    advance(48 * 3_600_000 - 1);
    expect(tablet.purge()).toBe(0);
    advance(1);
    expect(tablet.hello().heldSaleRecords).toBe(1);
    expect(tablet.purge()).toBe(1);
    advance(28 * 86_400_000 - 1);
    expect(tablet.purge()).toBe(0);
    advance(1);
    expect(tablet.purge()).toBe(1);
  });

  it("record age is the shorter of wall and monotonic clocks, like the app", async () => {
    let wall = new Date("2026-11-01T00:00:00Z").getTime();
    let mono = 1_000;
    const cloud = await startFakeCloud();
    const tablet = await connected(cloud, approve, {
      now: () => new Date(wall),
      monoMs: () => mono,
    });
    cloud.lease();
    cloud.command(1);
    await tablet.resultFor(cmd(1));
    cloud.send({
      type: "sale_record_release",
      terminalId: T1,
      traces: ["000123"],
    });
    await tablet.waitFor(() =>
      tablet.received.some((m) => m.type === "sale_record_release"),
    );
    // Wall clock moved forward a year, only an hour really passed.
    wall += 365 * 86_400_000;
    mono += 3_600_000;
    expect(tablet.hello().heldSaleRecords).toBe(0);
    expect(tablet.purge()).toBe(0);
    // Monotonic past 30 days but the wall clock was set back: still kept.
    wall -= 400 * 86_400_000;
    mono += 31 * 86_400_000;
    expect(tablet.purge()).toBe(0);
  });

  it("a late completion after a restart keeps the first answer", async () => {
    let finish: (answer: {
      outcome: "response";
      frame: string;
    }) => void = () => {};
    const cloud = await startFakeCloud();
    const tablet = await connected(
      cloud,
      () => new Promise((done) => (finish = done)),
    );
    cloud.lease();
    cloud.command(1);
    await tablet.waitFor(() => tablet.ran.length === 1);
    tablet.restart();
    finish({ outcome: "response", frame: "AAAA" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(tablet.unacked.get(cmd(1))?.answer).toEqual({
      outcome: "transport_error",
      kind: "disconnected",
    });
    expect([...tablet.saleRecords.values()][0]?.answer).toEqual({
      outcome: "transport_error",
      kind: "disconnected",
    });
  });

  it("a message outside the contract closes the socket", async () => {
    const cloud = await startFakeCloud();
    const tablet = await connected(cloud, approve);
    cloud.send({ type: "ack", commandId: cmd(1), extra: true });
    await tablet.waitFor(() => !tablet.connected);
  });

  it("frameBody: STX, BCD length, body, ETX, LRC", () => {
    expect(frameBody(Buffer.from("Hello")).toString("hex")).toBe(
      "02" +
        "0005" +
        "48656c6c6f" +
        "03" +
        (0x00 ^ 0x05 ^ 0x48 ^ 0x65 ^ 0x6c ^ 0x6c ^ 0x6f ^ 0x03)
          .toString(16)
          .padStart(2, "0"),
    );
  });
});
