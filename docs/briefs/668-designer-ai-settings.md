# Brief: designer (Codex) — Pengaturan AI (legend-nnufz), lanjutan

## Peran
Baca `~/.agents/team/roles/designer.md`, lalu ikuti. Jangan jalankan `bd`.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, cabang `design/ai-settings` (sudah ada, juga di origin). Kerjakan di worktree sendiri: `git worktree add .worktrees/design-ai-settings design/ai-settings`.

## Tujuan
Mockup layar Kelola → "Pengaturan AI" siap untuk gerbang founder. Brief asal: `docs/briefs/589-designer-ai-admin.md` (daftar state di sana). Mockup lama ada di `design/mockups/ai/` dan cabang `design/ai-settings`; UI yang sudah tersambung API ada di screenshot `docs/screenshots/ai-settings/` (bila ada di cabang mana pun: `git log --all --oneline -- docs/screenshots/ai-settings | head`).

1. Bandingkan yang sudah ada dengan daftar state brief 589. Tulis kekurangannya di `design/mockups/ai/README.md`.
2. Buat hanya state yang kurang atau yang tidak sesuai `~/.agents/team/ui-standard.md`, desktop 1280 dan mobile 390, lewat subagent Codex paralel (maks 6).
3. Satu page review `design/mockups/ai/review.html` berisi semua state, dicek `ghostex visual check design/mockups/ai/review.html --out design/mockups/ai/review.png` dan `--width 390`.

## Batas
Hanya `design/mockups/ai/`. Commit lokal lalu push `design/ai-settings` tanpa force.

## Laporan
Path page review, daftar state (baru vs lama), tiga keputusan desain, asumsi yang perlu dikonfirmasi founder.
