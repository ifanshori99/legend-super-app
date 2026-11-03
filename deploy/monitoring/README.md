# Monitoring (legend-az9)

The API already emits structured JSON to stdout in production. Use Docker's
`local` log driver with bounded rotation; forward logs to a protected remote
collector if off-host retention is required. Do not log cookies, credentials,
query values, relay URLs or payloads. Check retention and disk use regularly.

`check.mjs` is a low-cost one-shot API readiness and web probe intended for a
scheduled job. Set `API_HEALTH_URL`, `WEB_HEALTH_URL`, absolute
`MONITOR_STATE_FILE`, and at least one pair `ALERT_EMAIL_RELAY_URL` /
`ALERT_EMAIL_RELAY_TOKEN` or `ALERT_WHATSAPP_RELAY_URL` /
`ALERT_WHATSAPP_RELAY_TOKEN`. Provide secrets via a root-readable environment
file, never commit them. Relay URLs must use HTTPS (HTTP is allowed on loopback
only). The relay accepts an authenticated JSON POST and is responsible for
actual provider delivery. No relay implementation or provider credentials are
included. Each channel must return a successful HTTP status only after accepting
responsibility for delivery. Test both routes before relying on them.

Schedule with a service manager that prevents overlapping runs, for example a
systemd timer once per minute. Run a second independent uptime check outside
this VM: a co-located monitor cannot alert if the VM, network, or monitor itself
is down. Alert on a missed monitor heartbeat there. State tracks the last
successfully delivered status per check and channel; failed deliveries are
retried on the next invocation. A first healthy sample emits no recovery.
The process exits nonzero if configuration or delivery fails; it emits JSON
health and delivery-failure records without URLs or tokens. Protect and persist
its state directory. Set an appropriate public web URL and the private
`/api/health/ready` URL; the latter tests database readiness as well.

**Not yet wired:** the API currently has no production device registry
heartbeat route or deployed edge-status endpoint; `@starter/shared/edge`
contains contracts and mock fixtures only. Therefore this probe cannot detect
printer/KDS outages, queue lag, edge sync lag, API error rates or device battery
levels, and does not satisfy EDG-05. Connect authenticated tenant/outlet-scoped
heartbeat data and event-driven notification delivery once implemented. A
30-second detection requirement cannot be met by this once-per-minute VM probe.
The production email and WhatsApp relay adapters also require implementation and
provider configuration; the fake adapters are not production delivery.
