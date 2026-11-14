# Pembersihan kartu basi bd, 15 Nov 2026

Cabang kerja: `ux/customer-order-benchmark`. Pembanding: `origin/milestone/m1` (7aacd9f68). Tanpa perubahan kode.

## Ringkasan angka

- Kartu siap di bd sebelum: 374. Sesudah: 361.
- Kartu dipindai: 352 (bukan epic, bukan EXT).
- Ditutup: 13 (commit sudah di m1).
- Ada commit tetapi belum di m1 (tidak ditutup): 15 kartu.
- Commit di m1 tetapi cocok-isinya ragu (tidak ditutup): 6 kartu.
- Commit hanya menyebut id, bukan menyelesaikan kartu (FALSE, tidak ditutup): 19 kartu.
- Tanpa commit (dibiarkan): 299 kartu.
- Cara: `git log --all --grep <id>`, lalu `git merge-base --is-ancestor <sha> origin/milestone/m1`. Penilaian FALSE dan ragu dibuat dari subjek commit dan `--stat`, bukan membaca seluruh diff.
- Subagent: total 6 (4 Explore klasifikasi, 1 Explore usul area, 1 implementer yang menjalankan `bd close`), puncak 4 bersamaan.

## Ditutup (13)

| Kartu | Commit di m1 |
|---|---|
| legend-2fo | 257dac279 |
| legend-68if | 57eca78ad |
| legend-6m1w1 | b579a379f |
| legend-fn7ur | 65916e0f8 |
| legend-tny6 | e8a7a611b |
| legend-c9k87 | 4b7eb37a8 |
| legend-ktpc0 | 84060e4ae |
| legend-n8r5m | 8f30eb0d2 |
| legend-0ixe | f00d6c636 |
| legend-0lyzf | 399e99b0b |
| legend-800h1 | 8f3e1e4b4 |
| legend-be0lx | 9c566be5f |
| legend-pspy | c88943670 |

## Commit belum di m1 (jangan ditutup)

| Kartu | Sha | Cabang |
|---|---|---|
| legend-2lp.5 | 7fcfdb369 | fix/print-agent-kds-retry |
| legend-0y8tf | c3cef7cb4 | fix/e2e-mock-support-access |
| legend-2uqcd | 87284cbb7 | fix/edge-so-816 |
| legend-3k41y | 3875a8056 | fix/edge-so-816 |
| legend-cgduz | 87284cbb7 | fix/edge-so-816 |
| legend-aagpf | 10a196bc1 | fix/panic-push-device-revoke (keyakinan sedang: subjek commit tanpa id kartu) |
| legend-bkoim | d4c02fa0a | fix/clamd-scan-tenant-images |
| legend-ewmfd | 10a196bc1 | fix/panic-device-cross-tenant |
| legend-mm029 | 10a196bc1 | fix/panic-device-cross-tenant |
| legend-oi7ub | 10a196bc1 | fix/panic-device-cross-tenant |
| legend-po3fe | 10a196bc1 | fix/panic-device-cross-tenant |
| legend-l5tvy | 0ac8e3b7c | ghostex/hris-koreksi-absen-ditolak-tampil |
| legend-xzzdq | 0ac8e3b7c | ghostex/hris-koreksi-absen-ditolak-tampil |
| legend-qu04u | f161bcca7 | fix/leave-attachment-active-permission |
| legend-yhia9 | 1275f0123 | ghostex/775-qris-hold-c1 |

Catatan: satu commit 10a196bc1 dipakai untuk empat kartu panic; cakupan per kartu belum dicek. Cabang `fix/edge-so-816` memuat commit untuk tiga kartu edge.

## Ragu, tidak ditutup (6)

Commit di m1 ada, tetapi judul kartu lebih sempit atau berbeda dari subjek commit. Perlu cek diff sebelum ditutup.

