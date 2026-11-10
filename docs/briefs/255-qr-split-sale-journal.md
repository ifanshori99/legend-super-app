# Brief: engineer (Sonnet, lanjutan G7b4u) — jurnal penjualan QR split bill

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/qr-split-sale-journal` dari `ws/journal-split-guard` (ff571dc9, hasil legend-05cm9 milikmu; sudah antre merge train). Worktree `.worktrees/qr-split-sale-journal`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Tujuan
`legend-gzu54` (tingkat K, uang). `qrSaleGatewayOf` di `apps/api/src/services/accounting-auto-journal-amounts.ts` (~660) mensyaratkan intent payer (`orders.payment_intent_id`) `amount_idr >= total-DP` dan mendebit seluruh total-DP ke `customer_deposit` dari receipt payer saja. Split bill nyata (tiap kode bayar sebagian) membuat `order.paid` parkir `AUTO_JOURNAL_PAYLOAD_INVALID` non-retryable: pendapatan penjualan split bill tidak terjurnal.

Desain dari kartu (cek ke kode dulu, boleh disempurnakan bila ada alasan):
- `withReceipt` = jumlah bagian kontributor yang receipt-nya sudah posted.
- Ada kontributor yang receipt-nya pending: jurnal `pending` (retryable), bukan invalid.
- `assertSaleWithinReceipt` per kontributor, memakai bagian per intent yang sama dengan guard legend-05cm9.
- Order non-split tetap berperilaku sama persis (test regresi).

## Kartu
Awal: `ghostex board associate legend-gzu54`, `bd update legend-gzu54 --status in_progress`. Selesai: `--status review` + `bd comment` bahasa biasa.

## Scope
Boleh: `accounting-auto-journal-amounts.ts`, berkas guard/journal accounting yang terkait langsung, test accounting. Jangan: refund/payout guard di `accounting-auto-journal-guards.ts` kecuali benar-benar perlu (sebut di laporan), migrasi (butuh: berhenti dan lapor), UI.

## Bukti selesai
- Test gagal-dulu: split bill 2-3 kode bayar sebagian (semua posted → terjurnal; satu pending → pending lalu terjurnal sesudah posted; jumlah melebihi bagian → ditolak), plus regresi non-split.
- `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/..." pnpm test'`, sebut jumlah file dan tes.
- Typecheck `@starter/api` lewat `heavy` sekali di akhir, eslint + prettier berkas berubah. Jangan `pnpm check` penuh.
- Review (Q48, tingkat K): satu subagent `architect` untuk diff, lensa penyerang + `~/.agents/team/review-checklist.md`. Temuan nyata dibetulkan.
- Tulis brief Codex `docs/briefs/255b-second-opinion-qr-split-sale-journal.md` (rentang diff, berkas berisiko, invariant), jangan dijalankan.

## Laporan
Sekali di akhir: hasil, SHA akhir, bukti, file berubah, risiko, jumlah subagent dan puncak bersamaan.
