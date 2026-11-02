import { Router } from "express";
import { noStore } from "../middleware/no-store";
import { accessRouter } from "./access.routes";
import { adminRouter } from "./admin.routes";
import { healthRouter } from "./health.routes";
import { inventoryRouter } from "./inventory.routes";
import { meRouter } from "./me.routes";
import { notesRouter } from "./notes.routes";
import { orgRouter } from "./org.routes";
import { platformBrandRouter } from "./platform-brand.routes";
import { internalRouter } from "./platform-tls.routes";
import { platformRouter } from "./platform.routes";
import { createNotificationRouter } from "./notification.routes";

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
apiRouter.use("/platform", platformRouter);
apiRouter.use("/org", orgRouter);
// Whitelabel brand context for SSR (TEN-08), resolved from the request host.
apiRouter.use("/tenant", platformBrandRouter);
// Reverse-proxy endpoints (Caddy on-demand TLS ask). Not for browsers.
apiRouter.use("/internal", internalRouter);
// RBAC administration (WS-01) and the caller's effective access (legend-t4y7).
apiRouter.use("/access", accessRouter);
apiRouter.use("/me", meRouter);
// Inventory & warehouse (WS-06, bead legend-98t).
apiRouter.use("/inventory", inventoryRouter);
// Fail closed until production tenant membership and role resolvers are wired.
apiRouter.use("/notifications", createNotificationRouter());
