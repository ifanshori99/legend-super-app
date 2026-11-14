# Brief: ui-engineer (Claude Opus) — wiring UI payout ke API baru (legend-gthgq)

## Peran
Baca `~/.agents/team/roles/ui-engineer.md`, `~/.agents/team/ui-standard.md`, dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md`, lalu ikuti. `bd show legend-gthgq`.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree: `git worktree add -b ui/payout-wiring .worktrees/payout-wiring origin/ui/payout-finance-exceptions`, lalu `git merge --no-ff origin/ws/payout-api-gaps` (API: unggah bukti, snapshot rekening, daftar batch). Konflik: selesaikan, catat di laporan. UI sudah disetujui founder (Q23); jangan ubah desain, hanya wiring dan keadaan yang hilang.

## Tujuan
1. P1 uang (second opinion): `approval-items.tsx:~42` menampilkan rekening dari snapshot item (`accountHolderName`, `maskedAccountNumber`), bukan profil HR terkini. Item lama tanpa snapshot: tampilkan "Rekening belum tercatat di batch" dan jangan bisa disetujui tanpa konfirmasi eksplisit (atau blokir; pilih yang membatasi pembayaran).
2. Unggah bukti: aktifkan pilihan Gagal/Tidak terkirim dan return dengan unggah bukti (JPEG/PNG; PDF ditolak server 503 sementara: tampilkan pesan "Unggah foto atau screenshot bukti").
3. Daftar batch per PT memakai `GET /payout-batches` (paginasi), ganti N request per run.
Teks UI baru didaftarkan di katalog teks.

## Bukti, sebelum melapor
Spec mock gagal-dulu lalu hijau (browser lewat `heavy`), screenshot 390 dan 1280, `ui-auditor`, pra-gate AGENTS.md (prettier, eslint, teks, typecheck web lewat `heavy`). Ikuti `~/.agents/team/brief-template.md` "Batas kerja ulang", "Sebelum melapor", "Laporan" (angka subagent). Jangan ubah `docs/PROGRESS.md`. Push cabang tanpa force. Jangan merge ke milestone, jangan deploy.
