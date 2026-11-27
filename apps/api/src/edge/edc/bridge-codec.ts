// Bank message body for the EDC bridge (B2 legend-wasr7.21). The bridge is a
// pipe: the cloud builds the ECR message per bank and reads the terminal's
// answer here; the tablet only frames it (`framing`) on LAN or USB. One codec
// per bank (B5 adds the real ones from the bank's ECR document).
//
// Rules for codecs:
// - `encode*` is synchronous and pure: the bridge provider writes the command
//   in the same tick (the agent's "sale frame on the wire when `sale` is
//   called" rule).
// - `decode*` throws `EcrTransportError("protocol")` for anything it cannot
//   read. It never invents `approved`: the agent checks trace and amount again.
// - The amount always comes from the agent's request (the server-side bill),
//   never from the bridge.
import {
  EcrTransportError,
  ecrInquiryResultSchema,
  ecrResultSchema,
  type EcrInquiryResult,
  type EcrResult,
  type EcrSaleRequest,
  type EcrTraceRequest,
  type EdcBank,
  type EdcProviderCapabilities,
} from "@starter/shared/edc";
import type { EdcBridgeFraming } from "@starter/shared/edc/bridge";

export type EdcBridgeTraceOp = "cancel" | "inquiry" | "void";

export interface EdcBridgeCodec {
  readonly bank: EdcBank;
  readonly capabilities: EdcProviderCapabilities;
  readonly framing: EdcBridgeFraming;
  /** Base64 message body of a sale. */
  encodeSale(request: EcrSaleRequest): string;
  /** Base64 message body of a cancel, inquiry or void for `trace`. */
  encodeTrace(op: EdcBridgeTraceOp, request: EcrTraceRequest): string;
  /** The terminal's answer to a sale, cancel or void. */
  decodeResult(frame: string): EcrResult;
  /** The terminal's answer to an inquiry. */
  decodeInquiry(frame: string): EcrInquiryResult;
}

function fromBase64Json(frame: string): unknown {
  try {
    return JSON.parse(Buffer.from(frame, "base64").toString("utf8"));
  } catch {
    throw new EcrTransportError("protocol", "EDC bridge: unreadable answer");
  }
}

const toBase64Json = (value: unknown) =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64");

/** Dev/test codec: the message body is base64 JSON, read by the Node bridge
 * emulator (`src/test/helpers/edc-bridge-emulator.ts`, full emulator B3). A
 * terminal never speaks it, and in production it would let a forged tablet
 * answer `approved`, so it throws there. */
export function createSimulatorBridgeCodec(
  bank: EdcBank,
  options: {
    capabilities?: EdcProviderCapabilities;
    production?: boolean;
  } = {},
): EdcBridgeCodec {
  const production =
    options.production ?? process.env.NODE_ENV === "production";
  if (production)
    throw new Error(
      "The EDC bridge simulator codec is not allowed in production",
    );
  return {
    bank,
    capabilities: options.capabilities ?? {
      inquiry: "by_trace",
      cancelInProgress: true,
    },
    framing: "stx_bcdlen_etx_lrc",
    encodeSale: (request) =>
      toBase64Json({
        op: "sale",
        tid: request.terminal.terminalId,
        trace: request.trace,
        amountIdr: request.amountIdr,
        method: request.method,
        reference: request.reference,
      }),
    encodeTrace: (op, request) =>
      toBase64Json({
        op,
        tid: request.terminal.terminalId,
        trace: request.trace,
      }),
    decodeResult(frame) {
      const parsed = ecrResultSchema.safeParse(fromBase64Json(frame));
      if (!parsed.success)
        throw new EcrTransportError(
          "protocol",
          "EDC bridge: unreadable answer",
        );
      return parsed.data;
    },
    decodeInquiry(frame) {
      const parsed = ecrInquiryResultSchema.safeParse(fromBase64Json(frame));
      if (!parsed.success)
        throw new EcrTransportError(
          "protocol",
          "EDC bridge: unreadable answer",
        );
      return parsed.data;
    },
  };
}

/** Codecs every production cloud agent gets: none until B5 adds a bank, so
 * every bridge terminal is refused (`connection_unsupported`) and no ECR sale
 * starts. */
export function createProductionBridgeCodecs(): EdcBridgeCodec[] {
  return [];
}
