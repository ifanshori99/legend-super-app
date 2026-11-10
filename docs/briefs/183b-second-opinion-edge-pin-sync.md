# 183b: second opinion, sinkron PIN edge-cloud berurutan commit dan audit override edge

Tingkat K (PIN staf: hash rahasia, auth offline, sinkron offline, audit, migrasi). Untuk second-opinion Codex lewat antrean. Tidak di-commit.

## Rentang diff

Cabang `ws/edge-pin-sync`, basis `fee69d45` (milestone/m1). Rentang: `git diff bddf8442 e420469e` (setelah merge m1 bddf8442; commit kerja b370ca64, f308916b, e420469e).

## Kartu

- legend-t9ii: ekspor PIN cloud ke edge berurutan commit; edge membandingkan kunci generasi, bukan jam.
- legend-zclb: job edge sekali jalan memancarkan ulang `staff_pin.set` dengan material untuk set PIN lama tanpa material.
- legend-7iti: audit cloud untuk override `cash_shift_close` dari edge membawa expected, counted, selisih.

## Berkas berisiko

- `apps/api/src/services/staff-pin-sync.ts` (ekspor keyset `sync_xid` + `pg_snapshot_xmin`, apply edge)
- Migrasi baru `staff_pins.sync_xid` + trigger
- `apps/api/src/edge/staff-pin-resend.ts`, `apps/api/src/edge/runtime.ts`
- `apps/api/src/edge/access-applier.ts` (`applyStaffPinSet` material sama, `applyPosOverrideRecorded`)
- `apps/api/src/services/staff-override.service.ts`, `core-audit-writer.ts`
- `packages/shared/src/access/override.ts`

## Invariant

- Watermark ekspor tidak pernah melewati baris yang commit terlambat; tidak bergantung pada jam aplikasi atau DB.
- Set PIN yang lebih lama tidak pernah menimpa yang lebih baru, di cloud maupun edge; bila sama, cloud menang. Jam edge yang tertinggal tidak membuat set edge yang lebih baru kalah bila edge sudah mengenal generasi cloud.
- Lock dan counter tidak pernah melemah karena replay atau pengiriman ulang material yang sama.
- Hash dan salt tidak pernah tersimpan di luar `staff_pins`: tidak di konflik, baris parkir, log, atau pesan error.
- Job pengiriman ulang idempoten; primary dan standby menjalankannya bersamaan tanpa efek ganda di cloud.
- Selisih hitungan buta tidak pernah sampai ke perangkat kasir; event cloud sendiri tetap tanpa selisih.
- Apply cloud tidak memancarkan event; tidak ada ping-pong.

## Pertanyaan untuk second opinion

- Keamanan `xid8` + `pg_snapshot_xmin`: transaksi panjang, restore dari dump ke cluster baru, replika.
- Urutan rilis: cloud sebelum edge.
