import { Router } from "express";
import { noStore } from "../middleware/no-store";
import { accessRouter } from "./access.routes";
import { adminRouter } from "./admin.routes";
import { healthRouter } from "./health.routes";
import { meRouter } from "./me.routes";
import { notesRouter } from "./notes.routes";
import { orgRouter } from "./org.routes";
import { platformBrandRouter } from "./platform-brand.routes";
import { internalRouter } from "./platform-tls.routes";
import { platformRouter } from "./platform.routes";
import { createNotificationRouter } from "./notification.routes";
import { accountingRouter } from "./accounting.routes";

// Mounted at /api. Add a router per resource and register it here.
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
// Fail closed until production tenant membership and role resolvers are wired.
apiRouter.use("/notifications", createNotificationRouter());
// Accounting core (WS-07): CoA, mappings, journals, fiscal periods.
apiRouter.use("/accounting", accountingRouter);
