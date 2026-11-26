// O3 service worker of the /pos app shell (public/sw.js, the same worker
// that handles web push). Registered from the POS screens in production
// builds only: the dev server's modules must never be served from a cache.

/** Registers /sw.js so /pos/kasir and its assets load without internet. */
export async function registerPosShell(): Promise<void> {
  if (typeof window === "undefined" || import.meta.env.DEV) return;
  if (!window.isSecureContext || !("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("/sw.js");
  } catch {
    // Best-effort: without the worker the POS still works online.
  }
}

/** The worker's cache name (public/sw.js `POS_SHELL`). */
export const POS_SHELL_CACHE = "legend-pos-shell-v2";

/** Sign-out: drops the cached shell and assets. Best-effort. */
export async function clearPosShell(): Promise<void> {
  if (typeof window === "undefined" || !("caches" in window)) return;
  try {
    await caches.delete(POS_SHELL_CACHE);
    // The worker would otherwise wait out its refresh interval.
    const registration = await navigator.serviceWorker?.getRegistration();
    registration?.active?.postMessage({ type: "legend-pos-shell-reset" });
  } catch {
    // Storage refused or no worker: nothing to drop.
  }
}
