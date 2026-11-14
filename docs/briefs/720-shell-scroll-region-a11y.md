# Brief: engineer (Codex) — aksesibilitas region scroll di shell Kelola (legend-gvjbm)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti. Semua kerja UI ikut `~/.agents/team/ui-standard.md`. Jangan jalankan `bd` selain `bd show` read-only.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree: `git worktree add -b fix/shell-scroll-region-a11y .worktrees/shell-scroll-region-a11y origin/milestone/m1`.

## Tujuan
`bd show legend-gvjbm`. axe serious `scrollable-region-focusable` di `apps/web/src/components/shells/management-shell.tsx:295` (`#main-content`) saat isi halaman tidak punya elemen fokus (mis. state memuat di 390 px). Perbaiki di shell: region scroll bisa difokus keyboard dengan label yang jelas (mis. `tabIndex={0}` + `aria-label`/`role="region"`), tanpa cincin fokus mengganggu saat klik mouse (`focus-visible`), dan tanpa merusak skip-link ke `#main-content`. Jangan ubah layout atau warna.

## Bukti, sebelum melapor
Test gagal-dulu (axe/Playwright mock pada satu halaman Kelola yang memuat, atau test komponen) lalu hijau; e2e mock terkait lewat `heavy` (browser antre satu sekaligus); screenshot 390 dan 1280 sebelum/sesudah di `docs/screenshots/shell-a11y/`; pra-gate AGENTS.md (prettier, eslint, typecheck web lewat `heavy`). Ikuti `~/.agents/team/brief-template.md` "Batas kerja ulang", "Sebelum melapor", "Laporan". Push `fix/shell-scroll-region-a11y` tanpa force. Jangan merge, jangan deploy.
