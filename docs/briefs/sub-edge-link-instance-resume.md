# Sub-brief: edge link resume per instance (legend-nd3cu, tier K)

Worktree `.worktrees/edge-link-instance-resume`, branch `ws/edge-link-instance-resume` (base `ws/edge-pin-instance` e1100258).
Status: approved by CTO. Migration 0162 (journal when 1794241000000).

## Why a migration is needed
- Cloud keeps one `sync_cursors` row per (tenant, node, direction). After an edge DB rebuild (same node id, new `edge_nodes.instance_id`) the cloud still holds received_in_seq R (edge_to_cloud) and acked A / head N (cloud_to_edge); the new edge restarts at 0.
  - edge_to_cloud: cloud hello sends R; edge head < R -> 1008 "Peer cursor is ahead" on every reconnect; once head >= R the edge's events 1..R are acked as duplicates and never applied (the P1).
  - cloud_to_edge: edge hello 0 -> cloud resends from 0: pruned rows -> "Outbound queue is not contiguous" (1008 loop), else old QR orders replayed into the new DB.
- The cloud must remember which edge instance the cursors belong to. No existing place:
  - Cloud `edge_nodes.instance_id` is documented "Cloud rows NULL" and `pos-receipt.service.ts:263-280` `boundToThisDatabase` reads it: writing the edge's instance there would make the cloud treat edge-bound receipt sequences as its own (document numbers). Not usable.
  - `sync_cursors_forward_only` (edge-node.custom.sql:61-77) blocks lowering cursors, so a plain reset is also out.

## Design (cloud-side offset, no protocol change)
- Migration: `sync_cursors` + `peer_instance_id uuid` (null = unknown / old edge) + `peer_seq_offset bigint NOT NULL DEFAULT 0` (check 0 <= offset; offset <= next_out_seq / received_in_seq). Extend the forward-only trigger: offset never decreases. RLS unchanged (same table).
- Cloud `db-link-store` translates between the edge's numbering and the stored (monotonic) cursors:
  - inbound (edge_to_cloud): `lastReceivedInbound = received - offset`; `applyInbound` checks and stores `offset + toSeq`.
  - outbound (cloud_to_edge): `outboundHead = next - offset`, `lastAckedOutbound = acked - offset`, `readOutbound(after)` reads rows after `after + offset` and reports `linkSeq - offset`, `ackOutbound(e)` stores `offset + e`.
- Resume step on the cloud, before the peer sends `hello` (one tx, both rows FOR UPDATE), only when the link header carries instance I:
  - stored instance = I: nothing.
  - stored null (fresh node or edge upgraded in place): adopt I, offset unchanged.
  - stored J != I (rebuilt/restored DB): set I; edge_to_cloud offset = received_in_seq; cloud_to_edge offset = acked_out_seq (unacked A+1..N still delivered to the new DB, nothing replayed below A).
- No header (old edge): no resume step, offset stays 0, behaviour identical. Edge side unchanged; frames unchanged; old cloud ignores the header.
- Fail-closed for a same-instance restored snapshot stays (restore runbook resets instance_id -> that path becomes the rebase path).

## Evidence planned
- Real WS link test with createDbLinkStore on both sides (two scopes/rows in one Postgres via a cloud store and an edge store): rebuilt instance, cloud ahead -> new PIN set event reaches applier and is applied exactly once; no repeated 1008; old edge without header unchanged (1008 as before); other tenant's cursors untouched. Must fail on e1100258.
- Plus edge-received-events-migration.test.ts, migration-fk-force-rls.test.ts, edge-link, edge-db, edge-pin-instance.

## Known limit
- A rebuild done in the same step as the upgrade from an edge that never sent its instance (stored null + progress) is adopted, not rebased: keep the old runbook (enroll as new node) for that one case.

## Final design (supersedes "Resume step" above)
- Migration 0162: `sync_cursors.peer_instance_id uuid`, `peer_seq_offset bigint NOT NULL DEFAULT 0`; check `peer_seq_offset >= 0 AND peer_seq_offset <= GREATEST(acked_out_seq, received_in_seq) AND (peer_instance_id IS NOT NULL OR peer_seq_offset = 0)`. Trigger `sync_cursors_forward_only` adds: offset never decreases; offset changes only when instance goes from a non-null value to a different non-null value; instance never goes back to null.
- `LinkStore` gets one optional hook `onPeerHello(peerCursor)` (link-peer.ts). When present, this side's own hello is sent from onHello after the hook, not at start (the peer sends its hello unconditionally). Cloud db-link-store defines it only when `edgeInstanceId` is non-null.
- bindPeer(c), both rows in one tx (rev 2 after Review K):
  - stored = I nothing; null adopt I (offset unchanged).
  - J != I and c == 0 (rebuilt DB): instance I; edge_to_cloud offset = received_in_seq; cloud_to_edge offset = acked_out_seq.
  - J != I and c > 0 (restored/cloned DB): LinkProtocolError (1008), nothing changed.
- Every op translates by the row's offset; a row bound to instance X refuses (LinkProtocolError) any link whose instance is not X, including a link with no instance.
- Edge side and old edges (no header): hooks no-op, offset 0 -> identical behaviour.

## Part T (test-writer): new file apps/api/src/test/edge-link-instance-resume.test.ts
Do not edit src/edge/*, schema or migrations. Do not commit. Run nothing heavy; you may run your file with `LEGEND_TEST_FILES="src/test/edge-link-instance-resume.test.ts" pnpm test` from the worktree root (expected to FAIL on the current base: that is the point; report how it fails).
- Real WebSocket: `createEdgeLinkServer` (cloud) with `storeFor` = `createDbLinkStore` on the test DB (outboundDirection cloud_to_edge, edgeInstanceId from identity, real appliers), and `createEdgeLinkClient` (edge) with an IN-MEMORY LinkStore emulating the edge DB (see edge-link.test.ts helpers, edge-link-hardening-2.test.ts emptyStore). Reuse fixtures from edge-pin-instance.test.ts / edge-pin-adoption.test.ts (tenant, outlet, registerNode, staff, pin set events, pinRow).
- Scenario A (rebuild): edge store #1 with instance I1 sends several edge_to_cloud events (incl. a staff_pin.set) -> cloud received R >= 3; cloud enqueues >= 2 cloud_to_edge events (use edge-queue.service enqueue) that store #1 acks (A); then enqueue 1 more cloud_to_edge event (pending, not delivered: disconnect first). Disconnect. Fresh store #2 (all cursors 0) with instance I2 and one new staff_pin.set (new event id, sequence 1, newer setAt, other pin) -> assert: staff_pins row now has I2 generation + new hash, applied exactly once (edge_inbound_events outcome 'applied' for that event, one row); store #2 got ack for it; the pending cloud_to_edge event reaches store #2 exactly once and nothing at or below A is replayed; no close with code 1008 during phase 2 (record client close codes / server onError); a reconnect of store #2 (same I2) resumes without rebase and without duplicate apply.
- Scenario B (old edge, no instance header): same phase 1 without instance, then fresh store without instance -> behaves as before: link refused with 1008 ("Peer cursor is ahead") and nothing applied/acked (fail closed). sync_cursors.peer_instance_id stays NULL, offset 0.
- Scenario C (isolation): a second tenant's node with its own cursors; after scenario A its sync_cursors rows (all columns) are unchanged.
- Scenario D (trigger, after migration 0162): direct SQL as the test owner on a sync_cursors row: offset change with same instance refused; offset decrease refused; instance set back to NULL refused; instance J -> I with higher offset allowed; cursors still cannot decrease.
Report: test names, how each fails on the base.
