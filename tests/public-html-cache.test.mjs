// legend-vz93: public HTML (/ and /menu) is CDN-cacheable per tenant host, and
// everything else stays `private, no-store`.
//
// Contract assumed for the pure helper apps/web/src/lib/public-cache.server.ts
// (spec: brief section vz93; the module did not exist when these were written):
//   publicCacheSeconds(raw: string | undefined): number
//       undefined -> 60 (default), "0" -> 0 (disabled), "30" -> 30.
//   decidePublicCache({ method, pathname, status, requestHeaders: Headers,
//                       responseHeaders: Headers, seconds }) ->
//       { cacheControl: string, vary: string | null }
//     `responseHeaders` carries what the route already set (cache-control,
//     set-cookie, vary). `vary` is the full value to send (null = leave as is).
// Assumptions: any request Cookie header at all makes it non-cacheable; HEAD
// is treated like GET; "own Cache-Control" means the route set a value other
// than the middleware default `private, no-store`.

import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier))
        return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const { decidePublicCache, publicCacheSeconds } =
  await import("../apps/web/src/lib/public-cache.server.ts");

const NO_STORE = "private, no-store";
const PUBLIC = "public, max-age=0, s-maxage=60, stale-while-revalidate=300";

function decide(overrides = {}) {
  const { request = {}, response = {}, ...rest } = overrides;
  return decidePublicCache({
    method: "GET",
    pathname: "/",
    status: 200,
    seconds: 60,
    ...rest,
    requestHeaders: new Headers(request),
    responseHeaders: new Headers(response),
  });
}

const varyTokens = (value) =>
  (value ?? "")
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);

test("legend-vz93: anonymous GET / and /menu are public, short-lived, revalidated", () => {
  for (const pathname of ["/", "/menu"]) {
    const result = decide({ pathname });
    assert.equal(result.cacheControl, PUBLIC, pathname);
    assert.ok(varyTokens(result.vary).includes("host"), pathname);
  }
  // HEAD is read-only too.
  assert.equal(decide({ method: "HEAD" }).cacheControl, PUBLIC);
});

test("legend-vz93: any request cookie means no-store (signed-in output never cached)", () => {
  for (const pathname of ["/", "/menu"]) {
    const result = decide({
      pathname,
      request: { cookie: "better-auth.session_token=abc" },
    });
    assert.equal(result.cacheControl, NO_STORE, pathname);
  }
  assert.equal(
    decide({ request: { cookie: "theme=dark" } }).cacheControl,
    NO_STORE,
  );
});

test("legend-vz93: other paths and non-GET methods stay no-store", () => {
  for (const pathname of [
    "/account",
    "/menu/espresso",
    "/checkout",
    "/login",
    "/api/x",
  ])
    assert.equal(decide({ pathname }).cacheControl, NO_STORE, pathname);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"])
    assert.equal(decide({ method }).cacheControl, NO_STORE, method);
});

test("legend-vz93: non-200 and Set-Cookie stay no-store; a route's own Cache-Control is kept", () => {
  for (const status of [201, 204, 301, 302, 304, 404, 500])
    assert.equal(decide({ status }).cacheControl, NO_STORE, String(status));
  assert.equal(
    decide({ response: { "set-cookie": "sid=1; Path=/" } }).cacheControl,
    NO_STORE,
  );
  assert.equal(
    decide({ response: { "cache-control": "public, max-age=3600" } })
      .cacheControl,
    "public, max-age=3600",
    "route-owned Cache-Control is kept untouched",
  );
});

test("legend-vz93: Vary: Host is merged with an existing Vary, never duplicated", () => {
  assert.deepEqual(
    varyTokens(decide({ response: { vary: "Accept-Encoding" } }).vary).sort(),
    ["accept-encoding", "host"],
  );
  assert.deepEqual(varyTokens(decide({ response: { vary: "Host" } }).vary), [
    "host",
  ]);
  assert.deepEqual(
    varyTokens(
      decide({ response: { vary: "accept-encoding, HOST" } }).vary,
    ).sort(),
    ["accept-encoding", "host"],
  );
  // Vary: * already forbids sharing; do not weaken it.
  assert.ok(varyTokens(decide({ response: { vary: "*" } }).vary).includes("*"));
});

test("legend-vz93: knob 0 disables caching (today's behavior)", () => {
  for (const pathname of ["/", "/menu"]) {
    const result = decide({ pathname, seconds: 0 });
    assert.equal(result.cacheControl, NO_STORE, pathname);
    assert.ok(!varyTokens(result.vary).includes("host"), pathname);
  }
  assert.equal(publicCacheSeconds("0"), 0);
});

test("legend-vz93: PUBLIC_HTML_CACHE_SECONDS defaults to 60 and sets s-maxage", () => {
  assert.equal(publicCacheSeconds(undefined), 60);
  assert.equal(publicCacheSeconds("30"), 30);
  assert.match(decide({ seconds: 30 }).cacheControl, /s-maxage=30\b/);
  assert.match(decide({ seconds: 60 }).cacheControl, /s-maxage=60\b/);
});

test("legend-vz93: two tenant hosts never share a cache entry", () => {
  // The cache key is URL + the Vary headers. Both hosts get Vary: Host, so a
  // CDN that honors Vary keeps `a.example` and `b.example` apart; the decision
  // itself must not depend on one host being "public" for the other.
  const a = decide({ request: { host: "cafe-a.example" } });
  const b = decide({ request: { host: "cafe-b.example" } });
  assert.deepEqual(a, b);
  assert.ok(varyTokens(a.vary).includes("host"));
  // A cookie on one host's visitor never makes the anonymous host entry public
  // for them, and does not poison the other host.
  const signedIn = decide({
    request: { host: "cafe-a.example", cookie: "s=1" },
  });
  assert.equal(signedIn.cacheControl, NO_STORE);
  assert.equal(
    decide({ request: { host: "cafe-b.example" } }).cacheControl,
    PUBLIC,
  );
});
