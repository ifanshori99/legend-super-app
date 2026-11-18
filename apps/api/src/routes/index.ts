import { Router } from "express";
import { noStore } from "../middleware/no-store";
import { accessRouter } from "./access.routes";
import { serviceRequestRouter } from "./service-request.routes";
import { posOverrideRouter, staffPinRouter } from "./device-pin.routes";
import { posActingStaffRouter } from "./pos-acting-staff.routes";
import { qrOrderRouter } from "./qr-order.routes";
import { orderRecoveryRouter } from "./order-recovery.routes.ts";
import { apologyVoucherRouter } from "./apology-voucher.routes.ts";
import { healthRouter } from "./health.routes";
import { inventoryRouter } from "./inventory.routes";
import { createInventoryCountRouter } from "./inventory-count.routes.ts";
import { createInventoryOpsRouter } from "./inventory-ops.routes.ts";
import { createPurchasingSupplierRouter } from "./purchasing-supplier.routes.ts";
import { createPurchasingOrderRouter } from "./purchasing-order.routes.ts";
import { createInventoryReceivingRouter } from "./inventory-receiving.routes.ts";
import { createPurchaseReturnRouter } from "./purchase-return.routes.ts";
import { createPurchasingInvoiceRouter } from "./purchasing-invoice.routes.ts";
import { createPurchasingReceiptJournalizeRouter } from "./purchasing-receipt-journalize.routes.ts";
import { createPettyPurchaseRouter } from "./petty-purchase.routes.ts";
import {
  createPurchasingSendRouter,
  publicPurchaseOrderRouter,
} from "./purchasing-send.routes.ts";
import { createInventorySetupRouter } from "./inventory-setup.routes";
import { createInventoryHppRouter } from "./inventory-hpp.routes.ts";
import { createRecipeRouter } from "./recipe.routes.ts";
import { createAccountingApFaRouter } from "./accounting-ap-fa.routes";
import { createAccountingFinancePolicyRouter } from "./accounting-finance-policy.routes";
import { createAccountingBankAccountsRouter } from "./accounting-bank-accounts.routes";
import { createAccountingBankStatementsRouter } from "./accounting-bank-statements.routes";
import { createAccountingBankLinesRouter } from "./accounting-bank-lines.routes";
import { createAccountingCashDepositsRouter } from "./accounting-cash-deposits.routes";
import { createAccountingFinanceExceptionsRouter } from "./accounting-finance-exceptions.routes";
import { createAccountingCashBankEntriesRouter } from "./accounting-cash-bank-entries.routes";
import { createAccountingPettyCashRouter } from "./accounting-petty-cash.routes";
import { createAccountingBankReconCasesRouter } from "./accounting-bank-recon-cases.routes";
import { createAccountingLegalEntitiesRouter } from "./accounting-legal-entities.routes";
import { meRouter } from "./me.routes";
import { orgRouter } from "./org.routes";
import {
  orgIntegrationsRouter,
  platformUsageRouter,
} from "./platform-integrations.routes";
import { orgThemesRouter } from "./org-themes.routes";
import { orgConfigRouter } from "./org-config.routes";
import { opsOutboxRouter } from "./ops-outbox.routes";
import { consentRouter, textOverridesRouter } from "./text-consent.routes";
import { platformBrandRouter } from "./platform-brand.routes";
import { platformTextOverridesRouter } from "./platform-text-overrides.routes";
import { internalRouter } from "./platform-tls.routes";
import { platformRouter } from "./platform.routes";
import { platformTenantDirectoryRouter } from "./platform-tenant-directory.routes";
import { platformTenantResourcesRouter } from "./platform-tenant-resources.routes";
import { platformConfigRouter } from "./platform-config.routes";
import { platformPaymentGatewaysRouter } from "./platform-payment-gateways.routes";
import { platformKirimdevSendersRouter } from "./platform-kirimdev-senders.routes";
import { createNotificationRouter } from "./notification.routes";
import { createNotificationPushPorts } from "../services/notification-push-ports";
import { taxRouter } from "./tax.routes";
import { floorRouter, outletFloorRouter, tablesRouter } from "./floor.routes";
import { websiteAdminRouter } from "./website-admin.routes";
import { openBillRouter } from "./open-bill.routes";
import { salesTargetsRouter } from "./sales-targets.routes";
import { emergencyCloudRouter } from "./emergency-cloud.routes";
import { emergencySessionRouter } from "./emergency.routes";
import { emergencyPressRouter } from "./emergency-press.routes";
import { menuRecommendationRouter } from "./menu-recommendation.routes.ts";
import { tableLinksRouter } from "./table-links.routes";
import { tableSessionsRouter } from "./table-sessions.routes";
import { paymentRouter } from "./payment.routes";
import { paymentAdminRouter } from "./payment-admin.routes.ts";
import { paymentRecurringRouter } from "./payment-recurring.routes.ts";
import { accountingJournalRouter } from "./accounting-journal.routes";
import { accountingRouter } from "./accounting.routes";
import { createProfitShareRegistryRouter } from "./profit-share-registry.routes";
import { createProfitShareDistributionRouter } from "./profit-share-distribution.routes";
import { createProfitShareRecipientReconcileRouter } from "./profit-share-recipient-reconcile.routes";
import { approvalRouter } from "./platform-approval.routes";
import { promotionsRouter, vouchersRouter } from "./crm-promo.routes";
import { reservationRouter } from "./reservation.routes";
import { reservationPolicyRouter } from "./reservation-policy.routes";
import { reservationPublicRouter } from "./reservation-public.routes";
import { facilityCustomerRouter } from "./facility-customer.routes";
import { facilityEntitlementRouter } from "./facility-entitlement.routes";
import { facilityBreakfastRouter } from "./facility-breakfast.routes.ts";
import { facilityRouter } from "./facility.routes";
import { wifiConfigRouter } from "./wifi.routes";
import { wifiGuestRouter } from "./wifi-guest.routes.ts";
import { payrollLoanPolicyRouter } from "./payroll-loan-policy.routes";
import { payrollPph21PolicyRouter } from "./payroll-pph21-policy.routes";
import { payrollStatutoryRouter } from "./payroll-statutory.routes";
import {
  payrollComponentsRouter,
  payrollEmployeeComponentsRouter,
} from "./payroll-components.routes";
import {
  payrollLoansRouter,
  payrollMyLoansRouter,
} from "./payroll-loans.routes";
import { payrollPolicyRouter, payrollThrRouter } from "./payroll-policy.routes";
import { payrollServiceChargeRouter } from "./payroll-service-charge.routes";
import { payrollRapelRouter } from "./payroll-rapel.routes";
import { payrollPayoutRouter } from "./payroll-payout.routes";
import { payrollPayoutReturnRouter } from "./payroll-payout-return.routes";
import { payrollPayoutOverpaidRouter } from "./payroll-payout-overpaid.routes";
import { payrollPayoutCorrectionRouter } from "./payroll-payout-correction.routes";
import { payrollPayoutProofClosureRouter } from "./payroll-payout-proof-closure.routes";
import { payrollPayoutDisputeRouter } from "./payroll-payout-dispute.routes";
import { payrollPayoutReconClearanceRouter } from "./payroll-payout-recon-clearance.routes";
import { payrollRunsRouter } from "./payroll-runs.routes";
import {
  payrollMyReimbursementsRouter,
  payrollReimbursementCategoriesRouter,
  payrollReimbursementsRouter,
} from "./payroll-reimbursements.routes";
import { hrisAnnouncementRouter } from "./hris-announcement.routes";
import { hrisSopRouter } from "./hris-sop.routes";
import { hrisTrainingRouter } from "./hris-training.routes";
import { aiActionsRouter } from "./ai-actions.routes";
import { aiChatRouter } from "./ai-chat.routes";
import { aiGovernanceRouter } from "./ai-governance.routes";
import { aiGuidelinesRouter } from "./ai-guidelines.routes";
import { aiMcpAdminRouter } from "./ai-mcp-admin.routes";
import { aiProviderRouter } from "./ai-provider.routes";
import { aiChatgptRouter } from "./ai-chatgpt.routes";
import { aiInsightsRouter } from "./ai-insights.routes";
import { hrisSchedulingRouter } from "./hris-scheduling.routes";
import { hrisChecklistRouter } from "./hris-checklist.routes";
import { hrisOffboardingRouter } from "./hris-offboarding.routes";
import { hrisWorkCertificateRouter } from "./hris-work-certificate.routes";
import { hrisKpiRouter } from "./hris-kpi.routes";
import { hrisAttendanceCorrectionRouter } from "./hris-attendance-correction.routes";
import { operationsRouter } from "./operations.routes";
import { operationsEquipmentRouter } from "./operations-equipment.routes";
import { edgeRouter } from "./edge.routes.ts";
import { edgePrintRouter } from "./edge-print.routes.ts";
import { edgeNodesRouter } from "./edge-nodes.routes.ts";
import { expoRouter } from "./expo.routes.ts";
import { pickupRouter } from "./pickup.routes.ts";
import { servingTimeRouter } from "./serving-time.routes.ts";
import { kdsRouter } from "./kds.routes.ts";
import { orderIssuesRouter } from "./order-issues.routes.ts";
import { orderRecoveryChargeRouter } from "./order-recovery-charge.routes.ts";
import { customerDisplayRouter } from "./customer-display.routes.ts";
import { posOrderRouter } from "./pos-order.routes.ts";
import { posParkedOrderRouter } from "./pos-parked-order.routes.ts";
import { posReceiptRouter, publicReceiptRouter } from "./pos-receipt.routes.ts";
import { posReceiptWriteoffRouter } from "./pos-receipt-writeoff.routes.ts";
import { posShiftRouter } from "./pos-shift.routes.ts";
import { staffPinSyncRouter } from "./staff-pin-sync.routes.ts";
import { deviceRouter } from "./device.routes.ts";
import { printerRouter } from "./printer.routes.ts";
import { edgeDeviceRouter } from "./edge-device.routes.ts";
import { edgeWifiRouter } from "./edge-wifi.routes.ts";
import { deviceRecordSyncRouter } from "./edge-device-sync.routes.ts";
import { catalogRecordSyncRouter } from "./edge-catalog-sync.routes.ts";
import { edgePeopleSnapshotRouter } from "./edge-people-snapshot.routes.ts";
import { edgeBootstrapRouter } from "./edge-bootstrap.routes.ts";
import { edgeSyncConflictsRouter } from "./edge-sync-conflicts.routes.ts";
import { deliveryChannelsRouter } from "./delivery-channels.routes.ts";
import { deliveryOrdersRouter } from "./delivery-orders.routes.ts";
import { deliveryReconciliationRouter } from "./delivery-reconciliation.routes.ts";
// legend-111j
import { memberRouter } from "./member.routes.ts";
import { loyaltyProgramRouter } from "./loyalty-program.routes.ts";
import { customersRouter } from "./customers.routes.ts"; // legend-ts50
import { identityWaUnlinkRouter } from "./identity-wa-unlink.routes.ts"; // legend-7wzy
import { identityPushDevicesRouter } from "./identity-push-devices.routes.ts"; // legend-gchkf
import { segmentsRouter } from "./segments.routes.ts"; // legend-ts50
import { feedbackRouter } from "./feedback.routes.ts"; // legend-ts50
import { customerReviewRouter } from "./customer-review.routes.ts"; // legend-vqicf
import { memberFeedbackRouter } from "./member-feedback.routes.ts"; // legend-ts50
import { memberRewardsRouter } from "./member-rewards.routes.ts"; // legend-m4p5
import { loyaltyRewardsRouter } from "./loyalty-rewards.routes.ts"; // legend-m4p5
import { loyaltyTiersRouter } from "./loyalty-tiers.routes.ts"; // legend-3zd1
import { posOrderCustomerRouter } from "./pos-order-customer.routes.ts";
import { posPointsRouter } from "./pos-points.routes.ts";
import { facilityPosTicketRouter } from "./facility-pos-ticket.routes.ts";
import { installDeviceRegistryPorts } from "../services/device-ports.ts";

