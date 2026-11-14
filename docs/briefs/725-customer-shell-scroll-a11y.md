# Brief: engineer (Codex) — area scroll customer shell bisa difokus (legend-wyhzw)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian kerja berat di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti. Jangan jalankan `bd` selain `bd show` read-only.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree: `git worktree add -b fix/customer-shell-scroll-a11y .worktrees/customer-shell-scroll-a11y origin/milestone/m1`.

## Tujuan
Sama seperti perbaikan management shell di cabang `fix/shell-scroll-region-a11y` bd7332434 (lihat diff-nya): `apps/web/src/components/shells/customer-shell.tsx:149-150` `Main` `overflow-y-auto` tanpa `tabIndex`, memicu axe `scrollable-region-focusable`. Beri `tabIndex={0}`, label dari judul halaman, ring fokus keyboard saja (`focus-visible`). Jangan ubah shell lain.

## Bukti, sebelum melapor
Spec mock gagal-dulu lalu hijau (browser lewat `heavy`, satu sekaligus), screenshot 390 dan 1280, pra-gate AGENTS.md (prettier, eslint, typecheck web lewat `heavy`). Ikuti `~/.agents/team/brief-template.md` "Batas kerja ulang", "Sebelum melapor", "Laporan". Push tanpa force. Jangan merge, jangan deploy.
