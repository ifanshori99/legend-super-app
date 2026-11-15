# 890 Web payout: password step-up di approve, config, export

## Peran
ui-engineer (tugas kecil). Baca `~/.agents/team/roles/ui-engineer.md`, bagian "Paralel dulu" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), dan `~/.agents/team/ui-standard.md`.

## Repo dan cabang
`/Users/ifanshori99/Projects/legend super app/legend`, worktree sendiri. Base: `origin/fix/payout-area-final-888` (bddf9bf6c). Cabang baru `ui/payout-password-stepup-890`.

## Tujuan
Cabang 888 membuat API approve batch, config payout, dan export pembayaran mewajibkan `stepUp` + `passwordStepUp`; sesi yang hanya baru mendaftar MFA ditolak. Web belum mengirim password, jadi alur itu putus di UI. Tambahkan langkah konfirmasi password (pola yang sudah ada untuk posting sumber `POST /disbursement-batches/:id/postings/:postingId/source`, cari dulu dengan Explore) di ketiga aksi, plus pesan error yang jelas untuk kode penolakan baru. Kartu `legend-caobb` (`ghostex board associate`, `bd update --status in_progress`; saat lapor `--status review` + `bd comment`).

## Jangan
Ubah API, migrasi, atau modul uang lain. Jangan merge, jangan deploy.

## Bukti selesai
- Test web (komponen/hook) untuk tiga aksi: password terkirim, error password salah tampil, tombol tidak bisa dobel-kirim.
- Teks UI baru didaftarkan (`node --test tests/text-contract.test.mjs`), prettier, eslint, `heavy pnpm --filter @starter/web typecheck`.
- Satu screenshot dialog lewat `heavy` (lebar 390 dan desktop), satu subagent `reviewer` atas diff.
- Push tanpa force. Lapor SHA, test, angka subagent (total, puncak, pemegang heavy).
