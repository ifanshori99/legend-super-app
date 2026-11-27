// Pure rules of the charge method picker (legend-t93l8): what the cashier may
// do with a dearer-swap charge, read from the server's charge only. Plain
// TypeScript with no imports: Node tests load it directly.
//
// Money rule: while money may be on its way (a live code, an EDC request
// without an answer, a paid code not yet on the charge) nothing else can be
// collected and the method cannot change. A status this file does not know
// locks the charge instead of freeing it.

export type ChargeMethod = "cash" | "qris" | "edc_card";

export type ChargePhase =
  | "paid"
  | "closed"
  /** Nothing is out: cash and QRIS may start. */
  | "choose"
  /** A gateway code can still be paid. */
  | "gateway_waiting"
  /** The gateway has the money; the charge is not marked paid yet. */
  | "gateway_confirming"
  /** The terminal has not answered, or its answer was lost. */
  | "edc_waiting"
  /** The bank approved the sale: only recording it is left. */
  | "edc_approved"
  /** Possible double money or a sale that does not match: supervisor. */
  | "review";

type PaymentFacts = {
  id: string;
  method: string;
  status: string;
  amountIdr: number;
};

export type EdcSaleFacts = {
  id: string;
  terminalId?: string;
  status: string;
  amountIdr: number;
  method: string | null;
  mode: string | null;
  needsReconciliation: boolean;
};

export type ChargeFacts = {
  status: string;
  amountIdr: number;
  payment: PaymentFacts | null;
  edcSales: readonly EdcSaleFacts[];
};

export type ChargeRequestFacts =
  | { method: "cash"; receivedIdr: number }
  | { method: "qris" }
  | { method: "edc_card"; edcTransactionId: string };

/** Starting a card sale of the charge on one terminal. */
export type EdcStartFacts = { method: "edc_start"; terminalId: string };

/** Poll gap while the charge waits for the gateway or the terminal. */
export const CHARGE_POLL_MS = 3000;

const EDC_REFUSED = ["declined", "cancelled", "failed"];
const CODE_ENDED = ["expired", "failed"];

/** The sale pays this charge exactly: same rules as the collect route. */
export function edcSaleMatches(
  sale: EdcSaleFacts,
  chargeAmountIdr: number,
): boolean {
  return (
    sale.status === "approved" &&
    sale.method === "card" &&
    sale.mode === "ecr" &&
    sale.amountIdr === chargeAmountIdr &&
    !sale.needsReconciliation
  );
}

export function chargePhase(charge: ChargeFacts): ChargePhase {
  if (charge.status === "paid") return "paid";
  if (charge.status !== "open" && charge.status !== "routed_pos")
    return "closed";
  const { payment, edcSales, amountIdr } = charge;

  if (
    edcSales.some(
      (sale) =>
        sale.status !== "approved" && !EDC_REFUSED.includes(sale.status),
    )
  )
    return "edc_waiting";
  if (edcSales.some((sale) => sale.needsReconciliation)) return "review";

  const approved = edcSales.filter((sale) => sale.status === "approved");
  const codeEnded = payment === null || CODE_ENDED.includes(payment.status);
  if (approved.length > 0) {
    const onlySale = approved.length === 1 ? approved[0] : undefined;
    if (!onlySale || !edcSaleMatches(onlySale, amountIdr)) return "review";
    return codeEnded || payment.status === "pending"
      ? "edc_approved"
      : "review";
  }

  if (codeEnded) return "choose";
  if (payment.amountIdr !== amountIdr) return "review";
  if (payment.status === "pending") return "gateway_waiting";
  if (payment.status === "paid") return "gateway_confirming";
  return "review";
}

/** Whether this request may be sent for the charge as the server reads now. */
export function canCollect(
  charge: ChargeFacts,
  request: ChargeRequestFacts,
): boolean {
  const phase = chargePhase(charge);
  if (request.method === "edc_card")
    return (
      phase === "edc_approved" &&
      charge.edcSales.some(
        (sale) =>
          sale.id === request.edcTransactionId &&
          edcSaleMatches(sale, charge.amountIdr),
      )
    );
  if (phase !== "choose") return false;
  return request.method === "qris" || request.receivedIdr === charge.amountIdr;
}

