// Browser side of the Duitku return (C2b, legend-osqou.4): the page that opens
// an e-wallet or card payment stores which payment it was, then sends the
// guest to the gateway's page. `/bayar/kembali` reads it back (rules in
// ./return-status.ts). localStorage, so a guest whose e-wallet app reopens the
// browser in a new tab is still recognised; the record holds no credential
// for a table order (the session token stays in sessionStorage), and records
// expire after RETURN_RECORD_TTL_MS.
import { API_MOCK } from "@/lib/api/mock-flag";
import {
  parseReturnRecord,
  pickReturnRecord,
  serializeReturnRecord,
  type ReturnRecord,
} from "./return-status.ts";

const PREFIX = "legend-pay-return:";
const LAST_KEY = "legend-pay-return-last";
const OPENED_PREFIX = "legend-pay-opened:";

function local(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function session(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** Drops records past their lifetime so storage does not grow. */
function prune(storage: Storage, nowMs: number) {
  for (let index = storage.length - 1; index >= 0; index -= 1) {
    const key = storage.key(index);
    if (!key?.startsWith(PREFIX)) continue;
    if (!parseReturnRecord(storage.getItem(key), nowMs))
      storage.removeItem(key);
  }
}

export function saveReturnRecord(
  record: Omit<ReturnRecord, "v" | "savedAt">,
): void {
  const storage = local();
  if (!storage) return;
  const nowMs = Date.now();
  try {
    prune(storage, nowMs);
    storage.setItem(
      PREFIX + record.paymentId,
      serializeReturnRecord({
        ...record,
        v: 1,
        savedAt: nowMs,
      } as ReturnRecord),
    );
    storage.setItem(LAST_KEY, record.paymentId);
  } catch {
    // Storage full or blocked: the return page then shows "tidak dikenali"
    // and the guest checks the order from the table QR.
  }
}

/** The record this return is about, or null (see pickReturnRecord). */
export function readReturnRecord(search: string): ReturnRecord | null {
  const storage = local();
  if (!storage) return null;
  try {
    return pickReturnRecord(
      new URLSearchParams(search),
      (id) => storage.getItem(PREFIX + id),
      storage.getItem(LAST_KEY),
      Date.now(),
    );
  } catch {
    return null;
  }
}

/**
 * The gateway page is opened automatically once per payment and tab; coming
 * back with the browser's back button shows the manual button instead of
 * bouncing the guest to the gateway again.
 */
export function claimAutoOpen(paymentId: string): boolean {
  const storage = session();
  if (!storage) return true;
  try {
    if (storage.getItem(OPENED_PREFIX + paymentId)) return false;
    storage.setItem(OPENED_PREFIX + paymentId, "1");
  } catch {
    // Blocked storage: open it; the manual button covers a second visit.
  }
  return true;
}

/**
 * Whether a gateway page URL may be opened: https only. The mock API answers
 * with this app's own return page, so mock mode also allows its own origin.
 */
export function isOpenablePaymentUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") return true;
    return (
      API_MOCK &&
      typeof window !== "undefined" &&
      parsed.origin === window.location.origin
    );
  } catch {
    return false;
  }
}

/** Sends the tab to the gateway page; false when the URL is refused. */
export function openPaymentUrl(url: string): boolean {
  if (!isOpenablePaymentUrl(url)) return false;
  window.location.assign(url);
  return true;
}
