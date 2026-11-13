// "Edge-apply scope" (bead legend-078n, guard A). Recipe stock deduction runs
// where `order.paid` is emitted: the edge. The cloud worker feeds every outbox
// event to `deliverRecipeDeductionEvent`, so a cloud applier of an edge -> cloud
// POS event that re-emitted `order.paid` (or the other deduction events) onto
// the cloud outbox would deduct stock a second time; `stock.moved` from the
// edge already carries the first deduction.
//
// The edge_to_cloud dispatcher (applier-registry.ts) runs every handler inside
// this AsyncLocalStorage scope and `appendOutbox` refuses those events while
// it is active. Consume guard B lives in recipe-deduction.service.ts.
import { AsyncLocalStorage } from "node:async_hooks";

const edgeApplyScope = new AsyncLocalStorage<true>();

/** Runs `fn` (and everything it awaits) inside the edge-apply scope. */
export function runInEdgeApplyScope<T>(fn: () => Promise<T>): Promise<T> {
  return edgeApplyScope.run(true, fn);
}

/** True while an edge -> cloud handler is applying an event. */
export function inEdgeApplyScope(): boolean {
  return edgeApplyScope.getStore() === true;
}

/** Event names `deliverRecipeDeductionEvent` handles beyond `order` aggregates. */
const EDGE_APPLY_REFUSED_EVENT_NAMES: readonly string[] = [
  "order_issue.recorded",
  "day.closed",
];

/**
 * Whether an event must not be appended to the outbox from inside the scope:
 * every `order` aggregate event plus the other deduction events.
 */
export function isEdgeApplyRefusedEvent(event: {
  aggregateType: string;
  name: string;
}): boolean {
  return (
    event.aggregateType === "order" ||
    EDGE_APPLY_REFUSED_EVENT_NAMES.includes(event.name)
  );
}
