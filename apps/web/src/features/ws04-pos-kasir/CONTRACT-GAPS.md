# POS kasir: kontrak yang belum ada (legend-mjmm)

Semua hal di bawah memakai tipe lokal di `types.ts`, fungsi di `api.ts` yang di mode mock memanggil `mock-engine.ts`, dan di luar mock melempar `ApiError(501, "CONTRACT_PENDING")`. Di kode ditandai `DEMO-CONTRACT`. Layar harus menampilkan "Fitur ini belum tersambung ke server" untuk error ini (`isContractPending` dari `hooks.ts`).

| Kebutuhan                                                                  | Hook                                                                              | Keadaan di luar mock                                                                                                |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Daftar metode aktif outlet                                                 | `usePaymentMethods`                                                               | CONTRACT_PENDING                                                                                                    |
| Terminal EDC: status/ECR, kirim nominal, cek status, batal                 | `useEdcTerminals`, `useStartPayment`, `useCheckPaymentStatus`, `useCancelAttempt` | CONTRACT_PENDING                                                                                                    |
| Catat EDC standalone (referensi bank, `overrideId`, tanda rekonsiliasi)    | `useRecordEdcStandalone`                                                          | CONTRACT_PENDING                                                                                                    |
| VA: daftar bank, nomor, batas waktu                                        | `useVaBanks`, `useStartPayment`                                                   | CONTRACT_PENDING                                                                                                    |
| E-wallet: daftar dompet, status                                            | `useEwallets`, `useStartPayment`                                                  | CONTRACT_PENDING                                                                                                    |
| Kartu online, QRIS baru (`refresh`)                                        | `useStartPayment`, `useRefreshQris`                                               | CONTRACT_PENDING                                                                                                    |
| Lookup kode "Bayar di kasir" per outlet                                    | `useCashierCodeLookup`                                                            | CONTRACT_PENDING                                                                                                    |
| DP reservasi teralokasi ke tagihan, sisa DP jadi saldo pelanggan (Q7)      | `usePaymentSession` (`bill.deposit`, `bill.depositSurplusIdr`)                    | Sesi dibaca dari `getPosOrder`: tanpa DP dan tanpa percobaan aktif                                                  |
| Rencana split / sisa tagihan                                               | `useStartPayment`, `useConfirmCash`                                               | Tunai sebagian: CONTRACT_PENDING (body `addPosTender` tanpa nominal alokasi; API memakai `min(diterima, sisa)`)     |
| Blind count per pecahan lalu status "menunggu supervisor"                  | `useSubmitBlindCount`                                                             | CONTRACT_PENDING (`closePosShift` menggabungkan hitungan dan persetujuan)                                           |
| Tinjauan supervisor (hitungan, sistem, selisih)                            | `useShiftReview`                                                                  | CONTRACT_PENDING                                                                                                    |
| Tutup shift dengan `overrideId`                                            | `useApproveShiftClose`                                                            | CONTRACT_PENDING. `closePosShiftInputSchema` masih `approvedBy` + `approvalRequestId`; perlu `overrideId`           |
| Aksi override `cash_shift_close` dan `edc_standalone`                      | `useRequestOverride`                                                              | CONTRACT_PENDING. `POS_OVERRIDE_ACTIONS` hanya `void`, `discount`, `refund`, `cash_drawer_open`, `price_correction` |
| Daftar supervisor yang boleh menyetujui                                    | `useSupervisorOptions`                                                            | CONTRACT_PENDING                                                                                                    |
| Terminal terdaftar                                                         | `useRegisteredTerminals`                                                          | CONTRACT_PENDING                                                                                                    |
| Tutup hari: settlement per bank, antrean akuntansi, standalone belum cocok | `useDayCloseRecap`, `useCloseDay`                                                 | Rekap dari `getEndOfDayRecap`: `settlement` dan `standaloneUnmatched` bernilai `null`, `batches` kosong             |

## Kekurangan data pada endpoint yang sudah ada

