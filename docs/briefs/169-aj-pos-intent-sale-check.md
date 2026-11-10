# Brief lanjutan G0bgs: cek sisi penjualan POS lewat payment intent (legend-6bq2)

## Tujuan
Penjualan POS yang dibayar payment intent mendapat cek sisi penjualan yang sama dengan QR (`assertSaleWithinReceipt`, `intentBackedAt`), sehingga `customer_deposit` tidak terdebit dua kali (keluarga cacat F1 Codex 142).

## Repo dan cabang
Cabang baru `ws/aj-pos-intent` dari ujung `ws/aj-qr-sale` (6cc87dab), worktree `.worktrees/aj-pos-intent`, `worktree:setup`. Jangan commit lagi di `ws/aj-qr-sale`: cabang itu masuk merge train setelah batch9.

## Scope
- Boleh: consumer/amounts auto-journal, helper `intentBackedAt`, test `accounting*`, `pos-order*`.
- Jangan: `pos-order.service.ts` (thread kunci intent DP sedang mengubah pengambilan kunci dan waktu selesai di sana; bila cek harus di sana, lapor dulu), `qr-order.service.ts`, `pos-shift.service.ts`, `app.ts`, `routes/index.ts`, `worker-main.ts`, `edge/runtime.ts`, modul refund.

## Kartu
`ghostex board associate legend-6bq2`, `bd update legend-6bq2 --status in_progress`. Saat lapor: `--status review` dan `bd comment`.

## Bukti selesai
Test reproduksi gagal dulu. `LEGEND_TEST_FILES` daftar eksplisit lewat `bash -c` dengan nullglob, laporkan jumlah file jalan. tsc api lewat `heavy`, eslint, prettier. Review K: subagent reviewer Opus + architect. Brief Codex `docs/briefs/169b-second-opinion-aj-pos-intent.md` (tidak di-commit).

## Laporan
Hasil, bukti, file berubah, SHA, risiko, kebutuhan dari CTO. Bila review Opus CTO atas slice 3-4 mengirim temuan sebelum ini selesai, kerjakan temuan itu dulu di cabang baru ini.
