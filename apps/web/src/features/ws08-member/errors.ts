import type { MessageKey } from "@starter/shared/i18n";
import { ApiError } from "@/lib/api/errors";

// Stable error codes from @starter/shared/crm → catalog text. Every message
// says what to do next (PRD: setiap pesan error disertai petunjuk perbaikan).
const MESSAGES: Partial<Record<string, MessageKey>> = {
  POINTS_INSUFFICIENT: "member.errors.POINTS_INSUFFICIENT",
  REWARD_OUT_OF_STOCK: "member.errors.REWARD_OUT_OF_STOCK",
  REWARD_EXPIRED: "member.errors.REWARD_EXPIRED",
  REDEMPTION_LIMIT_REACHED: "member.errors.REDEMPTION_LIMIT_REACHED",
  MEMBERSHIP_NOT_ACTIVE: "member.errors.MEMBERSHIP_NOT_ACTIVE",
  IDEMPOTENCY_KEY_REUSED: "member.errors.IDEMPOTENCY_KEY_REUSED",
  NETWORK_ERROR: "member.errors.NETWORK_ERROR",
};

export function memberErrorKey(error: unknown): MessageKey {
  if (error instanceof ApiError)
    return MESSAGES[error.code] ?? "member.errors.default";
  return "member.errors.default";
}
