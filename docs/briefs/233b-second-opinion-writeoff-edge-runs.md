# Brief 233b: second opinion — write-off nomor struk untuk run milik edge (legend-drzaf)

Peran: second-opinion (Codex). Baca saja, jangan mengedit. Tingkat K (migrasi, nomor dokumen). Effort xhigh (migrasi).

## Lokasi
Repo `/Users/ifanshori99/Projects/legend super app/legend`, cabang `ws/receipt-writeoff-edge-runs` (worktree `.worktrees/receipt-writeoff-edge-runs`). Basis `integ/m1-batch31` d7a95d0c. Diff: `git diff d7a95d0c..ws/receipt-writeoff-edge-runs`.

## Masalah
Run (`receipt_sequences`) yang terikat edge (`edge_node_id` terisi lewat `claimDeviceReceiptSequencesForEdge`) dinomori edge; `last_number` cloud tetap 0 (legend-ol6v belum ada). Write-off cloud (`pos-receipt-writeoff.service.ts`, `sequenceNumber > lastNumber`) dan trigger `app.receipt_number_writeoffs_check_insert` (0156) menolak semua nomor run edge ("Nomor struk di luar rentang yang sudah terbit"), jadi salinan write-off ke edge (legend-jcby0, `edge-device-sync.ts`) tidak pernah jalan. Ditemukan architect di 210b.

## Perbaikan
- Batas write-off = `GREATEST(last_number, edge_reported_number)` di service dan trigger (migrasi 0166, `when` 1794245000000, hanya `CREATE OR REPLACE FUNCTION`; snapshot salinan 0162).
- `edge_reported_number` (0154, legend-yd0h8): high-water counter yang dilaporkan edge primary lewat `receiptRuns` saat pull; tidak pernah turun; laporan lebih rendah memensiunkan run (`edge_regressed`). Hanya jalur claim cloud yang menulisnya; di DB edge kolom itu 0, jadi trigger di edge tetap `last_number` lokal.
- Cek struk cloud dan cek duplikat tidak berubah. Runbook `docs/runbooks/receipt-number-writeoff.md`: batas run edge dan jalan sementara tutup hari lewat cloud dipulihkan.

## Pertanyaan
1. Adakah nomor <= `edge_reported_number` yang masih bisa terbit (restore/clone sebelum pull pertama, laporan stale, heal hfq3z, rotasi zsdd, pensiun sduiq, `prefix_used`, run pensiun)? Apakah write-off di atasnya bisa membuat edge atau cloud menghitung nomor "ada" padahal struknya nanti terbit?
2. Apakah `edge_reported_number` bisa naik dari sumber yang tidak tepercaya (node standby, edge tanpa binding, tenant/outlet lain)?
3. Struk edge yang belum sampai cloud: write-off cloud diterima, edge melewati salinan (struk lokal). Akibat di laporan shift cloud dan Tutup Hari?
4. Migrasi: aman di cloud dan edge (FORCE RLS, `search_path`, urutan `when`, `db:generate` kosong), rollback.
5. Apakah test baru membuktikan jalur nyata (bukan `last_number` disuntik)?

## Bukti engineer
Di komentar kartu legend-drzaf: test reproduksi gagal di basis, lulus sesudah perbaikan, SHA, tsc.

## Keluaran
Temuan saja: file:baris, skenario gagal konkret, tingkat (blocker/major/minor), usul perbaikan. Maks 700 kata.
