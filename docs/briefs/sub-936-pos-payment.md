# Brief 936: POS panel pembayaran, sisa legend-5w6

Worktree: /Users/ifanshori99/Projects/legend super app/legend-7944b492 (base c17c60df7). Tanpa migrasi.
Sudah ada, JANGAN dibangun ulang: apps/web/src/features/ws04-pos-kasir/components/payment/* (tunai, QRIS, EDC, standalone+PIN, VA, e-wallet, split).
UI standard: ~/.agents/team/ui-standard.md. Teks UI wajib dari katalog teks (tests/text-contract.test.mjs).
Aturan uang: potongan voucher/poin dan total dihitung SERVER; UI hanya menampilkan angka dari respons. Tombol bayar/terapkan terkunci saat permintaan berjalan (tidak dobel kirim).

## Bagian yang dibangun

A. Panel tukar poin member (endpoint loyalty yang ada; bila tidak ada: mock mode + catat di CONTRACT-GAPS.md).
B. Panel voucher (masukkan/scan kode, status valid/tidak/kedaluwarsa, potongan dari server).
C. Jual tiket fasilitas dari POS + cetak tiket lewat Print Agent edge (pola struk 928); pakai komponen features/facility bila bisa.
D. State EDC "ditolak" eksplisit; label penyedia QRIS di layar pelanggan dari data (bukan teks tetap "DOIT").

## Explore (read-only) — kembalikan ringkas, path:line

- E1 mockup: design/ (mockups, screens, pos, payments). Cari layar POS payment untuk voucher, poin, tiket fasilitas, EDC ditolak, layar pelanggan QRIS. Sebut path PNG/HTML tepat + ringkasan tata letak/teks per layar.
- E2 pola kode: payment-screen.tsx, method-grid.tsx, panel-types.ts, failed-panel.tsx, edc-*.tsx, qris-panel.tsx, layar pelanggan (customer display) dan di mana "DOIT" tertulis tetap; lapisan api/mock POS (features/ws04-pos-kasir/api|queries|hooks, mock mode); lokasi katalog teks + cara menambah key; pola test komponen web (lokasi, runner, contoh test panel payment); bagaimana metode baru didaftarkan di method grid.
- E3 kontrak: packages/shared (validators/types) untuk loyalty/poin redeem, voucher validate/apply, facility products/tickets/print; endpoint API yang ada di apps/api/src/routes; komponen apps/web/src/features/facility yang bisa dipakai ulang; pola cetak struk lewat Print Agent edge (brief/kartu 928, cari "print agent", "printReceipt"); lokasi CONTRACT-GAPS.md dan formatnya.

## Temuan Explore (ringkas)

- Mockup: design/mockups/pos/ hanya punya payment-failed.png, edc-unknown.png, payment-qris-active.png, payment-qris-expired.png. TIDAK ada mockup voucher/poin/tiket: ikuti pola visual panel payment yang ada (Card, PosTwoPane, Notice, Button) dan payment-failed.png untuk EDC ditolak.
- Kontrak: voucher preview `validateVoucher` POST /api/vouchers/validate (packages/shared/src/crm/endpoints.ts:629, crm/promo.ts:1083-1105, reason enum crm/promo.ts:1040). Apply = POS order discount source "voucher" (packages/shared/src/pos/endpoints.ts ~440-500) yang menghitung ulang total di server. Poin: tender method "points" ada (pos/schemas.ts:611,693) tetapi TIDAK ada endpoint kasir untuk saldo/quote/redeem poin: mock mode + CONTRACT_PENDING di luar mock. Tiket: `sellAccessTicketAtPos` POST /api/facility/tickets/pos (facility/endpoints.ts:143, body staffSellTicketSchema facility/inputs.ts:91). Cetak tiket lewat Print Agent: TIDAK ada endpoint; ikuti pola printReceipt (ws04-pos-kasir/api.ts:381, hooks.ts:235) di mock + CONTRACT_PENDING. Display QRIS wire sudah punya `provider: "doit"|"duitku"` (pos/schemas.ts:2251, ws04-display/mock.ts:105); katalog "QRIS DOIT" di packages/shared/src/i18n/messages/id.ts:~1762,~1836.
- Pola mock: api.ts memakai `API_MOCK` + `runPosKasirMock((engine) => ...)` / `local(...)`; di luar mock `contractPending(feature)`. Engine: mock-engine.ts (createPosKasirEngine). Test web: vitest node env, `apps/web/test/**/*.test.ts`, render `renderToString` + `vi.mock` hooks (contoh apps/web/test/payment-active-code.test.ts).
- Katalog teks: sudah dibuat & didaftarkan di id.ts: posKasirVoucher (pos-kasir-voucher.ts), posKasirPoints (pos-kasir-points.ts), posKasirTicket (pos-kasir-ticket.ts). Isi file milikmu sendiri; JANGAN edit id.ts kecuali pemilik bagian D.

## Kontrak bersama (wajib dipakai persis; dibuat oleh pemilik "I5a data")

types.ts (features/ws04-pos-kasir):

- `AttemptStatus` tambah `"declined"` (bank/terminal menolak; beda dari "failed" teknis dan "unknown").
- `PaymentAttempt.edc` tambah `declineReason?: string` (pesan dari server, mis. "Saldo tidak cukup") dan `responseCode?: string`.
- `PaymentBill` tambah `voucher?: { code: string; discountIdr: number } | null` (harga server; total/remaining sudah termasuk potongan).
- `export type VoucherCheck = { valid: true; code: string; discountPreviewIdr: number } | { valid: false; code: string; reason: VoucherRejectionReason }` (reason dari @starter/shared crm promo).
- `export type PointsAccount = { memberId: string; memberName: string; balancePoints: number; minRedeemPoints: number; maxRedeemPoints: number }` (max dihitung server: min(saldo, sisa tagihan)).
- `export type PointsQuote = { points: number; valueIdr: number }`.
  hooks.ts:
- `useValidateVoucher(orderId)` useMutation<VoucherCheck, Error, { code: string }>
- `useApplyVoucher(orderId)` useMutation<PaymentSession, Error, { code: string }> (invalidate session)
- `useRemoveVoucher(orderId)` useMutation<PaymentSession, Error, void>
- `usePointsAccount(orderId)` useQuery<PointsAccount | null> (null = pesanan tanpa member)
- `useQuotePoints(orderId)` useMutation<PointsQuote, Error, { points: number }>
- `useRedeemPoints(orderId)` useMutation<PaymentSession, Error, { points: number }> (kirim poin saja; server hitung nilai; menambah allocation method "points")
  Panel props: components/payment/adjustment-types.ts `AdjustmentPanelProps { orderId; onDone; onCancel }` (sudah ada). Stub voucher-panel.tsx / points-panel.tsx sudah ada (export VoucherPanel / PointsPanel).

## Aturan uang (semua bagian)

- UI tidak menghitung potongan/nilai poin/total. Tampilkan angka dari respons hook saja.
- Tombol terapkan/bayar/jual/cetak: `disabled` + aria-busy saat `isPending`; handler juga menolak bila isPending (tidak dobel).
- Mock engine mensimulasikan server: potongan voucher <= subtotal dan <= sisa; nilai poin <= sisa tagihan; voucher sekali pakai; idempotency key per percobaan.

## Pembagian (satu pemilik per file; jangan sentuh file milik orang lain)

- I1 voucher UI: components/payment/voucher-panel.tsx, packages/shared/src/i18n/messages/pos-kasir-voucher.ts. Input kode (uppercase, trim), tombol "Cek" (useValidateVoucher) lalu status valid (potongan dari discountPreviewIdr, label "perkiraan, dihitung ulang server") / tidak valid (pesan per reason), tombol "Pakai voucher" (useApplyVoucher) lalu onDone. Scan: input menerima scanner keyboard-wedge (Enter = cek), petunjuk teks. Kondisi loading/error/contract pending (isContractPending dari ../../hooks).
- I2 poin UI: components/payment/points-panel.tsx, packages/shared/src/i18n/messages/pos-kasir-points.ts. usePointsAccount: loading/kosong (tanpa member)/error/pending. Tampil nama + saldo; input jumlah poin (batas min/max dari server, tombol "Maks"), "Hitung nilai" (useQuotePoints) tampil valueIdr; "Tukar poin" (useRedeemPoints, kirim points) lalu onDone.
- I3 tiket fasilitas: features/ws04-pos-kasir/ticket/{api.ts,queries.ts,hooks.ts,mock.ts,types.ts}, features/ws04-pos-kasir/components/ticket/*, route apps/web/src/routes/_ops/pos.tiket.tsx (+ routeTree.gen.ts), packages/shared/src/i18n/messages/pos-kasir-ticket.ts, plus satu link masuk dari layar POS (pos.index/kasir; file yang tidak dimiliki bagian lain). Alur: pilih produk fasilitas (list produk, mock), pilih pelanggan (cari member/nama), waktu, jual (sellAccessTicketAtPos; API_MOCK pakai mock) lalu tampil tiket terbit (pakai ulang features/facility/components/access-ticket-qr.tsx / issued-step bila cocok) + "Cetak tiket" lewat Print Agent (mock seperti printReceipt; di luar mock CONTRACT_PENDING). Harga dari server/produk, bukan dihitung UI. Tulis baris CONTRACT-GAPS yang dibutuhkan di laporanmu (jangan edit CONTRACT-GAPS.md).
- I4 EDC ditolak + label QRIS: components/payment/edc-declined.tsx (baru, export EdcDeclined), components/payment/edc-panel.tsx (rute status "declined" ke EdcDeclined: judul "Pembayaran ditolak", alasan dari attempt.edc.declineReason/responseCode bila ada, jumlah, terminal; aksi "Coba lagi di terminal" dan "Pilih metode lain"; pola payment-failed.png), packages/shared/src/i18n/messages/pos-kasir-edc.ts; layar pelanggan: features/ws04-display/** (qris-panel tampil label penyedia dari wire.qris.provider lewat katalog, mis. key posDisplay.qris.provider.doit/duitku), packages/shared/src/i18n/messages/pos-display.ts, dan baris "QRIS DOIT" di id.ts diganti teks dengan placeholder {provider} atau dibuat netral. Kasir qris-panel.tsx JANGAN diubah kecuali label DOIT tertulis tetap di sana.
- I5a data: features/ws04-pos-kasir/{types.ts,api.ts,queries.ts,hooks.ts,mock-engine.ts,mock.ts,mock-wire.ts,CONTRACT-GAPS.md}. Buat semua kontrak bersama di atas. Voucher: di luar mock pakai validateVoucher + POS order discount (source voucher) bila wiring order tersedia, selain itu contractPending; mock: engine method validateVoucher/applyVoucher/removeVoucher (kode demo: HEMAT20 = 20% maks Rp30.000, LEGEND50K = Rp50.000 min belanja Rp150.000, EXPIRED1 = expired, PAKAI001 = already_redeemed), total & remaining dihitung ulang. Poin: mock engine pointsAccount/quotePoints/redeemPoints (1 poin = Rp1, saldo demo 12.500, min 1.000); di luar mock contractPending + baris gap. EDC: status "declined" di engine + satu skenario demo (mis. terminal tertentu menolak, declineReason "Saldo tidak cukup", responseCode "51"). Tambah baris CONTRACT-GAPS untuk poin kasir, voucher apply wiring, cetak tiket fasilitas (dari laporan I3 nanti; tulis baris dasar "Cetak tiket fasilitas lewat Print Agent" sekarang). Tambah test unit engine: potongan voucher tidak melebihi sisa/subtotal, voucher sekali pakai, redeem poin tidak melebihi sisa, saldo berkurang tepat.
- I5b integrasi: components/payment/payment-screen.tsx, komponen BillPanel (features/ws04-pos-kasir/components/shared*), packages/shared/src/i18n/messages/pos-kasir-payment.ts. Step baru {kind:"voucher"} dan {kind:"points"} merender VoucherPanel/PointsPanel; tombol masuk "Pakai voucher" dan "Tukar poin" di kolom tagihan saat !bill.paid dan tanpa attempt aktif; BillPanel tampil baris potongan voucher (bill.voucher.discountIdr, kode) + tombol hapus voucher (useRemoveVoucher, terkunci saat pending); poin tampil sebagai allocation yang sudah ada. headingKeys + heading.voucher/voucherHint/points/pointsHint.
- TW test-writer: apps/web/test/pos-payment-936-*.test.ts (renderToString + vi.mock hooks). Gagal-dulu terhadap stub: voucher valid tampil discountPreviewIdr dari hook (bukan hitungan UI), invalid tampil pesan reason, tombol Pakai disabled saat isPending; poin: tanpa member -> kosong, tombol Tukar disabled saat pending, nilai dari quote; EDC declined tampil judul ditolak + declineReason; display QRIS label penyedia "Duitku" saat provider duitku; tiket: tombol jual/cetak disabled saat pending. Jalankan test lewat `LEGEND_TEST_FILES=... heavy pnpm test` HANYA bila token heavy bebas; laporkan bukti gagal.

## Selesai per bagian

Prettier pada file sendiri (`pnpm exec prettier --write <file>`). Jangan jalankan tsc/typecheck penuh (agent menjalankan sekali). Laporan 5-10 baris: file, keputusan, kebutuhan kontrak/gap.
