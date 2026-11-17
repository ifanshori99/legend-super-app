// TEN-05: "Modul yang dimatikan melalui feature flag tidak dapat diakses lewat
// UI, API, Tanya AI, maupun MCP." This is the API surface of the one gate in
// @starter/shared/platform (`assertModuleEnabled`); UI guards, Tanya AI tool
// selection and MCP tool listing call the same function.
//
// Fail closed: missing flags, missing tenant row, or malformed JSON all mean
// "off". Mount after the tenant context is installed and after authentication.

import type { RequestHandler } from "express";
import { assertModuleEnabled, type ModuleKey } from "@starter/shared/platform";
import { getTenantContext } from "./tenant";
import { db } from "../db/index.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  assertAiPlatformUnlocked,
  isMcpModuleDisabled,
} from "../services/ai-platform-lock.ts";
import { tenantFeatureFlags } from "../services/platform-org.service";

export function requireModuleEnabled(module: ModuleKey): RequestHandler {
  return async (req, _res, next) => {
    const tenant = getTenantContext(req);
    const flags = await tenantFeatureFlags(tenant.tenantId);
    // Throws core FEATURE_DISABLED (403); the error handler maps it.
    assertModuleEnabled(flags, module, "api");
    next();
  };
}

// 981 / legend-hbuq3: `mcp` module off closes every MCP route. Answers like a
// missing tenant (404 TENANT_NOT_FOUND): no module or flag name leaks. Mount
// after authentication and the tenant context.
export function requireMcpModuleEnabled(): RequestHandler {
  return async (req, _res, next) => {
    if (await isMcpModuleDisabled(db, getTenantContext(req).tenantId))
      throw new HttpError(
        404,
        "TENANT_NOT_FOUND",
        "No tenant is available for this request.",
      );
    next();
  };
}

// Founder W16 Q7: when the platform turns AI off for a tenant, every AI write
// and use route answers 403 AI_PLATFORM_DISABLED. Mount after the permission
// check; credential removal and reads stay open.
export function requireAiPlatformEnabled(): RequestHandler {
  return async (req, _res, next) => {
    await assertAiPlatformUnlocked(db, getTenantContext(req).tenantId);
    next();
  };
}
