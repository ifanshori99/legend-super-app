# Brief 210b: second opinion — write-off nomor struk ke edge (legend-jcby0)

Peran: second-opinion (Codex). Baca saja, jangan mengedit. Tingkat K (nomor dokumen, sinkron edge).

## Lokasi
Repo `/Users/ifanshori99/Projects/legend super app/legend`, cabang `ws/receipt-writeoff-edge-sync` (worktree `.worktrees/receipt-writeoff-edge-sync`). Basis `integ/m1-batch27` f448cf94, commit pertama = merge `ws/receipt-run-self-heal` 996cc889 (legend-hfq3z, ditinjau terpisah di brief 204b). Diff kartu ini: `git diff <merge-commit>..ws/receipt-writeoff-edge-sync` (merge commit = parent pertama commit kartu, lihat `git log --oneline -3`).

## Masalah
`receipt_number_writeoffs` (legend-0hzqw, migrasi 0156) hanya dibuat di cloud. Pull registri perangkat (`apps/api/src/services/edge-device-sync.ts`) hanya membawa `receipt_sequences`, jadi Tutup Hari di edge (port cek celah sama dengan cloud) tetap ditolak `RECEIPT_SEQUENCE_GAP` sesudah owner melakukan write-off di cloud.

## Perbaikan
- Kontrak (`packages/shared/src/edge/schemas.ts`): `deviceReceiptWriteoffSyncSchema`, `RECEIPT_WRITEOFF_SYNC_MAX` 1000, field halaman opsional `receiptWriteoffs`.
- Cloud (`listDeviceRecordsSince`): untuk `?receiptWriteoffs=1`, daftar write-off outlet (tenant + outlet node), 1000 terbaru diurut lama ke baru, dibaca dalam savepoint (gagal = field tidak dikirim).
- Edge (`applyDeviceReceiptWriteoffs`, `pullDeviceRegistry`): primary dengan binding saja, sesudah sequences, sekali per pull. Salin dengan id cloud bila edge memegang run sama (id, outlet, prefix) dan `last_number >= nomor` dan tidak ada struk lokal untuk nomor itu; `onConflictDoNothing`, savepoint per baris, 23514 dilewati, galat lain = seluruh daftar ditolak (tidak memutus pull).
- Fetcher (`apps/api/src/edge/cloud-http.ts`): kirim `receiptWriteoffs=1` bersama sequences bila ada `edgeInstanceId`; 400 → ulang tanpa itu, lalu rantai lama.
- Cek celah (`writeoffOrdinalsBySequence`, `pos-receipt.service.ts`) tidak diubah: sudah menghitung write-off lokal dan aturan struk terlambat.
- Tanpa migrasi.

## Pertanyaan untuk dijawab
1. Adakah jalur di mana edge menghitung nomor sebagai ada padahal nomor itu masih bisa diterbitkan atau masih dalam perjalanan sinkron (restore DB edge, clone, rotasi zsdd, heal hfq3z, pensiun sduiq)?
2. Isolasi tenant/outlet di cloud dan edge (RLS/FORCE RLS, id dari payload).
3. Idempoten dan perilaku saat daftar > 1000, baris rusak, galat baca cloud.
4. Kompat: edge lama + cloud baru, edge baru + cloud lama, rollback cloud; urutan rilis cloud dulu.
5. Interaksi dengan halaman ganda di satu pull dan dengan rantai 400 hfq3z.

## Bukti engineer
Repro gagal di basis (probe: sesudah 2 pull, Tutup Hari edge tetap `RECEIPT_SEQUENCE_GAP`); angka test akhir, tsc, dan SHA di komentar kartu legend-jcby0.

## Keluaran
Temuan saja: file:baris, skenario gagal konkret, tingkat (blocker/major/minor), usul perbaikan. Maks 700 kata.
