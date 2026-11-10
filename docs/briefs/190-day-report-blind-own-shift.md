# Brief: engineer — laporan harian buta untuk shift sendiri (legend-awg5p)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai, item 9), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/day-report-blind` dari ujung `milestone/m1` terbaru, sesudah batch16 (shift-blind-close) masuk m1. Cek dulu: `git log milestone/m1 --oneline | grep -i blind`; bila belum ada, lapor dan berhenti. Worktree `.worktrees/day-report-blind`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Tujuan
`legend-awg5p` (tingkat K: uang tunai). Keputusan CTO 9 Nov: laporan harian mengosongkan baris angka laci (variance, expected, cash per metode) milik shift pemanggil sendiri hari itu, sebelum maupun sesudah tutup, kecuali peran outlet_manager ke atas. Berlaku untuk `pos-day.service.ts` (agregasi cashVarianceIdr per device sekitar :481-510) dan `getEndOfDayRecap` (:601-631, cash captured/refunded per metode di outlet satu device). Detail: `bd show legend-awg5p`, `bd show legend-4wrfd`.

## Kartu
`ghostex board associate legend-awg5p`, `bd update legend-awg5p --status in_progress`; saat lapor `--status review` + `bd comment`.

## Scope
Boleh: `pos-day.service.ts`, DTO/route laporan harian, UI yang menampilkan baris kosong (tampil "—", bukan 0), test. Jangan: `pos-shift.service.ts` (kecuali helper baca peran yang sudah ada), skema/migrasi, refund, auto-journal, payroll, open bill, edge, `app.ts`, `routes/index.ts`, `worker-main.ts`.

## Bukti selesai
Test reproduksi gagal dulu: supervisor yang memegang shift hari itu tidak melihat variance/expected/cash per metode device-nya, sebelum dan sesudah tutup; outlet_manager ke atas melihat semua; supervisor tanpa shift hari itu melihat seperti sekarang. `LEGEND_TEST_FILES` daftar eksplisit lewat `bash -c 'cd <worktree> && pwd && ...'` + nullglob dengan jumlah file jalan; test root hanya lewat `pnpm test`. tsc lewat `heavy` (satu kali per perbaikan), eslint, prettier. Jangan jalankan `pnpm check` penuh. Review K: reviewer Opus + architect paralel. Brief Codex `docs/briefs/190b-second-opinion-day-report-blind.md` di folder utama (tidak di-commit).

## Laporan
Sekali: hasil, bukti, file berubah, SHA, risiko tersisa. Jangan menunggu proses global. Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja.
