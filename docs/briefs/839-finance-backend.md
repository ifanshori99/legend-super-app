# Brief: engineer — area finance dan akuntansi, backend (3 kartu)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, worktree dari `milestone/m1`, cabang `ws/finance-followups`.

## Kartu
legend-qsgg3 (tolak reversal manual jurnal rujukan penyusutan aset tetap), legend-ym2kr (auto-journal kas keluar `needsApproval`), legend-4lft (`cumulativeBalances` di atas 2^53). `bd show` tiap kartu; cek `git log --all --grep <id>` dulu. Di awal: `ghostex board associate <id> --project-id <id proyek Legend bila diminta>` dan `bd update <id> --status in_progress`. Saat lapor: `--status review` + `bd comment`.

## Aturan
- Uang: test wajib membuktikan jurnal tetap seimbang, tidak ada kas keluar yang terbukukan tanpa persetujuan, dan tidak ada saldo yang terpotong/membulat (2^53: pakai bigint/numeric, bukan float).
- Tanpa migrasi; bila perlu, berhenti dan lapor. Tanpa UI.
- Ragu soal aturan akuntansi: berhenti dan lapor ke CTO dengan pilihan.

## Pembagian paralel
Explore (2): jurnal manual/penyusutan; auto-journal kas keluar + saldo kumulatif. test-writer gagal-dulu. implementer satu per kartu. Satu pemegang heavy. Review akhir: subagent architect effort xhigh (uang).

## Bukti selesai
Test terarah hijau lewat heavy, pra-gate AGENTS.md, typecheck API (dan web bila shared berubah) sekali lewat heavy, push tanpa force, laporan dengan angka subagent.
