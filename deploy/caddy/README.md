# Caddy integration (legend-7bd)

Mount `Caddyfile` read-only and persist Caddy's `/data` and `/config`; publish
only ports 80 and 443. Set `TLS_ASK_TOKEN` to the same strong secret as the API
(use an unquoted base64url value to avoid Caddyfile metacharacters). Never
publish the loopback-only port 2019. Caddy's native TLS ask sends no custom
header: the local listener adds the token before proxying to the API's verified
active-domain check. Public requests to `/api/internal/*` are rejected. For public API requests,
Caddy replaces `X-Forwarded-Host` with the actual request Host before the API
resolves a tenant.

Cloudflare must proxy each domain, and the host firewall must allow inbound
ports 80/443 only from current Cloudflare IP ranges; block direct access to
API, web, PostgreSQL and the Caddy admin/ask port. Maintain the Caddy trusted
proxy list and firewall together with Cloudflare's published IP ranges. Enable
Cloudflare Full (strict); ensure ACME validation can reach Caddy through the
proxy and test issuance/renewal for each custom domain. Cloudflare feature and
custom-hostname limits must be verified for the chosen free-plan setup.

The proxy preserves the application's Cache-Control: `robots.txt` and sitemap
explicitly opt into public caching, and so does anonymous (cookie-less) HTML for `/` and `/menu` (`Vary: Host`, see `docs/deployment.md` "Public HTML cache"); other SSR defaults to private/no-store. Do not
create a cache-everything rule for tenant or authenticated responses. Cache
keys for public responses must include the hostname. Verify cross-host and
signed-in isolation before enabling additional CDN caching. Use `TRUST_PROXY=2`
and configure `PUBLIC_RATE_LIMIT_INTERNAL_IPS` for the web SSR source address.