/** How often to re-read the charge; false when nothing is out. */
export function chargePollMs(charge: ChargeFacts | undefined): number | false {
  if (!charge) return false;
  const phase = chargePhase(charge);
  return phase === "gateway_waiting" ||
    phase === "gateway_confirming" ||
    phase === "edc_waiting"
    ? CHARGE_POLL_MS
    : false;
}

/** A collect answer settles the charge only when the server marks it paid. */
export function answerSettles(
  answer: { charge: { status: string } } | undefined,
): boolean {
  return answer?.charge.status === "paid";
}

/**
 * Names one intent of the cashier. Same signature, same idempotency key. A QRIS
 * asked after an ended code is a new intent, so it carries that code's id.
 */
export function requestSignature(
  charge: ChargeFacts,
  request: ChargeRequestFacts | EdcStartFacts,
): string {
  if (request.method === "edc_start") return `edc:${request.terminalId}`;
  if (request.method === "cash") return `cash:${request.receivedIdr}`;
  if (request.method === "edc_card")
    return `edc_card:${request.edcTransactionId}`;
  return `qris:${charge.payment?.id ?? "none"}`;
}

/** How long a collect may hang on this screen before the result is unknown. */
export const COLLECT_DEADLINE_MS = 30_000;

/**
 * A card start answers only when the terminal is done (the agent waits up to
 * 120 s, EDC_SALE_TIMEOUT_MS): the screen waits longer than that.
 */
export const EDC_START_DEADLINE_MS = 150_000;

/** How long the supervisor's settle may hang before it is read again. */
export const RESOLVE_DEADLINE_MS = 30_000;

/** The request did not answer in time: the result is unknown, not a failure. */
export class CollectDeadlineError extends Error {}

/** Settles with `work`, or rejects with `CollectDeadlineError` after `ms`. */
export function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new CollectDeadlineError()), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * The method a stored attempt holds the picker to (legend-f1mmf (a)): a card
 * start and recording its sale are both the card method. Unknown: null, the
 * picker offers nothing.
 */
export function methodOfSignature(signature: string): ChargeMethod | null {
  if (signature.startsWith("cash:")) return "cash";
  if (signature.startsWith("qris:")) return "qris";
  if (signature.startsWith("edc:") || signature.startsWith("edc_card:"))
    return "edc_card";
  return null;
}

/** The terminal a stored card start named, so a retry uses the same one. */
export function terminalOfSignature(signature: string): string | null {
  return signature.startsWith("edc:") ? signature.slice(4) : null;
}

/**
 * The server facts the key store frees an attempt by: the gateway code
 * (legend-f1mmf (c)) and the card sales approved for exactly this charge.
 */
export function codeFacts(charge: ChargeFacts | undefined): {
  paymentId: string | null;
  codeEnded: boolean;
  approvedSales: { id: string; terminalId: string }[];
} {
  const payment = charge?.payment ?? null;
  const amountIdr = charge?.amountIdr ?? 0;
  return {
    paymentId: payment?.id ?? null,
    codeEnded: payment !== null && CODE_ENDED.includes(payment.status),
    approvedSales: (charge?.edcSales ?? []).flatMap((sale) =>
      sale.terminalId !== undefined && edcSaleMatches(sale, amountIdr)
        ? [{ id: sale.id, terminalId: sale.terminalId }]
        : [],
    ),
  };
}

/** How long the read right before sending may take (legend-f1mmf (e)). */
export const PRECHECK_DEADLINE_MS = 8_000;

/** The read before sending did not answer in time: nothing was sent. */
export class PrecheckDeadlineError extends Error {}

/**
 * Runs `read` with a signal that aborts after `ms`; the read then rejects with
 * `PrecheckDeadlineError`, so a hanging read never holds the screen. An
 * `outer` signal (the query's own cancel) aborts the read too.
 */
export function readWithin<T>(
  read: (signal: AbortSignal) => Promise<T>,
  ms: number,
  outer?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  if (outer?.aborted) controller.abort(outer.reason);
  else
    outer?.addEventListener("abort", () => controller.abort(outer.reason), {
      once: true,
    });
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new PrecheckDeadlineError());
    }, ms);
    read(controller.signal).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
