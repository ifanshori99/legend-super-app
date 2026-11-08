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
