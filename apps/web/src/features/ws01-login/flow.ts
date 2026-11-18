// Pure sign-in rules shared by the /masuk screens (PRD v1.7 §3 F3
// "Autentikasi & Identitas", §4 Alur C; AUTH-01/03/07). No React and no fetch,
// so the screens and tests/login-flow.test.mjs import the same rules:
//
// - what the requesting browser may show while it polls its challenge
//   (AUTH-01: five minutes, single use, bound to this browser),
// - which countdown a code shows,
// - which API failure ends the code and asks for a new one,
// - where a completed sign-in lands (the return path only if it is one).
//
// The challenge state machine itself lives in the contract
// (@starter/shared/identity, machines.ts); this file only reads its output.

import {
  returnPathSchema,
  type LoginChallenge,
  type LoginChallengeView,
} from "@starter/shared/identity";

/** Two seconds between polls while the guest sends the message (AUTH-01 flow). */
export const LOGIN_POLL_MS = 2_000;

/** What the requesting browser can see of its own challenge. */
export const LOGIN_OUTCOMES = [
  "pending",
  "awaiting_confirmation",
  "signed_in",
  "expired",
  "cancelled",
] as const;
export type LoginOutcome = (typeof LOGIN_OUTCOMES)[number];

/**
 * A challenge that completed but carries no session for this browser cannot
 * hand one out (single use, AUTH-01), so it reads as expired rather than
 * spinning forever. A pending challenge past `expiresAt` is expired even
 * before the server sweeps it.
 */
export function loginChallengeOutcome(
  view: LoginChallengeView,
  nowMs: number,
): LoginOutcome {
  const { challenge } = view;
  // The message landed; the person still has to confirm the masked sender.
  // The API reports this as status "completed" with no session (older shapes
  // kept "pending"), so it is read before the completed branch.
  if (
    view.awaitingConfirmation === true &&
    view.session === null &&
    (challenge.status === "pending" || challenge.status === "completed")
  )
    return expiryMs(challenge, nowMs) === 0
      ? "expired"
      : "awaiting_confirmation";
  if (challenge.status === "completed")
    return view.session !== null ? "signed_in" : "expired";
  if (challenge.status === "cancelled") return "cancelled";
  if (challenge.status === "expired") return "expired";
  if (expiryMs(challenge, nowMs) === 0) return "expired";
  return "pending";
}

function expiryMs(
  challenge: Pick<LoginChallenge, "expiresAt">,
  nowMs: number,
): number {
  return Math.max(0, Date.parse(challenge.expiresAt) - nowMs);
}

/** Milliseconds left on the code, clamped at 0. */
export function loginCodeRemainingMs(
  challenge: Pick<LoginChallenge, "expiresAt">,
  nowMs: number,
): number {
  return expiryMs(challenge, nowMs);
}

/** "4:58" — minutes and seconds for the code countdown. */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * API failures that end this code. Each one asks for a new code instead of
 * retrying the same one (AUTH-01 single use; AUTH-04 rate limit).
 */
export const CHALLENGE_FAILURES = [
  "expired",
  "mismatch",
  "used",
  "rateLimited",
  "alreadyLinked",
] as const;
export type ChallengeFailure = (typeof CHALLENGE_FAILURES)[number];

const CHALLENGE_FAILURE_BY_CODE: Readonly<
  Record<string, ChallengeFailure | undefined>
> = {
  CHALLENGE_EXPIRED: "expired",
  CHALLENGE_BROWSER_MISMATCH: "mismatch",
  CHALLENGE_NOT_PENDING: "used",
  RATE_LIMITED: "rateLimited",
  // Linking a number that already belongs to another account merges instead of
  // creating a second one (identity graph, §3 F3 "Graf Identitas Pelanggan").
  IDENTITY_ALREADY_LINKED: "alreadyLinked",
};

/** The structured `code` an ApiError (or a CoreError/IdentityError) carries. */
export function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/** Non-null when the failure ends the challenge; render a restart state. */
export function challengeFailure(error: unknown): ChallengeFailure | null {
  const code = errorCode(error);
  return code === null ? null : (CHALLENGE_FAILURE_BY_CODE[code] ?? null);
}

/**
 * Catalog key for an inline failure that does not end the challenge. The
 * network case exists because the browser polls every two seconds; the guest
 * needs to know to reconnect rather than read a generic error.
 */
export type LoginErrorKey =
  | "login.errors.generic"
  | "login.errors.offline"
  | "login.errors.invalidEmail"
  | "login.errors.tooMany";

export function loginErrorKey(error: unknown): LoginErrorKey {
  const code = errorCode(error);
  if (code === "NETWORK_ERROR") return "login.errors.offline";
  if (code === "RATE_LIMITED") return "login.errors.tooMany";
  if (code === "VALIDATION_ERROR") return "login.errors.invalidEmail";
  return "login.errors.generic";
}

/**
 * Where a completed sign-in lands when the visitor did not come from a page.
 * Management sessions open the management dashboard, customers the member
 * home; the area guard still decides whether the session may see it.
 */
