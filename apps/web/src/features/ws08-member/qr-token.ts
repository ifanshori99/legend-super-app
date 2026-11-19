// Pure logic for the member QR token dialog (1150): the 120 s countdown and
// which state the dialog shows. No React, no clock access: callers pass `nowMs`.

/** Lifetime the API gives a freshly minted token. */
export const QR_TOKEN_TTL_SECONDS = 120;

/** Expiry on the device clock: receive time plus the known lifetime. */
export function localExpiry(receivedAtMs: number): string {
  return new Date(receivedAtMs + QR_TOKEN_TTL_SECONDS * 1000).toISOString();
}

export type QrTokenView = "loading" | "ready" | "expired" | "offline" | "error";

/** Whole seconds left, rounded up so "0:00" only shows once it is really over. */
export function secondsLeft(expiresAt: string, nowMs: number): number {
  const expiresMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresMs) || !Number.isFinite(nowMs)) return 0;
  return Math.max(0, Math.ceil((expiresMs - nowMs) / 1000));
}

export function isQrTokenExpired(expiresAt: string, nowMs: number): boolean {
  return secondsLeft(expiresAt, nowMs) === 0;
}

/** "2:00", "0:07", "0:00"; negative or NaN counts as zero. */
export function formatCountdown(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

/**
 * A token that is still valid always wins (an older QR stays usable while a
 * refresh is pending or has failed); otherwise pending, then failure, decide.
 */
export function resolveQrTokenView(input: {
  token?: { token: string; expiresAt: string };
  pending: boolean;
  failed: boolean;
  online: boolean;
  nowMs: number;
}): QrTokenView {
  const { token, pending, failed, online, nowMs } = input;
  const valid =
    token !== undefined && !isQrTokenExpired(token.expiresAt, nowMs);
  if (valid) return "ready";
  if (pending) return "loading";
  if (failed) return online ? "error" : "offline";
  if (token) return "expired";
  return "loading";
}

/** Request body: empty, or `orderId` and `points` together (the API rejects one alone). */
export function buildQrTokenBody(input?: {
  orderId?: string;
  points?: number;
}):
  | { orderId?: undefined; points?: undefined }
  | { orderId: string; points: number } {
  const orderId = input?.orderId;
  const points = input?.points;
  if (orderId === undefined && points === undefined) return {};
  if (orderId === undefined || points === undefined) {
    throw new Error("orderId and points must be sent together");
  }
  return { orderId, points };
}
