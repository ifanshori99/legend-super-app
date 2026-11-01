// Whitelabel brand context (PRD v1.7 §3 F4 "Whitelabel", D43, TEN-08).
//
// Public on a tenant host: the web server calls it during SSR (and the browser
// reads the same answer) to render the tenant's brand name, logo, theme and
// enabled modules. There is no tenant parameter — the host or a registered
// device token determines the tenant (TEN-02) — and no platform identity in the
// answer (TEN-08).
import { Router } from "express";
import { getTenantContext, requireTenantContext } from "../middleware/tenant";
import { getBrandContext } from "../services/platform-brand.service";

export const platformBrandRouter = Router();

platformBrandRouter.use(requireTenantContext);

platformBrandRouter.get("/context", async (req, res) => {
  res.json({ data: await getBrandContext(getTenantContext(req)) });
});
