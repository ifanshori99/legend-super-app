// The offline tablet keeps working inside the app (phone cart view, close
// shift, sign out) but every navigation re-reads the session, tenant brand and
// area access from the server. With the internet gone those calls fail and the
// whole app lands on the error page (O5, 27 Nov). While the network is gone the
// last context the browser resolved stays in force; it is presentation only,
// the API still authenticates every request on its own.

type Options = {
  /** True when the browser knows it has no connection. */
  offline?: () => boolean;
};

/**
 * Review K O5 P3 1: only the browsers' "no answer" TypeError of fetch counts,
 * not any TypeError (a code bug while online must still surface).
 */
const FETCH_FAILURE =
  /failed to fetch|load failed|networkerror|network request failed/i;

function isFetchFailure(error: unknown): boolean {
  return error instanceof TypeError && FETCH_FAILURE.test(error.message);
}

function browserOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/**
 * Runs `load`; when it fails because the network is gone and an earlier value
 * exists, returns that earlier value. Any other failure is rethrown.
 */
export async function loadWithOfflineFallback<T>(
  load: () => Promise<T>,
  last: T | null,
  options: Options = {},
): Promise<T> {
  try {
    return await load();
  } catch (error) {
    const offline = (options.offline ?? browserOffline)();
    const networkFailure = isFetchFailure(error);
    if (last !== null && (offline || networkFailure)) return last;
    throw error;
  }
}

// Browser-only memory of the last root context the browser resolved. Review K
// O5 P2: sign-out empties it, so a lost network after sign-out never shows the
// account that just left to the next person at this tablet.
let lastRootContext: unknown = null;

export function rememberRootContext<T>(context: T): void {
  lastRootContext = context;
}

export function recallRootContext<T>(): T | null {
  return (lastRootContext as T | null) ?? null;
}

export function forgetRootContext(): void {
  lastRootContext = null;
}
