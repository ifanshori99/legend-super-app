#!/bin/sh
# Static guards for the Caddy fronts (rehearsal 2026-11-25). They need no Docker;
# `caddy validate` of the pinned image is run by hand (docs/release/rehearsal-2026-11-25.md).
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cloud="$root/caddy/Caddyfile"
edge="$root/edge/Caddyfile.edge.example"
fail() { echo "caddy: $*" >&2; exit 1; }
# The internal prefix is closed with and without the trailing slash.
grep -Fq '@internal path /api/internal /api/internal/*' "$cloud" || fail 'cloud front does not close /api/internal and /api/internal/*'
grep -Fq '@internal path /api/internal /api/internal/*' "$edge" || fail 'edge front does not close /api/internal and /api/internal/*'
# Every public proxy block drops a client-supplied ask token; only the loopback
# listener on 2019 adds the real one.
proxies=$(grep -Ec '^[[:space:]]*reverse_proxy([[:space:]]|$)' "$cloud")
stripped=$(grep -Ec '^[[:space:]]*header_up -X-Tls-Ask-Token' "$cloud")
[ "$stripped" -eq "$((proxies - 1))" ] || fail "$stripped of $((proxies - 1)) public reverse_proxy blocks strip X-Tls-Ask-Token"
grep -Fq 'header_up X-Tls-Ask-Token "{$TLS_ASK_TOKEN}"' "$cloud" || fail 'the loopback ask bridge no longer adds the token'
# Body caps and slow-client timeouts stay in place.
grep -Fq 'max_size 12MB' "$cloud" || fail 'cloud upload cap missing'
grep -Fq 'max_size 12MB' "$edge" || fail 'edge body cap missing'
grep -Fq 'read_header 10s' "$cloud" || fail 'read_header timeout missing'
# The app trusts forwarding headers only from Cloudflare.
grep -Fq 'trusted_proxies static' "$cloud" || fail 'trusted_proxies missing'
# The edge front serves the web app and the API from one origin (1269 E8).
grep -Fq 'reverse_proxy 127.0.0.1:4000' "$edge" || fail 'edge front does not proxy /api/* to the API'
grep -Fq 'reverse_proxy 127.0.0.1:3000' "$edge" || fail 'edge front does not proxy the web app'
for unit in legend-edge.service legend-edge-worker.service legend-edge-web.service; do
  [ -f "$root/edge/$unit" ] || fail "edge unit $unit missing"
  grep -Fq 'Restart=always' "$root/edge/$unit" || fail "$unit must restart always"
done
grep -Fq 'apps/api/dist/worker.js' "$root/edge/legend-edge-worker.service" || fail 'edge worker unit does not run the worker'
echo 'caddy: front guards passed'
