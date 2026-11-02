// Per-device binding for attendance (PRD F25 "pengikatan perangkat"). The API
// stores only a hash, never a device id. This module mints one random local id
// per browser profile and hashes it with SHA-256 before it leaves the page.
// A missing Web Crypto (insecure context) means no hash: the server then
// applies the policy's unbound-device action (HR-02) instead of silently
// passing a fake value.

const DEVICE_STORAGE_KEY = "legend-hris-device";

function randomId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }
}

/** The stable local device id (not a hardware fingerprint). */
export function deviceId(): string {
  try {
    const existing = window.localStorage.getItem(DEVICE_STORAGE_KEY);
    if (existing && existing.length <= 200) return existing;
    const created = randomId();
    window.localStorage.setItem(DEVICE_STORAGE_KEY, created);
    return created;
  } catch {
    // Storage blocked: a per-page id still keeps the flow honest (unbound).
    return randomId();
  }
}

function toHex(bytes: Uint8Array): string {
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Lowercase SHA-256 hex of the local device id, or null without Web Crypto. */
export async function deviceIdHash(): Promise<string | null> {
  try {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(deviceId()),
    );
    return toHex(new Uint8Array(digest));
  } catch {
    return null;
  }
}
