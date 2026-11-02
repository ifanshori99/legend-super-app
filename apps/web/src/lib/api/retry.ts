import { ApiError } from "./errors";

/**
 * Query retry for screens whose error state matters more than a second
 * attempt (dashboards, homes): one quick retry for a server error, none for a
 * client error or a lost connection (`NETWORK_ERROR` has status 0). The page
 * then reaches its error/offline state in about a second instead of sitting
 * on a skeleton through the app-wide retries.
 */
export function retryOnceOnServerError(
  failureCount: number,
  error: unknown,
): boolean {
  if (error instanceof ApiError && error.status < 500) return false;
  return failureCount < 1;
}
