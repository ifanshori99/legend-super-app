# X2-UI legend-wasr7.18 progres

## Sudah
- Tutup Hari per terminal: struk, bank, selisih; "Menunggu file bank" bukan Rp 0; `standaloneUnmatched` hanya terminal yang sudah dicapai file bank. Test gagal-dulu `apps/web/test/pos-x2ui-settlement.test.ts` (10 lulus). Commit lokal.

## Sedang / berikut
- Layar unggah CSV: route `/kelola/pembayaran/edc-settlement` (izin payment.reconcile), feature `edc-settlement-import`, katalog `edcSettlementCsv`, mock, tautan dari panel EDC, step-up MFA.
- Pra-gate (prettier, eslint, text-contract, typecheck web), screenshot 390/1280.

## Keputusan
- Server belum memberi selisih: UI mengurangi receiptIdr dan settledIdr (dua angka server), dicatat di edc-settlement-view.ts.
- "Menunggu file bank" bila settledCount=0 dan mismatchCount=0 (server tidak memberi tanda file sudah diunggah).
- Galat per baris: pesan 422 parser server ("Baris 3, 5 tidak dapat dibaca"), API tidak memberi daftar baris terstruktur.
