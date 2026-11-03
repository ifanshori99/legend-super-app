import { Router } from "express";
import { noStore } from "../middleware/no-store";
import { accessRouter } from "./access.routes";
import { adminRouter } from "./admin.routes";
import { healthRouter } from "./health.routes";
import { inventoryRouter } from "./inventory.routes";
import { meRouter } from "./me.routes";
import { notesRouter } from "./notes.routes";
import { orgRouter } from "./org.routes";
import {
  orgIntegrationsRouter,
  platformUsageRouter,
} from "./platform-integrations.routes";
import { orgThemesRouter } from "./org-themes.routes";
import { opsOutboxRouter } from "./ops-outbox.routes";
import { consentRouter, textOverridesRouter } from "./text-consent.routes";
import { platformBrandRouter } from "./platform-brand.routes";
import { internalRouter } from "./platform-tls.routes";
import { platformRouter } from "./platform.routes";
import { createNotificationRouter } from "./notification.routes";
import { taxRouter } from "./tax.routes";
import { createMenuRouter } from "./menu.routes";
import { floorRouter, outletFloorRouter, tablesRouter } from "./floor.routes";
import { qrRouter } from "./qr.routes";
import { publicSiteRouter } from "./public-site.routes";
import { tableSessionsRouter } from "./table-sessions.routes";
import { paymentRouter } from "./payment.routes";
import { paymentAdminRouter } from "./payment-admin.routes.ts";
import { accountingRouter } from "./accounting.routes";
import { approvalRouter } from "./platform-approval.routes";
import { promotionsRouter, vouchersRouter } from "./crm-promo.routes";
import { reservationRouter } from "./reservation.routes";
import { facilityRouter } from "./facility.routes";
import { wifiConfigRouter } from "./wifi.routes";
import { hrisRouter } from "./hris.routes";
import { operationsRouter } from "./operations.routes";
import { operationsEquipmentRouter } from "./operations-equipment.routes";

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
apiRouter.use("/notes", notesRouter);
apiRouter.use("/admin", adminRouter);
// Panel Platform (Super Admin) and tenant organisation settings (WS-01).
apiRouter.use("/platform", platformUsageRouter);
apiRouter.use("/platform", platformRouter);
apiRouter.use("/org", orgIntegrationsRouter);
apiRouter.use("/org", orgRouter);
apiRouter.use("/org", orgThemesRouter);
apiRouter.use("/org/text-overrides", textOverridesRouter);
apiRouter.use("/consents", consentRouter);
// Operator outbox replay (legend-m119).
apiRouter.use("/ops", opsOutboxRouter);
// Whitelabel brand context for SSR (TEN-08), resolved from the request host.
apiRouter.use("/tenant", platformBrandRouter);
// Reverse-proxy endpoints (Caddy on-demand TLS ask). Not for browsers.
apiRouter.use("/internal", internalRouter);
// RBAC administration (WS-01) and the caller's effective access (legend-t4y7).
apiRouter.use("/access", accessRouter);
apiRouter.use("/me", meRouter);
// Generic approval inbox for every module (WS-01 F7, legend-y5q).
apiRouter.use("/approvals", approvalRouter);
// Menu back office (WS-03, legend-lmk). No object-storage provider is wired
// yet (WS-00 storage bead owns that), so the image upload answers 503 until
// the bootstrap injects one; every other menu route is live.
apiRouter.use("/menu", createMenuRouter());
// Inventory & warehouse (WS-06, bead legend-98t).
apiRouter.use("/inventory", inventoryRouter);
// Customer payment links and intents (WS-05, PRD §3.13). Public by token.
apiRouter.use("/payments/admin", paymentAdminRouter);
apiRouter.use("/payments", paymentRouter);
// Fail closed until production tenant membership and role resolvers are wired.
apiRouter.use("/notifications", createNotificationRouter());
// WS-03 floor: zones/tables editor, live board, signed table QR and the staff
// table-session lifecycle; /qr is the public guest scan (legend-irw).
apiRouter.use("/floor", floorRouter);
apiRouter.use("/outlets", outletFloorRouter);
apiRouter.use("/tables", tablesRouter);
apiRouter.use("/table-sessions", tableSessionsRouter);
apiRouter.use("/qr", qrRouter);
// Public brand website (WS-08 F21): the online menu page, tenant and brand from
// the request host (TEN-08). Q23 hides items without a photo.
apiRouter.use("/public/site", publicSiteRouter);
// WS-05 versioned tax / service-charge configuration, preview and PBJT recap.
apiRouter.use("/tax", taxRouter);
// Accounting core (WS-07): CoA, mappings, journals, fiscal periods.
apiRouter.use("/accounting", accountingRouter);
// WS-08 promo engine shared by POS/QR/website (legend-7x4g).
apiRouter.use("/promotions", promotionsRouter);
apiRouter.use("/vouchers", vouchersRouter);
// WS-08 reservations (legend-t8bz): full paths inside the router.
apiRouter.use(reservationRouter);
// WS-09 facility slots (legend-nm4f).
apiRouter.use("/facility", facilityRouter);
// WS-09 Wi-Fi policy configuration writes (legend-8dpm).
apiRouter.use("/wifi", wifiConfigRouter);
// WS-10 HRIS (legend-qe1z).
apiRouter.use("/hris", hrisRouter);
// WS-14 daily operations (legend-btha checklists/food safety/prep;
// legend-i57s equipment/maintenance/handovers). Two routers share the prefix;
// each applies its middleware per route so unmatched paths pass through.
apiRouter.use("/operations", operationsRouter);
apiRouter.use("/operations", operationsEquipmentRouter);
