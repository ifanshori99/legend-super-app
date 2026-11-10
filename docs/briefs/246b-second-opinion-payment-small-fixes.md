# Brief: second-opinion Codex — tiga perbaikan kecil pembayaran (246b)

Tidak di-commit. Repo worktree: `.worktrees/payment-small-fixes`, cabang `ws/payment-small-fixes`, diff `git diff 4c818489..HEAD`. Read-only: laporkan temuan, jangan edit.

## Tiga perubahan
1. **legend-deu7r** `packages/shared/src/edc/index.ts`: `cardNumberLike` jadi `/\d(?:[\s/_-]*\d){11,}/g` (newline, CRLF, NBSP, `/`, `_`). Jalur tulis dan baca teks bebas. Migrasi 0143 dan data lama tidak diubah. Periksa: positif palsu (tanggal `2026/11/09 12:30:45`, ID pesanan, jumlah rupiah), `\s` Unicode, interaksi dengan aturan `leftoverBeforeMask`/`tailCardRun` yang masih memakai kelas sempit, potong 200.
2. **legend-jf4i** `apps/api/src/worker-main.ts` + `payment.service.ts`: `expireDueIntents` jalan per tenant di tick relay, fail closed. Opsi baru `leaveGatewayReconciling` melewati kode yang diterbitkan gateway terpasang (providerRef + provider) supaya poller (`pollPendingGatewayIntents`) tetap punya jendela rekonsiliasi 24 jam. Periksa: pembayaran terlambat tidak hilang, intent berprovider lain tidak menggantung selamanya, balapan dengan poller dan webhook, beban query per tick.
3. **legend-aef1** `apps/api/src/services/pos-order-corrections.ts`: `refundSplit` membangun gross dari `refundedSubtotalIdr` hasil recompute promo dan diskon = gross − bagian barang payout, hanya bila promo di-recompute. Periksa: identitas gross − diskon + service + pajak = jumlah, kasus deposit (payout dibatasi tender), settlement tanpa item, refund berulang, dampak ke jurnal otomatis dan loyalty.

## Bukti
Test terarah lulus: edc-pan-*, payment-api, ws03-guest-va, payment-intent-expiry-worker, pos-refund-promo-db, pos-order, pos-cash-guard, accounting-auto-journal.

## Keluaran
Temuan dengan file:baris, skenario gagal konkret, tingkat keparahan. "Tidak ada temuan" bila bersih.
