# 158: second opinion, klasifikasi event edge ke cloud (legend-eadm + legend-niq9)

Tingkat K (sync offline). Untuk second-opinion Codex lewat antrean. Tidak di-commit.

## Rentang

- Cabang `ws/edge-event-class`, worktree `.worktrees/edge-event-class`.
- Basis `21edd29b` (integ/m1-batch5) sampai `2216e2b7`.
- `git diff 21edd29b..2216e2b7`

## Klaim bead dan hasil reproduksi

- Klaim legend-eadm: di cloud, `pos_override.*` dan `staff_pin.*` dari edge melempar `EdgeEventUnclassifiedError`, batch rollback, link macet.
- Test R (`apps/api/src/test/edge-event-class.test.ts`, describe "R") membantah klaim itu di basis ini. Batch campuran (`pos_override.recorded`, `staff_pin.set`, `staff_pin.locked`, aggregate tak dikenal, `stock.moved`) diterapkan utuh. Kursor maju 5, `stock.moved` masuk ledger, empat lainnya diparkir. Penyebabnya: legend-9fhs sudah memasang fallback `unclassified`.
- Catatan: R dijalankan dengan perubahan yang sudah ada di pohon kerja, bukan di basis bersih. R tidak memastikan `parked_reason`, jadi hasilnya tetap berlaku untuk basis.
- Celah nyata yang tersisa:
  - Event akses diparkir `unclassified`, padahal event itu dikenal.
  - Event `unclassified`, termasuk `stock.*` selain `stock.moved` (niq9), diparkir tanpa alarm.

## Perubahan

1. `apps/api/src/edge/deferred-event-applier.ts`
   - `applyEdgeDeferredEvent` mengembalikan `true` hanya bila baris parkir baru dimasukkan (`returning`). Redelivery mengembalikan `false`.
   - `registerAccessDeferredEdgeApplier()`: aggregate `pos_override` dan `staff_pin` didaftarkan lewat `registerDeferredEdgeAggregate`, jadi `parked_reason='deferred'` dengan kind `transaction_event`. Kind ini sama dengan fallback sebelumnya, sehingga sequence dan kursor tidak berubah.
   - `applyUnclassified`: setelah baris parkir BARU, alarm dikirim ke supervisor outlet dalam savepoint bersarang dengan catch diam.
2. `apps/api/src/edge/runtime.ts`: satu import dan satu panggilan di blok registrasi `registerEdgeLink`, di antara POS dan fallback. Izin CTO hanya untuk titik ini.
3. `apps/api/src/services/edge-sync-conflict-alert.ts`
   - Kode penerima dipisah ke `notifyOutletSupervisors`; perilaku `notifyEdgeSyncConflictRecorded` tidak berubah.
   - `notifyEdgeEventParkedUnclassified` baru mengirim nama event, aggregate type dan node saja, tanpa payload. Id alert memakai `createUlid` sendiri.
   - Dedupe: alarm dilewati bila `notification_outbox` sudah punya `edge_event.parked_unclassified` untuk (tenant, outlet, `payload->>'aggregateType'`, `payload->>'eventName'`) dalam 24 jam. Hitungannya dari alarm yang benar-benar terkirim, jadi alarm yang hilang (tanpa supervisor, atau savepoint gagal) tidak membungkam event berikutnya, dan trafik terus-menerus tetap beralarm sekali per 24 jam.
4. Test:
   - `edge-event-class.test.ts` baru: R, A (klasifikasi dan 1 alarm), B (alarm gagal di DB, batch tetap jalan), C (`stock.adjusted`), D (storm 1 alarm per nama; baris parkir yang sudah ada tidak beralarm).
   - B juga memastikan event berikutnya beralarm setelah alarm pertama hilang; D memastikan alarm kembali setelah 24 jam (outbox dimundurkan 25 jam).
   - `edge-order-deferred.test.ts`: registrasi mengikuti runtime.ts; nama "tak dikenal" diganti `zz_unknown.recorded`.

## Invarian yang harus dijaga

- Satu event edge->cloud yang tak dikenal tidak boleh menahan batch. Hanya dua hal yang boleh membatalkan batch: penolakan scope dan kegagalan DB nyata.
- Kegagalan alarm tidak boleh menggagalkan batch. Baris parkir adalah bukti yang awet.
- Redelivery, termasuk event id yang sama dari primary dan standby, tidak menulis apa pun dan tidak beralarm. Event itu dilewati di `edge_received_events` sebelum applier jalan.
- Alarm tidak membawa payload atau data pribadi. Penerima di-scope tenant dan outlet (`supervisorIds`).
- `edge_deferred_events` menyimpan envelope utuh untuk replay nanti (legend-kyie). Tidak boleh di-prune sebelum diterapkan.

## Temuan review K dan status

- Reviewer Opus:
  - Storm alarm per event (medium): DIPERBAIKI dengan dedupe 24 jam per nama event dan outlet.
  - Id alarm = id event edge, bentrok unique (tenant, source_event_id) dengan replay nanti (low): DIPERBAIKI, id alarm memakai ULID sendiri.
  - Test redelivery tidak menguji jalur `!parked` (low): DIPERBAIKI, test D kedua.
  - Re-review: dedupe awal memeriksa baris parkir, bukan alarm; trafik terus-menerus atau alarm pertama yang hilang membungkam nama itu selamanya (medium): DIPERBAIKI, dedupe pindah ke `notification_outbox`, ditambah test pemulihan.
- Architect:
  - Storm alarm (medium): DIPERBAIKI, sama dengan temuan reviewer.
  - `edge-order-deferred.test.ts` masih menganggap `pos_override.recorded` unclassified (low): DIPERBAIKI.
  - Kategori alarm sama dengan `edge_sync_conflict`, jadi mute ikut terbawa: bead legend-vw3d (P3).
  - Cloud tidak menerapkan event PIN dan override: celah lama, di luar bead ini. Bead legend-kyie (P1, K).

## Yang perlu dilihat second opinion

- Dedupe 24 jam: dua batch bersamaan (primary dan standby) dengan event berbeda tapi nama sama bisa mengirim 2 alarm. Ini diterima.
- Query dedupe memakai filter jsonb di `notification_outbox` tanpa index khusus; volumenya kecil per tenant, tapi perlu dilihat bila outbox besar.
- Apakah ada konsumen yang bergantung pada `parked_reason='unclassified'` untuk event akses. Architect: tidak ada kode production yang membaca nilai itu.
