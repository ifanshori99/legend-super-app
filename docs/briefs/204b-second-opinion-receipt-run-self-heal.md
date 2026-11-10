# Brief 204b: second opinion — receipt run self-heal (legend-hfq3z)

Peran: second-opinion (Codex). Baca saja, jangan mengedit. Tingkat K (nomor dokumen).

## Lokasi
Repo `/Users/ifanshori99/Projects/legend super app/legend`, cabang `ws/receipt-run-self-heal` (worktree `.worktrees/receipt-run-self-heal`), base `integ/m1-batch24` 94d769c6. Diff: `git diff 94d769c6..ws/receipt-run-self-heal`.

## Masalah
Cloud merotasi run struk perangkat (mis. legend-yd0h8 `edge_regressed`). Edge primary menolak run pengganti karena prefix atau id sudah ada di database lokalnya. legend-sduiq lalu memensiunkan run lokal lama. Perangkat tidak punya run: penjualan gagal `RECEIPT_SEQUENCE_NOT_PROVISIONED` selamanya (pengganti tetap di 0, tidak ada rotasi regresi).

## Perbaikan
- Edge (`applyCloudDeviceReceiptSequence`, `pos-receipt.service.ts`): bentrok prefix/id mengembalikan `refused_prefix_used` / `refused_id_used`; retire+insert dalam savepoint, unique violation dipetakan ke penolakan itu.
- Edge pull (`pullDeviceRegistry`, `edge-device-sync.ts`; `runtime.ts`; fetcher `cloud-http.ts`): penolakan halaman k dikirim di request berikutnya sebagai `receiptRefused=<uuid>:<alasan>,...` (maks 50), hanya bersama `receiptRuns`; disimpan di memori antar pull. 400 dari cloud lama: ulang tanpa `receiptRefused`, lalu jalur mundur lama.
- Cloud (`claimDeviceReceiptSequencesForEdge`): run berlaku, terikat tepat ke (node, instance), id dilaporkan, `lastNumber` 0, laporan ada; untuk `id_used` juga `edge_reported_number` 0 dan laporan tidak memberi nomor untuk prefix itu (untuk `prefix_used` nomor itu milik run lokal lain dan diabaikan) → pensiun `claim_rotated` + run baru terikat sama di prefix di atas semua `P<n>` laporan (dan di atas prefix yang ditolak). Penanda heal: `edge_reported_at = tau`, `retired_at = tau` (`id_used`) atau `tau + 1 ms` (`prefix_used`). Throttle 10 per perangkat per (node, instance) per 24 jam, menghitung kedua penanda → `alert`. Cek clone hanya memakai heal `id_used`. Baris `prefix_used` yang tidak di-heal dilewati cek regresi yd0h8.
- Kontrak shared: `packages/shared/src/edge/schemas.ts` (`encode/decodeReceiptRunRefusals`, `receiptRunRefusalQuerySchema`).
- Tanpa migrasi (alasan `claim_rotated` dipakai ulang; follow-up legend-p7gb6).

## Pertanyaan untuk dijawab
1. Adakah jalur yang menerbitkan nomor struk dua kali, melompati nomor tanpa jejak, atau memensiunkan run yang sudah menomori (termasuk clone dua database dengan node+instance sama)?
2. Laporan berulang, bersamaan, terlambat: idempoten? Run ganda mungkin?
3. Isolasi tenant/outlet/binding atas id yang dilaporkan.
4. Kompat: edge lama + cloud baru, edge baru + cloud lama; urutan rilis cloud dulu.
5. Interaksi dengan cek regresi yd0h8 dan pensiun-tak-terdaftar sduiq di request yang sama.
6. Penanda heal lewat selisih `retired_at - edge_reported_at` (0 / 1 ms) tanpa migrasi: bisakah rotasi klaim biasa, `edge_regressed`, atau jalur lain cocok tanpa sengaja? Amankah memensiunkan baris `prefix_used` yang `edge_reported_number`-nya > 0?

## Bukti engineer
Test baru gagal di base (32 gagal); sesudah perbaikan test terarah lulus (lihat komentar kartu legend-hfq3z untuk angka akhir dan SHA) (`pos-receipt-seq-edge`, `edge-pull-refusals`, `cloud-http`, `receipt-run-refusals`, `device-registry-puller`, `pos-receipt-restore-detect`, `edge-registry-pull`); tsc shared+api exit 0.

## Keluaran
Temuan saja: file:baris, skenario gagal konkret, tingkat (blocker/major/minor), usul perbaikan. Maks 700 kata.
