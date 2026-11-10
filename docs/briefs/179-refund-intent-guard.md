# Brief lanjutan G8qtg: refund intent yang dipakai tender POS (legend-riqu) dan order.refunded saat jurnal penjualan parkir (legend-ni6o)

## Cabang
Cabang baru `ws/refund-intent-guard` dari ujung `milestone/m1` terbaru (fee69d45 atau lebih baru; sudah berisi dp-intent-lock `lockIntentsForFact` dan aj-pos-intent `assertSaleWithinReceipt`), worktree `.worktrees/refund-intent-guard`, `worktree:setup`. Jangan push, jangan merge.

## Tujuan
1. `legend-riqu` (P2, tingkat K): approval refund masih mengizinkan refund intent yang masih dipakai tender POS captured. Tolak (409 dengan kode jelas) bila saldo intent yang belum terpakai tender/penjualan tidak cukup; hitung di bawah kunci `payment_intents FOR UPDATE` yang sama (`lockIntentsForFact`), waktu fakta dari kunci itu, bukan jam aplikasi sebelum commit.
2. `legend-ni6o` (P2, tingkat K): consumer auto-journal `order.refunded` memposting Cr customer_deposit walau jurnal penjualan order itu parkir. Parkir refund sampai jurnal penjualan posted (pola guard yang sama dengan payout), dan ulang otomatis saat penjualan diposting.
Detail: `bd show legend-riqu`, `bd show legend-ni6o`, desain `docs/design/auto-journals.md` §4 dan §10 di m1.

## Kartu
`ghostex board associate` keduanya, `bd update <id> --status in_progress`; saat lapor `--status review` + `bd comment`.

## Scope
Boleh: modul refund (`payment-refund*.ts`, `payment-admin.service.ts` bagian refund), `payment-refund-fact-time.ts`, consumer/amounts auto-journal, test. Jangan: `pos-shift.service.ts`, `pos-order.service.ts` selain membaca, `tax.service.ts`, payroll, `app.ts`, `routes/index.ts`, `worker-main.ts`, `edge/runtime.ts`.

## Bukti selesai
Test reproduksi gagal dulu (refund intent yang sudah dipakai tender POS diterima; order.refunded posted saat penjualan parkir). `LEGEND_TEST_FILES` daftar eksplisit lewat `bash -c` + nullglob, laporkan jumlah file jalan. Test root kontrak bila tipe shared berubah. tsc lewat `heavy`, eslint, prettier. Review K: reviewer Opus + architect paralel. Brief Codex `docs/briefs/179b-second-opinion-refund-intent-guard.md` (tidak di-commit).

## Laporan
Sekali setelah keduanya selesai. Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja.
