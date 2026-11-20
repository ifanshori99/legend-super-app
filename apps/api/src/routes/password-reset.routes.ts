// GET /api/auth/password-reset/status (legend-1255): tells the web whether the
// "Lupa kata sandi" link may be shown, i.e. whether this deployment can send
// mail. Public (a visitor has no session), no secrets, never cached. Mounted
// before Better Auth's catch-all in app.ts.

import { Router } from "express";
import { passwordResetAvailable } from "../lib/password-reset";
import { noStore } from "../middleware/no-store";

export const passwordResetRouter = Router();

passwordResetRouter.get("/status", noStore, (_req, res) => {
  res.json({ data: { enabled: passwordResetAvailable() } });
});
