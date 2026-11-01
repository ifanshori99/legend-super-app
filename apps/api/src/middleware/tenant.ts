import type { Request, RequestHandler } from "express";
import type { TenantContext } from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import { HttpError } from "../lib/http-error";

type ResolvedTenant = { tenantId: string; brandId: string | null };
type VerifiedCredential = ResolvedTenant & {
  source: "session" | "device" | "mcp_token";
};

/**
 * The implementations must look up a registered domain and verify credentials
 * server-side. Neither callback may derive a tenant from client parameters.
 * A credential verifier returns null for absent or invalid credentials; route
 * authentication remains a separate requirement.
 */
export function tenantContext(resolvers: {
  resolveDomain(hostname: string): Promise<ResolvedTenant | null>;
  verifyCredential(req: Request): Promise<VerifiedCredential | null>;
}): RequestHandler {
  return async (req, _res, next) => {
    // Express only honors X-Forwarded-Host when the sender is a trusted proxy.
    const [domain, credential] = await Promise.all([
      resolvers.resolveDomain(req.hostname.toLowerCase()),
      resolvers.verifyCredential(req),
    ]);
    const domainContext =
      domain && establishTenantContext({ ...domain, source: "domain" });
    const credentialContext = credential && establishTenantContext(credential);
    if (
      domainContext &&
      credentialContext &&
      (domainContext.tenantId !== credentialContext.tenantId ||
        (domainContext.brandId !== null &&
          credentialContext.brandId !== null &&
          domainContext.brandId !== credentialContext.brandId))
    )
      throw new HttpError(
        403,
        "TENANT_MISMATCH",
        "Tenant does not match this domain.",
      );
    const context = domainContext?.brandId
      ? domainContext
      : credentialContext?.brandId
        ? credentialContext
        : (domainContext ?? credentialContext);
    if (!context)
      throw new HttpError(
        404,
        "TENANT_NOT_FOUND",
        "No tenant is available for this request.",
      );
    contexts.set(req, context);
    next();
  };
}

const contexts = new WeakMap<Request, TenantContext>();

/** Returns only a server-minted context installed by tenantContext. */
export function getTenantContext(req: Request): TenantContext {
  const context = contexts.get(req);
  if (!context)
    throw new Error("getTenantContext() used without tenantContext");
  return context;
}

/**
 * A tenant-aware route that requires a resolved tenant (TEN-02). Without a
 * domain or credential there is no tenant, so the answer is 404 — never a
 * tenant picked from request input.
 */
export const requireTenantContext: RequestHandler = (req, _res, next) => {
  if (!contexts.has(req))
    throw new HttpError(
      404,
      "TENANT_NOT_FOUND",
      "No tenant is available for this request.",
    );
  next();
};

/** Optional for global starter endpoints; tenant services must call getTenantContext. */
export function developmentTenantContext(options: {
  enabled: boolean;
  hasSession(req: Request): Promise<boolean>;
  lookup(): Promise<ResolvedTenant | null>;
}): RequestHandler {
  return async (req, res, next) => {
    if (!options.enabled || !(await options.hasSession(req))) return next();
    return tenantContext({
      resolveDomain: async () => null,
      verifyCredential: async () => {
        const tenant = await options.lookup();
        return tenant ? { ...tenant, source: "session" } : null;
      },
    })(req, res, next);
  };
}
