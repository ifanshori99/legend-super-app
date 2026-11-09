# Decisions

Technical decisions the PRD leaves open. Newest first. Each entry names its
bead so the code comments and tests can be traced back.

## 2026-11-10: Audit retention purge with a dedicated maintenance identity (legend-usyi)

Context: `app.purge_expired_audit_logs(tenant)` (migration 0008) existed but
nothing scheduled it, and it only ran as the table owner. Audit rows are
append-only; only the owner may delete, and only rows 2 years or older
(PRD 2: "audit log ... 2 tahun"). Reviewed with an architect consult.

1. **Dedicated identity.** Group role `legend_maintenance` (NOLOGIN, NOBYPASSRLS,
   no table or sequence grant) plus login `legend_maint_<16hex>`, member only of
   that group, never of `legend_app`, owning nothing. Not a superuser, not a
   user identity. It reaches `audit_logs` only through two SECURITY DEFINER
   functions: `app.audit_retention_due_tenants()` and
   `app.purge_audit_retention_batch(tenant, batch)`.
2. **Passing FORCE RLS and the owner-only guard.** The functions are owned by the
   `audit_logs` owner, so `current_user` inside them is the owner and the
   existing guard trigger accepts the DELETE. The guard is unchanged: it still
   refuses rows younger than 2 years. Each function also sets
   `app.tenant_id` and filters on `tenant_id`, so it stays correct if the owner
   ever loses BYPASSRLS. Hardening: `search_path = pg_catalog, pg_temp`,
   schema-qualified names, no dynamic SQL, `REVOKE ALL FROM PUBLIC`, EXECUTE only
   to `legend_maintenance`. The old `purge_expired_audit_logs` is dropped.
3. **Per tenant, bounded batches.** Tenants with expired rows are listed (all
   statuses, so archived tenants are purged too). Each batch deletes at most
   1000 rows (`FOR UPDATE SKIP LOCKED`), one transaction per call; about 200
   batches per tenant and a 20 minute budget per run, the rest waits for the
   next day. A rerun deletes nothing and writes nothing.
4. **Trail.** Each batch that deletes rows inserts one `audit.retention_purged`
   row in the same transaction (actor type `system`; deleted count, cutoff,
   class). No ids, actors or content of deleted rows. A delete cannot land
   without its summary. The summary expires after its own 2 years.
5. **Scheduling and concurrency.** pg-boss queue `audit-retention-purge`, policy
   `exclusive`, cron `30 2 * * *` Asia/Jakarta, cloud worker only. `SKIP LOCKED`
   keeps two overlapping runs from double deleting, so no advisory lock.
6. **Config.** `MAINTENANCE_DATABASE_URL` in `worker.env` only (same host and
   database as the migration URL, different user from app and worker). Required
   at production start on the cloud worker; `verifyMaintenanceConnection`
   refuses a login that is in `legend_app`, has elevated attributes, owns an
   RLS table or is not in `legend_maintenance`.
7. **Not done.** Edge databases are not purged (follow-up bead). The only
   retention class is `audit_2y`; a class-to-days map is not introduced because
   the CHECK constraint allows one class.

## 2026-11-08: Worker event transport, acknowledgement and gap replay (legend-18qw)

Context: the production worker refused to start without an operator-supplied
transport module (`WORKER_TRANSPORT_MODULE`) and had no notification recipient
resolver or channel providers, so no outbox event was delivered in production.
Reviewed with an architect consult before implementation.

1. **No new HTTP ingest.** The authenticated edge/cloud ingest is the existing
   edge link `/api/edge-link` (legend-2pi): bearer credential checked against
   its stored hash, Origin header refused, re-verified every 30 s, revoked nodes
   closed with 4403. A second ingest path would duplicate that surface.
