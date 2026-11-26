import { describe, expect, it } from "vitest";
import { EcrTransportError } from "@starter/shared/edc";
import {
  EDC_BRIDGE_DEDUPED_OPS,
  EDC_BRIDGE_LEASE_HANDOVER_GRACE_MS,
  EDC_BRIDGE_MAX_COMMAND_TIMEOUT_MS,
  EDC_BRIDGE_MAX_MESSAGE_BYTES,
  EDC_BRIDGE_PAIRING_MAX_ATTEMPTS,
  EDC_BRIDGE_PROTOCOL_VERSION,
  EDC_BRIDGE_SALE_RECORD_MIN_RETENTION_MS,
  edcBridgeDedupeDecision,
  edcBridgeDedupeKey,
  edcBridgeFrameSha256,
  edcBridgeLeaseReusableAt,
  edcBridgeLinkTargetsSelf,
  edcBridgeDeviceTokenSchema,
  edcBridgeLinkSchema,
  edcBridgePairingCodeSchema,
  edcBridgeTransportErrorOf,
  isSupportedEdcBridgeVersion,
  parseEdcBridgeDownlink,
  parseEdcBridgeUplink,
} from "@starter/shared/edc/bridge";

// Contract between the cloud EDC agent and the "Legend EDC Bridge" tablet app
// (bead legend-wasr7.20, docs/design/edc-bridge-protocol.md).

const TERMINAL = "0b8f8a52-2d55-4a3e-9d4f-3c1f3c8a9b11";
const LEASE = "6a7c1d2e-3f40-4b51-8c62-7d83e94fa0b2";
const COMMAND = "9e1f2a3b-4c5d-4e6f-8a7b-9c0d1e2f3a4b";
const FRAME = "AAECAwQF";

function command(op: string, extra: Record<string, unknown> = {}) {
  return {
    type: "command",
    commandId: COMMAND,
    leaseId: LEASE,
    terminalId: TERMINAL,
    op,
    trace: "TRACE0001",
    frame: FRAME,
    timeoutMs: 120_000,
    ...extra,
  };
}

function result(answer: Record<string, unknown>, extra = {}) {
  return {
    type: "result",
    commandId: COMMAND,
    terminalId: TERMINAL,
    op: "sale",
    trace: "TRACE0001",
    replayOf: null,
    completedAt: "2026-11-27T03:00:00.000Z",
    answer,
    ...extra,
  };
}

describe("EDC bridge contract: versions and hello", () => {
  it("version 1 is the current and only supported version", () => {
    expect(EDC_BRIDGE_PROTOCOL_VERSION).toBe(1);
    expect(isSupportedEdcBridgeVersion(1)).toBe(true);
    expect(isSupportedEdcBridgeVersion(2)).toBe(false);
  });

  it("hello parses any positive version so the cloud can answer goodbye", () => {
    const hello = {
      type: "hello",
      protocolVersion: 2,
      appVersion: "1.0.0",
      unackedResults: 0,
    };
    expect(parseEdcBridgeUplink(JSON.stringify(hello))).toEqual(hello);
    expect(() =>
      parseEdcBridgeUplink(JSON.stringify({ ...hello, protocolVersion: 0 })),
    ).toThrow();
  });

  it("hello is strict: the device token never travels in a message", () => {
    expect(() =>
      parseEdcBridgeUplink(
        JSON.stringify({
          type: "hello",
          protocolVersion: 1,
          appVersion: "1.0.0",
          unackedResults: 0,
          token: "x",
        }),
      ),
    ).toThrow();
  });
});

