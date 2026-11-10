# Brief lanjutan G5xnj: kas keluar held saat tutup shift (legend-y9bf)

## Cabang
Cabang baru `ws/shift-close-held` dari ujung `ws/shift-close-fix` (1c051167), worktree `.worktrees/shift-close-held`, `worktree:setup`. Jangan commit lagi di `ws/shift-close-fix`. Jangan push, jangan merge.

## Keputusan aturan pembukuan (CTO, untuk F2)
Lihat `bd show legend-y9bf`. Ringkas: held belum dicairkan = uang masih di laci. Saat tutup, held yang belum disetujui kedaluwarsa (tidak dibukukan, audit), expected kas tanpa held, selisih dibukukan normal, approval terlambat ditolak, laporan harian menampilkan held yang kedaluwarsa. Ubah aturan event tutup bersama dan laporan harian seperlunya.

## Kartu
`ghostex board associate legend-y9bf`, `bd update legend-y9bf --status in_progress`; saat lapor `--status review` + `bd comment`.

## Scope
Boleh: `pos-shift.service.ts`, aturan event tutup shift di shared, consumer jurnal tutup shift, laporan harian, test. Jangan: auto-journal penjualan/refund, modul refund, `pos-order.service.ts`, `app.ts`, `routes/index.ts`, `worker-main.ts`, `edge/runtime.ts`.

## Bukti selesai
Test reproduksi gagal dulu (contoh Codex: expected=counted Rp100.000, cash_out held Rp150.000, tutup tidak boleh membuat debit kas Rp150.000 dan tidak boleh parkir). `LEGEND_TEST_FILES` daftar eksplisit lewat `bash -c` + nullglob, laporkan jumlah file jalan. tsc lewat `heavy`, eslint, prettier. Review K: reviewer Opus + architect paralel. Brief Codex `docs/briefs/176b-second-opinion-shift-close-held.md` (tidak di-commit).

## Laporan
Sekali setelah selesai. Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja.
