# hsk review 1 (Opus, tier K): fix all four

1. Late grant after revoke leaks access (edge-wifi-agent.service.ts:315-345, 383; simulator.ts:177). Pending row C authorize in flight; endSession revokes C before the controller knows it (no-op, simulator keeps no record); C marked revoked; authorize(C) lands -> device online up to 4h05, never revoked again. Also supersede of the old row (316-333) runs even if the new row's update matched 0 rows, pushing an old active row whose revoke failed into terminal superseded.
   Fix: supersede only after the new row's update returns a row; if authorized && updated.length === 0 && current status revoked -> provider.revoke again; the simulator records references revoked before authorize, and a later authorize of such a reference is refused (provider contract: a revoked reference never authorizes again).
2. Replayed authorize trusts retry time (agent :338-339): authorizedAt/expiresAt = at + duration on a replay, but the controller counts from the first apply -> agent renews/downgrades too late -> cut. Fix: conservative expiry = time of the first attempt (requestedAt) + durationSeconds.
3. Agent never restarts after its DB client is lost, or when the boot advisory lock loses to an exiting process (runtime.ts:304, 323-327) -> no renewals, all guests cut within ~4 h, applies 503. Fix: retry lock acquisition with backoff (stop cleanly on shutdown).
4. One bad walled-garden input stops all renewals (agent :739, used 777/801/826): buildWalledGarden throws (IPv6 literal origin "[::1]", >100 hosts) inside reconcile -> steps 3-5 never run -> devices cut. Fix: catch in reconcile, fall back to the last good list (or inFlightGarden), log name/code only; renew/downgrade must keep running.

Each fix needs a regression test that fails before the fix.
