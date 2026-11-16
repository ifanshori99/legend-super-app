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
 *
 * `fallback` is the development-only synthetic tenant. It runs only when no
 * real source resolved, so a request on a registered host can never be moved
 * to another tenant by it.
 *
 * `required: false` mounts the resolver on the whole API: routes that need a
 * tenant call `requireTenantContext`, while global and platform routes keep
 * answering without one (TEN-02 asks for denial, not for a blanket 404).
 */
export function tenantContext(resolvers: {
  resolveDomain(hostname: string): Promise<ResolvedTenant | null>;
  verifyCredential(req: Request): Promise<VerifiedCredential | null>;
  fallback?(req: Request): Promise<VerifiedCredential | null>;
  required?: boolean;
  /**
   * A route family that must not reveal which side of a domain/credential
   * mismatch was wrong (customer display, legend-yhia9 D-08) answers with its
   * own error here. Undefined keeps the default 403 TENANT_MISMATCH.
   */
  onMismatch?(req: Request): HttpError | undefined;
}): RequestHandler {
  return async (req, _res, next) => {
    // Express only honors X-Forwarded-Host when the sender is a trusted proxy.
    const [domain, credential] = await Promise.all([
      resolvers.resolveDomain(req.hostname.toLowerCase()),
      resolvers.verifyCredential(req),
    ]);
    const fallback =
      !domain && !credential && resolvers.fallback
        ? await resolvers.fallback(req)
        : null;
    const resolved = credential ?? fallback;
    const domainContext =
      domain && establishTenantContext({ ...domain, source: "domain" });
    const credentialContext = resolved && establishTenantContext(resolved);
    if (
      domainContext &&
      credentialContext &&
      (domainContext.tenantId !== credentialContext.tenantId ||
        (domainContext.brandId !== null &&
          credentialContext.brandId !== null &&
          domainContext.brandId !== credentialContext.brandId))
    )
      throw (
        resolvers.onMismatch?.(req) ??
        new HttpError(
          403,
          "TENANT_MISMATCH",
          "Tenant does not match this domain.",
        )
      );
    const context = domainContext?.brandId
      ? domainContext
      : credentialContext?.brandId
        ? credentialContext
        : (domainContext ?? credentialContext);
    if (!context) {
      if (resolvers.required ?? true)
        throw new HttpError(
          404,
          "TENANT_NOT_FOUND",
          "No tenant is available for this request.",
        );
      return next();
    }
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
 * The server-minted context when one resolved, undefined otherwise. For
 * cross-cutting middleware (the public rate limiter keys its tenant bucket)
 * that must not decide the route's tenant requirement.
 */
export function findTenantContext(req: Request): TenantContext | undefined {
  return contexts.get(req);
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