describe("EDC bridge contract: lease", () => {
  const grant = {
    terminalId: TERMINAL,
    leaseId: LEASE,
    ttlMs: 60_000,
    link: { connection: "lan", host: "192.168.1.20", port: 9000 },
    framing: "stx_bcdlen_etx_lrc",
  };

  it("parses a grant and a refusal", () => {
    const lease = {
      type: "lease",
      grants: [grant],
      refused: [
        {
          terminalId: "1b8f8a52-2d55-4a3e-9d4f-3c1f3c8a9b11",
          reason: "held_by_other_device",
        },
      ],
    };
    expect(parseEdcBridgeDownlink(JSON.stringify(lease))).toEqual(lease);
  });

  it("a grant has a relative ttlMs, never a cloud-clock expiresAt", () => {
    const lease = (g: Record<string, unknown>) =>
      JSON.stringify({ type: "lease", grants: [g], refused: [] });
    expect(() =>
      parseEdcBridgeDownlink(
        lease({ ...grant, expiresAt: "2026-11-27T03:05:00.000Z" }),
      ),
    ).toThrow();
    for (const ttlMs of [9_999, 600_001, 1.5])
      expect(() =>
        parseEdcBridgeDownlink(lease({ ...grant, ttlMs })),
      ).toThrow();
  });

  it("the cloud hands a terminal to another tablet only after ttl + max timeout + 30 s", () => {
    const issuedAt = new Date("2026-11-27T03:00:00.000Z");
    expect(EDC_BRIDGE_MAX_COMMAND_TIMEOUT_MS).toBe(300_000);
    expect(EDC_BRIDGE_LEASE_HANDOVER_GRACE_MS).toBe(30_000);
    expect(edcBridgeLeaseReusableAt(issuedAt, 60_000).toISOString()).toBe(
      "2026-11-27T03:06:30.000Z",
    );
  });

  it("LAN link only reaches a private IPv4 address", () => {
    for (const host of [
      "10.0.0.5",
      "172.16.3.4",
      "172.31.255.255",
      "192.168.0.10",
    ])
      expect(
        edcBridgeLinkSchema.safeParse({ connection: "lan", host, port: 9000 })
          .success,
      ).toBe(true);
    for (const host of [
      "8.8.8.8",
      "172.32.0.1",
      "172.15.255.255",
      "192.169.0.1",
      "0.0.0.0",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.1.1",
      "example.com",
    ])
      expect(
        edcBridgeLinkSchema.safeParse({ connection: "lan", host, port: 9000 })
          .success,
      ).toBe(false);
  });

  it("a LAN link to the tablet's own interface address is refused", () => {
    const link = edcBridgeLinkSchema.parse({
      connection: "lan",
      host: "192.168.1.20",
      port: 9000,
    });
    expect(edcBridgeLinkTargetsSelf(link, ["192.168.1.20", "10.0.0.2"])).toBe(
      true,
    );
    expect(edcBridgeLinkTargetsSelf(link, ["192.168.1.21"])).toBe(false);
    const usb = edcBridgeLinkSchema.parse({
      connection: "usb",
      baudRate: 9600,
    });
    expect(edcBridgeLinkTargetsSelf(usb, ["192.168.1.20"])).toBe(false);
  });

  it("USB link takes a standard baud rate; bluetooth is not a bridge link", () => {
    expect(
      edcBridgeLinkSchema.safeParse({ connection: "usb", baudRate: 9600 })
        .success,
    ).toBe(true);
    expect(
      edcBridgeLinkSchema.safeParse({ connection: "usb", baudRate: 1234 })
        .success,
    ).toBe(false);
    expect(
      edcBridgeLinkSchema.safeParse({ connection: "bluetooth" }).success,
    ).toBe(false);
  });
});

