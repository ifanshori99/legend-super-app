# 221b: second opinion, perbaikan race PIN edge (resend, counter ABA, lock lama)

Tingkat K (PIN staf: auth offline, sinkron offline, migrasi). Untuk second-opinion Codex lewat antrean. Tidak di-commit.

## Rentang diff

Cabang `ws/edge-pin-race-fixes` dari m1 `94d769c6`. Rentang: `git diff 94d769c6 <tip cabang>` (lihat `git log 94d769c6..ws/edge-pin-race-fixes`). Migrasi `0163_staff_pin_attempt_revision` (`when` 1794242000000; nomor dan prevId snapshot dapat diregenerasi merge train).

## Kartu

- legend-gauz3 (P1, asal 183b): job resend material PIN membaca baris PIN dan event set terakhir tanpa row lock, sehingga reset yang commit di antaranya membuat material lama terkirim dengan sequence lebih tinggi.
- legend-r11j7 (P2, asal 188b): counter cloud `3→0→3` di antara dua tarikan dianggap replay oleh edge; tiga kegagalan baru hilang.
- legend-lhffb (P2, asal 188b): lock dari backlog node asal dengan sequence ≤ sequence set generasi lolos lewat cabang timestamp setelah jam edge mundur, sehingga mengunci PIN baru.

## Berkas berisiko

- `apps/api/src/edge/staff-pin-resend.ts` (`resendMateriallessStaffPinSets`)
- `apps/api/src/edge/access-applier.ts` (`applyStaffPinLocked`; bandingkan dengan guard `applyStaffPinSet`)
- `apps/api/src/services/staff-pin-sync.ts` (ekspor `listStaffPinRecordsSince`, `applyStaffPinRecords` cabang material sama)
- `apps/api/src/db/schema/device-pin.ts`, migrasi `apps/api/drizzle/0163_staff_pin_attempt_revision.sql` (kolom `attempt_revision`, `cloud_attempt_revision`, trigger `staff_pins_attempt_revision`)
- `packages/shared/src/access/override.ts` (`staffPinEdgeRecordSchema.attemptRevision`, opsional)
- `apps/api/src/edge/cloud-http.ts` (penarik selalu mengirim `revision=1`), `staffPinSyncQuerySchema` di `staff-pin-sync.ts`
- Penulis lain `staff_pins`: `apps/api/src/services/device-pin.service.ts` (set/reset, verifikasi), job sinkron tarikan

## Invariant

- Event `staff_pin.set` dengan material lama tidak pernah mendapat sequence di atas set yang lebih baru untuk agregat yang sama; `appendDevicePinEvent` selalu dipanggil di bawah row lock baris PIN.
- Tidak ada deadlock baru antara resend, reset, verifikasi PIN, apply lock, dan apply tarikan.
- Lock dari node asal generasi dengan sequence ≤ sequence set generasi tidak pernah diterapkan, apa pun timestamp-nya; lock node lain dan lock node asal dengan sequence lebih tinggi tetap diterapkan seperti sebelumnya.
- Setiap perubahan counter atau material (hash/salt) menggerakkan `attempt_revision`; perubahan lock saja tidak (lock digabung edge berdasarkan nilai). Aplikasi tidak dapat menyetel atau melewatinya.
- Ekspor membawa `attemptRevision` hanya bila edge meminta `revision=1`; edge lama (schema strict) tidak pernah menerimanya.
- Edge menaikkan counter bila revisi cloud bergerak dari baseline dan nilai cloud di atas nilai lokal; replay (resync penuh, ekspor ulang tanpa mutasi) tidak memulihkan counter atau lock yang sudah dibersihkan edge (legend-7vv8h).
- Baseline revisi kosong (baris lama) atau record tanpa revisi (cloud lama): perbandingan nilai seperti sebelumnya, lalu baseline revisi disimpan.
- Counter tidak pernah diturunkan oleh tarikan; hash dan salt tidak masuk log atau error.

## Pertanyaan untuk second opinion

- Resend: job membaca id kandidat tanpa lock, lalu satu transaksi per baris (advisory lock outlet + `FOR UPDATE` satu baris). Apakah masih ada jalur deadlock dengan penulis `staff_pins` lain yang mengunci lebih dari satu baris atau memakai advisory lock dalam urutan lain? Apakah ada jalur append event PIN lain yang masih tanpa row lock?
- Revisi: restore/backup cloud yang membuat revisi mundur, baris PIN dihapus lalu dibuat ulang (revisi kembali 0), atau trigger yang tidak berjalan pada jalur tertentu (COPY, replika logis). Apakah ada kasus counter atau lock melemah?
- Rollout: flag `revision=1` opt-in. Edge baru ke cloud lama (query strict) mendapat 400 di tiap halaman; urutan rilis cloud dahulu dan tanpa rollback cloud. Apakah perlu fallback tanpa flag?
- Guard lock: apakah guard baru menolak lock sah (misal node yang sama dibangun ulang dengan sequence reset)?
