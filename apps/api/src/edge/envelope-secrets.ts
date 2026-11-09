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

/**
 * The envelope without `payload.material`; the same object when there is
 * nothing to strip. Never mutates its input.
 */
export function redactEdgeEnvelopeSecrets(event: EventEnvelope): EventEnvelope {
  if (!hasEdgeEnvelopeSecrets(event)) return event;
  const rest = { ...payloadRecord(event)! };
  delete rest.material;
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
