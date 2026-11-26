# 1272 legend-f1mmf: serah terima (27 Nov)

Cabang `ws/1272-f1mmf`. Bead: legend-f1mmf (backend tukar menu QRIS/EDC, lalu buka layar Tagih selisih).

## Sudah

1. `GET /api/order-issue-charges/:chargeId` (kontrak `@starter/shared/pos` `getPosIssueCharge`, `posIssueChargeDetailSchema`). Service `apps/api/src/services/order-recovery-charge-pos-read.ts`. Nominal, baris tukar, kode yang masih bisa menerima uang, dan penjualan EDC tagihan itu semuanya dari server. Test `order-issue-charge-pos-read-f1mmf.test.ts` (7, gagal dulu).
2. `POST /api/order-issue-charges/:chargeId/edc` (kontrak `startPosIssueChargeEdc`). Service `order-recovery-charge-pos-edc.ts`. Test `order-issue-charge-pos-edc-f1mmf.test.ts` (5, gagal dulu).
3. Guard uang baru: `assertNoEdcSaleOutstanding` (nontunai.ts) dipasang di QRIS dan tunai. `edcSaleChargePayable` (pos-order-support.ts) dipasang di write-ahead agent EDC.
4. Test lama yang diubah: `order-charge-refund-982-pos-nontunai-gt98h.test.ts`, dua kasus yang membuat QRIS padahal penjualan EDC sudah disetujui (aturan baru menolaknya). 53 test terkait lulus.

## Keputusan uang yang diambil (paling ketat)

- Kode "hidup" memakai `liveCodeWhere`, aturan yang sama dengan penolakan `createIntent` (ORDER_CODE_ACTIVE). Selama kode hidup, GET menampilkan `pending`, jadi kunci di kasir dan aturan server tidak pernah berbeda. Kode yang sudah lewat waktunya ditanyakan dulu ke provider lewat jalur poll (`settleGatewayIntentNowDetailed`). Bila uangnya sudah ada, dicatat sekali. Bila jawabannya final dan lewat margin, kode ditutup. Bila jawaban tidak jelas, kode tetap hidup.
- Satu jalur uang pada satu waktu. Penjualan EDC tagihan (reference = id tagihan) yang masih pending, unknown, sudah disetujui, atau sedang direkonsiliasi menolak QRIS, tunai, dan penjualan EDC baru. Sebaliknya, kode QRIS yang hidup atau intent yang sudah dibayar menolak penjualan EDC. Kedua sisi mengambil advisory lock agent (tenant, outlet:reference), jadi tidak bisa lolos bersamaan.
- Nominal EDC selalu `amount_idr` tagihan. Agent menolak nominal lain (EDC_AMOUNT_MISMATCH), tagihan yang sudah tertutup atau dibayar, dan order yang di-void.
- Tenant lain, outlet lain, kasir aktif outlet lain, atau tanpa `pos.payment.accept` di outlet tagihan: 404 (GET dan EDC).

## Sisa

- (d) Pembatalan percobaan di server (supervisor, beraudit): butuh keputusan, lihat pertanyaan di bawah.
- Web: sambungkan GET (hapus CONTRACT_PENDING di `charge-api.ts`), tombol mulai EDC + pilih terminal, blocker a/b/c/e dari re-review architect 25 Nov, test node/komponen, screenshot 390/1280.
- Typecheck api+web, text-contract, review K (architect), second-opinion area.

## Pertanyaan ke CTO (usulan paling ketat)

1. Batal QRIS tagihan: gateway tidak punya cancel. Usulan: tidak ada batal sebelum kode lewat waktu + 60 detik dan provider menjawab final. Kasir menunggu, server menutup kode basi sendiri. Tidak ada endpoint batal.
2. Percobaan tunai atau EDC tanpa jawaban di browser lain: usulan memakai pola supervisor PIN 1268 W2 (`payment-intents/resolve`) untuk tagihan, dengan kunci `cash:`/`edc:` per tagihan. Ini desain baru, butuh architect. Sampai itu ada, layar tetap dikunci pada metode yang belum pasti.
3. Layar dibuka sebelum (d) selesai? Usulan: tidak. CONTRACT_PENDING tetap sampai (d) dan review K lulus.
