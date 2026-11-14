// Where a signed-in visitor lands after sign-in or when opening /sign-in
// (legend-ykam). A session with the back-office permission goes to the kelola
// dashboard; everyone else (customers, staff without it) stays on the customer
// home. A pending second factor does not change this: /kelola asks for it.
// Presentation only: the kelola guard and the API still authorize.
import { siteConfig } from "@starter/shared/site";
import type { AreaAccess } from "./access.ts";

export function postLoginPath(access: AreaAccess): string {
  return access.permissions.includes("dashboard.management.view")
    ? "/kelola"
    : siteConfig.appHomePath;
}
