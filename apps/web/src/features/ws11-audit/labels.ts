// Catalog lookups of the audit log. Object types and action codes are open
// strings in the contract: a known code gets its catalog text, anything else
// shows the code itself (never a missing-key marker).
import { isMessageKey, type Translate } from "@starter/shared/i18n";
import type { AuditActorType } from "@starter/shared/audit";

export const ACTOR_LABEL_KEYS = {
  user: "auditSettings.audit.actor.user",
  ai: "auditSettings.audit.actor.ai",
  mcp_client: "auditSettings.audit.actor.mcp_client",
  system: "auditSettings.audit.actor.system",
  device: "auditSettings.audit.actor.device",
} as const satisfies Record<AuditActorType, string>;

export function objectTypeLabel(t: Translate, objectType: string): string {
  const key = `auditSettings.audit.objectTypes.${objectType}`;
  return isMessageKey(key) ? t(key) : objectType;
}

export function actionLabel(t: Translate, action: string): string {
  const key = `auditSettings.audit.actions.${action.replaceAll(".", "_")}`;
  return isMessageKey(key) ? t(key) : action;
}
