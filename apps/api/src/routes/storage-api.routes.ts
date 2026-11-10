import { Router } from "express";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { HttpError } from "../lib/http-error";
import { requireAuth } from "../middleware/auth";
import { noStore } from "../middleware/no-store";
import { requireTrustedOrigin } from "../middleware/origin";
import { createCoreStorageRouterWithAccess } from "../services/core-storage-access";
import type { StorageRuntime } from "../services/core-storage-runtime";
import type * as schema from "../db/schema";
import { createHrisAttendanceAdminRouter } from "./hris-attendance-admin.routes";
import { createHrisAttendanceRouter } from "./hris-attendance.routes";
import { createMenuRouter } from "./menu.routes";

/**
 * The /api routes that need the object storage (legend-dzh9q): core-storage
 * upload and signed URL, plus the attendance routers that mint selfie URLs.
 * Mounted by createApp ahead of `apiRouter`. Without a runtime, uploads answer
 * 503 and attendance logs carry no photo URL; everything else is unaffected.
 */
export function createStorageApiRouter(options: {
  runtime: StorageRuntime | null;
  database: NodePgDatabase<typeof schema>;
}): Router {
  const { runtime, database } = options;
  const router = Router();
  router.use(noStore);

  // The core-storage router's own paths start with /storage and it requires a
  // session on every request it sees, so only hand it /storage/* requests.
  const storage = runtime
    ? createCoreStorageRouterWithAccess({
        database,
        storage: runtime.storage,
        scanner: runtime.scanner,
      })
    : unavailableStorageRouter();
  router.use((req, res, next) =>
    req.path.startsWith("/storage/") ? storage(req, res, next) : next(),
  );

  // Menu back office (legend-7nv1): the photo upload needs the storage and the
  // scanner. The menu router runs the auth guards on every /menu/* request,
  // as it did in apiRouter; the menu import router stays there, after this.
  router.use(
    "/menu",
    createMenuRouter({
      storage: runtime?.storage ?? null,
      scanner: runtime?.scanner,
    }),
  );

  // Only attendance paths enter these routers: each runs the session and
  // tenant guards on every request it sees, which would double that work for
  // the other /hris routers that live in apiRouter.
  const attendance = Router();
  attendance.use(
    createHrisAttendanceRouter({ fileSigner: runtime?.fileSigner }),
    createHrisAttendanceAdminRouter({ signPhoto: runtime?.fileSigner }),
  );
  router.use("/hris", (req, res, next) =>
    req.path.startsWith("/attendance/") ? attendance(req, res, next) : next(),
  );
  return router;
}

function unavailableStorageRouter(): Router {
  const router = Router();
  router.use(requireAuth, requireTrustedOrigin, () => {
    throw new HttpError(
      503,
      "SERVICE_UNAVAILABLE",
      "Penyimpanan berkas belum tersedia.",
    );
  });
  return router;
}
