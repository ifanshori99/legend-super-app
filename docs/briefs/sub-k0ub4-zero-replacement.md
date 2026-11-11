# Sub-brief legend-k0ub4: item pengganti Rp0 di order selesai

Worktree `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/k0ub4-zero-replacement`, cabang `ws/k0ub4-zero-replacement` (dari ws/pti5r-promo-refund 326bfbfa). Konteks: `docs/briefs/sub-fwe4l-swap-cap.md` (cap baris pengganti, ledger goods pra-cap).

## Temuan (architect fwe4l, temuan 2)

Order `completed`: swap mencatat baris pengganti Rp0 (`apps/api/src/services/order-recovery-swap-kitchen.ts` ~240-247, nilai jual tetap di baris lama). Order promo: baris pengganti gagal -> manual_refund -> consumer (`order-recovery-refund.ts`) jalan recompute promo (kopi keluar dari kept lines), cap baris pengganti = 0 -> refund 0 -> `blocked("nothing_left")`. `recordPartialRefundPayout` tidak pernah dipanggil, jadi goods kopi tidak tercatat di ledger promo (`refunded_paid_idr`). Refund item lain berikutnya (mis. roti) ikut membayar porsi promo itu -> outlet bayar lebih.

## Perbaikan (aturan founder: tidak ada pihak dibayar lebih; bila ragu, batasi)

Pastikan setelah baris pengganti bernilai 0 berakhir nothing_left, refund item lain berikutnya tidak melebihi sisa dana setelah porsi promo item asal. Kandidat: di jalur nothing_left setelah recompute yang adjusted, catat payout goods pra-cap ke ledger (idempoten saat event dikirim ulang: sekali per issue, mis. dijaga audit blocked nothing_left yang sudah ada atau key idempotensi), ATAU jangan jalankan recompute untuk baris pengganti bernilai 0 bila itu lebih benar. Selidiki dulu mana yang benar secara uang (apa yang sebenarnya diterima tamu di order completed swap), tulis alasannya di laporan. JANGAN ubah perhitungan voucher selisih swap (menunggu founder).

## Test gagal-dulu (file baru `apps/api/src/test/order-recovery-refund-zero-replacement.test.ts`)

- Order promo pay-first, order completed, kopi di-swap (baris pengganti Rp0), baris pengganti gagal -> nothing_left; lalu roti gagal -> refund roti persis sama dengan refund roti bila kopi direfund normal (ledger mencatat porsi kopi), dan total refund <= sisa dana.
- Event nothing_left dikirim ulang -> ledger tidak bertambah dua kali.
- Order tanpa promo dengan swap Rp0: tidak berubah.
- Satu assertion isolasi tenant.
  Pola: `apps/api/src/test/order-recovery-refund-swap-cap.test.ts` (swap, `uuidToUlid`, ORD-09 approval = total baris), `order-recovery-refund-promo-final-failure.test.ts` (seed promo). Cari cara membuat order completed di test yang ada (grep `completed` di `apps/api/src/test/order-recovery*`).

## Aturan

- implementer: hanya `order-recovery-refund.ts` (+ `order-recovery-refund-amount.ts`, port promo bila perlu, sebut di laporan). test-writer: hanya file test baru.
- Jangan jalankan `pnpm test`. Typecheck `heavy pnpm --filter @starter/api typecheck`, prettier bersih. Jangan commit. Jangan baca `.env*`.
