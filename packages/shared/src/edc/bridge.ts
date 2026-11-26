// Wire contract between the cloud EDC agent and the "Legend EDC Bridge"
// Android app on the cashier tablet (bead legend-wasr7.20; design
// docs/design/edc-auto-cloud.md, protocol docs/design/edc-bridge-protocol.md).
//
// The bridge is a pipe. The cloud agent (apps/api/src/edge/edc/agent.ts, E1-E7)
// keeps every money rule: write-ahead ledger, idempotency, "inquiry before
// retry", amount check, PAN masking. The bank adapter in the cloud builds the
// ECR message body and decodes the terminal's answer; the bridge only frames
// it (STX/length/ETX/LRC, ACK/NAK) on the LAN socket or USB-serial port and
// sends the raw answer back. So:
// - A command carries opaque base64 bytes, never an amount or card data the
//   bridge could act on by itself.
// - A result carries the raw terminal frame, never a decoded outcome: only the
//   cloud adapter decides `approved`.
// - Anything but a raw response, after the command left the cloud, is an
//   `EcrTransportError`: the ledger row becomes `unknown` -> inquiry, never
//   `failed` (pengaman 3).
//
// Uplink = bridge -> cloud, downlink = cloud -> bridge. One JSON message per
// WebSocket text frame. The device token is sent only in the WSS upgrade
// `Authorization` header, never in a message.
import { z, uuidSchema, isoDateTimeSchema } from "../core/index.ts";
import { ecrTraceSchema, EcrTransportError } from "./index.ts";

export const EDC_BRIDGE_PROTOCOL_VERSION = 1 as const;
export const EDC_BRIDGE_SUPPORTED_VERSIONS: readonly number[] = [
  EDC_BRIDGE_PROTOCOL_VERSION,
];

export function isSupportedEdcBridgeVersion(version: number): boolean {
  return EDC_BRIDGE_SUPPORTED_VERSIONS.includes(version);
}

/** Largest WebSocket text frame either side accepts. Checked before
 * `JSON.parse`. ECR messages are a few hundred bytes. */
export const EDC_BRIDGE_MAX_MESSAGE_BYTES = 16_384;

export const edcBridgeOpSchema = z.enum(["sale", "cancel", "inquiry", "void"]);
export type EdcBridgeOp = z.infer<typeof edcBridgeOpSchema>;

/** Ops the bridge runs at most once per terminal + trace: a second command
 * replays the first result (`replayOf`) and never reaches the terminal again.
 * `cancel` and `inquiry` never charge, so they pass through. */
export const EDC_BRIDGE_DEDUPED_OPS: readonly EdcBridgeOp[] = ["sale", "void"];

/** Raw ECR bytes, standard base64, non-empty. */
const frameSchema = z
  .string()
  .min(4)
  .max(8_192)
  .regex(
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
    "Frame is base64",
  );

function isPrivateIpv4(host: string): boolean {
  const [a, b] = host.split(".").map(Number);
  if (a === 10) return true;
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
  return a === 192 && b === 168;
}

/** How the bridge reaches the terminal. LAN only to a private IPv4 (RFC 1918)
 * address: a cloud command can never turn the tablet into a TCP proxy to
 * the internet or to itself. Bluetooth terminals are not served by the
 * bridge (lease refused `connection_unsupported`). */
export const edcBridgeLinkSchema = z.discriminatedUnion("connection", [
  z.strictObject({
    connection: z.literal("lan"),
    host: z.ipv4().refine(isPrivateIpv4, "Terminal IP must be private"),
    port: z.number().int().min(1).max(65_535),
  }),
  z.strictObject({
    connection: z.literal("usb"),
    baudRate: z.union([
      z.literal(9_600),
      z.literal(19_200),
      z.literal(38_400),
      z.literal(57_600),
      z.literal(115_200),
    ]),
  }),
]);
export type EdcBridgeLink = z.infer<typeof edcBridgeLinkSchema>;

/** Link framing the bridge does locally (ACK/NAK/LRC must not cross 4G).
 * `stx_bcdlen_etx_lrc`: STX, 2-byte BCD length, body, ETX, LRC (XOR of
 * length..ETX); ACK 0x06 / NAK 0x15, at most 3 resends on NAK. A bank with
 * other framing adds a value here (B5), not a new protocol version. */
