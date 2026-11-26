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

## Re-review 26 Nov (a1e67703b)

Reviewer: architect (Opus). Delta bb2948ed0..a1e67703b, test tidak dijalankan. Hasil: **LULUS** untuk merge; keputusan founder tetap terbuka.

### Temuan lama
1. Gerbang tiket, poin, dan meja: **tertutup**.
   - `routes/facility-pos-ticket.routes.ts` (jual dan credential), `routes/pos-points.routes.ts` (quote dan redeem), dan `routes/table-sessions.routes.ts` (staff-session plus 5 route `:sessionId`) kini digerbang.
   - Gerbang tiket dan poin dipasang sesudah permission guard.
2. Movement di luar daftar close: **tertutup**.
   - `edge/shift-day-applier.ts` `parkedOfShift` menolak close dengan `movement_unlisted`. ID yang tercantum dua kali ditolak dengan `movement_listed_twice`.
   - Kasnya tidak pernah ikut tercermin; shift ditolak final dan alert dikirim.
3. Test: **tertutup**.
   - Kasus baru: void terlambat, close datang lebih dulu lalu dicerminkan lewat redrive, standby saja, revoke.
   - 409 lewat HTTP ada di `test/pos-write-on-edge-gate.test.ts`.

### Temuan baru (RENDAH, tidak menahan merge)
- R1 `middleware/pos-on-cloud.ts` `requirePosWriteOnCloudForTableSession`:
  - Masalah: lima route `:sessionId` menjalankan gerbang sebelum cek izin `floor.table.operate` (izin baru dicek di handler) dengan scope tenant (`memberTenantContext`). Akibatnya anggota tenant tanpa izin mendapat 409, bukan 403/404, dan bisa menebak apakah sesi ada di outlet edge.
  - Perbaikan: panggil `assertPosWriteNotOnEdge` di handler sesudah `resolveFloorContext`.
- R2 `test/pos-write-on-edge-gate.test.ts:33-40`: daftar route belum mencakup tiket, poin, dan route `:sessionId`. Tambahkan supaya gerbang tidak hilang diam-diam.
- R3 `parkedOfShift` memfilter `envelope->'payload'->>'shiftId'` tanpa indeks. Cukup untuk volume satu outlet; pantau bila tabel parkir membesar.

### Keputusan founder
Masih terbuka: kasir buntu bila edge mati. Runbook "cabut node edge" wajib ada sebelum gerbang rilis.

### Jawaban founder 26 Nov (no. 29)
Edge mati -> jual di cloud lewat jendela failover (kartu `docs/briefs/1271-edge-failover-cards.md`, bead legend-sxj96). Gerbang E3 lolos saat jendela `active` (kartu F3). Runbook cabut node edge tetap ditulis di F7 sebagai jalan darurat.
