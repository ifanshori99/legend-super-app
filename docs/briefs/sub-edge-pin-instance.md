# Sub-brief: edge PIN instance id (legend-o839h, tier K)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/edge-pin-instance` (branch `ws/edge-pin-instance`). Do not commit; the engineer commits. Do not touch `worker-main.ts`, receipt_sequences, refund, payroll, pos-day, Better Auth.

## Problem
Cloud `applyStaffPinSet` (`apps/api/src/edge/access-applier.ts:~195-330`) orders edge pin sets. Row `staff_pins` keeps provenance `generation_edge_node_id` + `generation_edge_sequence`. Overwrite WHERE (line ~281):
`(gen_node = me AND gen_seq < seq) OR (gen_at < key AND NOT (gen_node IS NOT DISTINCT FROM me AND gen_seq >= seq))`.
An edge whose DB is rebuilt keeps its node id but its aggregate sequence restarts at 1, so its new set (newer key) is refused until the sequence passes the stored one. `applyStaffPinLocked` (~line 395) has the same same-node sequence branch.

## Design (decided)
- New nullable column `staff_pins.generation_edge_instance_id uuid`, written with the node id and sequence on adoption, cleared (null) on a cloud set (`apps/api/src/services/device-pin.service.ts:~248`).
- `EdgeApplyMeta` (`apps/api/src/edge/ports.ts:26`) gains `readonly edgeInstanceId?: string | null` (the sending edge database's `edge_nodes.instance_id`; null/absent = unknown, old edge).
- "Same origin" = `gen_node = me AND gen_instance IS NOT DISTINCT FROM my_instance` (my_instance = meta.edgeInstanceId ?? null). Replace both node-only checks in set and lock with same-origin. Consequences: old edge (never sends instance) => both null => exactly today's behaviour; different instance => key comparison only; same instance, lower/equal sequence => still refused.
- Carrier: the edge sends its instance id as WebSocket upgrade header `x-edge-instance` (link client). Cloud link server reads it after authentication (valid uuid only, otherwise treat as null; never refuse the connection for it), passes it into the identity, and `db-link-store.ts` (~line 291) puts it in meta. Old cloud ignores the header; old edge sends none.

## Part T (test-writer): repro tests
New file `apps/api/src/test/edge-pin-instance.test.ts`, modelled on `apps/api/src/test/edge-pin-adoption.test.ts` (copy its fixture setup: own tenant, outlet, cashier role, `registerNode`, `newUser`, `asEdge`, `setPin`, `setEvents`, `pinRow`, `afterAll` cleanup; add `generation_edge_instance_id` to PinRow). Call the appliers directly with meta `{ edgeNodeId, edgeInstanceId, direction: "edge_to_cloud", kind: "transaction_event", context }`. Simulate the rebuilt DB by taking a set event and re-labelling: lower `sequence` (e.g. 1), new event id (`createUlid`), newer `material.setAt`, other material (set a second pin and use its event, then rewrite sequence). Cases:
1. Rebuilt DB, same node, new instance: after instance I1 adopted a set at sequence N, a set from instance I2 with sequence 1 and newer key is `applied`; row then holds I2 + sequence 1; next I2 set with sequence 2 and stepped-back (older) key is adopted (same-origin sequence rule).
2. Same instance, lower/equal sequence, newer key: `not_applicable`, row unchanged.
3. Old edge without instance (edgeInstanceId absent on both): reproduce today's rucdm behaviour (later sequence wins with older key; lower sequence with newer key refused); row instance stays null.
4. Lock: I2 lock with lower sequence but `occurredAt` older than generation is refused when gen instance is I1... and a lock of the same instance with higher sequence after adoption-by-sequence is applied.
5. Cross tenant: a second tenant's node (own tenant/outlet/staff) applying with same instance id never changes tenant 1's row; RLS/tenant scope holds.
Run nothing heavy; the engineer runs tests. Report test names.

## Part L (implementer): link transport
Files: `apps/api/src/edge/link-client.ts` (optional `instanceId` option -> header `x-edge-instance`), `apps/api/src/edge/runtime.ts` (pass `local.instanceId` where the link client is created; only that wiring), `apps/api/src/edge/link-server.ts` (~line 281-305: read header after auth, uuid-validate, carry on identity), whatever identity type it uses, `apps/api/src/edge/db-link-store.ts` (~291: meta.edgeInstanceId), `apps/api/src/edge/ports.ts` (meta field). Add focused test(s) in the existing link-server / link-client test file proving: header is sent; cloud puts it in meta; missing/invalid header => null and connection still accepted. Do NOT edit access-applier.ts, device-pin files, schema, migrations. Report files changed + test names.
