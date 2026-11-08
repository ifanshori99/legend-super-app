// In-memory ECR terminal simulator (bead legend-apt) for dev, test and demo.
// Deterministic: behavior is scripted per terminal row id with `next()`; the
// default scenario is `approve`. It models what a real terminal remembers per
// (terminal, trace) so status inquiry and cancel give honest answers, and it
// counts calls so tests can prove no second sale was sent (no double charge).
import {
  EcrTransportError,
  ecrInquiryResultSchema,
  ecrResultSchema,
} from "@starter/shared/edc";
import type {
  EcrInquiryResult,
  EcrResult,
  EcrSaleRequest,
  EcrTraceRequest,
  EdcBank,
  EdcMethod,
  EdcProvider,
  EdcProviderCapabilities,
} from "@starter/shared/edc";

export type EcrSimulatorScenario =
  | "approve"
  | "decline"
  | "timeout_after_charge"
  | "timeout_before_charge"
  | "disconnect"
  | "hold"
  | "inquiry_timeout"
  | "amount_mismatch"
  | "ignore_abort"
  | "pan_in_message"
  | "no_amount"
  | "wrong_trace";

export type EcrSimulatorOptions = {
  capabilities?: EdcProviderCapabilities;
  /** How long an `ignore_abort` sale keeps the terminal busy. */
  ignoreAbortDelayMs?: number;
};

export type EcrSimulatorCalls = {
  sale: number;
  cancel: number;
  inquiry: number;
};

type TerminalState = "in_progress" | "approved" | "declined" | "cancelled";

type SimRecord = {
  terminalRowId: string;
  trace: string;
  method: EdcMethod;
  amountIdr: number;
  state: TerminalState;
  result: EcrResult | null;
  /** Wakes the sale call held by the `hold` scenario, if still listening. */
  settle: ((result: EcrResult) => void) | null;
};

const emptyCalls = (): EcrSimulatorCalls => ({
  sale: 0,
  cancel: 0,
  inquiry: 0,
});

export class EcrSimulator implements EdcProvider {
  readonly bank: EdcBank;
  readonly capabilities: EdcProviderCapabilities;
  /** Delay of the `ignore_abort` scenario; tests may change it. */
  ignoreAbortDelayMs: number;
  readonly #records = new Map<string, SimRecord>();
  readonly #saleScripts = new Map<string, EcrSimulatorScenario[]>();
  readonly #inquiryTimeouts = new Map<string, number>();
  readonly #calls = new Map<string, EcrSimulatorCalls>();
  readonly #invoiceCounters = new Map<string, number>();
  readonly #lastTrace = new Map<string, string>();
  #counter = 0;

  constructor(bank: EdcBank, options: EcrSimulatorOptions = {}) {
    this.bank = bank;
    this.capabilities = options.capabilities ?? {
      inquiry: "by_trace",
      cancelInProgress: true,
    };
    this.ignoreAbortDelayMs = options.ignoreAbortDelayMs ?? 200;
  }

  /** Queue the behavior of the next sale on a terminal (FIFO).
   * `inquiry_timeout` is separate: it makes the next inquiry time out,
   * whatever is queued for sales. */
  next(terminalRowId: string, scenario: EcrSimulatorScenario): this {
    if (scenario === "inquiry_timeout") {
      this.#inquiryTimeouts.set(
        terminalRowId,
        (this.#inquiryTimeouts.get(terminalRowId) ?? 0) + 1,
      );
      return this;
    }
    const queue = this.#saleScripts.get(terminalRowId) ?? [];
    queue.push(scenario);
    this.#saleScripts.set(terminalRowId, queue);
    return this;
  }

