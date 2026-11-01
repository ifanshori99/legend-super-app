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
