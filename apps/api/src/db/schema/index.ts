// Export every table here. Drizzle Kit, the shared pool, and Better Auth use this entrypoint.
export * from "./user";
export * from "./session";
export * from "./account";
export * from "./verification";
export * from "./identity-mfa";
export * from "./notes";

export * from "./core-events";

export * from "./platform-org";
export * from "./menu";
export * from "./platform-domains";
export * from "./platform-packages";
export * from "./platform-payment-gateways";
export * from "./platform-integrations";
export * from "./kirimdev-sender-mappings";
export * from "./platform-themes";
export * from "./platform-support";
export * from "./platform-access";
export * from "./core-audit";
export * from "./core-storage";
export * from "./notification";
export * from "./inventory";
export * from "./floor";
export * from "./payment";
export * from "./accounting";
export * from "./identity";
// WS-05 versioned tax / service-charge rules, calculation options, snapshots.
export * from "./tax";

export * from "./payment-admin";
export * from "./payment-settlement";
export * from "./payment-gateway-webhook";
export * from "./payment-recurring";
// WS-01 generic approval requests (legend-y5q).
export * from "./platform-approval";
// WS-08 promo engine: promotions, vouchers, redemptions (legend-7x4g).
export * from "./crm-promo";
// WS-03 waiter call / bill request (legend-7qg).
export * from "./service-request";
// WS-01 device PIN + supervisor override (legend-dxb).
export * from "./device-pin";
// WS-03 QR order carts/orders (legend-e2x).
export * from "./qr-order";
export * from "./reservation";
// Guest reservation self-service links (legend-o5gr).
export * from "./reservation-public";
export * from "./facility";
export * from "./facility-entitlement";
export * from "./hris";
// WS-10 leave, balances, accrual, holidays, overtime (legend-hggk).
export * from "./hris-leave";
// WS-10 shift scheduling: templates, roster, swaps, compliance (legend-jstx).
export * from "./hris-scheduling";
export * from "./hris-attendance";
export * from "./hris-lifecycle";
// WS-07 AP/AR, fixed assets, budgets (legend-hpgo).
export * from "./accounting-ap-fa";
export * from "./accounting-auto-journal";
export * from "./accounting-journal-requests";
export * from "./accounting-cash-bank";
export * from "./accounting-cash-bank-entries";
export * from "./accounting-tax";
// WS-06 inventory setup writes (legend-gjmk).
export * from "./inventory-setup";
// WS-03 menu import + printable menu (legend-dmi).
export * from "./menu-import";
// WS-06 production, waste, alerts (legend-ugo).
export * from "./inventory-ops";
// WS-01 text overrides + consents (legend-cv3).
export * from "./text-overrides";
export * from "./consents";

