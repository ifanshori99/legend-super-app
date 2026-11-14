# Brief: engineer — area payroll dan HRIS (4 kartu)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, worktree dari `milestone/m1`, cabang `ws/hris-followups`.

## Kartu
legend-esjkw (carry cuti Y+2), legend-lyll9 (replay create cuti), legend-jitc3 (settlement offboarding), legend-2fk79 (performa guard piutang). `bd show` tiap kartu; cek `git log --all --grep <id>` dulu. Di awal: `bd update <id> --status in_progress` (lewati `ghostex board associate` bila error multi-board). Saat lapor: `--status review` + `bd comment`. JANGAN kerjakan legend-wtpf dan legend-8463 (butuh konfirmasi pajak).

## Aturan
- Gaji/settlement: test wajib membuktikan karyawan tidak dibayar lebih (dan tidak kurang dari haknya), piutang karyawan dipotong tepat sekali, outlet tidak rugi.
- Data pribadi: jangan log nominal gaji atau data karyawan.
- Tanpa migrasi; bila perlu, berhenti dan lapor. Ragu soal aturan bisnis: berhenti dan lapor ke CTO dengan pilihan.

## Pembagian paralel
Explore (2): cuti (carry + replay); offboarding + piutang. test-writer gagal-dulu. implementer satu per kartu, file tidak bertumpuk. Satu pemegang heavy. Review akhir: subagent architect effort xhigh (uang/gaji).

## Bukti selesai
Test terarah hijau lewat heavy, pra-gate AGENTS.md, typecheck API sekali lewat heavy, push tanpa force, laporan dengan angka subagent.