  /** Finish a `hold` sale as the customer would at the terminal. */
  complete(
    terminalRowId: string,
    trace: string,
    outcome: "approve" | "decline",
  ): void {
    const record = this.#records.get(key(terminalRowId, trace));
    if (!record || record.state !== "in_progress")
      throw new Error(`No in-progress sale for trace ${trace}`);
    this.#finish(
      record,
      outcome === "approve"
        ? this.#approved(
            record.terminalRowId,
            record.trace,
            record.method,
            record.amountIdr,
          )
        : declined(record.trace),
    );
  }

  /** Total calls to this bank's simulator, over all terminals. */
  get calls(): EcrSimulatorCalls {
    const total = emptyCalls();
    for (const calls of this.#calls.values()) {
      total.sale += calls.sale;
      total.cancel += calls.cancel;
      total.inquiry += calls.inquiry;
    }
    return total;
  }

  callsFor(terminalRowId: string): EcrSimulatorCalls {
    return { ...(this.#calls.get(terminalRowId) ?? emptyCalls()) };
  }

  /** Number of approved sales recorded at the terminal (money taken). */
  chargedCount(terminalRowId: string): number {
    let count = 0;
    for (const record of this.#records.values())
      if (record.terminalRowId === terminalRowId && record.state === "approved")
        count += 1;
    return count;
  }

  async sale(request: EcrSaleRequest): Promise<EcrResult> {
    const terminalRowId = request.terminal.id;
    this.#count(terminalRowId, "sale");
    const scenario = this.#saleScripts.get(terminalRowId)?.shift() ?? "approve";
    const { method, trace, amountIdr } = request;
    const record = (state: TerminalState, amount: number = amountIdr) => {
      const created: SimRecord = {
        terminalRowId,
        trace,
        method,
        amountIdr: amount,
        state,
        result: null,
        settle: null,
      };
      this.#records.set(key(terminalRowId, trace), created);
      this.#lastTrace.set(terminalRowId, trace);
      return created;
    };
    const approved = (
      amount: number | null = amountIdr,
      overrides: { message?: string; trace?: string } = {},
    ) => this.#approved(terminalRowId, trace, method, amount, overrides);
    switch (scenario) {
      case "approve": {
        const created = record("in_progress");
        return this.#finish(created, approved());
      }
      case "amount_mismatch": {
        const created = record("in_progress");
        return this.#finish(created, approved(amountIdr + 1));
      }
      case "no_amount":
        return this.#finish(record("in_progress"), approved(null));
      case "wrong_trace":
        return this.#finish(
          record("in_progress"),
          approved(amountIdr, { trace: "WRONG1" }),
        );
      case "pan_in_message":
        return this.#finish(
          record("in_progress"),
          approved(amountIdr, { message: "CARD 4111 1111 1111 1111 OK" }),
        );
      case "decline":
        return this.#finish(record("in_progress"), declined(trace));
      case "timeout_after_charge": {
        this.#finish(record("in_progress"), approved());
        throw new EcrTransportError("timeout", "Answer lost after charge");
      }
      case "disconnect": {
        this.#finish(record("in_progress"), approved());
        throw new EcrTransportError(
          "disconnected",
          "Link dropped after charge",
        );
      }
      case "ignore_abort": {
        // A misbehaving adapter: ignores the signal and settles late, after
        // the agent already gave up. The charge is recorded when it settles.
        const slow = record("in_progress");
        await new Promise<void>((resolve) =>
          setTimeout(resolve, this.ignoreAbortDelayMs),
        );
        if (slow.state !== "in_progress")
          return ecrResultSchema.parse(slow.result);
        return this.#finish(slow, approved());
      }
      case "timeout_before_charge":
        throw new EcrTransportError("timeout", "Sale never reached terminal");
      case "hold": {
        const held = record("in_progress");
        return await new Promise<EcrResult>((resolve, reject) => {
          const onAbort = () => {
            held.settle = null;
            reject(new EcrTransportError("timeout", "Sale wait timed out"));
          };
          if (request.signal.aborted) return onAbort();
          request.signal.addEventListener("abort", onAbort, { once: true });
          held.settle = (result) => {
            request.signal.removeEventListener("abort", onAbort);
            resolve(result);
          };
        });
      }
      case "inquiry_timeout":
        // Routed to the inquiry script by next(); unreachable here.
        throw new Error("inquiry_timeout is not a sale scenario");
    }
  }

  async cancel(request: EcrTraceRequest): Promise<EcrResult> {
    this.#count(request.terminal.id, "cancel");
    const record = this.#records.get(key(request.terminal.id, request.trace));
    if (!record) throw new EcrTransportError("protocol", "trace not found");
    if (record.state === "in_progress") {
      if (!this.capabilities.cancelInProgress)
        throw new EcrTransportError(
          "protocol",
          "Terminal cannot cancel a sale in progress",
        );
      return this.#finish(record, cancelled(record.trace));
    }
    // Already final: report what really happened, never claim a cancel.
    return ecrResultSchema.parse(record.result);
  }

  async inquiry(request: EcrTraceRequest): Promise<EcrInquiryResult> {
    const terminalRowId = request.terminal.id;
    this.#count(terminalRowId, "inquiry");
    const pending = this.#inquiryTimeouts.get(terminalRowId) ?? 0;
    if (pending > 0) {
      this.#inquiryTimeouts.set(terminalRowId, pending - 1);
      throw new EcrTransportError("timeout", "Inquiry timed out");
    }
    const record = this.#records.get(key(terminalRowId, request.trace));
    // `last_only` terminals remember only their last transaction.
    const known =
      this.capabilities.inquiry !== "last_only" ||
      this.#lastTrace.get(terminalRowId) === request.trace;
    if (!record || !known)
      return ecrInquiryResultSchema.parse({ outcome: "not_found" });
    if (record.state === "in_progress")
      return ecrInquiryResultSchema.parse({ outcome: "in_progress" });
    return ecrInquiryResultSchema.parse(record.result);
  }

  #count(terminalRowId: string, kind: keyof EcrSimulatorCalls): void {
    const calls = this.#calls.get(terminalRowId) ?? emptyCalls();
    calls[kind] += 1;
    this.#calls.set(terminalRowId, calls);
  }

  #approved(
    terminalRowId: string,
    trace: string,
    method: EdcMethod,
    amountIdr: number | null,
    overrides: { message?: string; trace?: string } = {},
  ): EcrResult {
    this.#counter += 1;
    const n = String(this.#counter).padStart(6, "0");
    const invoice = (this.#invoiceCounters.get(terminalRowId) ?? 0) + 1;
    this.#invoiceCounters.set(terminalRowId, invoice);
    return ecrResultSchema.parse({
      outcome: "approved",
      approvalCode: `AP${n}`,
      rrn: `RRN${n}`.padEnd(12, "0"),
      cardType: method === "qris" ? "QRIS" : "VISA",
      maskedPan: method === "qris" ? null : "411111******1111",
      responseCode: "00",
      amountIdr,
      invoiceNo: String(invoice).padStart(6, "0"),
      batchNo: "000001",
      trace: overrides.trace ?? trace,
      ...(overrides.message === undefined
        ? {}
        : { message: overrides.message }),
    });
  }

  #finish(record: SimRecord, result: EcrResult): EcrResult {
    record.state = result.outcome as TerminalState;
    record.result = result;
    record.settle?.(result);
    record.settle = null;
    return result;
  }
}

function declined(trace: string): EcrResult {
  return ecrResultSchema.parse({
    outcome: "declined",
    trace,
    responseCode: "51",
    message: "Declined",
  });
}

function cancelled(trace: string): EcrResult {
  return ecrResultSchema.parse({
    outcome: "cancelled",
    trace,
    message: "Cancelled",
  });
}

function key(terminalRowId: string, trace: string): string {
  return `${terminalRowId}:${trace}`;
}
