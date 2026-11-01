// Where this device keeps the door credential of a ticket it just issued.
//
// The contract returns the QR token and the 6-digit PIN exactly once, in the
// `bookAccessTicket` response (`issuedTicketSchema`); `getAccessTicket` never
// repeats them, because a 6-digit PIN has only 10^6 digests and a stored copy
// would be a stored secret. So the phone that bought the ticket keeps it for
// the session and the ticket screen shows it from here. Another device (or a
// cleared browser) sees the "not shown again" hint instead of a fake QR.
//
// Storage is `sessionStorage`: gone when the tab closes, never synced, never
// sent anywhere, and absent during SSR (so the QR is rendered after mount).

export type StoredTicketCredential = {
  readonly qrToken: string;
  readonly pin: string;
  readonly validFrom: string;
  readonly validUntil: string;
};

const KEY_PREFIX = "legend-facility-credential:";

function storage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.sessionStorage;
  } catch {
    // Storage can be blocked (private mode, embedded webview): no credential
    // is better than a crash, and the ticket still shows its session.
    return null;
  }
}

export function credentialKey(ticketId: string): string {
  return `${KEY_PREFIX}${ticketId}`;
}

// A tiny external store the ticket screen subscribes to (useSyncExternalStore):
// one cached object per ticket, so the snapshot keeps its identity between
// renders, and saving a credential notifies the screen that is showing it.
const listeners = new Set<() => void>();
const cache = new Map<string, StoredTicketCredential | null>();

export function subscribeTicketCredentials(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function saveTicketCredential(
  ticketId: string,
  credential: StoredTicketCredential,
): void {
  try {
    storage()?.setItem(credentialKey(ticketId), JSON.stringify(credential));
  } catch {
    // Quota or blocked storage: the ticket screen falls back to its hint.
  }
  cache.set(ticketId, credential);
  notify();
}

/** Cached read: the same object until it is saved or cleared. */
export function readTicketCredential(
  ticketId: string,
): StoredTicketCredential | null {
  if (cache.has(ticketId)) return cache.get(ticketId) ?? null;
  const credential = loadTicketCredential(ticketId);
  cache.set(ticketId, credential);
  return credential;
}

function loadTicketCredential(ticketId: string): StoredTicketCredential | null {
  try {
    const raw = storage()?.getItem(credentialKey(ticketId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const value = parsed as Record<string, unknown>;
    if (
      typeof value.qrToken !== "string" ||
      typeof value.pin !== "string" ||
      typeof value.validFrom !== "string" ||
      typeof value.validUntil !== "string"
    )
      return null;
    return {
      qrToken: value.qrToken,
      pin: value.pin,
      validFrom: value.validFrom,
      validUntil: value.validUntil,
    };
  } catch {
    return null;
  }
}

export function clearTicketCredential(ticketId: string): void {
  try {
    storage()?.removeItem(credentialKey(ticketId));
  } catch {
    // Nothing to clear.
  }
  cache.set(ticketId, null);
  notify();
}