export * from "./operations";
// WS-02 edge node registry + cloud <-> edge link (legend-2pi).
export * from "./edge-deferred-event";
export * from "./edge-link-dead-letter";
export * from "./edge-order-ingest";
export * from "./edge-receipt-skip";
export * from "./edge-reconciliation";
export * from "./edge-txn-ledger";
export * from "./edge-node";
export * from "./edge-hris";
export * from "./edge-sync-conflict";
export * from "./edge-print";
export * from "./edge-catalog-gate-state";
export * from "./edge-catalog-sale-overrides";
// WS-04 POS order service (legend-kk7).
export * from "./pos-order";
export * from "./pos-parked-order";
// QRIS hold (legend-yhia9): freezes a bill while its QR is collectible.
export * from "./pos-qris-hold";
export * from "./pos-qris-release-recon";
// VA staff release (legend-5wn1e): audit + provider check queue.
export * from "./payment-va-release";
export * from "./customer-display";
// TEN-09 tenant config templates + import runs (legend-34c).
export * from "./platform-config";
export * from "./pos-receipt";
export * from "./pos-receipt-writeoff";
// WS-04 KDS routing + ticket lifecycle (legend-4d5).
export * from "./kds";
export * from "./expo-pickup";
// WS-04 remake / comp / complaint log (legend-4b5).
export * from "./kds-issues";
export * from "./apology-vouchers";
// WS-04 kitchen capacity rules (legend-w4nq4).
export * from "./kds-capacity";
// WS-04 order pacing: menu loads, channel pauses, pacing state (legend-gyc).
export * from "./kds-pacing";
// WS-06 purchasing: suppliers, price history, PR/PO (legend-9yz).
export * from "./purchasing";
// WS-06 supplier invoice payments with approval (legend-xxqz3).
export * from "./supplier-payments";
// WS-04 cashier shift, cash movements, end-of-day close (legend-6c0).
export * from "./pos-shift";
// Acting cashier token per POS device (legend-aruta).
export * from "./pos-acting-staff";
// WS-10 payroll PPh 21 tenant policy versions (legend-y4wp).
export * from "./payroll-pph21-policy";
// WS-10 payroll core tables (legend-gfcr).
export * from "./payroll";
export * from "./payroll-rapel";
// WS-10 payroll overtime correction ledger (legend-72nod).
export * from "./payroll-overtime-corrections";
// WS-10 payroll disbursement: payout config, batches, items (legend-wnkep.1).
export * from "./payroll-payout";
// WS-10 payslip PIN and its WhatsApp reset challenges (legend-2ap3).
export * from "./payslip-pin";
// EDC agent framework (legend-apt).
export * from "./edc";
// HRIS SOP library, training and announcements (legend-7df1).
export * from "./hris-sop";
export * from "./hris-training";
export * from "./hris-announcement";
// WS-07 shareholder documents (legend-69yq).
export * from "./shareholder-documents";
// WS-07 profit share (legend-2ljb).
export * from "./accounting-profit-share";
// WS-06 stock count / stok opname (legend-j5x).
export * from "./inventory-count";
// WS-02 device registry + training periods (legend-165).
export * from "./device";
// Outlet-device attendance PIN proofs + per-device PIN throttle (legend-u7g9w).
export * from "./staff-pin-proof";
// WS-12 Tanya AI, MCP server and AI governance (legend-zfi4, xq8y, zw9r, xkbt).
export * from "./ai";
// WS-12 AI insights: forecasts, anomaly alerts, daily summaries (legend-hkd4, legend-lely).
export * from "./ai-insights";
// WS-06 inventory -> GL bridge tracking (legend-w1vo).
export * from "./inventory-gl";
// WS-09 edge Wi-Fi agent grant ledger (legend-hsk).
export * from "./edge-wifi";
export * from "./wifi-quota";
// WS-03 open-bill controls per outlet (legend-cqrw).
export * from "./open-bill";
// WS-08 public brand website content (legend-qgr6).
export * from "./website";
// WS-08 delivery channel framework (legend-5bn3).
export * from "./delivery";
// WS-06 recipe / BOM, modifier rules, auto stock deduction (legend-db6).
export * from "./recipe";
// WS-06 goods receipts: partial receiving, QC, photos (legend-o1o4s).
export * from "./inventory-receiving";
// WS-06 supplier returns and simple petty purchases (legend-65mgw).
export * from "./purchase-returns";
export * from "./petty-purchases";
// WS-11 metrics_daily pre-aggregates (kartu A, legend-5wzoc).
export * from "./metrics";
// WS-11 sales targets (legend-ne81z).
export * from "./sales-targets";
// AI-01 menu recommendation rules.
export * from "./menu-recommendation";
// legend-k2l
export * from "./identity-merge";
// legend-6vgv pinned outlet of a staff session.
export * from "./session-active-outlet";
// WS-12 per-tenant AI provider config (legend-dwrr).
export * from "./ai-provider";
// WS-03 table link groups (legend-1nmh).
export * from "./table-links";
// WS-03 per-order bill splits (legend-ms3).
export * from "./bill-splits";
// WS-08 member profiles, consent policy versions, loyalty program, point
// ledger, earn records, visits, anomalies (legend-111j).
export * from "./crm-member";
export * from "./loyalty-claim-pause";
export * from "./crm-ledger";
// WS-08 rewards, redemptions, missions (legend-m4p5).
export * from "./crm-rewards";
// WS-08 feedback, customer segments (legend-ts50).
export * from "./crm-feedback";
export * from "./crm-segments";
// WS-08 loyalty tiers, tier history, referrals (legend-3zd1).
export * from "./crm-tiers";

// legend-dn4 WhatsApp login reply policy, default off (AUTH-03).
export * from "./wa-login-reply";

// legend-2qq HPP read model (menu_costs) and its recompute queue.
export * from "./hpp";
export * from "./pos-deposit-refund";

export * from "./reservation-deposit-remainder";

// WS-12 opt-in ChatGPT device-code connection.
export * from "./ai-chatgpt";

// legend-bod emergency (panic) button tables.
export * from "./panic-alert";
export * from "./sealed-secret-reseal";

// legend-vqicf customer reviews (migration 0455).
export * from "./customer-reviews";
