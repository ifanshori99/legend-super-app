# Brief: engineer — perbaikan uang: celah peta akun jurnal + 3 test refund gagal

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul bagian, Read dengan offset/limit; jangan baca TEAM.md utuh), lalu ikuti. Tingkat K (uang).

## Repo
Worktree baru dari `milestone/m1` (sudah dibuat Ghostex). Cabang kerja: `fix/money-journal-refund`.

## Tujuan
1. legend-48ft7: tutup celah waktu antara baca peta akun (`apps/api/src/services/accounting-auto-journal-amounts.ts`) dan pembukuan (`accounting-journal.service.ts` sekitar baris 598-609). Satu refund tidak boleh pernah membukukan payout ke akun service charge/pajak. Fail-closed di transaksi yang sama.
2. legend-bxdhv: 3 test refund gagal (order-recovery-refund T3/T4, rereport RR-2) dari cabang rat9r. Cek dulu apakah gagal juga di tip `milestone/m1` sekarang. Bila lulus di m1: jangan ubah kode, catat temuan di kartu (gagalnya ikut cabang rat9r / ws/pti5r-promo-refund yang ditahan, legend-fwe4l), selesai. Bila gagal di m1: reproduksi, cari akar masalah, perbaiki.

## Kartu
`legend-48ft7`, `legend-bxdhv`. Di awal: `ghostex board associate <id>` dan `bd update <id> --status in_progress` untuk keduanya. Saat melapor: `bd update <id> --status review` dan `bd comment <id> "<ringkasan bahasa biasa>"`.

## Masukan
- Temuan architect batch48k (deskripsi `bd show legend-48ft7`).
- `bd show legend-bxdhv`, `bd show legend-fwe4l`.

## Scope
- Boleh diubah: `apps/api/src/services/accounting-*.ts`, `apps/api/src/services/order-recovery-refund.ts` (hanya bila gagal di m1), test terkait di `apps/api/src/test/`.
- Jangan disentuh: alur pembayaran DOIT/Duitku, QRIS DP (`ws/qris-dp-hold` sedang dikerjakan thread lain), edge emergency.
- Migrasi: sebaiknya tidak perlu. Bila terpaksa: rentang `0430-0431` saja.

## Pembagian paralel (giliran pertama)
- Explore (2): (a) alur peta akun payout dari baca sampai insert jurnal, termasuk lock/transaksi; (b) jalankan analisis kenapa 3 test bxdhv gagal di rat9r vs m1 (baca test dan kode, tanpa menjalankan test).
- test-writer: test gagal-dulu untuk 48ft7: peta payout bentrok ke akun pajak ditolak; refund terdahulu yang sudah di-reverse; tidak ada pihak dibayar lebih dan outlet tidak rugi.
- implementer: satu untuk 48ft7; satu untuk bxdhv bila perlu kode.
- Pemegang token heavy: satu `test-runner`.

## Bukti selesai
- `heavy env LEGEND_TEST_FILES="<test baru dan test jurnal/refund terkait>" pnpm test` hijau; bukti gagal-dulu sebelum fix.
- Pra-gate AGENTS.md (prettier, eslint) pada file berubah.
- Satu review subagent `architect` effort xhigh (uang) atas diff; temuan nyata dibetulkan.

## Batas kerja ulang (Retro 11)
- `typecheck` atau `tsc` gagal 2 kali di kartu yang sama: baca `~/.claude/state/heavy-fail/<berkas terbaru>` sampai habis, betulkan semua sekaligus, jalankan sekali lagi. Gagal ketiga: lapor dengan isi log.
- Jangan `pkill`/`killall` proses test, dev server, atau tsc.
- Jam di laporan: `date '+%H:%M'`.
- Jangan merge ke milestone/m1 atau main; jangan deploy.

## Sebelum melapor
Commit di `fix/money-journal-refund`, hanya file dalam scope, lalu push cabang itu ke `origin`.

## Laporan
Hasil, bukti (perintah dan hasilnya), file berubah, commit, risiko tersisa, yang dibutuhkan dari CTO.
Wajib satu baris: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
