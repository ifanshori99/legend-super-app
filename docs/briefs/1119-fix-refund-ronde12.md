# 1119 Perbaikan refund ronde 12 (tingkat K uang)
Peran: engineer (`~/.agents/team/roles/engineer.md`). Lanjutan 1108, cabang `ws/1072-refund-ronde6-q45` (head 8200e3849), worktree `legend-2ad4d9ab`. Laporan SO: `docs/qa/second-opinion-refund-ronde12-1117.md` (2 P1, skenario Rp150.000 dari Rp100.000). Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran. Push tanpa `--force`. Tanpa migrasi (bila terpaksa: nomor sesudah 0493, lapor; nomor akan dinomori ulang saat landing).

## Keputusan CTO (membatasi; ronde 12, tutup kelasnya: "hold ditutup tanpa cakupan nominal")
1. Satu invarian untuk SEMUA jalur penutupan hold sebagai counted (resolver finance `counted_against_intent` di `refund-recon-hold.service.ts`, `closeLiveOwnHold` di `payment-provider-partial-refund.ts`, jalur duplicate, dan penutup otomatis lain yang ditemukan lewat grep): hold hanya boleh ditutup counted bila jumlah fact yang tercatat untuk refund penyedia itu (refund id/pembayaran yang sama) >= nominal hold. Bandingkan nominal, bukan hanya keberadaan ID fact.
2. Bila fact < hold: penutupan otomatis TIDAK menutup (hold tetap terbuka penuh, tetap dihitung di batas pengembalian). Resolver finance counted ditolak 409 dengan kode jelas (mis. `REFUND_HOLD_FACT_SHORT`); finance harus mencatat nominal penuh dulu atau memilih jalur lain yang sudah ada. Jangan menurunkan nilai hold.
3. Satu helper bersama untuk cek cakupan (dipakai semua penutup), di dalam transaksi + lock yang sama dengan penutupan.

## Bukti
Test merah di 8200e3849, hijau di head untuk dua skenario SO (P1-1: hold mismatch 80 + fact 30, counted ditolak, refund baru 70 ditolak; P1-2: hold live-own 80 terbuka, laporan 30 sesudah saklar mati tidak menutup hold, refund manual 70 ditolak). Test properti/tabel: total keluar (fact + refund manual + hold terbuka) <= dibayar. Regresi 1072/1075/1077/1088/1101/1108 + suite saklar nyala tetap hijau. Typecheck API sekali lewat heavy (heap 8 GB). Prettier/eslint. Architect xhigh delta sekali.

## Laporan
Per temuan: commit, head SHA, risiko, daftar semua penutup hold yang diubah. `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.` Lapor sekali.
