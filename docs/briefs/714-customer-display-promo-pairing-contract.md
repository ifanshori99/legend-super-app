# Brief: engineer (Codex) — kontrak layar pelanggan: promo idle + payload kode pairing (legend-r1ax)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti. Jangan jalankan `bd` selain `bd show` read-only.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree: `git worktree add -b ct/customer-display-promo-pairing .worktrees/customer-display-promo-pairing origin/milestone/m1`.

## Tujuan
Baca `bd show legend-r1ax`. Tambahkan ke kontrak `getCustomerDisplayState` (`packages/shared/src/pos`): daftar promo aman-tampil (title, body, validUntil; tanpa kode voucher, kuota, atau harga internal) dan keadaan belum-terpasang berisi payload kode pairing enam digit untuk ditampilkan layar. Zod strict, tipe DTO, mock di web untuk layar pelanggan (fixtures), dan test kontrak. Hanya kontrak dan mock: JANGAN ubah logika autentikasi pairing perangkat di server (`pairCustomerDisplay` tetap menerima kode dari terminal). Bila ternyata butuh perubahan akses/token perangkat atau migrasi, berhenti dan laporkan rancangannya.

## Bukti, sebelum melapor
Test kontrak gagal-dulu lalu hijau lewat `heavy`, pra-gate AGENTS.md (prettier, eslint, typecheck api dan web lewat `heavy` karena `packages/shared` berubah). Ikuti `~/.agents/team/brief-template.md` "Batas kerja ulang", "Sebelum melapor", "Laporan". Push `ct/customer-display-promo-pairing` tanpa force. Jangan merge, jangan deploy.
