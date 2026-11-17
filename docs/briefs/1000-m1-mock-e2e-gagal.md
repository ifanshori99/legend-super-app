# 1000 Perbaiki test mock e2e yang gagal di m1 (legend-dq4y3)

Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5, effort high. Tingkat S (test/web), kecuali akar masalah ternyata di kode uang: berhenti dan lapor.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (Explore per kelompok spec, test-runner untuk run).

Base: origin/milestone/m1 (1b0fd2a9e). Kartu: legend-dq4y3. 38 test gagal di base batch81 (14 spec, rincian di kartu: `bd show legend-dq4y3`). Log contoh: /tmp/claude-501/mock83.log dan /tmp/claude-501/mock84.log (baca lewat grep/Explore, jangan seluruhnya).

Kerja:
1. Petakan dulu dari log mana yang masih gagal di m1 sekarang (jangan run penuh). Jalankan hanya spec yang gagal: `heavy --browser pnpm test:e2e:mock <spec...>` (cek nama skrip di package.json). Browser maks satu sekaligus di seluruh Mac; merge train batch84 juga memakai antrean ini, jadi kelompokkan spec, jangan run satu-satu berkali-kali.
2. Cari akar per spec: tanggal/waktu, teks katalog berubah, selektor basi, data mock. Betulkan test atau kode web. Jangan skip tanpa kartu bd; jangan longgarkan asersi uang (nominal, status bayar).
3. Jangan sentuh: apps/api/src/services/payout*, payment-refund*, order-charge*, migrasi (tidak boleh ada migrasi baru).

Bukti selesai: spec yang tadinya gagal lulus 2x berturut-turut, prettier/eslint bersih, `pnpm --filter @starter/web typecheck` lewat heavy. Review: satu reviewer sonnet konteks segar. Commit di cabang worktree-mu, push tanpa force. Hapus worktree subagent milikmu sebelum lapor.

Laporan (sekali di akhir, pakai Monitor untuk menunggu, jangan sleep loop): spec yang dibetulkan + akar, sisa yang masih gagal + kartu baru, SHA, angka subagent.