export function postLoginPath(session: {
  readonly kind: "customer" | "management";
  /** A shared tablet (founder Q29) opens the POS: kelola and member are closed. */
  readonly sharedDevice?: boolean;
}): string {
  if (session.sharedDevice) return "/pos";
  return session.kind === "management" ? "/kelola" : "/member";
}

/**
 * A return path from the URL is untrusted: only a same-origin path, never a
 * protocol-relative `//host`, another scheme, or a backslash/whitespace form a
 * browser normalizes into one (`/\evil.example`, `/<TAB>/evil.example`). The
 * screens validate `?lanjut=`/`?redirect=` with the contract's
 * returnPathSchema; this is the same rule for code that builds a sign-in URL,
 * so the two can never drift.
 *
 * On top of the contract rule the browser side also refuses (legend-qhh5
 * review): any C0/DEL control character, a percent-encoded `/` or `\` in the
 * path (a router that decodes before navigating would turn `/%2F%2Fevil` or
 * `/%5Cevil` into a protocol-relative URL), dot segments that resolve to
 * another origin or to an API path, and the API/auth endpoints themselves
 * (a return to `/api/...` would replay a request, not show a page).
 */
const RETURN_PATH_BASE = "https://return-path.invalid";
const BLOCKED_RETURN_PREFIXES = ["/api", "/auth"] as const;
// eslint-disable-next-line no-control-regex -- refusing control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const ENCODED_SEPARATOR = /%(?:2f|5c)/i;

export function safeReturnPath(
  value: string | null | undefined,
): string | undefined {
  if (!value) return undefined;
  if (!returnPathSchema.safeParse(value).success) return undefined;
  if (CONTROL_CHARS.test(value)) return undefined;
  const rawPath = value.split(/[?#]/, 1)[0] ?? "";
  if (ENCODED_SEPARATOR.test(rawPath)) return undefined;
  let url: URL;
  let decodedPath: string;
  try {
    url = new URL(value, RETURN_PATH_BASE);
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }
  if (url.origin !== RETURN_PATH_BASE) return undefined;
  if (
    decodedPath.startsWith("//") ||
    /[\s\\]/.test(decodedPath) ||
    CONTROL_CHARS.test(decodedPath)
  )
    return undefined;
  const pathname = url.pathname.toLowerCase();
  if (
    BLOCKED_RETURN_PREFIXES.some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    )
  )
    return undefined;
  return value;
}

/**
 * Where `/masuk/hubungkan` returns after linking (legend-vnvg): only a member
 * screen (`/member` or `/member/...`). The value must first pass
 * `safeReturnPath`; the result is the bare pathname, so query and fragment are
 * dropped and dot segments are resolved (`/member/../masuk` is refused).
 */
export const MEMBER_RETURN_DEFAULT = "/member";

export function memberReturnPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const safe = safeReturnPath(value);
  if (!safe) return undefined;
  const pathname = new URL(safe, RETURN_PATH_BASE).pathname;
  return pathname === "/member" || pathname.startsWith("/member/")
    ? pathname
    : undefined;
}

/** `validateSearch` for `/masuk/hubungkan`: keep `lanjut` only as a member path. */
export function linkWhatsAppSearch(search: Record<string, unknown>): {
  lanjut?: string;
} {
  return { lanjut: memberReturnPath(search.lanjut) };
}

/**
 * Query names `/masuk` accepts for "the page to go back to". `lanjut` is the
 * app's own name; `redirect` is the alias captive portals and payment links
 * use (bead legend-qhh5), so an external entry point does not have to know the
 * internal name of the parameter.
 */
export const SIGN_IN_RETURN_PARAMS = ["lanjut", "redirect"] as const;
export type SignInReturnParam = (typeof SIGN_IN_RETURN_PARAMS)[number];

/** A search value is untrusted: arrays, objects and non-paths are ignored. */
function returnPathValue(value: unknown): string | undefined {
  return typeof value === "string" ? safeReturnPath(value) : undefined;
}

/**
 * `validateSearch` for `/masuk`: keep `lanjut` and its `redirect` alias only
 * when each is an app-local path. Everything else is dropped before render, so
 * an unsafe value never reaches `SignInScreen`.
 */
export function signInSearch(search: Record<string, unknown>): {
  lanjut?: string;
  redirect?: string;
} {
  return {
    lanjut: returnPathValue(search.lanjut),
    redirect: returnPathValue(search.redirect),
  };
}

/**
 * The path a validated `/masuk` search returns to. `redirect` wins when both
 * are present: it is the name the linking page just set. The value is checked
 * again here, so a caller that skipped `signInSearch` cannot introduce an open
 * redirect.
 */
export function signInReturnPath(search: {
  readonly lanjut?: unknown;
  readonly redirect?: unknown;
}): string | undefined {
  return returnPathValue(search.redirect) ?? returnPathValue(search.lanjut);
}

/**
 * Build the `/masuk?...` URL a page uses to hand the visitor to sign-in.
 * `param` chooses between the app's `lanjut` (default, keeps old links) and
 * the `redirect` alias external portals use.
 */
export function signInPath(
  returnTo: string | null | undefined,
  param: SignInReturnParam = "lanjut",
): string {
  const safe = safeReturnPath(returnTo);
  return safe ? `/masuk?${param}=${encodeURIComponent(safe)}` : "/masuk";
}
