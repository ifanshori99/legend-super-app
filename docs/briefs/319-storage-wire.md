# Brief 319: engineer — pasang object storage di app dan worker

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul bagian, Read dengan offset/limit), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend` (folder utama di cabang lain: jangan checkout di sana). Buat worktree: `git worktree add .worktrees/storage-wire -b ws/storage-wire ws/hris-attendance`, kerja hanya di sana (PORT dan nama DB sendiri).

## Tujuan
`legend-dzh9q`: StorageProvider S3 dari legend-ruf sudah ada tapi belum terpasang. Pasang: router core-storage di app, storage di worker, daftarkan `registerAttendanceSelfiePurgeJob` di `worker-main.ts`, berikan `fileSigner` ke router absensi dan admin (createApp perlu bisa disuntik signer untuk tes). Bila env storage kosong: app tetap jalan, fitur upload menjawab galat jelas (503), job purge tidak didaftarkan dan log peringatan sekali. Nama key env: baca `.env.example` (jangan baca .env). Cek juga apakah `legend-7nv1` (menu media) dan logo brand (a30j) bisa memakai jalur yang sama; laporkan, jangan kerjakan 7nv1.

## Kartu
`legend-dzh9q`. Di awal: `ghostex board associate legend-dzh9q` dan `bd update legend-dzh9q --status in_progress`. Saat melapor: `bd update legend-dzh9q --status review` dan `bd comment legend-dzh9q "<ringkasan>"`.

## Scope
- Boleh: `app.ts`, `worker-main.ts`, routes/index, router core-storage, router absensi (injeksi signer), tes, `.env.example` (nama key saja).
- Jangan: migrasi, UI, modul lain. Jangan pkill proses lain; jangan ekspansi array zsh `${(@f)...}`. Jalankan tes dari root worktree.

## Bukti selesai
- Tes gagal-dulu: signer tersuntik -> photoUrl bertanda tangan di log absensi; env kosong -> upload 503 dan worker tetap start; job purge terdaftar saat storage ada.
- Tes absensi + core storage hijau; `heavy pnpm --filter api typecheck` bersih; eslint/prettier.
- Tingkat K (data pribadi): satu subagent `architect` effort high.

## Sebelum melapor
Commit lokal di `ws/storage-wire`. Jangan push, jangan merge.

## Laporan
Hasil, bukti, file berubah, SHA, nama env yang dibutuhkan produksi, risiko tersisa.
