# X2-UI legend-wasr7.18 progres

## Selesai (cabang ws/1272-x2ui, tanpa migrasi)
- Tutup Hari per terminal: struk, bank, selisih; "Menunggu file bank" bukan Rp 0; `standaloneUnmatched` hanya terminal yang sudah dicapai file bank. `apps/web/test/pos-x2ui-settlement.test.ts` (10 lulus, gagal-dulu).
- Layar unggah CSV: `/kelola/pembayaran/edc-settlement` (izin payment.reconcile, step-up MFA, galat per baris, hasil dari angka server), tautan dari tab EDC. `apps/web/test/edc-settlement-import.test.ts` (10 lulus, gagal-dulu).
- e2e `legend-mjmm-pos-kasir.mock.spec.ts` DAY-01 disesuaikan ke teks baru (DAY-01/02 lulus).
- Pra-gate: prettier, eslint (0 error), text-contract 12 lulus, i18n-area-split 7 lulus, typecheck web dan api hijau.
- Screenshot `docs/review/img/x2ui-*.png` 390/1280 (skrip `scripts/shot-x2ui.mjs`).

## Keputusan / catatan
- Server belum memberi selisih: UI mengurangi receiptIdr dan settledIdr (dua angka server), tercatat di edc-settlement-view.ts.
- "Menunggu file bank" bila settledCount=0 dan mismatchCount=0 (server tidak menandai file sudah diunggah; file yang tak mengenai satu pun penjualan terminal tampil sama).
- Galat per baris: pesan 422 parser server ("Baris 3, 5 tidak dapat dibaca"), API tidak memberi daftar terstruktur.
- Alias kolom CSV per bank masih perlu contoh berkas asli (founder), bukan bagian UI.
