// In-memory refund provider for tests (PAY-04). Dedupes on the idempotency key
// like a real provider, so "called twice" and "executed twice" can be asserted
// separately.

import { randomBytes } from "node:crypto";
import type { ScopedTenantContext } from "@starter/shared/core";
import type {
  GatewayRefundRequest,
  GatewayRefundLookup,
  GatewayRefundResult,
  PaymentRefundPort,
} from "../services/payment-refund-gateway.ts";

export type ScriptedRefundOutcome =
  "succeeded" | "pending" | "failed" | "throw";

export class FakeRefundGateway implements PaymentRefundPort {
  readonly provider = "doit";
  /** Every `refund()` call, including deduped replays and throws. */
  readonly calls: GatewayRefundRequest[] = [];
  /** Every `getRefundStatus()` call. */
  readonly statusCalls: {
    context: ScopedTenantContext;
    idempotencyKey: string;
    providerRef: string | null;
    signal: AbortSignal;
  }[] = [];
  /** Outcomes consumed one per NEW (non-deduped) execution; default succeeded. */
  readonly script: ScriptedRefundOutcome[] = [];
  /** Await this inside `refund` (before the outcome) for concurrency tests. */
  gate: Promise<void> | null = null;
  /**
   * Milliseconds `refund` waits (abortable through the request signal) so lease
   * and timeout tests can overlap calls. A timeout throws the signal's reason.
   */
  delayMs = 0;
  /** When true the delay runs AFTER the provider recorded the refund (a timeout then leaves it executed). */
  delayAfterExecution = false;
  /** When set, `getRefundStatus` throws it (provider unreachable). */
  statusError: Error | null = null;
  /** The lookup answer for a key nobody registered (a provider that never saw it). */
  defaultStatus: GatewayRefundLookup = { status: "not_found" };
  /**
   * Runs inside each `getRefundStatus` call, before it answers: lets a test
   * change the refund while the service waits for the provider (stale lookup).
   */
  onStatus: (() => Promise<void>) | null = null;
  /** Decline code returned for a scripted `failed`. */
  failureCode = "declined";
  private executions = 0;
  private sequence = 0;
  private readonly results = new Map<string, GatewayRefundResult>();
  private readonly statusOverrides = new Map<string, GatewayRefundLookup>();

  /** Queue the next outcome(s) for new executions. */
  enqueue(...outcomes: ScriptedRefundOutcome[]): void {
    this.script.push(...outcomes);
  }

  /** Provider-side executions: new idempotency keys that were not a throw. */
  get executionCount(): number {
    return this.executions;
  }

  /** Number of executions for one key (0 or 1 when dedupe works). */
  executionsFor(idempotencyKey: string): number {
    return this.results.has(idempotencyKey) ? 1 : 0;
  }

  storedResult(idempotencyKey: string): GatewayRefundResult | undefined {
    return this.results.get(idempotencyKey);
  }

  /** Make `getRefundStatus` answer this for the key (e.g. pending -> succeeded). */
  setStatus(idempotencyKey: string, result: GatewayRefundLookup): void {
    this.statusOverrides.set(idempotencyKey, result);
  }

  async refund(input: GatewayRefundRequest): Promise<GatewayRefundResult> {
    this.calls.push(input);
    input.signal.throwIfAborted();
    if (this.gate) await abortable(this.gate, input.signal);
    if (!this.delayAfterExecution) await this.wait(input.signal);
    const existing = this.results.get(input.idempotencyKey);
    if (existing) return existing;

    const outcome = this.script.shift() ?? "succeeded";
    // A throw models a timeout before the provider recorded anything.
    if (outcome === "throw") throw new Error("fake refund provider timeout");

    this.executions += 1;
    const providerRef = `FAKE-RF-${randomBytes(6).toString("hex")}-${++this.sequence}`;
    const result: GatewayRefundResult =
      outcome === "failed"
        ? { status: "failed", providerRef, code: this.failureCode }
        : { status: outcome, providerRef };
    this.results.set(input.idempotencyKey, result);
    if (this.delayAfterExecution) await this.wait(input.signal);
    return result;
  }

  private async wait(signal: AbortSignal): Promise<void> {
    if (this.delayMs <= 0) return;
    await abortable(
      new Promise<void>((resolve) => setTimeout(resolve, this.delayMs)),
      signal,
    );
  }

  async getRefundStatus(input: {
    context: ScopedTenantContext;
    idempotencyKey: string;
    providerRef: string | null;
    signal: AbortSignal;
  }): Promise<GatewayRefundLookup> {
    this.statusCalls.push(input);
    input.signal.throwIfAborted();
    if (this.statusError) throw this.statusError;
    if (this.onStatus) await this.onStatus();
    const override = this.statusOverrides.get(input.idempotencyKey);
    if (override) return override;
    const stored = this.results.get(input.idempotencyKey);
    if (stored) return stored;
    return this.defaultStatus;
  }
}

/** Rejects with the signal's reason when it aborts first. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
