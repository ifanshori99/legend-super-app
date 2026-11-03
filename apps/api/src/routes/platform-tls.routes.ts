// Caddy on-demand TLS ask endpoint (PRD v1.7 §3 F4 "Domain": custom domain per
// brand and a default platform subdomain, TLS automatic).
//
// Caddy calls `GET /api/internal/tls/ask?domain=<host>` before issuing a
// certificate for an unknown host. 2xx means "issue"; anything else means no
// certificate. Only a host that resolves to a verified domain of an active
// tenant (resolveHost) may pass, so a random Host header cannot fill the
// certificate store or probe other tenants' customers.
//
// The Caddy configuration itself is infra (legend-7bd); this is the API side.
import { Router } from "express";
import { hostnameSchema } from "@starter/shared/platform";
import { z } from "@starter/shared/core";
import { tlsAskGuard, tlsAskRateLimit } from "../middleware/tls-ask";
import { isVerifiedTenantHost } from "../services/org-resolve.service";

const askQuery = z.strictObject({ domain: hostnameSchema });

export const internalRouter = Router();

// Token first, so unauthenticated calls never spend the lookup budget.
internalRouter.get(
  "/tls/ask",
  tlsAskGuard(),
  tlsAskRateLimit(),
  async (req, res) => {
    const { domain } = askQuery.parse(req.query);
    res.status((await isVerifiedTenantHost(domain)) ? 200 : 404).end();
  },
);