describe("EDC bridge contract: commands", () => {
  it("parses sale, cancel, inquiry and void", () => {
    for (const op of ["sale", "cancel", "inquiry", "void"])
      expect(parseEdcBridgeDownlink(JSON.stringify(command(op)))).toEqual(
        command(op),
      );
  });

  it("refuses an unknown op, a bad trace, a non-base64 frame, an amount field", () => {
    for (const bad of [
      command("refund"),
      command("sale", { trace: "TR-1" }),
      command("sale", { frame: "not base64!" }),
      command("sale", { frame: "" }),
      command("sale", { amountIdr: 1000 }),
      command("sale", { timeoutMs: 999 }),
    ])
      expect(() => parseEdcBridgeDownlink(JSON.stringify(bad))).toThrow();
  });

  it("dedupes sale only; void, cancel and inquiry always reach the terminal", () => {
    expect(EDC_BRIDGE_DEDUPED_OPS).toEqual(["sale"]);
    const sale = parseEdcBridgeDownlink(JSON.stringify(command("sale")));
    const again = parseEdcBridgeDownlink(
      JSON.stringify(
        command("sale", { commandId: "1e1f2a3b-4c5d-4e6f-8a7b-9c0d1e2f3a4b" }),
      ),
    );
    if (sale.type !== "command" || again.type !== "command")
      throw new Error("expected commands");
    expect(edcBridgeDedupeKey(sale)).toBe(`${TERMINAL}:sale:TRACE0001`);
    expect(edcBridgeDedupeKey(again)).toBe(edcBridgeDedupeKey(sale));
    for (const op of ["void", "cancel", "inquiry"]) {
      const cmd = parseEdcBridgeDownlink(JSON.stringify(command(op)));
      if (cmd.type !== "command") throw new Error("expected command");
      expect(edcBridgeDedupeKey(cmd)).toBeNull();
      expect(
        edcBridgeDedupeDecision(
          cmd,
          {
            commandId: COMMAND,
            frameSha256: "0".repeat(64),
            state: "done",
          },
          "0".repeat(64),
        ),
      ).toEqual({ action: "run" });
    }
  });

  it("frame hash is SHA-256 hex of the base64 frame text", async () => {
    expect(await edcBridgeFrameSha256(FRAME)).toBe(
      "131afd4cbe2f7ea4295563cbbde7bdb6120d5fd74dcec8827de0fbe23c9eb04d",
    );
    expect(await edcBridgeFrameSha256("AAECAwQG")).not.toBe(
      await edcBridgeFrameSha256(FRAME),
    );
  });

  it("a repeated sale replays only when the frame hash matches; else trace_conflict", async () => {
    const sale = edcBridgeDedupeDecisionInput(command("sale"));
    const hash = await edcBridgeFrameSha256(FRAME);
    const other = await edcBridgeFrameSha256("AAECAwQG");
    const first = "1e1f2a3b-4c5d-4e6f-8a7b-9c0d1e2f3a4b";
    expect(edcBridgeDedupeDecision(sale, null, hash)).toEqual({
      action: "run",
    });
    expect(
      edcBridgeDedupeDecision(
        sale,
        {
          commandId: first,
          frameSha256: hash,
          state: "done",
        },
        hash,
      ),
    ).toEqual({ action: "replay", replayOf: first });
    expect(
      edcBridgeDedupeDecision(
        sale,
        {
          commandId: first,
          frameSha256: hash,
          state: "in_flight",
        },
        hash,
      ),
    ).toEqual({ action: "refuse", reason: "duplicate_in_flight" });
    for (const state of ["done", "in_flight"] as const)
      expect(
        edcBridgeDedupeDecision(
          sale,
          {
            commandId: first,
            frameSha256: other,
            state,
          },
          hash,
        ),
      ).toEqual({ action: "refuse", reason: "trace_conflict" });
  });

  it("sale records outlive the unacked queue: at least 48 hours", () => {
    expect(EDC_BRIDGE_SALE_RECORD_MIN_RETENTION_MS).toBe(48 * 3_600_000);
  });
});

function edcBridgeDedupeDecisionInput(raw: Record<string, unknown>) {
  const cmd = parseEdcBridgeDownlink(JSON.stringify(raw));
  if (cmd.type !== "command") throw new Error("expected command");
  return cmd;
}

