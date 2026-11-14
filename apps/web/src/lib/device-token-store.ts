// The registered-device token of this browser (bead legend-ofq4f). The token
// is issued once by the device registry (enroll / reissue); when staff choose
// "Pakai di perangkat ini" it is kept here so apiFetch can send it as
// X-Device-Token. The API verifies it on every call, so a stale or revoked
// token is refused server-side. Browser only: on the server every function
// answers "no token". Storage can be blocked, so each call fails soft.
const DEVICE_TOKEN_KEY = "legend.device.token";

export function getDeviceToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(DEVICE_TOKEN_KEY);
    return value === null || value === "" ? null : value;
  } catch {
    return null;
  }
}

/** Returns false when the browser refused to store it. */
export function setDeviceToken(token: string): boolean {
  if (typeof window === "undefined" || token === "") return false;
  try {
    window.localStorage.setItem(DEVICE_TOKEN_KEY, token);
    return true;
  } catch {
    return false;
  }
}

export function clearDeviceToken(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(DEVICE_TOKEN_KEY);
  } catch {
    // Nothing stored that we could remove.
  }
}

/** `{ "X-Device-Token": token }` in the browser when a token is stored. */
export function deviceTokenHeader(): Record<string, string> {
  const token = getDeviceToken();
  return token === null ? {} : { "X-Device-Token": token };
}
