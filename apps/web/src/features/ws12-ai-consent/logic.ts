// Pure logic of the MCP consent screen (contract docs/contracts/ws12-ai-fe.md,
// "MCP consent screen"). No React, router or framework imports so a Node test
// can load it directly.

export const CONSENT_QUERY_KEYS = [
  "client_id",
  "redirect_uri",
  "response_type",
  "scope",
  "state",
  "code_challenge",
  "code_challenge_method",
] as const;

export type ConsentQuery = {
  client_id: string;
  redirect_uri: string;
  response_type?: string;
  scope?: string;
  state?: string;
  code_challenge?: string;
  code_challenge_method?: string;
};

/**
 * Reads the OAuth query the API forwarded to /mcp/consent. Keeps only the
 * known keys that are present and non-empty; `null` when the client or the
 * redirect address is missing.
 */
export function parseConsentQuery(search: string): ConsentQuery | null {
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  const picked: Record<string, string> = {};
  for (const key of CONSENT_QUERY_KEYS) {
    const value = params.get(key);
    if (value !== null && value !== "") picked[key] = value;
  }
  if (!picked.client_id || !picked.redirect_uri) return null;
  return picked as ConsentQuery;
}

/**
 * The address-bar query as the browser first received it. The router rewrites
 * JSON-like values (a long numeric `state` loses digits) before the page can
 * read `window.location.search`; the navigation entry URL is untouched. Used
 * only when that entry is the consent page itself, else `currentSearch`.
 */
export function pickRawConsentSearch(
  navEntryUrl: string | undefined,
  currentSearch: string,
): string {
  if (!navEntryUrl) return currentSearch;
  try {
    const url = new URL(navEntryUrl);
    return url.pathname === "/mcp/consent" ? url.search : currentSearch;
  } catch {
    return currentSearch;
  }
}

/** sessionStorage key holding the raw consent search while the person signs in. */
export const CONSENT_RESUME_KEY = "legend.mcpConsent.resume";

/**
 * True when the page was opened as the return from sign-in: `resume=1` and no
 * `client_id` (the OAuth query itself waits in sessionStorage).
 */
export function isResumeSearch(search: string): boolean {
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  return params.get("resume") === "1" && !params.has("client_id");
}

/**
 * The short return path handed to sign-in. The real consent URL is longer than
 * the 300 characters the sign-in return rule allows.
 */
export function buildResumeReturnPath(): string {
  return "/mcp/consent?resume=1";
}

// A redirect_uri may be a custom scheme (native MCP clients), but never a
// scheme that runs code in this page.
const SCRIPT_SCHEMES = new Set(["javascript:", "data:", "vbscript:"]);

/** True when navigating the browser to `href` cannot run script in this page. */
export function isSafeNavigationUrl(href: string): boolean {
  try {
    return !SCRIPT_SCHEMES.has(new URL(href).protocol);
  } catch {
    return false;
  }
}

/**
 * Where "Tolak" sends the browser: the client's redirect_uri with
 * `error=access_denied` (and `state` when the client sent one). No API call.
 */
export function buildDenyRedirect(q: ConsentQuery): string | null {
  let url: URL;
  try {
    url = new URL(q.redirect_uri);
  } catch {
    return null;
  }
  if (!isSafeNavigationUrl(url.href)) return null;
  url.searchParams.set("error", "access_denied");
  if (q.state) url.searchParams.set("state", q.state);
  return url.href;
}

/** Body of POST /api/ai/mcp/authorize: the OAuth query plus `approve: true`. */
export function buildAuthorizeBody(
  q: ConsentQuery,
): ConsentQuery & { approve: true } {
  return { ...q, approve: true };
}
