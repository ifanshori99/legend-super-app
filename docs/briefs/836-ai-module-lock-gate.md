# Brief: engineer — gerbang rilis: tenant tanpa modul ai_assistant terkunci AI

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, worktree dari `milestone/m1`, cabang `fix/ai-module-gate-0m495`.

## Kartu
`legend-0m495` (`bd show`). Di awal: `ghostex board associate legend-0m495`, `bd update legend-0m495 --status in_progress`. Saat lapor: `--status review` + `bd comment`.

## Tujuan
Tenant live yang belum punya modul `ai_assistant` tidak boleh terkunci dari Tanya AI saat rilis (founder: Tanya AI wajib ikut rilis). Reproduksi dulu, cari akar masalah. Tetap pakai pengecekan modul/RBAC yang ada; bila jalan keluarnya backfill data modul, migrasi data idempoten di 0383 saja. Ragu soal paket/biaya modul: berhenti dan lapor ke CTO dengan pilihan.

## Pembagian paralel
Explore (2): gerbang modul AI API + web; data modul tenant/seed. test-writer: test gagal-dulu. implementer 1-2. Satu pemegang heavy. Review akhir: subagent architect effort xhigh (akses).

## Bukti selesai
Test terarah hijau lewat heavy, pra-gate AGENTS.md, `pnpm db:generate` kosong bila ada migrasi, push tanpa force, laporan dengan angka subagent.
