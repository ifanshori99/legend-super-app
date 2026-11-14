# Brief: engineer (Codex) — alarm untuk event edge yang diparkir (legend-1opho, legend-n2d3g)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti. Jangan jalankan `bd` selain `bd show` read-only.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree sendiri dari `origin/fix/edge-transport-no-outlet` (3c4b17f17): `git worktree add -b fix/edge-dead-letter-alarm .worktrees/edge-dead-letter-alarm origin/fix/edge-transport-no-outlet`.

## Tujuan
Event outbox edge yang di-dead-letter menahan event berikutnya di aggregate yang sama selamanya, dan satu-satunya sinyal hanya `logger.warn` (`core-outbox.ts` ~l.210 gap query menganggap baris dead tetap ada). Hal serupa di legend-n2d3g: `edge-receipt-run-reporter.ts:106-110` menahan struk device/prefix setelah order paid di-dead-letter, tanpa alarm. Tambahkan alarm operator yang tahan duplikat (pola dedupe `notification_outbox` yang sudah ada, satu alarm per aggregate/prefix yang tertahan), dan metrik/hitungan tertahan yang bisa dibaca monitoring. Jangan melepas atau melewati event tertahan secara otomatis (urutan dan uang harus tetap aman); hanya membuat terlihat.

Tanpa migrasi bila index yang ada cukup; bila butuh migrasi atau mengubah aturan uang, berhenti dan laporkan.

## Bukti, sebelum melapor
Test gagal-dulu (event diparkir → tidak ada alarm di base; setelah perbaikan tepat satu alarm, tidak ganda saat relay berulang), test terarah hijau lewat `heavy`, pra-gate AGENTS.md (prettier, eslint, typecheck api lewat `heavy`). Ikuti `~/.agents/team/brief-template.md` "Batas kerja ulang", "Sebelum melapor", "Laporan". Push `fix/edge-dead-letter-alarm` tanpa force. Jangan merge, jangan deploy.
