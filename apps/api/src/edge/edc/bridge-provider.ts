// EdcProvider over the EDC bridge tablet (B2 legend-wasr7.21). The agent
// (agent.ts, E1-E7) keeps every money rule; this file only moves bytes:
// codec (bank message body) -> transport (WSS command to the tablet that
// holds the terminal's lease) -> raw answer -> codec.
//
// - Nothing on the wire: `sale` rejects with `edcNotSentError()` (the agent
//   records `failed` "never sent" and revokes the dispatch). Only possible
//   before `transport.send` wrote the command.
// - Written to the bridge = dispatched. Every doubt after that (socket gone,
//   no result in time, a refusal, an unreadable answer) is an
//   `EcrTransportError`: the agent records `unknown` and inquires, never
//   `failed` (pengaman 3).
// - `signal` is not a reason to stop waiting: the command keeps its own
//   deadline in the transport, so the agent keeps the terminal locked while
//   the tablet may still be talking to it, and a late answer still settles
//   the open row.
import {
  EcrTransportError,
  type EcrInquiryResult,
  type EcrResult,
  type EcrSaleRequest,
  type EcrTerminal,
  type EcrTraceRequest,
  type EdcBank,
  type EdcProvider,
  type EdcProviderCapabilities,
} from "@starter/shared/edc";
import {
  edcBridgeTransportErrorOf,
  type EdcBridgeAnswer,
  type EdcBridgeOp,
} from "@starter/shared/edc/bridge";
import { edcNotSentError } from "./agent.ts";
import type { EdcBridgeCodec } from "./bridge-codec.ts";

/** The cloud side of the bridge sessions (cloud-runtime.ts). */
export interface EdcBridgeTransport {
  /** True when a live session of this process holds `terminal`'s lease with
   * enough time left for a command. */
  ready(terminal: { tenantId: string; outletId: string; id: string }): boolean;
  /** Writes the command to the tablet in this tick and returns its answer
   * (a `transport_error` answer once the command's deadline passed), or
   * `null` when nothing was written. Never throws. */
  send(command: {
    terminal: EcrTerminal;
    op: EdcBridgeOp;
    trace: string;
    frame: string;
    timeoutMs: number;
  }): Promise<EdcBridgeAnswer> | null;
}

export type EdcBridgeProviderOptions = {
  /** How long the tablet waits for the terminal on a sale (`timeoutMs`). */
  saleTimeoutMs: number;
  /** Same for cancel, inquiry and void. */
  traceTimeoutMs: number;
};

function frameOf(answer: EdcBridgeAnswer): string {
  const error = edcBridgeTransportErrorOf(answer);
  if (error) throw error;
  if (answer.outcome !== "response")
    throw new EcrTransportError("protocol", "EDC bridge: no answer");
  return answer.frame;
}

export class EdcBridgeProvider implements EdcProvider {
  readonly bank: EdcBank;
  readonly capabilities: EdcProviderCapabilities;
  readonly #codec: EdcBridgeCodec;
  readonly #transport: EdcBridgeTransport;
  readonly #options: EdcBridgeProviderOptions;

  constructor(
    codec: EdcBridgeCodec,
    transport: EdcBridgeTransport,
    options: EdcBridgeProviderOptions,
  ) {
    this.bank = codec.bank;
    this.capabilities = codec.capabilities;
    this.#codec = codec;
    this.#transport = transport;
    this.#options = options;
  }

  get framing() {
    return this.#codec.framing;
  }

  ready(terminal: { tenantId: string; outletId: string; id: string }) {
    return this.#transport.ready(terminal);
  }

  sale(request: EcrSaleRequest): Promise<EcrResult> {
    const sent = this.#transport.send({
      terminal: request.terminal,
      op: "sale",
      trace: request.trace,
      frame: this.#codec.encodeSale(request),
      timeoutMs: this.#options.saleTimeoutMs,
    });
    if (sent === null) return Promise.reject(edcNotSentError());
    return sent.then((answer) => this.#codec.decodeResult(frameOf(answer)));
  }

  cancel(request: EcrTraceRequest): Promise<EcrResult> {
    return this.#trace("cancel", request).then((frame) =>
      this.#codec.decodeResult(frame),
    );
  }

  void(request: EcrTraceRequest): Promise<EcrResult> {
    return this.#trace("void", request).then((frame) =>
      this.#codec.decodeResult(frame),
    );
  }

  inquiry(request: EcrTraceRequest): Promise<EcrInquiryResult> {
    return this.#trace("inquiry", request).then((frame) =>
      this.#codec.decodeInquiry(frame),
    );
  }

  /** Not sent is still a transport error here: a cancel or void that may not
   * have happened never claims an outcome. */
  #trace(
    op: "cancel" | "inquiry" | "void",
    request: EcrTraceRequest,
  ): Promise<string> {
    const sent = this.#transport.send({
      terminal: request.terminal,
      op,
      trace: request.trace,
      frame: this.#codec.encodeTrace(op, request),
      timeoutMs: this.#options.traceTimeoutMs,
    });
    if (sent === null)
      return Promise.reject(
        new EcrTransportError("disconnected", "EDC bridge: not connected"),
      );
    return sent.then(frameOf);
  }
}
