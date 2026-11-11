# 533 Fix temuan architect 531: edge katalog dan promo stream (tingkat K, uang + akses)

Peran: engineer (~/.agents/team/roles/engineer.md), Sonnet. Satu putaran fix. Sumber: laporan G82h6 (brief 531), disalin di bawah. Keputusan sudah diambil CTO; jangan tanya ulang. Aturan uang founder: fix dibuktikan test bahwa outlet tidak rugi.

Cabang dan worktree (commit lokal, jangan merge antar cabang):
- ws/edge-catalog-fresh -> .worktrees/edge-catalog-fresh
- ws/edge-promo-streams -> .worktrees/edge-promo-streams
Migrasi baru: rentang 0345-0349 saja, `when` lebih besar dari semua 0328-0334. Jangan ubah nomor/`when` 0333-0334 (merge train menggabung urut angka).

A. ws/edge-catalog-fresh
1. P1-a `apps/api/src/edge/catalog-freshness.ts:236` (beku di :204): keputusan CTO `ageReference = at` = high water saat boot + waktu monotonic sejak boot, jadi blokir 24 jam Q57 tetap berjalan saat offline. Balik test `catalog-freshness.test.ts:601`. Test: katalog 20 jam basi, restart offline, 5 jam kemudian penjualan harga basi diblokir.
2. P1-b `trusted-clock.ts:61-63`: pakai waktu server cloud saat link tersambung sebagai bukti; setelah terbukti hapus status tak terbukti dan alarm antre. Test: restart <5 menit dengan link tersambung tidak memicu alarm owner dan promo hidup lagi.
3. P2-a `promo-gate-runtime.ts:73`: saat tak terbukti terima checkpoint dengan lastSuccessAt >= high water saat boot.
4. P2-b `catalog-alarm-queue.ts:115-146`: hapus entri setelah N heartbeat diterima atau 7 hari.
5. P3 `runtime.ts:761`: antrean alarm ke direktori state sendiri, bukan EDGE_SELFIE_DIR.
6. P2-c (jam mundur >5 menit, CLOCK_REGRESSED): JANGAN ubah dulu. Menunggu keputusan founder Q2 CTO baru; CTO mengirim pesan.

B. ws/edge-promo-streams
1. P1 akses `edge-catalog-sync.ts:613` (promo :583) + `edge-catalog-apply.ts:564,671`: buang codeHash dari stream voucher; promo berkode kirim pengganti yang tidak bisa dibalik (mis. hash dari id). Test: payload stream ke edge tidak berisi codeHash/kode apa pun; edge tetap menolak kode voucher (Q66).
2. P2-1 `catalog-puller.ts:697-738`: keputusan CTO sesuai Q57: promo tanpa kuota hanya ditutup saat tarikan terpotong, dan offline tetap hidup sampai batas 24 jam; promo/voucher berkuota tetap mati offline (Q66). Test keduanya.
3. P2-2 `edge-catalog-apply.ts:573,575`: kuota dan anggaran disimpan sebagai max(angka cloud, hitungan lokal) agar constraint uses_total <= quota_total tidak macet; test promo 50x lokal lalu kuota cloud 30 -> sinkron jalan dan promo tidak bisa dipakai lagi.
4. P3: tambah skrip rollback 0333-0334; stream voucher kirim hanya yang aktif/perlu untuk tanda kesegaran bila sederhana, kalau tidak catat.

Paralel: Explore per cabang, satu implementer per cabang (A dan B bersamaan), test-writer untuk test fail-first P1, test-runner per cabang. Test terarah lewat `LEGEND_TEST_FILES=... heavy pnpm test`; tsc lewat heavy.
Selesai: tiap fix test gagal-dulu lalu lulus, tsc api lulus, satu `reviewer` sonnet atas diff fix tiap cabang. Laporan: commit per cabang, test, angka subagent, apa yang belum.
