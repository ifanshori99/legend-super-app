// Contract fixtures for the Android bridge's JVM tests (B3 legend-wasr7.22):
// every expected value comes from the zod schemas and helpers in
// @starter/shared/edc/bridge, so the Kotlin parser and the TypeScript contract
// cannot drift. Written to
// apps/edc-bridge-android/app/src/test/resources/edc-bridge-contract-fixtures.json
// by edc-bridge-tablet.test.ts (UPDATE_EDC_BRIDGE_FIXTURES=1), which also fails
// when the committed file is stale.
import {
  EDC_BRIDGE_MAX_MESSAGE_BYTES,
  EDC_BRIDGE_SALE_RECORD_MAX_RETENTION_MS,
  EDC_BRIDGE_SALE_RECORD_MIN_RETENTION_MS,
  edcBridgeDedupeDecision,
  edcBridgeFrameSha256,
  edcBridgeResultSchema,
  edcBridgeHelloSchema,
  edcBridgeSaleRecordDeletable,
  parseEdcBridgeDownlink,
  type EdcBridgeAnswer,
  type EdcBridgeSaleRecord,
} from "@starter/shared/edc/bridge";
import { frameBody } from "./edc-bridge-tablet.ts";

const T1 = "3f0e2a4c-1b2d-4c3e-8f40-5a6b7c8d9e01";
const T2 = "3f0e2a4c-1b2d-4c3e-9f40-5a6b7c8d9e02";
const L1 = "7a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d";
const C1 = "0b1c2d3e-4f50-4162-a374-8596a7b8c9d0";
const C2 = "0b1c2d3e-4f50-4162-b374-8596a7b8c9d1";

const lanLink = { connection: "lan", host: "192.168.1.50", port: 9000 };
const grant = (extra: Record<string, unknown> = {}) => ({
  terminalId: T1,
  leaseId: L1,
  ttlMs: 120_000,
  link: lanLink,
  framing: "stx_bcdlen_etx_lrc",
  ...extra,
});
const lease = (grants: unknown[], refused: unknown[] = []) => ({
  type: "lease",
  grants,
  refused,
});
const command = (extra: Record<string, unknown> = {}) => ({
  type: "command",
  commandId: C1,
  leaseId: L1,
  terminalId: T1,
  op: "sale",
  trace: "000123",
  frame: "eyJvcCI6InNhbGUifQ==",
  timeoutMs: 60_000,
  ...extra,
});
const lanGrant = (host: unknown, port: unknown = 9000) =>
  lease([grant({ link: { connection: "lan", host, port } })]);

