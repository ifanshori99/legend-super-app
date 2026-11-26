// O3 service worker of the /pos app shell (public/sw.js, the same worker
// that handles web push). Registered from the POS screens in production
// builds only: the dev server's modules must never be served from a cache.

/** Registers /sw.js so /pos pages and their assets load without internet. */
export async function registerPosShell(): Promise<void> {
  if (typeof window === "undefined" || import.meta.env.DEV) return;
  if (!window.isSecureContext || !("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("/sw.js");
  } catch {
    // Best-effort: without the worker the POS still works online.
  }
}

/** Sign-out: the cached /pos pages belong to this login. Best-effort. */
export async function clearPosShell(): Promise<void> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    registration?.active?.postMessage({ type: "legend-pos-shell-clear" });
  } catch {
    // Nothing registered: nothing cached.
  }
}
