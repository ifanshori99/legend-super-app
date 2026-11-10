# Brief: engineer — perbaikan temuan Codex laporan pajak (legend-powk0)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta "Kerja berat" di `~/.agents/team/TEAM.md` (Grep judul bagian, Read offset/limit), lalu ikuti. Tingkat K (pajak): satu subagent architect review (effort xhigh: perhitungan uang).

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, worktree `.worktrees/r3i8w-tax-reports`, cabang `ws/r3i8w-tax-reports` (feb4f6bb). Push cabang kerja ke origin tiap commit. Jangan push main, jangan --force.

## Tujuan
Ikuti `bd show legend-powk0`: (1) sumber baris PBJT hanya pemungutan + koreksinya, setoran dan saldo awal tidak ikut; (2) dasar pajak dari snapshot `taxBaseIdr` transaksi (setelah diskon, sesuai service charge); (3) `TAX_REPORT_NO_CHANGE` membandingkan amount+lines tanpa melihat versi periode (versi tetap dipakai untuk cek stale). Cek PRD bagian pajak/PBJT untuk dasar pengenaan (`/Users/ifanshori99/Projects/legend super app/PRD_Legend_Super_App_v1.7.md`, Grep "PBJT").

## Kartu
`legend-powk0`. `ghostex board associate legend-powk0`, `bd update legend-powk0 --status in_progress`; selesai `--status review` + `bd comment`.

## Scope
- Boleh diubah: `accounting-tax-line-source.ts`, `accounting-tax-reports.service.ts`, test.
- Jangan disentuh: migrasi (0242 tetap), modul lain.

## Bukti selesai
- Test gagal-dulu: contoh Codex (pajak Nov Rp1.000.000, setoran Okt Rp800.000 -> laporan Rp1.000.000; transaksi Rp100.000 diskon Rp20.000 PBJT 10% -> dasar Rp80.000 pajak Rp8.000; reopen-tutup tanpa perubahan -> 409 NO_CHANGE).
- Typecheck dan test terarah lewat `heavy`. Architect review.

## Batas kerja ulang (Retro 11)
- `typecheck`/`tsc` gagal 2 kali: baca `~/.claude/state/heavy-fail/<berkas terbaru>` sampai habis, betulkan SEMUA error, jalankan sekali lagi. Gagal ketiga: lapor dengan isi log.
- Jangan `pkill`/`killall`. Jam dari `date '+%H:%M'`. Edit pakai tool Edit.

## Laporan
SHA, test gagal-dulu, temuan review, risiko.
