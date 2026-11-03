// Public surface of the inventory contract (beads legend-p38 and legend-ejk):
// schemas + helpers, domain events, endpoint contracts and Cafe Legend
// fixtures. Legend-ejk adds the purchasing sub-contract (suppliers, PR/PO,
// goods receipts, supplier invoices/payments, returns, petty purchases).
// Import from `@starter/shared/inventory`, never a deep path.

export * from "./errors.ts";
export * from "./schemas.ts";
export * from "./events.ts";
export * from "./endpoints.ts";
export * from "./fixtures.ts";
export * from "./purchasing/index.ts";
export * from "./alerts.ts";
