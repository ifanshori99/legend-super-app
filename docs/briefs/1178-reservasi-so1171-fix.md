# 1178 Fix SO 1171 reservasi DP (engineer, 19 Nov)

Peran: `~/.agents/team/roles/engineer.md`. Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (test-writer per kartu, implementer per kartu; berkas terpisah).
Template kerja: `docs/briefs/_TEMPLATE-workstream.md`. Langkah 0 worktree: `node ~/.claude/scripts/worktree-slim.mjs && heavy pnpm worktree:setup`.

Base: `ws/1163-reservasi-slot-pickup` (cca06c1a6). Cabang kerja: `ws/1178-reservasi-so1171-fix`. Tingkat K (uang): architect effort xhigh sebelum lapor. Tanpa migrasi; bila perlu: berhenti dan lapor ke CTO.
Temuan: `docs/qa/second-opinion-reservasi-dp-1171.md` (baca kedua temuan, saran, usul test).

## Kartu (baca `bd show <id>`)
1. `legend-3dfri` Keputusan CTO: semua pembayaran DP yang terbukti datang sesudah cap (`payableUntil + GATEWAY_POLL_WINDOW_MS`) diputuskan di bawah kunci reservasi -> link -> intent menjadi: booking batal, settle, refund penuh SEKALI lewat RSV-02 (`late_refund_requested`), tanpa kredit booking. Berlaku sama untuk DOIT dan Duitku, callback dan polling, sebelum atau sesudah sweep (termasuk opsi `closedIntentNeedsOpenBill`). DP terlambat SEBELUM cap tetap aturan parkir yang ada. Test: matriks usul test di laporan; tepat satu `payment.paid`, satu permintaan refund Rp100.000, replay tidak menambah refund, total refund <= diterima, holds nol.
2. `legend-chmz2` Keputusan CTO: kecualikan legacy unresolved (tanpa `deposit_payment_link_id`, provider belum final, lewat cap) dari kandidat sweep di SQL dengan predikat yang sama dengan guard `reconcileDeposit`; legacy berbayar tetap masuk. Test: 100-150 legacy unresolved + satu booking baru jatuh tempo + satu legacy berbayar, sweep berulang limit default: booking baru batal dan holds lepas, legacy unresolved tetap, legacy berbayar terkonfirmasi, tenant/outlet lain tidak berubah.

## Batas
- Jangan sentuh: `reservation.routes.ts`, `reservation-booking.ts` (thread 1177), `order-given.ts`, `edge-*`, `access.service.ts`, `payment-webhook.service.ts` (thread 1176).

## Bukti selesai
Test gagal-dulu per kartu (terarah lewat `heavy`), typecheck api lewat `heavy` sekali dengan exit code di laporan, prettier + eslint file berubah, `db:generate` kosong. Tunggu job heavy dengan Bash run_in_background (notifikasi exit); jangan akhiri giliran dengan kabar tunggu. Commit dan push ke cabang kerja.

## Laporan
SHA, kartu selesai, jumlah subagent dan puncak bersamaan, hasil gate, temuan architect dan fixnya, yang belum teruji. Lapor sekali.
