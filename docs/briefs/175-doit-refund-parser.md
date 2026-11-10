# Brief lanjutan G8qtg: parser refund DOIT (legend-r7g2)

## Cabang
Cabang baru `ws/doit-refund-parser` dari ujung `milestone/m1` terbaru (5e227f59 atau lebih baru), worktree `.worktrees/doit-refund-parser`, `worktree:setup`. Jangan push, jangan merge. Cek dulu apakah `ws/doit-refund` sudah di m1 (`git merge-base --is-ancestor ws/doit-refund milestone/m1`); bila belum, berangkat dari ujung `ws/doit-refund` dan sebut di laporan.

## Tujuan
`legend-r7g2` (P1, tingkat K, penahan `DOIT_REFUNDS_ENABLED`): parser refund DOIT menerima respons dengan ID pembayaran lain sebagai sukses (`payment-doit-wire.ts:429`, `payment-refund.service.ts:1451`). Respons refund hanya sukses bila ID pembayaran, ID refund/idempotensi, dan nominal cocok dengan permintaan; selain itu gagal tertutup (bukan sukses, bukan retry tak berujung). Detail dan saran fix: `docs/briefs/117-second-opinion-doit-refund.resultA.md`; P2 Run B: `docs/briefs/117-second-opinion-doit-refund.resultB.md` (kerjakan yang murah dan relevan, sisanya bead).

## Kartu
`ghostex board associate legend-r7g2`, `bd update legend-r7g2 --status in_progress`; saat lapor `--status review` + `bd comment`.

## Scope
Boleh: adapter DOIT (`payment-doit-wire.ts` dan sekitarnya), jalur hasil refund gateway di `payment-refund.service.ts`, test DOIT/refund. Jangan: auto-journal, `pos-shift.service.ts`, `pos-order.service.ts`, `crm-promo-refund.ts` dan `order-promo-refund.ts` (cabangmu sebelumnya), `app.ts`, `routes/index.ts`, `worker-main.ts`, `edge/runtime.ts`.

## Bukti selesai
Test reproduksi gagal dulu (respons ID lain, nominal beda, ID refund beda). `LEGEND_TEST_FILES` daftar eksplisit (`src/test/*doit*`, `*refund*`) lewat `bash -c` + nullglob, laporkan jumlah file jalan. tsc lewat `heavy`, eslint, prettier, kontrak node. Review K: reviewer Opus + architect paralel. Brief Codex `docs/briefs/175b-second-opinion-doit-refund-parser.md` (tidak di-commit).

## Laporan
Sekali setelah selesai: hasil, bukti, file berubah, SHA, risiko, syarat menyalakan `DOIT_REFUNDS_ENABLED`. Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja.
