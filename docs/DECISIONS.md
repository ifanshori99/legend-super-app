# Decisions

Technical decisions the PRD leaves open. Newest first. Each entry names its
bead so the code comments and tests can be traced back.

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
   relay marks it resolved once the consumer offset passes it. Nothing skips a
   gap automatically; the aggregate stays held until the event arrives. An
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
   stay `disabled` until legend-hyq. Brevo 401, 403, 408, 429 and 5xx throw
   (retried, visible); other 4xx decline the message.
6. **Recipients come from server state only**, by event name:
   `approval.requested` goes to holders of the current level's approver roles
   whose assignment covers the outlet (requester excluded);
   `approval.resolved` to the requester; `support_access.*` to tenant admins
   (`org.settings.manage` on a tenant-wide assignment); checklist missed and
   failed alerts to the outlet's `supervisor`/`outlet_manager` roles, falling
   back to the tenant owner. An event without a rule throws, so it is retried
   and dead-lettered instead of dropped silently. Banned (disabled) or missing
   accounts are dropped from every audience and unreachable at send time; a
   malformed stored preference falls back to the defaults for that user only.