- `getPosOrder` tidak memuat label meja dan jumlah tamu: sesi di luar mock memakai nomor pesanan sebagai `tableLabel` dan `guestCount: 0`.
- `posShiftSchema` tidak memuat nomor shift, nama kasir, atau label terminal: `ActiveShift` di luar mock memakai id pendek dan teks kosong.
- Pesanan bertipe ULID di kontrak (`orderIdSchema`), sedangkan `DEMO_ORDER_ID` dan `DEMO_CODE_ORDER_ID` berbentuk UUID. Mock membaca sesi lewat engine, dan menjawab `getPosOrder` untuk id UUID maupun alias ULID (`DEMO_ORDER_ULID`).
- Nomor struk dan referensi bertanda hubung ASCII (`POS01-000048`, `RSV-0018`, `LG-0044`) karena itu bentuk kontrak. Mockup memakai tanda pisah panjang: tampilkan lewat `formatReference` dari `types.ts`.
- `addPosTender` di mock hanya menerima tunai; tender gateway dan EDC datang dari WS-05.

## Aturan untuk server (dari tinjauan)

- Kas keluar, kas masuk, dan setoran (`recordPosCashMovement`) tidak boleh ditolak dengan pesan yang memuat saldo laci atau angka sistem. Kasir mengisi hitungan buta, jadi penolakan karena "melebihi uang di laci" membocorkan saldo. Server memakai pesan generik tanpa angka (atau tidak menolak) dan menandai selisih saat tutup shift. Mock tidak punya cek saldo.
- Kunci idempotensi dibuat sekali per niat di hook (`useConfirmCash`, `usePrintReceipt`, `useOpenShift`, `useRecordCashMovement`, `useCloseDay`) dan dipakai ulang saat percobaan diulang dengan input sama. Server wajib memperlakukan kunci yang sama sebagai satu permintaan.

## Kas keluar ditahan, batas hitungan, tutup paksa (legend-pspy, legend-7mlf)

Tipe di `shift-extra-types.ts`, fungsi di `shift-extra-api.ts`, aturan murni di `shift-extra-logic.ts`.

- Kas keluar atau setoran yang lebih besar dari kas laci diterima seperti biasa (tanpa 409, jadi saldo tidak bocor) lalu ditahan untuk supervisor. Layar kasir tidak menangani 409 kas keluar; mock `recordCashMovement` meniru: dicatat, dikeluarkan dari angka laci, ditandai ditahan.
- `useHeldCashOuts`: di luar mock memakai `getPosShift` (`needsApproval`) dan `listPosShiftCounts` (selisih hitungan terakhir). Gap: baris kas tidak memuat nama kasir; DTO hitungan tidak memuat `forced`, jadi `cashierCounts` = jumlah semua hitungan.
- `MAX_CASHIER_COUNTS = 3` hanya konstanta di API service (`SHIFT_CASHIER_COUNT_LIMIT` di web). Perlu diekspor dari `@starter/shared/pos`.
- `useOwnCountSummary` (nomor dan jumlah hitungan terakhir untuk kasir): CONTRACT_PENDING di luar mock. `submitPosShiftCount` mengembalikan `sequence` dan `countedIdr`, tetapi `submitBlindCount` di `api.ts` (milik payment) belum memakainya.
- Tutup paksa (`useForceCloseView`, `useSubmitForcedCount`, `useWitnessForcedCount`, `useForceCloseShift`): CONTRACT_PENDING di luar mock. `forceClosePosShiftInputSchema` masih `approvedBy` + `approvalRequestId`; persetujuan orang ketiga lewat PIN (`overrideId`) belum punya jalur. Kode `DEVICE_UNVERIFIED` (perangkat tidak terverifikasi) belum ada di `pos/errors.ts`.
- Demo mock: `?demo=hitungan-batas|tutup-paksa|tutup-paksa-menunggu|tutup-paksa-siap|hitungan-usang|shift-sendiri|perangkat-gagal`. Shift demo bawaan (supervisor) kini punya kas keluar ditahan Rp200.000.

## Koreksi refund (legend-2fo, dari I1)

- Koreksi refund: order detail tidak memuat jumlah yang sudah direfund; layar menampilkan sisa penuh, server (422) yang membatasi.

## Selisih buku dan koreksi tertahan (legend-y9bf, audit F)

- API membukukan `varianceIdr + heldCorrectionIdr` saat tutup shift (`pos-shift.service.ts`, `closeShiftWithCount`); kas keluar dan setoran ditahan kedaluwarsa dan tidak dibukukan. DTO hitungan di `@starter/shared/pos` belum memuat `heldCorrectionIdr` (kas refund dan void ditahan). Sampai ada, `HeldCashOutReview.heldCorrectionIdr` = 0 di `shift-extra-api.ts` dan mock, jadi selisih buku = selisih fisik.