export const edcBridgeFramingSchema = z.enum(["stx_bcdlen_etx_lrc"]);
export type EdcBridgeFraming = z.infer<typeof edcBridgeFramingSchema>;

// Uplink (bridge -> cloud)

export const edcBridgeHelloSchema = z.strictObject({
  type: z.literal("hello"),
  /** Any positive version parses, so the cloud can answer `goodbye`
   * `protocol_unsupported` instead of dropping the socket. */
  protocolVersion: z.number().int().min(1),
  appVersion: z
    .string()
    .max(32)
    .regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/),
  /** Results in the local journal still waiting for an `ack`. The bridge
   * resends them right after the lease. */
  unackedResults: z.number().int().min(0).max(10_000),
});
export type EdcBridgeHello = z.infer<typeof edcBridgeHelloSchema>;

export const edcBridgeAnswerSchema = z.discriminatedUnion("outcome", [
  /** The terminal answered; `frame` is its message body, unframed. */
  z.strictObject({ outcome: z.literal("response"), frame: frameSchema }),
  /** The bridge could not learn the terminal's answer. */
  z.strictObject({
    outcome: z.literal("transport_error"),
    kind: z.enum(["timeout", "disconnected", "protocol"]),
  }),
  /** The bridge did not run the command. Still `unknown` in the cloud for
   * every op: the cloud already marked it dispatched. */
  z.strictObject({
    outcome: z.literal("refused"),
    reason: z.enum([
      "lease_invalid",
      "terminal_busy",
      "link_down",
      "duplicate_in_flight",
    ]),
  }),
]);
export type EdcBridgeAnswer = z.infer<typeof edcBridgeAnswerSchema>;

export const edcBridgeResultSchema = z.strictObject({
  type: z.literal("result"),
  /** The command this answers (a replay answers the NEW command). */
  commandId: uuidSchema,
  terminalId: uuidSchema,
  op: edcBridgeOpSchema,
  trace: ecrTraceSchema,
  /** Set when a deduped op was replayed from the journal: the first command. */
  replayOf: uuidSchema.nullable(),
  completedAt: isoDateTimeSchema,
  answer: edcBridgeAnswerSchema,
});
export type EdcBridgeResult = z.infer<typeof edcBridgeResultSchema>;

export const edcBridgeUplinkSchema = z.discriminatedUnion("type", [
  edcBridgeHelloSchema,
  edcBridgeResultSchema,
]);
export type EdcBridgeUplink = z.infer<typeof edcBridgeUplinkSchema>;

// Downlink (cloud -> bridge)

export const edcBridgeLeaseGrantSchema = z.strictObject({
  /** `payment_edc_terminals.id`. */
  terminalId: uuidSchema,
  leaseId: uuidSchema,
  /** The bridge starts no command on this lease after this instant; one in
   * flight finishes and is journaled. The cloud renews with a new `lease`. */
  expiresAt: isoDateTimeSchema,
  link: edcBridgeLinkSchema,
  framing: edcBridgeFramingSchema,
});
export type EdcBridgeLeaseGrant = z.infer<typeof edcBridgeLeaseGrantSchema>;

/** Full set of leases this device holds now: a terminal missing from
 * `grants` is no longer leased to it. */
export const edcBridgeLeaseSchema = z.strictObject({
  type: z.literal("lease"),
  grants: z.array(edcBridgeLeaseGrantSchema).max(8),
  refused: z
    .array(
      z.strictObject({
        terminalId: uuidSchema,
        reason: z.enum([
          "held_by_other_device",
          "terminal_inactive",
          "connection_unsupported",
        ]),
      }),
    )
    .max(8),
});
export type EdcBridgeLease = z.infer<typeof edcBridgeLeaseSchema>;

