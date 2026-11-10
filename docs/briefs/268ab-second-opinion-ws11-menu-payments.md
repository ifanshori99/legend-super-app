# Brief: second-opinion (Codex) — WS-11 keluarga Menu dan HPP (F3) dan Pembayaran dan Pajak (F4)

Jangan dijalankan sebelum CTO memutuskan. Tingkat K (uang). Effort: high. Wajib sebelum gerbang rilis, tidak menahan slice berikut.

## Peran

Baca `~/.agents/team/roles/second-opinion.md`, lalu ikuti. Hanya membaca dan melapor; jangan mengedit.

## Repo

`/Users/ifanshori99/Projects/legend super app/legend`. Dua cabang, masing-masing dibandingkan dengan basis `ws/ws11-shared-1` (a597254c):

- `ws/ws11-menu-cogs` (worktree `.worktrees/ws11-menu-cogs`, kartu legend-e58wz): `apps/api/src/services/metric-sources/menu-cogs.ts`, `apps/api/src/test/ms-menu-cogs.test.ts`.
- `ws/ws11-payments-tax` (worktree `.worktrees/ws11-payments-tax`, kartu legend-hpc4s): `apps/api/src/services/metric-sources/payments-tax.ts`, `apps/api/src/test/ms-payments-tax.test.ts`.

## Konteks

- Keputusan: `docs/DECISIONS.md` entri 2026-11-10 (WS-11), butir 1 sampai 7.
- Kontrak pembaca: `apps/api/src/services/metric-sources/types.ts` (aturan baris total per outlet-hari, pecahan ledger + residual `__ledger_adjustment__`).
- Brief umum: `docs/briefs/268-ws11-family-common.md`.

## Yang diperiksa

1. `cogs.per_menu` (pecahan menu) dan `payments.methods` (pecahan metode bayar): jumlah baris pecahan + residual harus sama dengan total GL. Uji skenario: refund, void, diskon, order multi-tender, order tanpa tender (`unassigned`), QR payment intent, pembulatan, nilai negatif, order lintas hari bisnis.
2. Isolasi tenant dan outlet di semua query raw SQL pembaca (filter `tenant_id` dan `outlet_id`, join ke tabel lain). Dimensi hanya id, tidak ada nama orang (`cash_variance` per id kasir).
3. Finality: hari tanpa baris total tidak `final`; metrik POS butuh `pos_daily_closes`; backfill `recomputeMetricsDaily` idempoten.
4. Klaim kode ganda: setelah review architect, F3 tidak lagi memegang `menu_sold_qty` dan F4 tidak lagi mendaftarkan pecahan `net_sales` per metode bayar (`netSalesByMethodReader` tinggal bahan untuk kartu sales). Pastikan tidak ada pembaca lain yang menulis kode yang sama dan job harian tidak menghapus baris keluarga lain (bead legend-iwsrp).
5. Metrik `unavailable` yang dicatat (`gateway_settlement`, `edc_settlement`, `tax_collected`, `service_charge_collected`, `tax_payable`, `menu_popularity_pct`, `sold_out_menu_count`, `menu_gross_margin`). Catatan: `cost_snapshot_idr` belum ditulis oleh insert mana pun (bead legend-u4js6), jadi pecahan `cogs` per menu di produksi kini 100% residual: tidak ada angka palsu.

## Laporan

Satu baris per temuan: `path:baris`, tingkat (blokir/penting/saran), masalah, skenario gagal konkret, saran. Tidak ada temuan: katakan satu baris.
