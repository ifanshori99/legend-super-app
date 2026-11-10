# sub brief: write-off nomor struk untuk run milik edge (legend-drzaf)

Worktree: `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/receipt-writeoff-edge-runs` (cabang `ws/receipt-writeoff-edge-runs`). Path di bawah relatif ke `apps/api/` kecuali disebut lain. Jangan commit; agent induk yang commit.

## Masalah
Run (`receipt_sequences`) yang terikat edge (`edge_node_id` terisi lewat `claimDeviceReceiptSequencesForEdge`, `src/services/pos-receipt.service.ts:~905`) punya `last_number` cloud = 0 selamanya (edge yang menomori; legend-ol6v belum ada). Cloud hanya tahu angka tertinggi edge lewat `edge_reported_number` (high-water laporan `receiptRuns` saat pull, `pos-receipt.service.ts:~1123-1143`, tidak pernah turun; hanya jalur claim cloud yang menulisnya, baris di DB edge tetap 0).
Write-off cloud (`src/services/pos-receipt-writeoff.service.ts:108`, `input.sequenceNumber > sequence.lastNumber`) dan trigger `app.receipt_number_writeoffs_check_insert` (0156, `src/db/schema/pos-receipt-writeoff.custom.sql`, `NEW.sequence_number > seq.last_number`) menolak semua nomor run edge, jadi salinan ke edge (`src/services/edge-device-sync.ts:~809-884`) tidak pernah jalan.

## Keputusan
Batas = `GREATEST(last_number, edge_reported_number)` (service: `Math.max(sequence.lastNumber, sequence.edgeReportedNumber)`), tanpa syarat binding: untuk run tak terikat `edge_reported_number` = 0, jadi perilaku sama. Nomor <= high-water sudah dialokasikan dan di-commit di edge, jadi tidak bisa terbit lagi (restore yang turun = run dipensiunkan `edge_regressed`). Di DB edge kolom itu 0, jadi trigger di edge tetap ketat (`last_number` lokal). Cek struk cloud dan cek duplikat tetap.

## Bagian A (implementer): service + trigger + migrasi
1. `src/services/pos-receipt-writeoff.service.ts`: ganti cek batas sesuai keputusan, komentar singkat rujuk legend-drzaf. Pesan galat tetap sama.
2. `src/db/schema/pos-receipt-writeoff.custom.sql`: fungsi `check_insert` pakai `s.last_number, s.edge_reported_number` dan `NEW.sequence_number > GREATEST(seq.last_number, seq.edge_reported_number)`; perbarui komentar.
3. Migrasi baru `drizzle/0166_receipt_writeoff_edge_reported.sql`: hanya `CREATE OR REPLACE FUNCTION app.receipt_number_writeoffs_check_insert()` dengan body yang sama persis dengan custom.sql (header komentar legend-drzaf). Journal `drizzle/meta/_journal.json`: idx 166, `when` 1794245000000, tag `0166_receipt_writeoff_edge_reported`. Ikuti pola migrasi trigger-only sebelumnya untuk snapshot (cek apakah migrasi custom-only lain menyalin snapshot sebelumnya sebagai `0166_snapshot.json`; tiru polanya) supaya `pnpm --filter api db:generate` (atau skrip setara di repo) tidak menghasilkan apa pun. Jangan jalankan tsc/test; agent induk menjalankan.

## Bagian B (test-writer): test reproduksi
File baru `src/test/pos-receipt-writeoff-edge-run.test.ts`. Tiru fixture/helper dari `src/test/pos-receipt-restore-detect.test.ts` (claim lewat `claimDeviceReceiptSequencesForEdge` / pull `listDeviceRecordsSince` dengan `receiptRuns`) dan helper write-off dari `src/test/pos-receipt-writeoff.test.ts` (panggil `writeOffReceiptNumber` asli, bukan SQL). Jangan suntik `last_number` manual.
Kasus:
1. Run terikat edge, edge melaporkan counter 5 (high-water 5) → write-off nomor 3 di cloud berhasil (201/objek), nomor 6 ditolak CONFLICT "Nomor struk di luar rentang yang sudah terbit.".
2. Nomor yang sudah punya struk di cloud tetap ditolak; write-off ganda tetap ditolak.
3. Backstop trigger: insert SQL owner langsung nomor 6 (di atas high-water) ditolak (23514); nomor <= high-water diterima.
4. Bila mudah dengan simulasi edge yang ada di `src/test/edge-pull-writeoffs.test.ts` (DB edge = outlet edge): write-off itu tersalin ke run edge lewat `pullDeviceRegistry` dan gap edge tidak lagi memuatnya. Bila terlalu berat, lewati dan tulis alasannya di laporan.
Test harus gagal di kode basis (kasus 1 dan 3) dan lulus setelah Bagian A. Jalankan sekali di basis untuk membuktikan gagal:
`bash -c 'cd "/Users/ifanshori99/Projects/legend super app/legend/.worktrees/receipt-writeoff-edge-runs" && pwd && LEGEND_TEST_FILES="src/test/pos-receipt-writeoff-edge-run.test.ts" pnpm test'` (output disaring: hanya ringkasan dan galat). Catatan: Bagian A berjalan bersamaan dan bisa mengubah service; bila trigger belum dimigrasi tetapi service sudah, kasus 1 tetap gagal di trigger, itu wajar. Laporkan hasilnya apa adanya.

## Bagian C (implementer): runbook
`docs/runbooks/receipt-number-writeoff.md` (root repo), bagian "### Outlet dengan edge" dan "Kemungkinan penolakan" serta catatan rilis:
- Jelaskan: untuk run milik edge, batas nomor adalah nomor tertinggi yang sudah dilaporkan edge ke cloud; edge harus sudah sinkron (pull) setelah nomor itu terbit, kalau belum write-off ditolak 409 "di luar rentang" → tunggu sinkron lalu ulangi.
- Pulihkan jalan sementara untuk outlet yang belum upgrade (cloud tanpa legend-drzaf, atau edge sebelum legend-jcby0): tutup hari lewat cloud (gap cloud untuk run edge dihitung dari `last_number` cloud yang 0, jadi cloud tidak menahan).
- Catatan rilis: migrasi 0166 (ganti fungsi trigger saja, tanpa ubah tabel), rilis cloud dulu.
Bahasa Indonesia, gaya sama dengan isi runbook. Ringkas.
