import { API_MOCK } from "@/lib/api/mock-flag";
import type { PushSubscriptionInput } from "./api";
import { newIdempotencyKey } from "../../lib/idempotency.ts";

// Web push opt-in (PRD v1.7 §2 "PWA", §3.15 "Urutan Kanal"). This module only
// talks to the browser: ask permission, register the service worker, subscribe
// this device and hand the contract the fields it expects. Sending and the
// VAPID pair belong to the delivery bead (legend-hyq); the tenant's public key
// reaches the browser at runtime from GET /api/notifications/push-key (one web
// build serves every tenant, so it is never a build-time variable).
//
// Mock mode has no VAPID key or service worker, so it short-circuits the push
// stack and keeps the opt-in state in sessionStorage. The screens and tests
// therefore review the whole flow (permission -> registered -> off) against
// fixtures; a build without the mock flag uses the real browser APIs.

export type PushState =
  | "checking"
  | "inactive"
  | "active"
  | "blocked"
  | "unsupported"
  | "unavailable"
  | "ios-install"
  | "ios-outdated";

const MOCK_SUBSCRIPTION_KEY = "legend-mock-push-subscription-id";
// The API row id of this browser's subscription (bead legend-ofq4f). Not a
// secret (the endpoint and keys stay server-side); sign-out reads it to revoke
// the row before the session ends. localStorage: it must survive a reload.
const SUBSCRIPTION_ID_KEY = "legend.push.subscriptionId";

// Shapes only: mock mode never reaches a push service, so the contract's
// base64url fields are fixed sample values.
const MOCK_P256DH =
  "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM";
const MOCK_AUTH = "tBHItJI5svbpez7KI4CCXg";

type NavigatorWithStandalone = Navigator & { standalone?: boolean };

export function readMockSubscriptionId(): string | null {
  try {
    return sessionStorage.getItem(MOCK_SUBSCRIPTION_KEY);
  } catch {
    return null;
  }
}

export function rememberMockSubscriptionId(id: string): void {
  if (!API_MOCK) return;
  try {
    sessionStorage.setItem(MOCK_SUBSCRIPTION_KEY, id);
  } catch {
    // Storage can be blocked; the flow still works for this page.
  }
}

export function forgetMockSubscriptionId(): void {
  if (!API_MOCK) return;
  try {
    sessionStorage.removeItem(MOCK_SUBSCRIPTION_KEY);
  } catch {
    // Storage can be blocked.
  }
}

export function readStoredSubscriptionId(): string | null {
  try {
    const value = localStorage.getItem(SUBSCRIPTION_ID_KEY);
    return value === null || value === "" ? null : value;
  } catch {
    return null;
  }
}

export function rememberSubscriptionId(id: string): void {
  try {
    localStorage.setItem(SUBSCRIPTION_ID_KEY, id);
  } catch {
    // Storage can be blocked; sign-out then cannot revoke by id.
  }
}

export function forgetSubscriptionId(): void {
  try {
    localStorage.removeItem(SUBSCRIPTION_ID_KEY);
  } catch {
    // Storage can be blocked.
  }
}

function isIos(
  userAgent: string,
  navigator: NavigatorWithStandalone,
): { ios: true; supportsPush: boolean; installed: boolean } | null {
  const iPhoneLike =
    /iphone|ipad|ipod/i.test(userAgent) ||
    (/macintosh/i.test(userAgent) && navigator.maxTouchPoints > 1);
  if (!iPhoneLike) return null;
  const version = /OS (\d+)_(\d+)/.exec(userAgent);
  const major = Number(version?.[1] ?? 0);
  const minor = Number(version?.[2] ?? 0);
  // iOS 16.4 is the first version with web push for home-screen apps (PRD §2).
  const supportsPush = major > 16 || (major === 16 && minor >= 4);
  const installed =
    navigator.standalone === true ||
    window.matchMedia("(display-mode: standalone)").matches;
  return { ios: true, supportsPush, installed };
}