/** Raw text cases: a JSON value is stringified; a string is sent as is. */
const downlinkCases: Array<[name: string, raw: unknown]> = [
  [
    "lease lan + usb + refused",
    lease(
      [
        grant(),
        grant({ terminalId: T2, link: { connection: "usb", baudRate: 9_600 } }),
      ],
      [{ terminalId: T2, reason: "held_by_other_device" }],
    ),
  ],
  ["lease empty", lease([])],
  [
    "lease uppercase uuid",
    lease([grant({ terminalId: T1.toUpperCase(), leaseId: L1.toUpperCase() })]),
  ],
  ["lease ttl min", lease([grant({ ttlMs: 10_000 })])],
  ["lease ttl max", lease([grant({ ttlMs: 600_000 })])],
  ["lease ttl below min", lease([grant({ ttlMs: 9_999 })])],
  ["lease ttl above max", lease([grant({ ttlMs: 600_001 })])],
  ["lease ttl fractional", lease([grant({ ttlMs: 120_000.5 })])],
  ["lease ttl string", lease([grant({ ttlMs: "120000" })])],
  ["lease ttl null", lease([grant({ ttlMs: null })])],
  ["lease ttl boolean", lease([grant({ ttlMs: true })])],
  [
    "lease ttl written 120000.0",
    '{"type":"lease","grants":[{"terminalId":"' +
      T1 +
      '","leaseId":"' +
      L1 +
      '","ttlMs":120000.0,"link":{"connection":"lan","host":"10.0.0.5","port":9000},"framing":"stx_bcdlen_etx_lrc"}],"refused":[]}',
  ],
  [
    "lease ttl written 1.2e5",
    '{"type":"lease","grants":[{"terminalId":"' +
      T1 +
      '","leaseId":"' +
      L1 +
      '","ttlMs":1.2e5,"link":{"connection":"lan","host":"10.0.0.5","port":9000},"framing":"stx_bcdlen_etx_lrc"}],"refused":[]}',
  ],
  ["lease 9 grants", lease(Array.from({ length: 9 }, () => grant()))],
  [
    "lease 9 refused",
    lease(
      [],
      Array.from({ length: 9 }, () => ({
        terminalId: T2,
        reason: "terminal_inactive",
      })),
    ),
  ],
  [
    "lease refused unknown reason",
    lease([], [{ terminalId: T2, reason: "busy" }]),
  ],
  [
    "lease refused extra key",
    lease([], [{ terminalId: T2, reason: "terminal_inactive", note: "x" }]),
  ],
  [
    "lease grant extra key",
    lease([grant({ expiresAt: "2026-11-27T00:00:00Z" })]),
  ],
  [
    "lease grant missing framing",
    lease([{ terminalId: T1, leaseId: L1, ttlMs: 120_000, link: lanLink }]),
  ],
  ["lease framing unknown", lease([grant({ framing: "raw" })])],
  [
    "lease link extra key",
    lease([grant({ link: { ...lanLink, tls: false } })]),
  ],
  [
    "lease link bluetooth",
    lease([
      grant({
        link: { connection: "bluetooth", address: "00:11:22:33:44:55" },
      }),
    ]),
  ],
  [
    "lease usb baud 115200",
    lease([grant({ link: { connection: "usb", baudRate: 115_200 } })]),
  ],
  [
    "lease usb baud 4800",
    lease([grant({ link: { connection: "usb", baudRate: 4_800 } })]),
  ],
  [
    "lease usb baud 14400",
    lease([grant({ link: { connection: "usb", baudRate: 14_400 } })]),
  ],
  ["lan 10.0.0.1", lanGrant("10.0.0.1")],
  ["lan 10.255.255.255", lanGrant("10.255.255.255")],
  ["lan 172.16.0.1", lanGrant("172.16.0.1")],
  ["lan 172.31.255.255", lanGrant("172.31.255.255")],
  ["lan 192.168.0.1", lanGrant("192.168.0.1")],
  ["lan 172.15.255.255", lanGrant("172.15.255.255")],
  ["lan 172.32.0.1", lanGrant("172.32.0.1")],
  ["lan 192.169.1.1", lanGrant("192.169.1.1")],
  ["lan 8.8.8.8", lanGrant("8.8.8.8")],
  ["lan 0.0.0.0", lanGrant("0.0.0.0")],
  ["lan 127.0.0.1", lanGrant("127.0.0.1")],
  ["lan 100.64.0.1", lanGrant("100.64.0.1")],
  ["lan 169.254.1.1", lanGrant("169.254.1.1")],
  ["lan 010.0.0.1", lanGrant("010.0.0.1")],
  ["lan 10.0.0.256", lanGrant("10.0.0.256")],
  ["lan trailing space", lanGrant("10.0.0.1 ")],
  ["lan newline", lanGrant("10.0.0.1\n")],
  ["lan hostname", lanGrant("edc.local")],
  ["lan port 1", lanGrant("10.0.0.1", 1)],
  ["lan port 65535", lanGrant("10.0.0.1", 65_535)],
  ["lan port 0", lanGrant("10.0.0.1", 0)],
  ["lan port 65536", lanGrant("10.0.0.1", 65_536)],
  ["command sale", command()],
  ["command void", command({ op: "void" })],
  ["command cancel", command({ op: "cancel" })],
  ["command inquiry", command({ op: "inquiry" })],
  ["command op refund", command({ op: "refund" })],
  [
    "command uppercase uuid",
    command({ commandId: C1.toUpperCase(), terminalId: T1.toUpperCase() }),
  ],
  [
    "command nil uuid",
    command({ commandId: "00000000-0000-0000-0000-000000000000" }),
  ],
  [
    "command max uuid",
    command({ commandId: "ffffffff-ffff-ffff-ffff-ffffffffffff" }),
  ],
  [
    "command uuid version 0",
    command({ commandId: "0b1c2d3e-4f50-0162-a374-8596a7b8c9d0" }),
  ],
  [
    "command uuid variant c",
    command({ commandId: "0b1c2d3e-4f50-4162-c374-8596a7b8c9d0" }),
  ],
  [
    "command uuid no dashes",
    command({ commandId: "0b1c2d3e4f504162a3748596a7b8c9d0" }),
  ],
  ["command trace 32", command({ trace: "A".repeat(32) })],
  ["command trace 33", command({ trace: "A".repeat(33) })],
  ["command trace empty", command({ trace: "" })],
  ["command trace dash", command({ trace: "00-123" })],
  ["command frame min", command({ frame: "AAAA" })],
  ["command frame padded", command({ frame: "AAA=" })],
  ["command frame 3 chars", command({ frame: "AAA" })],
  ["command frame bad padding", command({ frame: "AA=A" })],
  ["command frame newline", command({ frame: "AAAA\nAAAA" })],
  ["command frame url-safe", command({ frame: "AA-_" })],
  ["command frame 8192", command({ frame: "A".repeat(8_192) })],
  ["command frame 8196", command({ frame: "A".repeat(8_196) })],
  ["command timeout 1000", command({ timeoutMs: 1_000 })],
  ["command timeout 300000", command({ timeoutMs: 300_000 })],
  ["command timeout 999", command({ timeoutMs: 999 })],
  ["command timeout 300001", command({ timeoutMs: 300_001 })],
  ["command extra amount", command({ amountIdr: 10_000 })],
  [
    "command missing frame",
    (() => {
      const { frame: _frame, ...rest } = command();
      void _frame;
      return rest;
    })(),
  ],
  ["ack", { type: "ack", commandId: C1 }],
  ["ack extra", { type: "ack", commandId: C1, at: 1 }],
  [
    "release 1",
    { type: "sale_record_release", terminalId: T1, traces: ["000123"] },
  ],
  [
    "release 500",
    {
      type: "sale_record_release",
      terminalId: T1,
      traces: Array.from({ length: 500 }, (_, i) => `T${i}`),
    },
  ],
  ["release 0", { type: "sale_record_release", terminalId: T1, traces: [] }],
  [
    "release 501",
    {
      type: "sale_record_release",
      terminalId: T1,
      traces: Array.from({ length: 501 }, (_, i) => `T${i}`),
    },
  ],
  [
    "release bad trace",
    { type: "sale_record_release", terminalId: T1, traces: ["a b"] },
  ],
  [
    "goodbye protocol_unsupported",
    { type: "goodbye", reason: "protocol_unsupported" },
  ],
  ["goodbye token_revoked", { type: "goodbye", reason: "token_revoked" }],
  [
    "goodbye replaced_by_newer_session",
    { type: "goodbye", reason: "replaced_by_newer_session" },
  ],
  ["goodbye server_shutdown", { type: "goodbye", reason: "server_shutdown" }],
  ["goodbye unknown", { type: "goodbye", reason: "bye" }],
  [
    "uplink hello is not downlink",
    {
      type: "hello",
      protocolVersion: 1,
      appVersion: "0.1.0",
      unackedResults: 0,
      heldSaleRecords: 0,
    },
  ],
  ["unknown type", { type: "ping" }],
  ["missing type", { commandId: C1 }],
  ["array", [command()]],
  ["string", '"lease"'],
  ["bad json", '{"type":"ack",'],
  ["trailing comma", `{"type":"ack","commandId":"${C1}",}`],
  [
    "oversize",
    {
      type: "goodbye",
      reason: "server_shutdown",
      pad: "x".repeat(EDC_BRIDGE_MAX_MESSAGE_BYTES),
    },
  ],
];

