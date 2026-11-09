// @starter/shared/accounting — WS-07 accounting contract (bead legend-5ob;
// PRD v1.7 §3.19 Akuntansi & Keuangan, §6 F, ACC-01–ACC-05). Browser-safe:
// the web app uses the same schemas, state machines and statement builders as
// the API. Profit share & dividends (bead legend-cq2; §3.37, §6 I, §4 P,
// SH-03/SH-04) live in profit-share.ts and its events/endpoints.

export * from "./ids.ts";
export * from "./errors.ts";
export * from "./period-key.ts";
export * from "./coa.ts";
export * from "./journal.ts";
export * from "./period.ts";
export * from "./banking.ts";
export * from "./payables.ts";
export * from "./assets.ts";
export * from "./budgets.ts";
export * from "./statements.ts";
export * from "./tax.ts";
export * from "./posting-rules.ts";
export * from "./late-adjustment.ts";
export * from "./profit-share.ts";
export * from "./events.ts";
export * from "./profit-share-events.ts";
export * from "./endpoints.ts";
export * from "./profit-share-endpoints.ts";
export * from "./fixtures.ts";
