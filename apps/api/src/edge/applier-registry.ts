// One registry for the edge link appliers and the receiver classification
// (bead legend-s4r6). `edge/ports.ts` holds ONE applier per direction and ONE
// classifier; domains used to install them directly, which only works for one
// domain. Domains now register per event type / aggregate type here and the
// registry installs a single dispatcher per direction and a single classifier.
//
// Fail closed, exactly like the ports defaults:
// - an event type no domain registered goes to the applier that was installed
//   before the dispatcher (the ports default refuses with
//   EdgeApplierUnavailableError), so the receive transaction rolls back and the
//   sender keeps the batch queued;
// - an aggregate type no domain registered classifies as null
//   (EdgeEventUnclassifiedError, same outcome).
//
// Registration is idempotent: the same handler again is a no-op, a different
// handler for a taken event type throws (a wiring bug). Every register call
// re-installs the dispatcher if something replaced it (tests reset the ports
// with `setEdgeEventApplier(direction, null)`); `resetEdgeApplierRegistryForTests`
// clears the registry itself.
import type { EventEnvelope, SyncDirection } from "@starter/shared/events";
import type { EdgeEventKind } from "../db/schema/edge-node.ts";
import type { EdgeTx } from "../services/edge-queue.service.ts";
import {
  EdgeApplierUnavailableError,
  edgeEventApplier,
  setEdgeEventApplier,
  setEdgeEventClassifier,
  type EdgeApplyMeta,
  type EdgeEventApplier,
  type EdgeEventClassifier,
} from "./ports.ts";

/** Applies one event inside the link's receive transaction. */
export type EdgeEventHandler = (
  tx: EdgeTx,
  event: EventEnvelope,
  meta: EdgeApplyMeta,
) => Promise<void>;

type DirectionEntry = {
  readonly handlers: Map<string, EdgeEventHandler>;
  readonly dispatcher: EdgeEventApplier;
  /** What was installed before the dispatcher; unknown event types go here. */
  fallback: EdgeEventApplier | null;
};

const directions = new Map<SyncDirection, DirectionEntry>();
const aggregateKinds = new Map<string, EdgeEventKind>();

function entryFor(direction: SyncDirection): DirectionEntry {
  const existing = directions.get(direction);
  if (existing) return existing;
  const handlers = new Map<string, EdgeEventHandler>();
  const entry: DirectionEntry = {
    handlers,
    fallback: null,
    dispatcher: {
      async apply(tx, event, meta) {
        const handler = handlers.get(event.name);
        if (handler) return handler(tx as EdgeTx, event, meta);
        // Fallback is the refusing default unless another applier was there.
        if (!entry.fallback) throw new EdgeApplierUnavailableError(direction);
        return entry.fallback.apply(tx, event, meta);
      },
      async lastSequence(tx, aggregate, meta) {
        return (await entry.fallback?.lastSequence?.(tx, aggregate, meta)) ?? null;
      },
    },
  };
  directions.set(direction, entry);
  return entry;
}

function installDispatcher(direction: SyncDirection): void {
  const entry = entryFor(direction);
  const current = edgeEventApplier(direction);
  if (current === entry.dispatcher) return;
  // `current` is the refusing default or an applier installed outside the
  // registry; never the dispatcher itself, so this cannot nest.
  entry.fallback = current;
  setEdgeEventApplier(direction, entry.dispatcher);
}

/** Receiver-side classification from the registered aggregate types only. */
export const registeredEdgeEventClassifier: EdgeEventClassifier = (event) =>
  aggregateKinds.get(event.aggregateType) ?? null;

function installClassifier(): void {
  setEdgeEventClassifier(registeredEdgeEventClassifier);
}

/** Routes `eventType` arriving on `direction` to `handler`. */
export function registerEdgeEventHandler(
  direction: SyncDirection,
  eventType: string,
  handler: EdgeEventHandler,
): void {
  const entry = entryFor(direction);
  const existing = entry.handlers.get(eventType);
  if (existing && existing !== handler)
    throw new Error(
      `A ${direction} handler for ${eventType} is already registered`,
    );
  entry.handlers.set(eventType, handler);
  installDispatcher(direction);
}

/** Classifies events of `aggregateType` as `kind` on this receiver. */
export function registerEdgeAggregateKind(
  aggregateType: string,
  kind: EdgeEventKind,
): void {
  const existing = aggregateKinds.get(aggregateType);
  if (existing && existing !== kind)
    throw new Error(
      `Aggregate type ${aggregateType} is already classified as ${existing}`,
    );
  aggregateKinds.set(aggregateType, kind);
  installClassifier();
}

/** Clears every registration and restores the ports defaults. */
export function resetEdgeApplierRegistryForTests(): void {
  for (const [direction, entry] of directions)
    if (edgeEventApplier(direction) === entry.dispatcher)
      setEdgeEventApplier(direction, entry.fallback);
  directions.clear();
  aggregateKinds.clear();
  setEdgeEventClassifier(null);
}