const answers: Record<string, EdcBridgeAnswer> = {
  response: { outcome: "response", frame: "eyJyYyI6IjAwIn0=" },
  timeout: { outcome: "transport_error", kind: "timeout" },
  disconnected: { outcome: "transport_error", kind: "disconnected" },
  protocol: { outcome: "transport_error", kind: "protocol" },
  lease_invalid: { outcome: "refused", reason: "lease_invalid" },
  terminal_busy: { outcome: "refused", reason: "terminal_busy" },
  link_down: { outcome: "refused", reason: "link_down" },
  duplicate_in_flight: { outcome: "refused", reason: "duplicate_in_flight" },
  trace_conflict: { outcome: "refused", reason: "trace_conflict" },
};

export async function buildEdcBridgeFixtures() {
  const downlink = downlinkCases.map(([name, value]) => {
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    try {
      return { name, raw, valid: true, parsed: parseEdcBridgeDownlink(raw) };
    } catch {
      return { name, raw, valid: false };
    }
  });

  const uplink = [
    edcBridgeHelloSchema.parse({
      type: "hello",
      protocolVersion: 1,
      appVersion: "0.1.0",
      unackedResults: 2,
      heldSaleRecords: 1,
    }),
    ...Object.values(answers).map((answer, i) =>
      edcBridgeResultSchema.parse({
        type: "result",
        commandId: i % 2 ? C1 : C2,
        terminalId: T1,
        op: i % 3 === 0 ? "sale" : "void",
        trace: "000123",
        replayOf: i === 0 ? C2 : null,
        completedAt: "2026-11-27T06:58:25.123Z",
        answer,
      }),
    ),
  ];

  const frames = ["AAAA", "eyJvcCI6InNhbGUifQ==", "A".repeat(8_192)];
  const frameSha256 = await Promise.all(
    frames.map(async (frame) => ({
      frame,
      sha256: await edcBridgeFrameSha256(frame),
    })),
  );

  const hashA = frameSha256[1]!.sha256;
  const record = (
    state: EdcBridgeSaleRecord["state"],
    answer: EdcBridgeAnswer | null,
  ): EdcBridgeSaleRecord => ({
    commandId: C2,
    frameSha256: hashA,
    state,
    answer,
  });
  const dedupeInputs: Array<{
    op: "sale" | "void" | "cancel" | "inquiry";
    record: EdcBridgeSaleRecord | null;
    frameSha256: string;
  }> = [
    { op: "sale", record: null, frameSha256: hashA },
    {
      op: "sale",
      record: record("done", answers.response!),
      frameSha256: hashA,
    },
    {
      op: "sale",
      record: record("done", answers.timeout!),
      frameSha256: hashA,
    },
    { op: "sale", record: record("in_flight", null), frameSha256: hashA },
    { op: "sale", record: record("done", null), frameSha256: hashA },
    {
      op: "sale",
      record: record("done", answers.response!),
      frameSha256: "0".repeat(64),
    },
    {
      op: "sale",
      record: record("in_flight", null),
      frameSha256: "0".repeat(64),
    },
    {
      op: "void",
      record: record("done", answers.response!),
      frameSha256: hashA,
    },
    {
      op: "cancel",
      record: record("done", answers.response!),
      frameSha256: hashA,
    },
    { op: "inquiry", record: record("in_flight", null), frameSha256: hashA },
  ];
  const dedupe = dedupeInputs.map((input) => ({
    ...input,
    decision: edcBridgeDedupeDecision(
      { op: input.op },
      input.record,
      input.frameSha256,
    ),
  }));

  const min = EDC_BRIDGE_SALE_RECORD_MIN_RETENTION_MS;
  const max = EDC_BRIDGE_SALE_RECORD_MAX_RETENTION_MS;
  const storedAt = new Date("2026-11-01T00:00:00.000Z");
  const deletable = [0, min - 1, min, max - 1, max, max + 1].flatMap((ageMs) =>
    [false, true].map((released) => ({
      ageMs,
      released,
      deletable: edcBridgeSaleRecordDeletable(
        { storedAt, released },
        new Date(storedAt.getTime() + ageMs),
      ),
    })),
  );

  const bodies = ["", "00", "48656c6c6f", "02031506ff", "ab".repeat(1_234)];
  const framing = bodies.map((bodyHex) => ({
    bodyHex,
    framedHex: frameBody(Buffer.from(bodyHex, "hex")).toString("hex"),
  }));

  return { downlink, uplink, frameSha256, dedupe, deletable, framing };
}
