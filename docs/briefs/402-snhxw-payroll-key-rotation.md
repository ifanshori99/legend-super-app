# Brief: engineer — rotasi kunci untuk nilai payroll tersegel (legend-snhxw)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Worktree `.worktrees/snhxw-payroll-keys`, cabang `ws/snhxw-payroll-keys`, dari `ws/hris-pii-pin` (8305fdc3; sedang di batch48c). Lalu `pnpm worktree:setup`.

## Tujuan
`bd show legend-snhxw`. Pakai ulang key ring HRIS dari legend-33mj (`HRIS_PII_KEYS`, `HRIS_PII_ACTIVE_KEY_VERSION`, job `hris-pii-reseal`) untuk nilai payroll tersegel (slip gaji, komponen gaji, dan kolom tersegel payroll lain; temukan semua lewat Explore). Tambah versi kunci per baris bila belum ada, perluas job re-seal (idempoten, bisa dilanjutkan, semua tenant termasuk suspended). Setelah ini kunci v1 bisa dipensiunkan: tulis langkahnya di docs.

## Kartu
`legend-snhxw`. Awal: `ghostex board associate legend-snhxw`, `bd update legend-snhxw --status in_progress`. Lapor: `--status review` + `bd comment`.

## Scope
Hanya payroll/HRIS crypto, job re-seal, test, docs. Migrasi bila perlu: rentang 0272-0273, `when` > 1794460000000.

## Bukti selesai
- Test gagal-dulu: baca nilai v1 setelah kunci aktif v2; re-seal mengubah semua baris ke v2; ulang = tidak berubah; terputus lalu lanjut; isolasi tenant; nilai rusak/versi tak dikenal gagal jelas.
- Test terarah; typecheck via `heavy`; prettier; `pnpm db:generate` kosong.
- Review tingkat K (data pribadi + migrasi): satu `architect` effort xhigh.

## Batas kerja ulang
typecheck gagal 2x: baca `~/.claude/state/heavy-fail/<terbaru>` habis, betulkan semua. Gagal ketiga: lapor. Tunggu job lewat notifikasi, bukan sleep. Jangan `pkill`. Jam dari `date '+%H:%M'`.

## Laporan
Commit, push. Hasil, bukti, migrasi + when, file, subagent dan puncak, risiko.
