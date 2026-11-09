import { Router } from "express";
import {
  listNotesSchema,
  noteIdSchema,
} from "@starter/shared/validators/notes";
import { HttpError } from "../lib/http-error";
import { requireAuth, requirePermission } from "../middleware/auth";
import { requireSessionMfa } from "../middleware/identity";
import { requireTrustedOrigin } from "../middleware/origin";
import { requirePlatformAdmin } from "../middleware/platform-admin";
import { deleteAnyNote, listAnyNotes } from "../services/notes.service";

// Cross-account endpoints. Order matters: 401 without a session, 403 for an
// untrusted origin, 403 without an active platform_admins row, the AUTH-05
// second factor (as on /api/platform), then 403 without the permission — all
// before a service runs. The Better Auth role alone is not enough: a revoked
// platform admin keeps `user.role = admin` (legend-atwse), and an
// impersonated session is never a platform admin.
export const adminRouter = Router();

adminRouter.use(
  requireAuth,
  requireTrustedOrigin,
  requirePlatformAdmin,
  requireSessionMfa(),
);

adminRouter.get(
  "/notes",
  requirePermission({ notes: ["read-any"] }),
  async (req, res) => {
    const query = listNotesSchema.parse(req.query);
    res.json(await listAnyNotes(query));
  },
);

adminRouter.delete(
  "/notes/:id",
  requirePermission({ notes: ["delete-any"] }),
  async (req, res) => {
    const id = noteIdSchema.parse(req.params.id);
    if (!(await deleteAnyNote(id)))
      throw new HttpError(404, "NOT_FOUND", "Note not found.");
    res.status(204).end();
  },
);
