// Map the API's stable error codes (contracts.md D-CORE-4) to catalog text so
// every screen explains the same failure the same way.
//
// The access catalog is gaining one text per access-domain code under
// `access.error.<CODE>` (legend-svza). Those keys may not exist in this branch
// yet and MessageKey is a typed union, so the key is built at runtime and only
// used when the catalog really has it (isMessageKey). Until then the camelCase
// `access.errors.*` block below keeps today's rendering.
import {
  isMessageKey,
  type MessageKey,
  type Translate,
} from "@starter/shared/i18n";
import { ApiError } from "../../lib/api/errors.ts";

/**
 * Core codes that describe the same denial as an access-domain code. Both are
 * folded onto the domain code so a FORBIDDEN response and a PERMISSION_DENIED
 * response always render the same permission text, whichever catalog key the
 * new catalog adds.
 */
const equivalentAccessCode: Readonly<Record<string, string>> = {
  FORBIDDEN: "PERMISSION_DENIED",
};

/** Keys that exist in the catalog today, used when `access.error.*` is absent. */
const camelCaseKeys: Readonly<Record<string, MessageKey>> = {
  REAUTH_REQUIRED: "access.errors.reauthRequired",
  SELF_ELEVATION_FORBIDDEN: "access.errors.selfElevation",
  ROLE_NOT_ASSIGNABLE: "access.errors.roleNotAssignable",
  ROLE_SCOPE_NOT_ALLOWED: "access.errors.roleScopeNotAllowed",
  PERMISSION_NOT_IN_CATALOG: "access.errors.permissionNotInCatalog",
  APPROVER_IS_REQUESTER: "access.errors.approverIsRequester",
  PERMISSION_DENIED: "access.errors.forbid",
  NOT_FOUND: "access.errors.notFound",
  CONFLICT: "access.errors.conflict",
  VALIDATION_ERROR: "access.errors.invalid",
  NETWORK_ERROR: "access.errors.offline",
};

/**
 * `isKnownKey` defaults to the real catalog. Tests inject a predicate to
 * exercise the `access.error.<CODE>` path before those keys land.
 */
export function accessErrorMessage(
  error: unknown,
  t: Translate,
  isKnownKey: (key: string) => boolean = isMessageKey,
): string {
  if (!(error instanceof ApiError)) return t("access.errors.generic");

  // Field-level detail beats any generic validation text.
  if (error.code === "VALIDATION_ERROR")
    return error.details?.[0]?.message ?? t("access.errors.invalid");
  if (error.code === "NETWORK_ERROR") return t("access.errors.offline");

  const code = equivalentAccessCode[error.code] ?? error.code;
  const catalogKey = `access.error.${code}`;
  if (isKnownKey(catalogKey)) return t(catalogKey as MessageKey);

  const fallback = camelCaseKeys[code];
  if (fallback) return t(fallback);
  return error.message || t("access.errors.generic");
}
