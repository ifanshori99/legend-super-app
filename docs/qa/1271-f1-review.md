# Review K F1 failover kontrak + skema (ws/1271-f1 2db8e6fd3)

Reviewer: architect (Opus xhigh), 26 Nov. Hasil: **LULUS bersyarat**. Bukti: `edge-failover-schema`, `edge-db`, `data-import-registry` 65/65; kontrak F1 4/4; urutan journal 0529 benar.

## Wajib sebelum merge
1. P2: tabel window di edge punya FK `activated_by`, `return_started_by`, `cancelled_by` ke `user`. Manager pengaktif belum ada di people snapshot edge -> event `state` gagal diterapkan -> edge tetap jual saat cloud jual = kas dobel. Hapus tiga FK itu di `apps/api/src/db/schema/edge-failover.ts`, buat ulang 0529.

## Ubah brief sebelum kartu mulai
2. F2: run `C` kini berseri `cloud`. Filter `series='device'` di `findSequenceRow`/`ensureSequence` membuat run C tak ketemu -> insert C lagi kena `receipt_sequences_prefix_key` -> jual cloud tanpa perangkat gagal. Pakai `series <> 'failover'` atau seri eksplisit; `insertSequence` terima `series` eksplisit.
3. F4: `idempotency_key` salinan window di edge = id window (tidak ada di `failoverWindowSchema`).

## Diterima
- Nama event `pos_failover_window.state` / `.closed`; F0/F3/F4 wajib pakai konstanta ini.
- `receiptRunPrefixSchema` (F boleh di cloud); skema menuju edge tetap ketat. Penjaga F di daftar perangkat = filter F2 + test "edge pull tanpa F-run".
- Run C lama ditandai `cloud`; trigger kunci seri dibuat sesudah UPDATE.
- `pos.failover.manage` untuk owner/outlet_manager/supervisor (pola 0523).
- `failover_window_id` dikunci sejak insert: F3 wajib mengisinya di semua jalur insert order/shift (split, merge, pindah bill).

## Catatan
- F5: `receipt-writeoff.ts` menolak F -> celah nomor run F tidak bisa dihapuskan.
- Nit: `return_started_by`/`cancelled_by` belum diikat status lewat check; `businessDates` max 31.

## Keputusan CTO 27 Nov
- general_manager tidak dapat `pos.failover.manage` (sesuai brief; pilih yang membatasi). Owner/outlet_manager/supervisor cukup.
- Window > 31 hari tidak realistis; batas 31 tetap. Edge mati > 31 hari = runbook cabut node (F7).
- Nit check status dikerjakan sekalian bersama perbaikan no. 1 (migrasi masih di F1).
