// Public tenant text overrides (legend-it6p4, PRD v1.7 §3 F4 "Teks & Kamus
// Istilah"). The web server reads them while rendering a tenant host, before
// any sign-in, so the answer is limited to the `terms.*` dictionary and holds
// no ids, versions or authors. Like the brand context there is no tenant
// parameter: the host or a registered device token decides the tenant (TEN-02).
import { Router } from "express";
import { getTenantContext, requireTenantContext } from "../middleware/tenant";
import { getPublicTextOverrides } from "../services/text-override.service";

export const platformTextOverridesRouter = Router();

// The tenant resolves from x-forwarded-host or a device token, not only Host,
// so a Host-keyed shared cache could serve one tenant's text to another. Every
// response here, success included, stays no-store. (The 429 from the public
// limiter gets its own no-store in app.ts, earlier in the chain.)
platformTextOverridesRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

platformTextOverridesRouter.use(requireTenantContext);

platformTextOverridesRouter.get("/", async (req, res) => {
  const data = await getPublicTextOverrides(getTenantContext(req));
  res.json({ data });
});