/** "Chrome · macOS" style label for the device list (max 100 characters). */
export function deviceLabel(userAgent = navigator.userAgent): string {
  const browser = /edg\//i.test(userAgent)
    ? "Edge"
    : /opr\/|opera/i.test(userAgent)
      ? "Opera"
      : /firefox|fxios/i.test(userAgent)
        ? "Firefox"
        : /chrome|crios/i.test(userAgent)
          ? "Chrome"
          : /safari/i.test(userAgent)
            ? "Safari"
            : "Browser";
  const system = /android/i.test(userAgent)
    ? "Android"
    : /iphone|ipad|ipod/i.test(userAgent)
      ? "iOS"
      : /windows/i.test(userAgent)
        ? "Windows"
        : /mac os/i.test(userAgent)
          ? "macOS"
          : /linux/i.test(userAgent)
            ? "Linux"
            : null;
  return (system ? `${browser} · ${system}` : browser).slice(0, 100);
}

/**
 * What this browser can do right now, without touching any stored state.
 * `vapidKey` is the tenant's public key; null = the tenant has push off.
 */
export async function detectPushState(
  vapidKey: string | null,
): Promise<PushState> {
  if (!("Notification" in window)) return "unsupported";
  // iOS 16.4+ only delivers web push to an app added to the Home Screen, so
  // the install guidance comes first — also in mock mode (PRD §2 PWA).
  const ios = isIos(navigator.userAgent, navigator);
  if (ios && !ios.supportsPush) return "ios-outdated";
  if (ios && !ios.installed) return "ios-install";
  if (API_MOCK) {
    if (Notification.permission === "denied") return "blocked";
    if (!vapidKey) return "unavailable";
    return readMockSubscriptionId() ? "active" : "inactive";
  }
  if (!window.isSecureContext) return "unsupported";
  if (!("serviceWorker" in navigator) || !("PushManager" in window))
    return "unsupported";
  if (Notification.permission === "denied") return "blocked";
  if (!vapidKey) return "unavailable";
  if (Notification.permission !== "granted") return "inactive";
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    return subscription ? "active" : "inactive";
  } catch {
    return "inactive";
  }
}

export async function requestPushPermission(): Promise<NotificationPermission> {
  return Notification.requestPermission();
}

// VAPID keys travel as base64url; PushManager wants the raw bytes.
function keyToBytes(key: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (key.length % 4)) % 4);
  const raw = atob((key + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1)
    bytes[index] = raw.charCodeAt(index);
  return bytes;
}

/** Subscribes this browser and returns the contract's registration input. */
export async function subscribeThisBrowser(
  vapidKey: string | null,
  // The outlet whose panic alarms this browser should receive. Omitted for
  // plain notifications; the API refuses it without the emergency permission.
  outletId?: PushSubscriptionInput["outletId"],
): Promise<PushSubscriptionInput> {
  const label = deviceLabel();
  const scope = outletId === undefined ? {} : { outletId };
  if (API_MOCK) {
    return {
      endpoint: `https://push.legend.mock/subscription/${newIdempotencyKey()}`,
      keys: { p256dh: MOCK_P256DH, auth: MOCK_AUTH },
      deviceLabel: label,
      ...scope,
    };
  }
  if (!vapidKey) throw new Error("PUSH_UNAVAILABLE");
  await navigator.serviceWorker.register("/sw.js");
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyToBytes(vapidKey),
    }));
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth)
    throw new Error("PUSH_INCOMPLETE");
  return {
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    deviceLabel: label,
    ...scope,
  };
}

/** Drops this browser's push subscription; the API row is removed separately. */
export async function unsubscribeThisBrowser(): Promise<void> {
  if (API_MOCK) {
    forgetMockSubscriptionId();
    return;
  }
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    await subscription?.unsubscribe();
  } catch {
    // A browser without a live registration has nothing left to unsubscribe.
  }
}
