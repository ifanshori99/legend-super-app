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
// A direction may also get a default aggregate kind and an "unhandled" handler
// (legend-9fhs): events no domain registered are then classified and applied
// by that default instead of stalling the link. Explicit registrations always
// win; the default applies only when the classifier is told the direction.
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
  type EdgeAggregateRef,
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

/** A domain's own "last held sequence" for one aggregate type. */
export type EdgeLastSequenceHook = (
  tx: EdgeTx,
  aggregate: EdgeAggregateRef,
  meta: EdgeApplyMeta,
) => Promise<number | null>;

type DirectionEntry = {
  readonly handlers: Map<string, EdgeEventHandler>;
  /** Per aggregate type; before the fallback's `lastSequence`. */
  readonly lastSequences: Map<string, EdgeLastSequenceHook>;
  readonly dispatcher: EdgeEventApplier;
  /** Applies event types with no explicit handler; before `fallback`. */
  unhandled: EdgeEventHandler | null;
  /** What was installed before the dispatcher; unknown event types go here. */
  fallback: EdgeEventApplier | null;
};

const directions = new Map<SyncDirection, DirectionEntry>();
const aggregateKinds = new Map<string, EdgeEventKind>();
const defaultAggregateKinds = new Map<SyncDirection, EdgeEventKind>();

function entryFor(direction: SyncDirection): DirectionEntry {
  const existing = directions.get(direction);
  if (existing) return existing;
  const handlers = new Map<string, EdgeEventHandler>();
  const lastSequences = new Map<string, EdgeLastSequenceHook>();
  const entry: DirectionEntry = {
    handlers,
    lastSequences,
    unhandled: null,
    fallback: null,
    dispatcher: {
      async apply(tx, event, meta) {
        const handler = handlers.get(event.name);
        if (handler) return handler(tx as EdgeTx, event, meta);
        if (entry.unhandled) return entry.unhandled(tx as EdgeTx, event, meta);
        // Fallback is the refusing default unless another applier was there.
        if (!entry.fallback) throw new EdgeApplierUnavailableError(direction);
        return entry.fallback.apply(tx, event, meta);
      },
      async lastSequence(tx, aggregate, meta) {
        const hook = lastSequences.get(aggregate.aggregateType);
        if (hook) return hook(tx as EdgeTx, aggregate, meta);
        return (
          (await entry.fallback?.lastSequence?.(tx, aggregate, meta)) ?? null
        );
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
export const registeredEdgeEventClassifier: EdgeEventClassifier = (
  event,
  direction,
) =>
  aggregateKinds.get(event.aggregateType) ??
  (direction ? defaultAggregateKinds.get(direction) : undefined) ??
  null;

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

/**
 * `aggregateType` arriving on `direction` asks `hook` for its last held
 * sequence instead of the link's own receipts. Idempotent; a different hook
 * for a taken aggregate type throws (a wiring bug).
 */
export function registerEdgeAggregateLastSequence(
  direction: SyncDirection,
  aggregateType: string,
  hook: EdgeLastSequenceHook,
): void {
  const entry = entryFor(direction);
  const existing = entry.lastSequences.get(aggregateType);
  if (existing && existing !== hook)
    throw new Error(
      `A ${direction} last-sequence hook for ${aggregateType} is already registered`,
    );
  entry.lastSequences.set(aggregateType, hook);
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

/**
 * Classifies every aggregate type with no explicit kind as `kind` when it
 * arrives on `direction`. Other directions are unchanged.
 */
export function setEdgeDefaultAggregateKind(
  direction: SyncDirection,
  kind: EdgeEventKind,
): void {
  const existing = defaultAggregateKinds.get(direction);
  if (existing && existing !== kind)
    throw new Error(
      `A ${direction} default aggregate kind (${existing}) is already set`,
    );
  defaultAggregateKinds.set(direction, kind);
  installClassifier();
}

/**
 * Applies `direction` events no explicit handler claimed, before the old
 * fallback applier.
 */
export function setEdgeUnhandledEventHandler(
  direction: SyncDirection,
  handler: EdgeEventHandler,
): void {
  const entry = entryFor(direction);
  if (entry.unhandled && entry.unhandled !== handler)
    throw new Error(`A ${direction} unhandled handler is already registered`);
  entry.unhandled = handler;
  installDispatcher(direction);
}

/** Clears every registration and restores the ports defaults. */
export function resetEdgeApplierRegistryForTests(): void {
  for (const [direction, entry] of directions)
    if (edgeEventApplier(direction) === entry.dispatcher)
      setEdgeEventApplier(direction, entry.fallback);
  directions.clear();
  aggregateKinds.clear();
  defaultAggregateKinds.clear();
  setEdgeEventClassifier(null);
}
