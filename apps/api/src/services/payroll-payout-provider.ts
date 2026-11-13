// Payout provider boundary (design docs/design/payroll-disbursement.md §2, §7.4;
// bead legend-wnkep.1). The interface is what a bank API adapter must offer;
// the Duitku adapter itself is legend-wnkep.3 and is NOT wired to any batch in
// this slice. `FakePayoutProvider` is an in-memory stand-in for tests: it never
// opens a socket and never calls a real bank.
//
// Money rule the interface encodes: `transfer` is idempotent per
// `idempotencyKey`. A second call with the same key never moves money again
// (R1/R2); a timeout is reported as outcome `unknown`, never as a failure.

export type PayoutInquiryRequest = {
  idempotencyKey: string;
  bankCode: string;
  accountNumber: string;
  amountIdr: number;
};

export type PayoutInquiryResult =
  | {
      ok: true;
      /** Account holder name as the bank reports it. */
      accountName: string;
      /** Provider reference of this inquiry, needed by `transfer`. */
      inquiryRef: string;
      responseCode: string;
    }
  | { ok: false; responseCode: string };

export type PayoutTransferRequest = {
  idempotencyKey: string;
  inquiryRef: string;
  bankCode: string;
  accountNumber: string;
  amountIdr: number;
  /** Short reference the bank echoes back (design 4.3 `cust_ref_number`). */
  custRefNumber: string;
};

export type PayoutOutcome = "succeeded" | "failed" | "unknown";

export type PayoutTransferResult = {
  outcome: PayoutOutcome;
  responseCode: string;
  providerRef: string | null;
};

export type PayoutStatusResult = {
  outcome: PayoutOutcome;
  responseCode: string;
  providerRef: string | null;
};

export type PayoutBalanceResult = { effectiveBalanceIdr: number };

export interface PayoutProvider {
  inquiry(request: PayoutInquiryRequest): Promise<PayoutInquiryResult>;
  transfer(request: PayoutTransferRequest): Promise<PayoutTransferResult>;
  status(idempotencyKey: string): Promise<PayoutStatusResult>;
  balance(): Promise<PayoutBalanceResult>;
}

type FakeAccount = { accountName: string };
type FakeTransfer = PayoutTransferResult & { amountIdr: number };

/** Records one call so a test can count transfers per idempotency key. */
export type FakeProviderCall = {
  method: "inquiry" | "transfer" | "status" | "balance";
  idempotencyKey: string | null;
};

export class FakePayoutProvider implements PayoutProvider {
  readonly calls: FakeProviderCall[] = [];
  private readonly accounts = new Map<string, FakeAccount>();
  private readonly transfers = new Map<string, FakeTransfer>();
  private readonly scripted = new Map<string, PayoutOutcome>();
  private balanceIdr: number;
  private sequence = 0;

  constructor(options: { balanceIdr?: number } = {}) {
    this.balanceIdr = options.balanceIdr ?? 0;
  }

  /** Make an account known to `inquiry`. */
  addAccount(bankCode: string, accountNumber: string, accountName: string) {
    this.accounts.set(`${bankCode}:${accountNumber}`, { accountName });
  }

  setBalance(balanceIdr: number) {
    this.balanceIdr = balanceIdr;
  }

  /** Force the outcome of the next first-time transfer for this key. */
  script(idempotencyKey: string, outcome: PayoutOutcome) {
    this.scripted.set(idempotencyKey, outcome);
  }

  /** Number of transfer calls that reached the provider for this key. */
  transferCalls(idempotencyKey: string): number {
    return this.calls.filter(
      (call) =>
        call.method === "transfer" && call.idempotencyKey === idempotencyKey,
    ).length;
  }

  /** Money that actually moved: succeeded transfers only, once per key. */
  get movedIdr(): number {
    let total = 0;
    for (const transfer of this.transfers.values())
      if (transfer.outcome === "succeeded") total += transfer.amountIdr;
    return total;
  }

  async inquiry(request: PayoutInquiryRequest): Promise<PayoutInquiryResult> {
    this.calls.push({
      method: "inquiry",
      idempotencyKey: request.idempotencyKey,
    });
    const account = this.accounts.get(
      `${request.bankCode}:${request.accountNumber}`,
    );
    if (!account) return { ok: false, responseCode: "-14" };
    this.sequence += 1;
    return {
      ok: true,
      accountName: account.accountName,
      inquiryRef: `fake-inquiry-${this.sequence}`,
      responseCode: "00",
    };
  }

  async transfer(
    request: PayoutTransferRequest,
  ): Promise<PayoutTransferResult> {
    this.calls.push({
      method: "transfer",
      idempotencyKey: request.idempotencyKey,
    });
    const existing = this.transfers.get(request.idempotencyKey);
    if (existing)
      return {
        outcome: existing.outcome,
        responseCode: existing.responseCode,
        providerRef: existing.providerRef,
      };
    const outcome = this.scripted.get(request.idempotencyKey) ?? "succeeded";
    let result: FakeTransfer;
    if (outcome === "succeeded" && request.amountIdr > this.balanceIdr) {
      result = {
        outcome: "failed",
        responseCode: "-510",
        providerRef: null,
        amountIdr: request.amountIdr,
      };
    } else if (outcome === "succeeded") {
      this.balanceIdr -= request.amountIdr;
      this.sequence += 1;
      result = {
        outcome,
        responseCode: "00",
        providerRef: `fake-transfer-${this.sequence}`,
        amountIdr: request.amountIdr,
      };
    } else {
      result = {
        outcome,
        responseCode: outcome === "unknown" ? "-420" : "-1",
        providerRef: null,
        amountIdr: request.amountIdr,
      };
    }
    this.transfers.set(request.idempotencyKey, result);
    return {
      outcome: result.outcome,
      responseCode: result.responseCode,
      providerRef: result.providerRef,
    };
  }

  async status(idempotencyKey: string): Promise<PayoutStatusResult> {
    this.calls.push({ method: "status", idempotencyKey });
    const existing = this.transfers.get(idempotencyKey);
    if (!existing)
      return { outcome: "unknown", responseCode: "-404", providerRef: null };
    return {
      outcome: existing.outcome,
      responseCode: existing.responseCode,
      providerRef: existing.providerRef,
    };
  }

  async balance(): Promise<PayoutBalanceResult> {
    this.calls.push({ method: "balance", idempotencyKey: null });
    return { effectiveBalanceIdr: this.balanceIdr };
  }
}
