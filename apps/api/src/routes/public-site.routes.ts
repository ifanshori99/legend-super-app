// Public brand website API (PRD v1.7 §3 F21 / §3.24 "Website Publik per Brand";
// contract `GET /api/public/site/menu`).
//
// Public on a tenant host: the tenant — and the brand pinned to it — come from
// the request host (TEN-02, D-CORE-3), never from a query parameter, so the
// same code serves every brand domain. No cookie is read, no session is
// required, and the answer is public catalogue data only.
//
// Q23 (legend-qf0i): the online menu read hides active items without a photo,
// exactly like the QR order menu.

import { Router } from "express";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import { getTenantContext, requireTenantContext } from "../middleware/tenant";
import { getPublicMenuPage as readPublicMenuPage } from "../services/guest-menu.service";
import { getPublicSite as readPublicSite } from "../services/public-site.service";

export const publicSiteRouter = Router();

publicSiteRouter.use(requireTenantContext);

// Contract `getPublicSite` (`GET /api/public/site`). 404
// `PUBLIC_SITE_NOT_PUBLISHED` until staff publish; only a published answer is
// cacheable (the app-wide `no-store` default stays on every other answer).
publicSiteRouter.get("/", async (req, res) => {
  const context = establishScopedTenantContext(getTenantContext(req), {
    kind: "tenant",
  });
  // Only a host that resolved to a registered tenant domain names the member
  // link and may be cached; any other source keeps the no-store default.
  const domain =
    context.tenant.source === "domain" ? req.hostname.toLowerCase() : null;
  const data = await readPublicSite(
    context,
    domain ? `https://${domain}` : null,
  );
  if (domain) res.setHeader("Cache-Control", "public, max-age=60");
  res.json({ data });
});

// Contract `getPublicMenuPage` (`GET /api/public/site/menu`).
publicSiteRouter.get("/menu", async (req, res) => {
  // TEN-03 (legend-7csf): this stays tenant-wide on purpose. The outlet scope
  // only knows "tenant" or an outlet list, and the outlet shown is chosen by
  // the service from the brand the host pins, so the route has no outlet id to
  // pin yet. The service filters by the host's brand; narrowing the context
  // needs the outlet resolved first (a service change, not a route one).
  const context = establishScopedTenantContext(getTenantContext(req), {
    kind: "tenant",
  });
  res.json({ data: await readPublicMenuPage(context) });
});
