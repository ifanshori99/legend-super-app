# Brief: engineer — flake test cuti HRIS

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul bagian, Read dengan offset/limit), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, worktree baru dari `milestone/m1`, cabang `ws/hris-leave-flakes`.

## Tujuan
Suite test cuti HRIS stabil saat dijalankan bersama (tidak saling tabrak fixture), dan 500 sesekali pada persetujuan cuti dengan hari libur ditemukan akarnya.

## Kartu
`legend-8ldhb`, `legend-l0qbr`, `legend-4mpqc`, `legend-agn0i`. Di awal tiap kartu: `ghostex board associate <id>` dan `bd update <id> --status in_progress`. Saat melapor: `bd update <id> --status review` dan `bd comment <id> "<ringkasan bahasa biasa>"`. Kartu yang ternyata sudah beres di `milestone/m1`: tutup dengan bukti commit.

## Masukan
- `bd show <id>` tiap kartu. Cek dulu path test di `milestone/m1` (bukan salinan `.worktrees/*`).
- Arah: tenant/fixture per suite, scope unik, hitungan global (accrual count, approval_policies) dibatasi ke tenant test sendiri.
- `legend-agn0i`: reproduksi dulu (jalankan berulang / bersamaan), cari urutan lock. Time-box 60 menit; tanpa repro, lapor temuan dan hipotesis, jangan ubah kode produksi menebak.

## Scope
- Boleh diubah: test HRIS cuti/libur dan helper fixture-nya di `apps/api/src/test/`; kode produksi HRIS cuti/libur hanya bila akar 500 terbukti.
- Jangan disentuh: payroll, payout, accounting, edge, reports, ops, platform. Tanpa migrasi. Jangan hapus volume Docker apa pun.

## Pembagian paralel (giliran pertama)
- Explore (2): fixture bersama yang dipakai tiga suite cuti; alur POST /api/hris/holidays + approve cuti (lock/transaksi).
- implementer: 3 (satu per file suite / helper, tidak bertumpuk), 1 untuk repro agn0i.
- Pemegang token heavy: satu test-runner.

## Bukti selesai
- Tiga suite cuti dijalankan bersama 3 kali berturut lewat `LEGEND_TEST_FILES="<ketiganya>" heavy pnpm test`, semua hijau; catat kegagalan sebelum fix sebagai bukti gagal-dulu.
- Pra-gate AGENTS.md (prettier, eslint, typecheck api lewat heavy).
- Satu `reviewer` sonnet atas diff.
- Commit lokal, push ke `ws/hris-leave-flakes` (tanpa force). Jangan merge.

## Batas kerja ulang (Retro 11)
- `typecheck` gagal 2 kali: baca `~/.claude/state/heavy-fail/<berkas terbaru>` sampai habis, betulkan semua sekaligus, jalankan sekali lagi. Gagal ketiga: lapor ke CTO.
- Jangan `pkill`/`killall` proses test, dev server, atau tsc.
