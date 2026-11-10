# Sub-brief: PPh 21 saldo tiap pembayar tanpa clamp (bd legend-mmgd, tingkat K)

Engine: `packages/shared/src/hris/payroll/pph21.ts` `computePph21Period`. Notasi: `docs/briefs/sub-pph21-history-split.md` dan `docs/briefs/sub-pph21-overwithhold.md` (H, aP = annual(prior) = priorTax + H, pET, pEeT, E, Gs, mix, G*, X, D = T − H, De/Dr).

## Bug

Clamp ke [0, H] (aturan B, H > 0) dan ke [0, C] (legend-u1xq, H < 0) membuat kelebihan bayar satu pembayar menutup kekurangan pembayar lain. Contoh architect: net 5,4 jt Jan–Jun, gross 20 jt Jul–Nov, Desember (gross 20 jt): karyawan mendanai 1.189.305 (`proportional`) / 2.810.000 (`gross_first`) pajak milik perusahaan. Test H3/H4 di `payroll-pph21-history-split-reference.test.ts` memuat perilaku ini.

## Usulan desain engineer (divalidasi architect)

Saldo riwayat tiap pembayar, tanpa clamp, bE + bR = H (bertanda: + kurang bayar, − lebih bayar):

- mix > 0, `gross_first`: bE = annual(Gs) − pEeT; bR = H − bE.
- mix > 0, `proportional`: bR = floor(aP × E / mix) − pET; bE = H − bR.
- tanpa mix, priorTax > 0: bR = trunc(H × pET / priorTax) (pembulatan sama dengan sekarang di kedua tanda); bE = H − bR. Tanda sama dengan H, jadi tidak ada clamp.
- tanpa mix, priorTax = 0, basis bulan ini > 0 (H ≥ 0): bR = floor(H × (G+U+N − G*) / (G+U+N)); bE = H − bR.
- lainnya (termasuk bulan TER, H = 0): bE = bR = 0, kecuali priorTax = 0 dan basis 0 dan H > 0: bE = H (sama dengan sekarang).

Satu jalur untuk semua periode (menggantikan cabang H ≥ 0 lama dan cabang H < 0 legend-u1xq):

- D(X) = T(X) − H. De: `proportional` floor(D × G*/X) (0 bila X = 0); `gross_first` min(D, annual(prior + G*) − annual(prior)) (TER: min(T, TER(G*))). Dr = D − De.
- Titik tetap: covered = max(0, Dr(X(covered)) + bR), dari 0, berhenti di non-kenaikan pertama.
- Karyawan: e = De + bE. W = max(0, e), refund karyawan = max(0, −e).
- Perusahaan: r = Dr + bR. r ≥ 0: A = min(covered × U/(U+N), r), B = r − A; r < 0: refund perusahaan = −r.
- Invarian: withheld + borne − refund − employerRefund = T; W ≤ De + max(0, bE); refund karyawan ≤ max(0, −bE); refund perusahaan ≤ max(0, −bR); satu pembayar tidak sekaligus dipotong dan di-refund.
- Klaim: hasil identik dengan engine baf5ca9e bila bE dan bR bertanda sama (atau salah satu 0), termasuk bulan TER, X = 0, satu skema. Berubah hanya saat clamp mengikat (bE, bR berlawanan tanda).

## Pertanyaan architect

- Q1 Desain di atas benar dan setara di kasus tanpa clamp (buktikan per cabang, termasuk cap lama `min(share, T)` di kedua kebijakan)?
- Q2 Saat H > 0 tetapi satu pihak lebih bayar: refund ke pihak itu di Desember sementara pihak lain dipotong lebih dari T — ada masalah aturan (PMK 168 Pasal 21, bukti potong A1)?
- Q3 Angka contoh net 5,4 jt Jan–Jun / gross 20 jt Jul–Nov (sebutkan Desember) sebelum dan sesudah, kedua kebijakan.

## Test

- Referensi hitung tangan: `apps/api/src/test/payroll-pph21-unclamped-reference.test.ts` (test-writer), langkah di komentar, invarian di tiap kasus.
- Kasus: contoh architect (kedua kebijakan); H > 0 dengan karyawan lebih bayar (kedua kebijakan); H > 0 dengan perusahaan lebih bayar; H < 0 dengan satu pihak kurang bayar (kedua kebijakan); kasus tanpa clamp tidak berubah.
- Perbarui H3/H4 (dan test lain yang terkena) dengan hitung tangan + alasan "bead legend-mmgd".
- Regresi: semua `apps/api/src/test/payroll-*.test.ts`. Jalankan `LEGEND_TEST_FILES="src/test/<file> ..." pnpm test` dari root worktree.

## Keputusan architect (final)

- Desain disetujui tanpa koreksi blok. Saldo hanya di periode terakhir (`input.lastTaxPeriod && priorMix > 0n`); periode terakhir dengan H = 0 dan basis skema boleh memberi saldo berlawanan (benar).
- Q1: setara saat tidak ada clamp mengikat (bukti per cabang; cap lama `min(share, T)` tidak pernah mengikat di bawah clamp). Fuzz 6.500 kasus tanda sama: nol beda.
- Q2: T > 0 tidak bertentangan dengan PMK 168 Pasal 21 (setoran dan A1 = T; pembagian internal). T < 0 dengan refund perusahaan: bacaan ketat Pasal 21(1) mengembalikan seluruh lebih potong ke pegawai — butuh konsultan pajak (ikut legend-8463, keputusan founder). A1 wajib memakai `pph21Idr`.
- Q3 (Desember gross 20 jt, H = −4.140.000): sebelum X 20.000.000, T −1.140.000, borne 0, refund karyawan 1.140.000 (kedua kebijakan). Sesudah `proportional` X 21.399.181, T −930.150, borne 1.399.181, refund 2.329.331; `gross_first` X 23.305.750, T −644.250, borne 3.305.750, refund 3.950.000.
