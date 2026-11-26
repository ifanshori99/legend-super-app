// Secret material an edge event may carry (bead legend-kyie). An edge node's
// `staff_pin.set` carries the pin hash material (hash, salt, cost, pepper
// version; never the pin) so the cloud can adopt a pin set on the edge
// (edge/access-applier.ts). It travels edge -> cloud only and is stripped
// before an envelope is stored anywhere a person can read it back: a link
// conflict (`edge_sync_conflicts.event`, returned by the conflict detail API)
// and a parked row (`edge_deferred_events.envelope`).
//
// Kept in its own module (shared imports only) so the link store, the
// deferred inbox and the edge queue can use it without an import cycle.
import { CoreError } from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";

/** Event names whose payload may carry secret `material`. */
const SECRET_MATERIAL_EVENTS = new Set(["staff_pin.set"]);

function payloadRecord(event: EventEnvelope): Record<string, unknown> | null {
  const payload: unknown = event.payload;
  return payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>)
    : null;
}

/** True when `event` carries pin hash material. */
export function hasEdgeEnvelopeSecrets(event: EventEnvelope): boolean {
  if (!SECRET_MATERIAL_EVENTS.has(event.name)) return false;
  const payload = payloadRecord(event);
  return payload !== null && "material" in payload;
}

// 1269 E4: an `edc_transaction.*` event must never carry a card number, but a
// faulty edge could send one. Every place that keeps an edge envelope (parked
// row, link conflict) goes through `redactEdgeEnvelopeSecrets`, so a value
// that looks like one is replaced there and never stored.
const EDC_EVENT_PREFIX = "edc_transaction.";
/** Payload keys holding ids or times: digits split by dashes, never a card. */
const EDC_ID_KEYS = new Set([
  "transactionId",
  "tenantId",
  "outletId",
  "terminalId",
  "completedAt",
]);
const UUID_OR_TIME =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{4}-\d{2}-\d{2}T[0-9:.]+(?:Z|[+-]\d{2}:\d{2}))$/i;
/** 13+ digits, also split by spaces or dashes (a card number). */
const SPLIT_CARD_NUMBER = /\d(?:[\s-]*\d){12,}/;
/** The POS order number may hold 14 digits across a dash: contiguous only. */
const CONTIGUOUS_CARD_NUMBER = /\d{13,19}/;
export const REDACTED_CARD_NUMBER = "[redacted]";

/** Payload keys of an EDC event whose value looks like a card number. */
export function edcCardNumberKeys(event: EventEnvelope): string[] {
  if (!event.name.startsWith(EDC_EVENT_PREFIX)) return [];
  const payload = payloadRecord(event);
  if (payload === null) return [];
  const keys: string[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (value === null || value === undefined || typeof value === "boolean")
      continue;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (EDC_ID_KEYS.has(key) && UUID_OR_TIME.test(text)) continue;
    const pattern =
      key === "reference" ? CONTIGUOUS_CARD_NUMBER : SPLIT_CARD_NUMBER;
    if (pattern.test(text)) keys.push(key);
  }
  return keys;
}

/**
 * The envelope without `payload.material` and without a card-number-like
 * value of an EDC event; the same object when there is nothing to strip.
 * Never mutates its input.
 */
export function redactEdgeEnvelopeSecrets(event: EventEnvelope): EventEnvelope {
  const cardKeys = edcCardNumberKeys(event);
  if (!hasEdgeEnvelopeSecrets(event) && cardKeys.length === 0) return event;
  const rest = { ...payloadRecord(event)! };
  delete rest.material;
  for (const key of cardKeys) rest[key] = REDACTED_CARD_NUMBER;
  return { ...event, payload: rest } as EventEnvelope;
}

/**
 * Runs a write whose parameters may carry pin hash material. A driver error
 * quotes the failed query and its parameters (hash, salt) in its message and
 * cause, which reach API logs and job output, so anything but a domain
 * refusal is rethrown as a generic error with no message detail and no cause
 * (Codex 160 C2). Domain refusals pass unchanged.
 */
export async function withoutSecretErrorDetail<T>(
  message: string,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof CoreError) throw error;
    throw new Error(message);
  }
}