// Mounted at /api. Add a router per resource and register it here.
//
// Two WS-01 identity routers are mounted in app.ts instead, because their paths
// decide the order of middleware rather than the path prefix:
// - routes/identity-auth.routes.ts is under /api/auth/* and must run BEFORE
//   Better Auth's catch-all (it is Legend's, not Better Auth's);
// - routes/identity-wa-webhook.routes.ts is a server-to-server webhook that
//   reads the raw bytes for the AUTH-02 signature and must run before any body
//   parser or tenant middleware.
export const apiRouter = Router();

apiRouter.use(noStore);
apiRouter.use("/health", healthRouter);
// Panel Platform (Super Admin) and tenant organisation settings (WS-01).
apiRouter.use("/platform", platformUsageRouter);
apiRouter.use("/platform/payment-gateways", platformPaymentGatewaysRouter);
apiRouter.use("/platform", platformRouter);
apiRouter.use("/platform", platformTenantDirectoryRouter);
apiRouter.use("/platform", platformTenantResourcesRouter);
apiRouter.use("/platform", platformConfigRouter);
apiRouter.use("/platform", platformKirimdevSendersRouter);
apiRouter.use("/org", orgIntegrationsRouter);
apiRouter.use("/org", orgRouter);
apiRouter.use("/org", orgThemesRouter);
apiRouter.use("/org", orgConfigRouter);
apiRouter.use("/org/text-overrides", textOverridesRouter);
apiRouter.use("/consents", consentRouter);
// Operator outbox replay (legend-m119).
apiRouter.use("/ops", opsOutboxRouter);
// Public terms.* text overrides for SSR, same host resolution (legend-it6p4).
// Before the brand router: its host guard would answer first otherwise.
apiRouter.use("/tenant/text-overrides", platformTextOverridesRouter);
// Whitelabel brand context for SSR (TEN-08), resolved from the request host.
apiRouter.use("/tenant", platformBrandRouter);
// Reverse-proxy endpoints (Caddy on-demand TLS ask). Not for browsers.
apiRouter.use("/internal", internalRouter);
// RBAC administration (WS-01) and the caller's effective access (legend-t4y7).
apiRouter.use("/access", accessRouter);
apiRouter.use("/me", meRouter);
// Generic approval inbox for every module (WS-01 F7, legend-y5q).
apiRouter.use("/approvals", approvalRouter);
// Menu back office (WS-03, legend-lmk). Mounted by createStorageApiRouter
// (routes/storage-api.routes.ts, legend-7nv1) ahead of this router, because the
// photo upload needs the object storage runtime: without one it answers 503;
// every other menu route is live.
// Menu CSV/XLSX import + printable menu (WS-03, legend-dmi): mounted by
// createStorageApiRouter with the storage runtime (legend-0w2wy).
// AI-01 menu recommendations and per-outlet rules (legend-ptd): per-route
// guards; the menu router before it passes unmatched /menu paths through.
apiRouter.use("/menu", menuRecommendationRouter);
// Inventory & warehouse (WS-06, bead legend-98t).
apiRouter.use("/inventory", inventoryRouter);
// Inventory setup writes + settings (WS-06, legend-gjmk).
apiRouter.use("/inventory", createInventorySetupRouter());
// Production, waste, transfers, expiry/par alerts, suggestions (WS-06, legend-ugo).
apiRouter.use("/inventory", createInventoryOpsRouter());
// Suppliers, contacts, price catalog (WS-06 purchasing, legend-9yz).
apiRouter.use("/inventory", createPurchasingSupplierRouter());
// Purchase requests + purchase orders with approval (PRD §3.18, legend-9yz).
apiRouter.use("/inventory", createPurchasingOrderRouter());
// Goods receipt: partial receiving, QC, photos (PRD §3.18 INV-05, legend-o1o4s).
apiRouter.use("/inventory", createInventoryReceivingRouter());
// Supplier returns and simple petty purchases (legend-65mgw).
apiRouter.use("/inventory", createPurchaseReturnRouter());
apiRouter.use("/inventory", createPettyPurchaseRouter());
// Supplier invoices, three-way match, hold/release, tolerance policy (ws/purchasing-apar).
apiRouter.use("/inventory", createPurchasingInvoiceRouter());
// Finance "journalize receipt": opening journal for a receipt without one (legend-7e0q4).
apiRouter.use("/inventory", createPurchasingReceiptJournalizeRouter());
// Send PO by email or share link (PRD §3.18 "Kirim PO", legend-9yz).
apiRouter.use("/inventory", createPurchasingSendRouter());
// Stock opname / stok opname with blind count and approval (legend-j5x, INV-03).
apiRouter.use("/inventory", createInventoryCountRouter());
// Recipes / BOM, modifier rules, auto stock deduction, duty meals (WS-06, legend-db6).
apiRouter.use("/inventory", createRecipeRouter());
// HPP reports: menu costs, recipe coverage, food cost, menu engineering (legend-2qq).
apiRouter.use("/inventory", createInventoryHppRouter());
// Customer payment links and intents (WS-05, PRD §3.13). Public by token.
apiRouter.use("/payments/admin", paymentAdminRouter);
// DOIT recurring billing back office (legend-6c6); before the public /payments router.
apiRouter.use("/payments/recurring", paymentRecurringRouter);
apiRouter.use("/payments", paymentRouter);
// Only web push registration is wired (active staff assignment); every other
// notification operation stays denied until its resolver exists.
apiRouter.use(
  "/notifications",
  createNotificationRouter(createNotificationPushPorts()),
);
// WS-03 floor: zones/tables editor, live board, signed table QR and the staff
// table-session lifecycle; /qr is the public guest scan (legend-irw).
apiRouter.use("/floor", floorRouter);
// WS-04 POS order service (legend-kk7): contract paths
// /api/outlets/:outletId/pos/*; the router merges params. Before the floor's
// /outlets router so POS requests do not run its middleware too.
// legend-yhia9 D-08 customer display: device-token routes, before the order
// router whose requireAuth would refuse a display without a session.
apiRouter.use("/outlets/:outletId/pos", customerDisplayRouter);
apiRouter.use("/outlets/:outletId/pos", posOrderRouter);
apiRouter.use("/outlets/:outletId/pos", posParkedOrderRouter);
// WS-04 receipts, kuitansi and invoices (legend-93a): same prefix, own routes;
// the order router passes unmatched paths through.
apiRouter.use("/outlets/:outletId/pos", posReceiptRouter);
apiRouter.use("/outlets/:outletId/pos", posReceiptWriteoffRouter);
// WS-04 KDS (legend-4d5): /api/outlets/:outletId/kitchen/* tickets and feeds.
apiRouter.use("/outlets/:outletId/kitchen", kdsRouter);
// WS-04 pickup display feed and call/picked-up (legend-mzhr0): per-route auth,
// the prefix is shared with other outlet routers.
apiRouter.use("/outlets/:outletId", pickupRouter);
// WS-04 serving-time estimate (legend-gyc): per-route auth, shared prefix.
apiRouter.use("/outlets/:outletId", servingTimeRouter);
// WS-04 expo board, runner assignment and delivered (legend-him8j), same prefix.
apiRouter.use("/outlets/:outletId", expoRouter);
// WS-04 remake / comp log (legend-4b5): /api/outlets/:outletId/orders/:orderId/issues
// and /api/outlets/:outletId/order-issues; per-route middleware (shared prefix).
apiRouter.use("/outlets/:outletId", orderIssuesRouter);
// WS-04 cashier shift, cash movements and end of day (legend-6c0), same prefix.
apiRouter.use("/outlets/:outletId/pos", posShiftRouter);
// WS-08 delivery channels, orders and commission reconciliation (legend-5bn3).
apiRouter.use("/outlets/:outletId/delivery-channels", deliveryChannelsRouter);
apiRouter.use("/outlets/:outletId/delivery-orders", deliveryOrdersRouter);
apiRouter.use(
  "/outlets/:outletId/delivery-reconciliation",
  deliveryReconciliationRouter,
);
// WS-11 sales targets per outlet and day (legend-ne81z).
apiRouter.use("/outlets/:outletId/sales-targets", salesTargetsRouter);
// Emergency button manager routes (legend-bod.5): list, cloud acknowledge, resolve.
apiRouter.use("/outlets/:outletId/emergency-alerts", emergencyCloudRouter);
// Emergency receiver sessions: registered device + staff PIN, no Better Auth.
apiRouter.use("/emergency/sessions", emergencySessionRouter);
// Emergency button press, acknowledge and POS fallback (legend-bod.4).
apiRouter.use("/emergency", emergencyPressRouter);
apiRouter.use("/outlets", outletFloorRouter);
// Before /table-sessions: guest + staff service-request paths span prefixes.
apiRouter.use(serviceRequestRouter);
// Open-bill convert, approvers and outlet policy (legend-8cm4, legend-2zb5).
apiRouter.use(openBillRouter);
apiRouter.use("/tables", tablesRouter);
apiRouter.use("/table-links", tableLinksRouter);
// WS-04 failed paid item recovery (legend-4qu): full contract paths across
// /order-items, /order-issues and /table-sessions, per-route guards. Before
// /table-sessions so the guest order-issues list is not shadowed.
apiRouter.use(orderRecoveryRouter);
// legend-i83ls: staff waive / expire of a dearer-swap charge.
apiRouter.use(orderRecoveryChargeRouter);
apiRouter.use("/apology-vouchers", apologyVoucherRouter);
apiRouter.use("/table-sessions", tableSessionsRouter);
apiRouter.use("/table-sessions", qrOrderRouter);
// /qr (scan + guest menu) needs the storage resolvers for photo and logo
// URLs, so createApp mounts it (routes/storage-api.routes.ts) ahead of this.
// Acting cashier token (legend-aruta), before staffPinRouter; its routes carry
// their own guards so /staff-pins/verify stays sessionless.
apiRouter.use("/staff-pins", posActingStaffRouter);
apiRouter.use("/staff-pins", staffPinRouter);
apiRouter.use("/pos-overrides", posOverrideRouter);
// Public brand website (WS-08 F21): the online menu page, tenant and brand from
// the request host (TEN-08). Q23 hides items without a photo.
// /public/site is mounted by routes/storage-api.routes.ts (menu photo URLs).
// Public e-receipt page and PDF by link token, tenant from the host (legend-93a).
apiRouter.use("/public/receipts", publicReceiptRouter);
// Staff editor of the brand website content (WS-08, legend-qgr6).
apiRouter.use("/website", websiteAdminRouter);
// Supplier-facing PO PDF by share token (legend-9yz): hashed token, rate
// limited, token redacted from request logs.
apiRouter.use("/public/purchase-orders", publicPurchaseOrderRouter);
// WS-05 versioned tax / service-charge configuration, preview and PBJT recap.
apiRouter.use("/tax", taxRouter);
// Shareholder documents (WS-07, legend-69yq): mounted by createStorageApiRouter
// (routes/storage-api.routes.ts, legend-68if) ahead of this router, because
// upload and signed URL need the storage runtime and the real membership.
// Profit share (WS-07, legend-2ljb): entities, shareholders, share versions
// (SH-03), distribution runs, adjustments and statements (SH-04).
apiRouter.use("/accounting", createProfitShareRegistryRouter());
apiRouter.use("/accounting", createProfitShareDistributionRouter());
apiRouter.use("/tenant", createProfitShareRecipientReconcileRouter());
// Accounting core (WS-07): CoA, mappings, journals, fiscal periods.
apiRouter.use("/accounting", accountingRouter);
// Manual + recurring journals with approval (WS-07, legend-vmyg).
apiRouter.use("/accounting", accountingJournalRouter);
// AP/AR aging, fixed assets, depreciation, budgets (WS-07, legend-hpgo).
apiRouter.use("/accounting", createAccountingApFaRouter());
// Per-tenant finance policy: bank matching tolerance, ACC-05 day limit (legend-pxcs).
apiRouter.use("/accounting", createAccountingFinancePolicyRouter());
// WS-07 cash & bank (legend-fnxl).
apiRouter.use("/accounting", createAccountingBankAccountsRouter());
apiRouter.use("/accounting", createAccountingBankStatementsRouter());
apiRouter.use("/accounting", createAccountingBankLinesRouter());
apiRouter.use("/accounting", createAccountingCashDepositsRouter());
// Read-only finance exceptions list (legend-4oclu).
apiRouter.use("/accounting", createAccountingFinanceExceptionsRouter());
// Cash in/out, bank transfers and the petty cash fund (legend-4961).
apiRouter.use("/accounting", createAccountingCashBankEntriesRouter());
apiRouter.use("/accounting", createAccountingPettyCashRouter());
apiRouter.use("/accounting", createAccountingBankReconCasesRouter());
// Legal-entity picker for finance screens, accounting.journal.view (legend-bddb).
apiRouter.use("/accounting", createAccountingLegalEntitiesRouter());
// WS-08 promo engine shared by POS/QR/website (legend-7x4g).
apiRouter.use("/promotions", promotionsRouter);
// WS-08 member PWA API, loyalty program, POS order customer attach (legend-111j).
apiRouter.use("/member", memberRouter);
// legend-m4p5: rewards, redemptions, missions, member vouchers; staff rewards/missions/fulfil.
apiRouter.use("/member", memberRewardsRouter);
apiRouter.use("/member", memberFeedbackRouter); // legend-ts50
// The next two keep full paths inside the router and guard each route.
apiRouter.use(loyaltyProgramRouter);
apiRouter.use(customersRouter); // legend-ts50
apiRouter.use(identityWaUnlinkRouter); // legend-7wzy
apiRouter.use("/identity/push-devices", identityPushDevicesRouter); // legend-gchkf
apiRouter.use(segmentsRouter); // legend-ts50
apiRouter.use(feedbackRouter); // legend-ts50
apiRouter.use("/reviews", customerReviewRouter); // legend-vqicf
apiRouter.use(loyaltyRewardsRouter); // legend-m4p5
apiRouter.use(loyaltyTiersRouter); // legend-3zd1
apiRouter.use(posOrderCustomerRouter);
apiRouter.use(posPointsRouter); // 936 legend-hpgyw
// 936 legend-hpgyw part D: ticket sale at the POS (absolute paths). Before facilityRouter.
apiRouter.use(facilityPosTicketRouter);
apiRouter.use("/vouchers", vouchersRouter);
// WS-08 reservations (legend-t8bz): full paths inside the router.
apiRouter.use(reservationRouter);
// Reservation DP/cancellation policy versions (legend-u0q8): full paths inside.
apiRouter.use(reservationPolicyRouter);
// Guest self-service via signed link (legend-o5gr): full paths inside.
apiRouter.use(reservationPublicRouter);
// WS-09 guest-facing facility reads, public (legend-zjfi). Before facilityRouter, which requires a session.
apiRouter.use("/facility", facilityCustomerRouter);
// WS-09 breakfast order from the ticket, paid before the kitchen (oa0qk). Before facilityRouter.
apiRouter.use("/facility", facilityBreakfastRouter);
// WS-09 facility slots (legend-nm4f).
apiRouter.use("/facility", facilityRouter);
// WS-09 staff entitlements (legend-fjk5), after facilityRouter.
apiRouter.use("/facility", facilityEntitlementRouter);
// WS-09 guest Wi-Fi sessions of a member (legend-kmd3). Before wifiConfigRouter, which requires a staff session on the same prefix.
apiRouter.use("/wifi", wifiGuestRouter);
// WS-09 Wi-Fi policy configuration writes (legend-8dpm).
apiRouter.use("/wifi", wifiConfigRouter);
// WS-10 payroll PPh 21 tenant policy versions (legend-y4wp). Before `/hris`,
// whose router applies its own middleware to everything under its prefix.
apiRouter.use("/hris/payroll/loan-policy", payrollLoanPolicyRouter);
apiRouter.use("/hris/payroll/pph21-policies", payrollPph21PolicyRouter);
// WS-10 payroll configuration API (legend-gfcr). Before `/hris` as well.
apiRouter.use("/hris/payroll/statutory-tables", payrollStatutoryRouter);
apiRouter.use("/hris/payroll/policies", payrollPolicyRouter);
apiRouter.use("/hris/payroll/thr-schedules", payrollThrRouter);
apiRouter.use("/hris/payroll/components", payrollComponentsRouter);
apiRouter.use("/hris/payroll/employees", payrollEmployeeComponentsRouter);
apiRouter.use("/hris/payroll/loans", payrollLoansRouter);
apiRouter.use("/hris/payroll/service-charge-pools", payrollServiceChargeRouter);
apiRouter.use("/hris/payroll/rapel", payrollRapelRouter);
// Payroll run simulate + lock (legend-c2yca). Guards per route, so the bank
// transfer file paths under /runs fall through to the storage export router.
apiRouter.use("/hris/payroll/runs", payrollRunsRouter);
// Payroll payout / disbursement (legend-648). Guards per route; paths
// `/payout-configs`, `/runs/:id/disbursement-batches`, `/disbursement-batches`.
apiRouter.use("/hris/payroll", payrollPayoutRouter);
apiRouter.use("/hris/payroll", payrollPayoutReturnRouter);
apiRouter.use("/hris/payroll", payrollPayoutOverpaidRouter);
apiRouter.use("/hris/payroll", payrollPayoutCorrectionRouter);
apiRouter.use("/hris/payroll", payrollPayoutProofClosureRouter);
apiRouter.use("/hris/payroll", payrollPayoutDisputeRouter);
apiRouter.use("/hris/payroll", payrollPayoutReconClearanceRouter);
apiRouter.use(
  "/hris/payroll/reimbursement-categories",
  payrollReimbursementCategoriesRouter,
);
apiRouter.use("/hris/payroll/reimbursements", payrollReimbursementsRouter);
apiRouter.use("/hris/me/loans", payrollMyLoansRouter);
apiRouter.use("/hris/me/reimbursements", payrollMyReimbursementsRouter);
// WS-10 HRIS (legend-qe1z). hrisRouter and hrisLeaveRouter need the storage
// signer, so createApp mounts them (routes/storage-api.routes.ts) ahead of
// this router; the other two groups below sat between them and keep their
// paths, which the two never own.
apiRouter.use(
  "/hris",
  hrisSopRouter,
  hrisTrainingRouter,
  hrisAnnouncementRouter,
);
// WS-10 employee scheduling: shift templates, roster, publication, swaps
// (legend-jstx).
apiRouter.use("/hris", hrisSchedulingRouter);
// WS-10 lifecycle: onboarding/offboarding checklists, exit clearance, final
// settlement summary, work certificate, KPI (legend-ovxw).
apiRouter.use(
  "/hris",
  hrisChecklistRouter,
  hrisOffboardingRouter,
  hrisWorkCertificateRouter,
  hrisKpiRouter,
);
// WS-10 attendance: selfie/geofence/device/QR clock, corrections, sampling
// review, policy, duty meal (legend-wh71).
// The employee and admin attendance routers need the storage signer, so
// createApp mounts them (routes/storage-api.routes.ts) ahead of this router.
apiRouter.use("/hris", hrisAttendanceCorrectionRouter);
// WS-14 daily operations (legend-btha checklists/food safety/prep;
// legend-i57s equipment/maintenance/handovers). Two routers share the prefix;
// each applies its middleware per route so unmatched paths pass through.
apiRouter.use("/operations", operationsRouter);
apiRouter.use("/operations", operationsEquipmentRouter);
// WS-12 AI (brief 96): Pedoman AI (legend-jk6s contract), Tanya AI chat
// (legend-xq8y), action requests (legend-zw9r), governance + usage
// (legend-zfi4), MCP client/token admin (legend-xkbt). All share /ai; each
// router guards its own routes. The /mcp endpoint + OAuth are mounted in app.ts.
apiRouter.use("/ai", aiGuidelinesRouter);
apiRouter.use("/ai", aiChatRouter);
apiRouter.use("/ai", aiActionsRouter);
apiRouter.use("/ai", aiGovernanceRouter);
apiRouter.use("/ai", aiProviderRouter);
apiRouter.use("/ai", aiChatgptRouter);
apiRouter.use("/ai", aiMcpAdminRouter);
// WS-12 AI insights: forecasts, purchase/roster inputs, anomalies, daily
// summaries, promo copy and expense account drafts (legend-hkd4, legend-lely).
apiRouter.use("/ai", aiInsightsRouter);
// WS-02 edge mode (legend-2pi): /edge is served only by an edge node and
// /edge-nodes (registry) only by the cloud; app.ts edgeRouteGuard enforces
// the split before any router runs.
// /edge/devices (registry list + heartbeat, legend-165) before /edge.
apiRouter.use("/edge/devices", edgeDeviceRouter);
// Wi-Fi agent grants + staff revoke + walled garden (legend-hsk), also before /edge.
apiRouter.use("/edge/wifi", edgeWifiRouter);
apiRouter.use("/edge", edgePrintRouter);
apiRouter.use("/edge", edgeRouter);
apiRouter.use("/edge-nodes", edgeNodesRouter);
// Staff PIN hash down-sync for edge nodes (legend-obh5): edge credential
// only, deny-all until server.ts installs the registry verifier.
apiRouter.use("/edge-sync/staff-pin-records", staffPinSyncRouter);
// Device registry (WS-02 F5, legend-165): enroll, token, revoke, training mode
// and the device heartbeat, cloud only.
apiRouter.use("/devices", deviceRouter);
// Printer registry (legend-2lp.6): cloud only, not under /edge.
apiRouter.use("/printers", printerRouter);
// Device registry replica feed for edge nodes: edge credential only.
apiRouter.use("/edge-sync/device-records", deviceRecordSyncRouter);
// Catalog (menu, prices, recipes) down-sync for edge nodes (legend-97p): edge credential only.
apiRouter.use("/edge-sync/catalog", catalogRecordSyncRouter);
// People snapshot for edge clocking (WS-02/WS-10 C2, legend-ye4j1): edge credential only.
apiRouter.use("/edge-sync/people-snapshot", edgePeopleSnapshotRouter);
apiRouter.use("/edge-sync/bootstrap", edgeBootstrapRouter);
apiRouter.use("/edge-sync-conflicts", edgeSyncConflictsRouter);

// Registry-backed EdgeDeviceLookup for /api/edge/status `thisDevice`.
installDeviceRegistryPorts();