export const edcBridgeCommandSchema = z.strictObject({
  type: z.literal("command"),
  commandId: uuidSchema,
  leaseId: uuidSchema,
  terminalId: uuidSchema,
  op: edcBridgeOpSchema,
  /** Agent trace (the ledger's), the dedupe key with `terminalId` + `op`. */
  trace: ecrTraceSchema,
  /** ECR message body built by the cloud bank adapter. */
  frame: frameSchema,
  /** Bridge gives up waiting for the terminal after this and answers
   * `transport_error` `timeout`. */
  timeoutMs: z.number().int().min(1_000).max(300_000),
});
export type EdcBridgeCommand = z.infer<typeof edcBridgeCommandSchema>;

/** The cloud stored the result durably: the bridge may drop it from its
 * journal. Until then the bridge resends it on every reconnect. */
export const edcBridgeAckSchema = z.strictObject({
  type: z.literal("ack"),
  commandId: uuidSchema,
});
export type EdcBridgeAck = z.infer<typeof edcBridgeAckSchema>;

/** Sent right before the cloud closes the socket. */
export const edcBridgeGoodbyeSchema = z.strictObject({
  type: z.literal("goodbye"),
  reason: z.enum([
    "protocol_unsupported",
    "token_revoked",
    "replaced_by_newer_session",
    "server_shutdown",
  ]),
});
export type EdcBridgeGoodbye = z.infer<typeof edcBridgeGoodbyeSchema>;

export const edcBridgeDownlinkSchema = z.discriminatedUnion("type", [
  edcBridgeLeaseSchema,
  edcBridgeCommandSchema,
  edcBridgeAckSchema,
  edcBridgeGoodbyeSchema,
]);
export type EdcBridgeDownlink = z.infer<typeof edcBridgeDownlinkSchema>;

function parseMessage<T>(raw: string, schema: z.ZodType<T>): T {
  if (new TextEncoder().encode(raw).length > EDC_BRIDGE_MAX_MESSAGE_BYTES)
    throw new Error("EDC bridge message too large");
  return schema.parse(JSON.parse(raw));
}

/** Cloud side: one WebSocket text frame from a bridge. Throws on oversize,
 * bad JSON or a message outside the contract (close the socket). */
export function parseEdcBridgeUplink(raw: string): EdcBridgeUplink {
  return parseMessage(raw, edcBridgeUplinkSchema);
}

/** Bridge side (and the Node bridge emulator): one frame from the cloud. */
export function parseEdcBridgeDownlink(raw: string): EdcBridgeDownlink {
  return parseMessage(raw, edcBridgeDownlinkSchema);
}

/** Journal key for a deduped op, `null` for ops that pass through. */
export function edcBridgeDedupeKey(
  command: Pick<EdcBridgeCommand, "terminalId" | "op" | "trace">,
): string | null {
  if (!EDC_BRIDGE_DEDUPED_OPS.includes(command.op)) return null;
  return `${command.terminalId}:${command.op}:${command.trace}`;
}

/** The cloud bridge provider's rule: only a raw `response` goes on to the bank
 * adapter; everything else is thrown as this error, so the agent records
 * `unknown` and inquires (never `failed`). A refusal maps to `protocol`. */
export function edcBridgeTransportErrorOf(
  answer: EdcBridgeAnswer,
): EcrTransportError | null {
  switch (answer.outcome) {
    case "response":
      return null;
    case "transport_error":
      return new EcrTransportError(answer.kind, `EDC bridge: ${answer.kind}`);
    case "refused":
      return new EcrTransportError(
        "protocol",
        `EDC bridge refused: ${answer.reason}`,
      );
  }
}

// Device token (per tablet) and pairing code. See
// docs/design/edc-bridge-protocol.md "Token perangkat".

/** `edcb_<device ULID>_<32 random bytes, base64url, no padding>`. The cloud
 * stores only SHA-256 of the whole token. */
export const edcBridgeDeviceTokenSchema = z
  .string()
  .regex(/^edcb_[0-7][0-9A-HJKMNP-TV-Z]{25}_[A-Za-z0-9_-]{43}$/);

/** One-time code shown in backoffice and typed on the tablet: 8 Crockford
 * base32 characters, any case. */
export const edcBridgePairingCodeSchema = z
  .string()
  .toUpperCase()
  .regex(/^[0-9A-HJKMNP-TV-Z]{8}$/);
