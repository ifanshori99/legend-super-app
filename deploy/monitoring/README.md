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
actual provider delivery. Each channel must return a successful HTTP status only
after accepting responsibility for delivery. Direct Brevo and Kirimdev adapters
are also available below; no provider credentials are included. Test configured
routes before relying on them.

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

**Sync horizon (legend-9h0kg).** One idle open transaction holds
`pg_snapshot_xmin` back and stops edge catalog and PIN sync. Set
`MONITOR_XMIN_ENABLED=true` to add an `xmin_age` check that runs `psql` against
the cloud database and alerts (`down`, then `recovered`) when the oldest open
transaction that holds an id, or the oldest prepared transaction, is older than
`MONITOR_XMIN_MAX_AGE_SECONDS` (default 600, ten minutes). The age counts from
`xact_start`, the start of the transaction rather than of its id, so it can
over-estimate; that is safe, it only alerts earlier. Give the job the libpq variables `PGHOST`,
`PGUSER`, `PGPASSWORD`, `PGDATABASE` and `PGSSLMODE` in its environment file,
never in arguments. The login must be a superuser or a member of `pg_read_all_stats`; without that
`xact_start` of other sessions is hidden, so the probe fails (counts as down)
instead of reading 0. `psql` runs with `-w` (never prompts for a password) and
must be installed on the machine that runs the probe. A failed query counts as
down.
Because this check needs the database, run it on the VM or a host with private
database access, not from the independent uptime host.

**Device and edge monitoring (legend-4lm6).** Set
`MONITOR_OPERATIONAL_ENABLED=true`, `MONITOR_TENANT_ID` and
`MONITOR_OUTLET_ID` to add `device_heartbeat`, `queue_depth` and `sync_lag`.
The source uses `psql` and the same private libpq connection settings as the xmin
probe. It reads persisted heartbeat timestamps written by the existing verified
device-token and edge-credential routes, rather than accepting caller-supplied
health claims. Every table read has explicit tenant/outlet filters, with
transaction-local RLS settings for exactly that outlet. Use an existing database
role authorized to read those rows; this change creates no grants or migrations.
Use a separate state file and process configuration for each tenant/outlet.

Operational checks require the outlet's **edge database**, with an active local
node whose `instance_id` was initialized by edge boot. A cloud-only database or
a nonexistent tenant/outlet scope returns an unavailable source rather than an
empty healthy snapshot. HTTP readiness monitors the local edge process; its
boot-only registry timestamp is not a periodic device heartbeat.

The source reads the outlet's active devices, excluding revoked rows.
Never-seen devices count as offline. The heartbeat threshold defaults to
120 seconds (four 30-second heartbeats); override with
`MONITOR_DEVICE_MAX_AGE_SECONDS`. The queue reads pending `edge_to_cloud`
events for active nodes in that database; `MONITOR_QUEUE_MAX_PENDING` defaults
to 100. `MONITOR_SYNC_MAX_AGE_SECONDS` defaults to 300 and checks the oldest
last acknowledgement among nodes with pending work. A nonempty queue without an
acknowledgement is unhealthy; an empty queue does not trigger a sync-age alarm.
The cloud database cannot see work that is still only on a disconnected edge.
Database time is used
for heartbeat and acknowledgement ages. Invalid data or a failed query emits
`operational_source: down`, retries channel failures, and emits recovery after
the source becomes valid again. It never converts query failure to healthy data.

**Direct production channels.** `config.example.env` lists all names. Select
`ALERT_EMAIL_PROVIDER=brevo` with `ALERT_BREVO_API_KEY`,
`ALERT_EMAIL_FROM` and `ALERT_EMAIL_TO` for the existing Brevo transactional
email contract. Select `ALERT_WHATSAPP_PROVIDER=kirimdev` with
`ALERT_KIRIMDEV_API_KEY`, `ALERT_WHATSAPP_PHONE_NUMBER_ID`,
`ALERT_WHATSAPP_TO`, `ALERT_WHATSAPP_TEMPLATE_NAME` and
`ALERT_WHATSAPP_TEMPLATE_LANGUAGE` for Kirimdev at `api.kirimdev.com`.
The operator must configure an approved body-only WhatsApp template with exactly
one text parameter (the alert summary), in its approved language. Templates allow
alerts outside the 24-hour conversation window. No template or paid account is
created by this code. A channel can use a direct provider or its existing relay;
configuring both for the same channel fails before delivery.

Destinations come only from the operator's private configuration. Delivery payloads
contain machine check/status identifiers, time and (when operational monitoring is
enabled) the configured tenant/outlet IDs. Before provider I/O the monitor persists
a random UUID and the exact pending payload with mode 0600. Retrying an ambiguous
response reuses that UUID and payload. A successful response is recorded per
channel; failed email or WhatsApp delivery retries without resending to channels
that acknowledged. This relies on provider idempotency windows (Brevo 30 minutes,
Kirimdev 24 hours); acknowledgement lost beyond that window can cause a duplicate.
Never delete the state file to repair a delivery problem. Run one process at a
time per state file. A provider's acceptance is not proof of inbox/device receipt.

Provider request contracts were checked against the official
[Brevo email documentation](https://developers.brevo.com/reference/send-transac-email),
[Brevo idempotency documentation](https://developers.brevo.com/docs/heterogenous-versions-batch-emails),
[Kirimdev templates](https://docs.kirimdev.com/sending/send-templates/), and
[Kirimdev idempotency](https://docs.kirimdev.com/concepts/idempotency/).
Automated tests use fetch mocks; live credentials, template approval and real
delivery still need deployment-time verification.

**Detection limits.** This independent periodic probe supplements the edge's
event-driven Print Agent monitor. A once-per-minute schedule and the default
120-second device threshold do not satisfy EDG-05's 30-second detection target.
Use the edge Print Agent's supervisor alerts for that target; this probe does not
measure device battery levels or API error rates.