2. **Built-in transport** (`apps/api/src/worker/transport.ts`, selected with
   `WORKER_TRANSPORT=builtin`; the module overrides stay for operators):
   - Cloud: destination `cloud-sync` is a local sink. The in-process consumers
     already ran inside `consumeOutbox`; the `domain_event_consumptions` row
     (unique per consumer + event id) is the durable, idempotent
     acknowledgement, so a redelivered job is a no-op.
   - Edge (`EDGE_MODE=true`): `cloud-sync` events are queued `edge_to_cloud`
     with `enqueueEdgeEvent` on the consumption transaction (idempotent by
     event id, gap-free link sequence). The link's batch/ack/resend frames
     carry them; `edge_outbound_queue.status` + `sync_cursors.acked_out_seq`
     are the wire acknowledgement. This is the edge outbox drain the up-sync
     bead legend-kai mentions; legend-kai keeps the cloud-side applier,
     reconciliation and outage tests.
   - Any other destination, or a row with a non-null `direction`, throws: the
     job retries and then dead-letters (operator replay exists). Cloud-to-edge
     fan-out is not routed here: outbox sequences are per destination, not per
     edge node, and master-data versus transaction classification belongs to
     legend-97p.
3. **Gap replay.** An outbox sequence is allocated in the producer's own
   transaction, so a missing sequence is a producer bug that no peer can fill;
   wire-level gaps are already resent by the link. `requestMissing` records the
   gap in `domain_event_gap_requests` (unique per tenant, destination,
   aggregate and missing sequence; tenant RLS), counts repeats, logs
   `Outbox sequence gap` on the first request and each power of two, and the
   relay marks it resolved once the consumer offset passes it. The relay asks
   every tick, but a gap row is counted and rewritten at most once a minute
   (a resolved gap requested again is always reopened). Nothing skips a gap
   automatically; the aggregate stays held until the event arrives. An
   audited operator "skip gap" action would be a separate bead. A failure to
   write the gap record is logged and never aborts the relay tick.
4. **Producer bug fixed.** `operations-events.ts` numbered checklist events
   across destinations, so the `notification` alert of a started run got a
   sequence above 1 and was blocked forever. Sequences are now per
   destination, like the other allocators.
5. **Notifications fail closed at startup.** `NOTIFICATION_EMAIL_PROVIDER`,
   `NOTIFICATION_PUSH_PROVIDER` and `NOTIFICATION_WHATSAPP_PROVIDER` are
   required; `disabled` is an explicit value. A disabled channel is reported as
   unreachable to the delivery planner, so it is skipped, never reported as
   sent; in-app notifications are always written. Email has a Brevo adapter
   (account and sender domain: legend-wwuc); web push and WhatsApp templates
   stay `disabled` until legend-hyq. Only Brevo 400 and 422 decline a
   message for good; every other failure (401, 403, 404, 408, 429, 5xx,
   network) throws, is retried and is logged with the channel and HTTP status
   only (never the body, the address or the key). `BREVO_API_KEY` must be
   printable ASCII without spaces and `NOTIFICATION_EMAIL_FROM` must not be a
   placeholder (`.invalid`, `replace_me`); both are checked at startup.
6. **Recipients come from server state only**, by event name:
   `approval.requested` goes to holders of the current level's approver roles
   whose assignment covers the outlet (requester excluded);
   `approval.resolved` to the requester; `support_access.*` to tenant admins
   (`org.settings.manage` on a tenant-wide assignment); checklist missed and
   failed alerts to the outlet's `supervisor`/`outlet_manager` roles, falling
   back to the tenant owner. An event without a rule throws, so it is retried
   and dead-lettered instead of dropped silently. Banned (disabled) or missing
   accounts are dropped from every audience before a fallback is chosen (a
   banned supervisor does not hide the owner fallback) and unreachable at send
   time; an account whose `ban_expires` has passed counts as active again.
   `approval.resolved` reaches the requester only while they still hold an
   active assignment in the tenant. A malformed stored preference falls back
   to the defaults for that user only.
7. **Email is at-least-once, deduplicated within Brevo's window.** Every send
   carries `headers.idempotencyKey`, a UUID derived from the delivery
   attempt's stable reference, so a retry of the same attempt (lost response,
   worker crash) reuses the key. Brevo processes a key once for 30 minutes and
   answers a reuse with error code `duplicate_parameter` (status undocumented,
   so any 4xx carrying it counts), which the adapter treats as the
   acknowledgement. A retry later than 30 minutes after an accepted send whose
   response was lost can still deliver a second copy; with the default retry
   table (30 s, 2 min, 10 min, 1 h; tenant policy may change it) only the
   last retry falls outside the window. A duplicate notification email is accepted as the lesser failure
   compared with a lost one.
