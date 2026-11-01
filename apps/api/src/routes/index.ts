import { Router } from "express";
import { noStore } from "../middleware/no-store";
import { adminRouter } from "./admin.routes";
import { healthRouter } from "./health.routes";
import { notesRouter } from "./notes.routes";
import { orgRouter } from "./org.routes";
import { platformRouter } from "./platform.routes";
import { createNotificationRouter } from "./notification.routes";

// Mounted at /api. Add a router per resource and register it here.
export const apiRouter = Router();

apiRouter.use(noStore);
apiRouter.use("/health", healthRouter);
apiRouter.use("/notes", notesRouter);
apiRouter.use("/admin", adminRouter);
// Panel Platform (Super Admin) and tenant organisation settings (WS-01).
apiRouter.use("/platform", platformRouter);
apiRouter.use("/org", orgRouter);
// Fail closed until production tenant membership and role resolvers are wired.
apiRouter.use("/notifications", createNotificationRouter());