describe("EDC bridge contract: results and ack", () => {
  it("a response carries the raw terminal frame and is definite", () => {
    const msg = parseEdcBridgeUplink(
      JSON.stringify(result({ outcome: "response", frame: FRAME })),
    );
    if (msg.type !== "result") throw new Error("expected result");
    expect(edcBridgeTransportErrorOf(msg.answer)).toBeNull();
  });

  it("a replay names the first command", () => {
    const msg = parseEdcBridgeUplink(
      JSON.stringify(
        result(
          { outcome: "response", frame: FRAME },
          { replayOf: "1e1f2a3b-4c5d-4e6f-8a7b-9c0d1e2f3a4b" },
        ),
      ),
    );
    if (msg.type !== "result") throw new Error("expected result");
    expect(msg.replayOf).toBe("1e1f2a3b-4c5d-4e6f-8a7b-9c0d1e2f3a4b");
  });

  it("transport errors and refusals after dispatch are unknown, never failed", () => {
    for (const [answer, kind] of [
      [{ outcome: "transport_error", kind: "timeout" }, "timeout"],
      [{ outcome: "transport_error", kind: "disconnected" }, "disconnected"],
      [{ outcome: "transport_error", kind: "protocol" }, "protocol"],
      [{ outcome: "refused", reason: "lease_invalid" }, "protocol"],
      [{ outcome: "refused", reason: "duplicate_in_flight" }, "protocol"],
      [{ outcome: "refused", reason: "link_down" }, "protocol"],
      [{ outcome: "refused", reason: "terminal_busy" }, "protocol"],
      [{ outcome: "refused", reason: "trace_conflict" }, "protocol"],
    ] as const) {
      const msg = parseEdcBridgeUplink(JSON.stringify(result(answer)));
      if (msg.type !== "result") throw new Error("expected result");
      const error = edcBridgeTransportErrorOf(msg.answer);
      expect(error).toBeInstanceOf(EcrTransportError);
      expect(error?.kind).toBe(kind);
    }
  });

  it("a result never carries decoded card data", () => {
    expect(() =>
      parseEdcBridgeUplink(
        JSON.stringify(
          result({ outcome: "response", frame: FRAME, pan: "4111" }),
        ),
      ),
    ).toThrow();
    expect(() =>
      parseEdcBridgeUplink(
        JSON.stringify(result({ outcome: "approved", frame: FRAME })),
      ),
    ).toThrow();
  });

  it("ack and goodbye parse; unknown message types do not", () => {
    expect(
      parseEdcBridgeDownlink(
        JSON.stringify({ type: "ack", commandId: COMMAND }),
      ),
    ).toEqual({ type: "ack", commandId: COMMAND });
    expect(
      parseEdcBridgeDownlink(
        JSON.stringify({ type: "goodbye", reason: "protocol_unsupported" }),
      ),
    ).toEqual({ type: "goodbye", reason: "protocol_unsupported" });
    expect(() =>
      parseEdcBridgeDownlink(JSON.stringify({ type: "hello" })),
    ).toThrow();
    expect(() =>
      parseEdcBridgeUplink(JSON.stringify({ type: "ack", commandId: COMMAND })),
    ).toThrow();
  });

  it("refuses an oversized message before JSON parsing", () => {
    const big = JSON.stringify(
      result({
        outcome: "response",
        frame: "A".repeat(EDC_BRIDGE_MAX_MESSAGE_BYTES),
      }),
    );
    expect(() => parseEdcBridgeUplink(big)).toThrow(/too large/);
    expect(() => parseEdcBridgeUplink("{not json")).toThrow();
  });
});

describe("EDC bridge contract: device token and pairing code", () => {
  it("token is edcb_<ULID>_<43 base64url chars>", () => {
    const token = `edcb_01JDZQ7X8M3K4N5P6Q7R8S9T0V_${"a".repeat(43)}`;
    expect(edcBridgeDeviceTokenSchema.safeParse(token).success).toBe(true);
    for (const bad of [
      `edcb_01JDZQ7X8M3K4N5P6Q7R8S9T0V_${"a".repeat(42)}`,
      `edcx_01JDZQ7X8M3K4N5P6Q7R8S9T0V_${"a".repeat(43)}`,
      `edcb_01JDZQ7X8M3K4N5P6Q7R8S9T0U_${"a".repeat(43)}`,
    ])
      expect(edcBridgeDeviceTokenSchema.safeParse(bad).success).toBe(false);
  });

  it("pairing code is 8 Crockford characters, case-insensitive", () => {
    expect(edcBridgePairingCodeSchema.parse("abcd2345")).toBe("ABCD2345");
    expect(edcBridgePairingCodeSchema.safeParse("ABCD234I").success).toBe(
      false,
    );
    expect(edcBridgePairingCodeSchema.safeParse("ABC2345").success).toBe(false);
  });

  it("pairing allows at most 5 wrong attempts", () => {
    expect(EDC_BRIDGE_PAIRING_MAX_ATTEMPTS).toBe(5);
  });
});
