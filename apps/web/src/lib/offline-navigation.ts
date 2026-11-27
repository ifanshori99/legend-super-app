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
    const networkFailure = error instanceof TypeError;
    if (last !== null && (offline || networkFailure)) return last;
    throw error;
  }
}