- legend-tetyr (46fe03759): kartu soal reseal `sealSecret`, commit soal rotasi kunci dan temuan Codex.
- legend-5w6 (d89b2698f): kartu panel pembayaran POS luas, commit hanya status QRIS di layar pelanggan.
- legend-3a5m (abb920e45): kartu ledger impor settlement, commit auto-journal slice 4.
- legend-edjgj (a0f0c1273): kartu fungsi SECURITY DEFINER, commit "one grant scan per request".
- legend-p7gb6 (996cc8896): kartu alasan retire `edge_refused`, commit self-heal run ditolak edge.
- legend-ph62j (84060e4ae): kartu lanjutan status edge, commit u5b layar status edge.

## FALSE (commit hanya menyebut id atau milik kartu lain, 19)

legend-m0mch, legend-2lp.10, legend-0una, legend-5d76, legend-tvkuz, legend-5bjh, legend-1j8o9, legend-3l4q, legend-4us1a, legend-70dm, legend-88pky, legend-ahgg, legend-arj.7, legend-2t69x (docs desain saja), legend-axmob (docs desain saja), legend-e6xi5, legend-n64n, legend-npnh, legend-whg2.

## Usul area gelombang berikut

Semua kartu berstatus tanpa commit. Direktori diambil dari prefiks file service dan belum dicek per kartu dengan `bd show` (kecuali legend-ghi7, legend-lhe4k, legend-h0q4); CTO atau agent pelaksana memverifikasi sebelum mulai.

1. **Edge sync dan keandalan** (`apps/api/src/edge/`, `services/edge-*`): legend-fjpxq (retensi `edge_txn_ledger_events`), legend-gzwhg (purge audit di edge), legend-g1799 (rotasi `instance_id` saat DB edge hasil restore), legend-tmar2 (deteksi restore DB edge), legend-x2c0x (`defaultLastSequence`), legend-vj7ma (bersihkan printer retired). Gerbang founder: tidak ada. Hindari kartu yang menambah migrasi.
2. **HPP, stok, inventori** (`services/inventory-*`, `menu-*`): legend-wa9k9 (rebuild HPP merek satu transaksi), legend-8qm1d (`cost_snapshot_idr` dan retur stok), legend-xtuik (HPP dan lokasi nonaktif), legend-1qyx (index `stock_ledger`), legend-uloj6 (rata-rata bergerak retur supplier). Gerbang founder: legend-1qyx butuh migrasi; kartu HPP menyentuh uang, wajib test "tidak ada pihak dibayar lebih, outlet tidak rugi".
3. **Finance dan akuntansi** (`services/accounting-*`, sebagian `packages/shared` dan UI finance): legend-ghi7 (`last_error` template jurnal berulang), legend-z13t (tampilan `AUTO_JOURNAL_RECEIPT_PENDING`), legend-qsgg3 (tolak reversal manual jurnal rujukan penyusutan aset tetap), legend-ym2kr (auto-journal kas keluar `needsApproval`), legend-4lft (`cumulativeBalances` di atas 2^53). Gerbang founder: legend-ym2kr menyangkut uang; legend-ghi7 dan legend-z13t perlu UI.
4. **Payroll dan HRIS** (`services/hris-*`): legend-esjkw (carry cuti Y+2), legend-lyll9 (replay create cuti), legend-jitc3 (settlement offboarding), legend-2fk79 (performa guard piutang). Gerbang founder: data pribadi dan gaji. Hindari legend-wtpf dan legend-8463 (butuh konfirmasi pajak).
5. **UI ops dan web** (`apps/web/src/routes/_ops/`): legend-lhe4k (sembunyikan halaman template checklist), legend-z274 (kategori notifikasi checklist), legend-1n5z (`dueTime` di bawah cutoff hari bisnis), legend-v99yu (hydration warning), legend-5tai0 (toaster menutupi konten), legend-rxida (halaman `/masuk` melebar di 320px). Perlu mockup/UI: semua kartu.

Area 1, 2, 3, 4 berada di direktori service yang berbeda sehingga bisa jalan paralel; area 3 dan 5 sama-sama menyentuh `apps/web`, jadi jangan bersamaan bila menyentuh file halaman yang sama.
