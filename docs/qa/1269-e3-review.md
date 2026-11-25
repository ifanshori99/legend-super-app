# Review K E3 applier shift/kas/tutup hari (ws/1269-e3 bb2948ed0)

Reviewer: architect (Opus), 26 Nov. Hasil: **LULUS bersyarat**.

## Aman
- Kas tidak pernah tercatat dobel (applier idempoten per event).
- Migrasi 0528 (sementara) aman. Rendah: trigger tidak menjaga `edge_node_id`.

## Wajib dibetulkan sebelum gabung
1. SEDANG: `apps/api/src/routes/facility-pos-ticket.routes.ts:200` panggil `assertPosWriteNotOnEdge` sesudah `resolveFacilityOutlet`. Gerbang yang sama di `routes/pos-points.routes.ts:93,113` dan route table-sessions.
2. RENDAH: movement parkir yang tidak ada di daftar close ditolak `movements_mismatch` (`edge/shift-day-applier.ts:350`). Tetap tolak, tapi pesan dan test jelas.
3. Test kurang: void terlambat, tutup hari menunggu lalu tercermin, standby saja (tanpa primary), 409 `POS_WRITE_ON_EDGE` lewat HTTP.

## Keputusan founder
SEDANG: gerbang 409 `POS_WRITE_ON_EDGE` membuat kasir buntu bila edge mati.
- Keputusan founder 9 Nov (`docs/design/edge-cloud-failover.md`): boleh jual di cloud lewat jendela failover. Belum dibangun.
- Rencana architect 25 Nov (`docs/briefs/1269-scope-tambahan.md` bag. E): edge mati = promosi standby (F11b/c, drill F11e, legend-b3k), tanpa jual di cloud.
- Sementara F11 belum ada: runbook "cabut node edge" (cabut enroll → outlet kembali dilayani cloud).
- CTO tanya founder 26 Nov. Saran: mini PC cadangan (standby) saja + runbook darurat.
