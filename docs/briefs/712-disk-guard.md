# Brief: engineer (Codex) — penjaga disk di ram-guard dan heavy (legend-h32dy)

## Peran
Baca `~/.agents/team/roles/engineer.md`, lalu ikuti. Jangan jalankan `bd` selain `bd show` read-only.

## Lokasi
Skrip tim di luar repo: `~/.claude/scripts/ram-guard`, `~/.claude/scripts/heavy`, sampler `~/.claude/scripts/ram-sampler` (bila ada), test di `~/.claude/scripts/tests/` (`test-ram-guard.sh`, `test-heavy.sh`, `test-ram-sampler.sh`). Folder ini bukan repo git: sebelum mengubah, salin tiap berkas yang diubah ke `<berkas>.bak-712` sebagai cadangan.

## Tujuan
Retro 27: Mac kena ENOSPC (sisa 0,26 GB) tanpa peringatan, semua kerja berhenti. Tambahkan pembacaan ruang kosong volume data (`df -k /System/Volumes/Data` atau `/`), dengan override env untuk test (pola `RAM_GUARD_FREE`/`RAM_GUARD_SWAP_MB` yang sudah ada, mis. `RAM_GUARD_DISK_FREE_GB`):
- ram-guard: mode kuning bila disk < 15 GB, merah bila < 5 GB (digabung dengan aturan RAM yang ada, yang terburuk menang). `status` menampilkan disk.
- heavy: menolak job baru dengan pesan jelas bila disk < 3 GB (sebelum mengambil kunci), exit code bukan 0.
- Sampler (bila menulis `~/.claude/state/ram-log.csv`): tambahkan kolom disk di akhir baris tanpa merusak pembaca kolom lama (cek `parallel-report` dan skrip lain yang membaca CSV itu).
Jangan ubah ambang RAM, aturan jalur, atau perilaku lain. Perubahan kecil dan terbaca.

## Bukti, sebelum melapor
Test baru di `test-ram-guard.sh` dan `test-heavy.sh` (dan sampler bila diubah) untuk tiap ambang, merah sebelum perubahan; lalu SEMUA `~/.claude/scripts/tests/*.sh` lulus. `ram-guard status` nyata menampilkan disk. Laporan: diff ringkas per berkas, hasil test, dan cara rollback dari `.bak-712`. Ikuti `~/.agents/team/brief-template.md` "Batas kerja ulang", "Sebelum melapor", "Laporan".
