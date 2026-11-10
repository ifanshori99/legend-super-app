# Brief: second-opinion — deteksi database edge hasil restore/clone (legend-yd0h8)

## Peran
Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti.

## Repo
Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/edge-restore-detect`, cabang `ws/edge-restore-detect`.
Rentang diff: `git diff 12c91f6b..ws/edge-restore-detect` (base = ujung `milestone/m1` 12c91f6b, sudah memuat zsdd; abaikan `apps/api/drizzle/meta/*.json` dan `docs/`). Jangan pakai `merge-base main`. Migrasi cabang ini `0154_receipt_sequence_restore_detect` (0153 milik ws/edge-pin-pull).
Desain: `docs/briefs/sub-edge-restore-detect.md` (bagian Design) di worktree itu; desain zsdd: `docs/briefs/sub-receipt-seq-edge.md`.

## Berkas berisiko
- `apps/api/src/services/pos-receipt.service.ts` (`claimDeviceReceiptSequencesForEdge`: high-water, regresi, rate limit, alert; `localReceiptRunReport`; `retireSequence` dengan alasan)
- `apps/api/src/services/edge-device-sync.ts` (query `receiptRuns`, `listDeviceRecordsSince`, `pullDeviceRegistry`, `splitPage`)
- `apps/api/src/edge/cloud-http.ts` (param `receiptRuns`, fallback 400 bertahap), `apps/api/src/edge/runtime.ts`, `apps/api/src/edge/device-registry-puller.ts`
- `apps/api/src/db/schema/pos-receipt.ts`, `apps/api/src/db/schema/pos-receipt.custom.sql`, `apps/api/drizzle/0153_receipt_sequence_restore_detect.sql`
- `packages/shared/src/edge/schemas.ts` (`encodeReceiptRunReport`, `decodeReceiptRunReport`, `receiptRunReportQuerySchema`, `receiptRunAlert`), `packages/shared/src/edge/endpoints.ts`

## Invariant (PRD)
- POS-06 / §3 F8: satu nomor struk tidak pernah terbit dua kali di satu outlet; nomor berurutan per perangkat; void tidak mengembalikan nomor.
- Database edge yang di-restore dari backup/snapshot atau di-clone (instance_id sama) tidak boleh mencetak ulang nomor yang terbit sesudah backup, bila cloud sudah melihat laporan counter yang lebih tinggi. Laporan normal (maju/sama) tidak boleh memicu rotasi.
- Dua database hidup pada satu node id: rotasi dibatasi (maks 2 per perangkat per 24 jam), lalu peringatan di status edge; tidak berputar tanpa batas.
- EDG-02: pull registri perangkat tidak boleh berhenti karena urutan struk atau laporan counter.
- TEN-01/TEN-02: tenant dan outlet hanya dari kredensial edge yang terverifikasi.
- Kompatibilitas: edge lama tanpa `receiptRuns` tetap jalan dan tidak menerima field halaman baru; edge baru di cloud zsdd atau cloud lebih lama tetap menarik registri. Rilis: cloud dulu.
- Batas yang diketahui (bukan temuan kecuali ada perbaikan murah): restore yang menjual melewati high-water sebelum pull pertama, atau backup lebih baru dari pull terakhir, tidak terdeteksi (legend-ol6v).

## Effort
xhigh.

## Laporan
Satu baris per temuan: `path:baris`, tingkat, masalah, skenario gagal, saran perbaikan. Tidak ada temuan: satu baris.

## Larangan
Jangan edit atau commit. Jangan baca `.env*` atau `~/.ssh`.
